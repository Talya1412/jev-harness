/**
 * Failure taxonomy for Jev transport errors.
 *
 * Blanket fail-open treats every failure the same, which is wrong in both
 * directions: a bad API key keeps spending calls that can never succeed, and a
 * transient network blip gets logged as if it were an outage. Classify the
 * failure once, then apply the policy — retry the retryable, disable the
 * session on `auth`/`model`, stay silent on `network`.
 *
 * Nothing here throws: classification has to work on whatever the caller
 * caught, including a bare `TypeError` from `fetch`.
 */
import { JevError } from "./types.js";

export type JevFailureKind = "auth" | "model" | "rate_limit" | "network" | "server" | "unknown";

export interface JevFailurePolicy {
  kind: JevFailureKind;
  retryable: boolean;
  /** Suggested wait before the next attempt; 0 when not retryable. */
  backoffMs: number;
  /** Stop spending calls this session (key invalid / model unknown). */
  disableSession: boolean;
  /** Stay silent in logs (transient network blips are noise). */
  silent: boolean;
}

/**
 * Wait before retrying a 429 that carries no `Retry-After`. Rate limits are
 * per-minute windows, so a sub-second retry only burns attempts.
 */
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 30_000;
/** Ceiling on an honoured `Retry-After`, so a bad header cannot stall a session for hours. */
const MAX_RATE_LIMIT_BACKOFF_MS = 300_000;

const freeze = (p: JevFailurePolicy): JevFailurePolicy => Object.freeze(p);

const POLICIES: Record<JevFailureKind, JevFailurePolicy> = Object.freeze({
  /** The key is missing, rejected, or lacks access: every later call fails too. */
  auth: freeze({
    kind: "auth",
    retryable: false,
    backoffMs: 0,
    disableSession: true,
    silent: false,
  }),
  /** The model name is withdrawn or unavailable to this key: retrying re-fails. */
  model: freeze({
    kind: "model",
    retryable: false,
    backoffMs: 0,
    disableSession: true,
    silent: false,
  }),
  /** Throttled. Retryable, but only after the advertised window. */
  rate_limit: freeze({
    kind: "rate_limit",
    retryable: true,
    backoffMs: DEFAULT_RATE_LIMIT_BACKOFF_MS,
    disableSession: false,
    silent: false,
  }),
  /** DNS/TLS/socket/abort failures. Retryable and deliberately quiet. */
  network: freeze({
    kind: "network",
    retryable: true,
    backoffMs: 1_000,
    disableSession: false,
    silent: true,
  }),
  /** Upstream 5xx. Retryable, worth logging. */
  server: freeze({
    kind: "server",
    retryable: true,
    backoffMs: 2_000,
    disableSession: false,
    silent: false,
  }),
  /** Anything unrecognised: do not retry, do not disable, do not hide it. */
  unknown: freeze({
    kind: "unknown",
    retryable: false,
    backoffMs: 0,
    disableSession: false,
    silent: false,
  }),
});

/**
 * Upstream has no dedicated status for a model the key cannot use, so the
 * model shows up in the message of an otherwise generic error. A 404 that
 * mentions a model is that case; the narrower phrasings cover the responses
 * that arrive without a status at all.
 */
const MODEL_MENTION_RE = /\bmodel\b/i;
const MODEL_MESSAGE_RE =
  /unknown model|no such model|invalid model|unsupported model|model[^.]{0,40}(?:not found|not supported|unavailable|does not exist)/i;
const NETWORK_MESSAGE_RE =
  /fetch failed|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ETIMEDOUT|EPIPE|socket hang up|network|timed? ?out|abort/i;

function readMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const m = (error as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "";
}

function readName(error: unknown): string {
  if (error instanceof Error) return error.name;
  if (error && typeof error === "object") {
    const n = (error as { name?: unknown }).name;
    if (typeof n === "string") return n;
  }
  return "";
}

/**
 * Status from a `JevError`, or from any error-shaped object an adapter might
 * catch instead (a raw `Response`, an axios-style `{ response: { status } }`).
 */
function readStatus(error: unknown): number | undefined {
  if (error instanceof JevError) return error.status;
  if (!error || typeof error !== "object") return undefined;
  const direct = (error as { status?: unknown }).status;
  if (typeof direct === "number") return direct;
  const nested = (error as { response?: { status?: unknown } }).response?.status;
  return typeof nested === "number" ? nested : undefined;
}

/** Read one header out of a `Headers`, a `Map`, or a plain object, wherever it hangs. */
function readHeader(error: unknown, name: string): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const nested = (error as { headers?: unknown }).headers;
  const container = nested ?? error;
  if (!container || typeof container !== "object") return undefined;
  const get = (container as { get?: unknown }).get;
  if (typeof get === "function") {
    const value = (container as { get(n: string): string | null }).get(name);
    return value === null || value === undefined ? undefined : String(value);
  }
  if (container instanceof Map) {
    const found = (container as Map<unknown, unknown>).get(name);
    return found === undefined || found === null ? undefined : String(found);
  }
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(container as Record<string, unknown>)) {
    if (k.toLowerCase() === wanted && v !== undefined && v !== null) return String(v);
  }
  return undefined;
}

const clampBackoff = (ms: number): number => Math.min(Math.max(0, ms), MAX_RATE_LIMIT_BACKOFF_MS);

/**
 * `Retry-After` in milliseconds, in either of its two legal forms (delta
 * seconds or an HTTP date). Undefined when the header is absent or unreadable,
 * so the caller falls back to the kind's default backoff.
 */
export function retryAfterMs(error: unknown): number | undefined {
  const raw = readHeader(error, "retry-after");
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? clampBackoff(seconds * 1_000) : undefined;
  }
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : clampBackoff(at - Date.now());
}

/**
 * Map a caught error onto the framework's failure kinds.
 *
 * Observed upstream behaviour drives the status mapping: 401/403 mean the key
 * is dead (retrying never helps), 429 and 5xx are transient, and a missing
 * model shows up as a 404 whose body names the model rather than as its own
 * status code.
 */
export function classifyJevFailure(error: unknown): JevFailureKind {
  const status = readStatus(error);
  const message = readMessage(error);
  if (status !== undefined) {
    if (status === 401 || status === 403) return "auth";
    if (status === 404 && MODEL_MENTION_RE.test(message)) return "model";
    if (status === 429) return "rate_limit";
    if (status >= 500) return "server";
    return "unknown";
  }
  if (MODEL_MESSAGE_RE.test(message)) return "model";
  // A rejected fetch surfaces as a TypeError ("fetch failed"); an aborted or
  // timed-out request lands here too, and is quiet rather than terminal.
  if (error instanceof TypeError || readName(error) === "AbortError") return "network";
  if (NETWORK_MESSAGE_RE.test(message)) return "network";
  return "unknown";
}

/**
 * Policy for a kind, optionally tightened by the error itself: a `JevError`
 * carrying `retryable: false` has already been through the client's attempt
 * loop, so the caller must not put it back on a backoff.
 */
export function policyForFailure(kind: JevFailureKind, error?: unknown): JevFailurePolicy {
  const base = POLICIES[kind] ?? POLICIES.unknown;
  if (error instanceof JevError && error.retryable === false && base.retryable) {
    return freeze({ ...base, retryable: false, backoffMs: 0 });
  }
  if (base.kind === "rate_limit" && base.retryable) {
    const honoured = retryAfterMs(error);
    if (honoured !== undefined && honoured !== base.backoffMs) {
      return freeze({ ...base, backoffMs: honoured });
    }
  }
  return base;
}
