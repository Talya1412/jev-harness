import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  JevError,
  type JevConfig,
  type JevResponse,
  type Questions,
  type Answer,
  type NoulAnswer,
  type ChoiceAnswer,
  type ScoreAnswer,
} from "./types.js";
import { redactState } from "./redact.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 3;

function resolveConfig(config: JevConfig) {
  const apiKey = (config.apiKey ?? "").trim();
  if (!apiKey) {
    throw new JevError(
      "TYPESAFE_API_KEY is not set. Add it to your environment or pass { apiKey }.",
      { retryable: false },
    );
  }
  return {
    apiKey,
    baseUrl: (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: config.model ?? DEFAULT_MODEL,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxAttempts: Math.max(1, config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
    fetchImpl: config.fetchImpl ?? fetch,
    onRetry: config.onRetry,
    redact: config.redact,
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Validate the question map before spending a request. */
export function validateQuestions(questions: Questions): void {
  const keys = Object.keys(questions ?? {});
  if (keys.length === 0)
    throw new JevError("questions must be a non-empty object", { retryable: false });
  for (const key of keys) {
    const q = questions[key];
    if (!q || typeof q !== "object")
      throw new JevError(`question "${key}" must be an object`, { retryable: false });
    if (!q.instructions || typeof q.instructions !== "string") {
      throw new JevError(`question "${key}" needs a non-empty instructions string`, {
        retryable: false,
      });
    }
    if (q.type === "choice") {
      const n = Object.keys(q.criteria ?? {}).length;
      if (n < 2)
        throw new JevError(`choice "${key}" needs at least 2 criteria`, { retryable: false });
    } else if (q.type === "score") {
      const n = Array.isArray(q.criteria) ? q.criteria.length : 0;
      if (n < 2)
        throw new JevError(`score "${key}" needs at least 2 ordered levels`, { retryable: false });
    } else if (q.type !== "noul") {
      throw new JevError(`question "${key}" has unknown type "${(q as { type?: string }).type}"`, {
        retryable: false,
      });
    }
  }
}

/**
 * One System One call. Batches every question into a single request — the
 * primitives are evaluated independently against the same state, so this is
 * strictly cheaper than one call per question.
 */
export async function askJev(
  config: JevConfig,
  state: unknown,
  questions: Questions,
  signal?: AbortSignal,
): Promise<JevResponse> {
  const cfg = resolveConfig(config);
  validateQuestions(questions);

  if (state === undefined || state === null) {
    throw new JevError("state is required", { retryable: false });
  }

  // Redaction is a privacy control, not an availability control: if it ever
  // throws, sending the original state is preferable to breaking the call.
  let effectiveState: unknown = state;
  if (cfg.redact) {
    const opts = cfg.redact === true ? {} : cfg.redact;
    try {
      effectiveState = redactState(state, opts);
    } catch {
      effectiveState = state;
    }
  }

  const body = JSON.stringify({ model: cfg.model, state: effectiveState, questions });
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    if (signal?.aborted) {
      const abortErr = new Error("Jev call aborted");
      abortErr.name = "AbortError";
      throw abortErr;
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await cfg.fetchImpl(cfg.baseUrl + "/v1/systemone", {
        method: "POST",
        headers: { Authorization: "Bearer " + cfg.apiKey, "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });

      if (res.status === 429 || res.status >= 500) {
        const text = await res.text().catch(() => "");
        lastError = new JevError(`Jev HTTP ${res.status}: ${text.slice(0, 300)}`, {
          status: res.status,
          retryable: true,
        });
        if (attempt < cfg.maxAttempts) {
          cfg.onRetry?.(attempt, lastError);
          await sleep(250 * attempt * attempt);
          continue;
        }
        throw lastError;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new JevError(`Jev HTTP ${res.status}: ${text.slice(0, 500)}`, {
          status: res.status,
          retryable: false,
        });
      }

      let parsed: unknown;
      const raw = await res.text();
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new JevError("Jev returned malformed JSON", { retryable: false });
      }
      const obj = parsed as Partial<JevResponse> | null;
      if (!obj || typeof obj !== "object" || !obj.answers || typeof obj.answers !== "object") {
        throw new JevError("Jev response is missing `answers`", { retryable: false });
      }
      return obj as JevResponse;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (e instanceof JevError && !e.retryable) throw e;
      lastError = e;
      const transient =
        e.name === "AbortError" || /fetch failed|ECONN|network|timeout|aborted/i.test(e.message);
      if (!transient || attempt === cfg.maxAttempts) throw e;
      cfg.onRetry?.(attempt, e);
      await sleep(250 * attempt * attempt);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  throw lastError ?? new JevError("Jev call failed", { retryable: false });
}

/** List the models available to the configured key. */
export async function listJevModels(
  config: JevConfig,
  signal?: AbortSignal,
): Promise<Array<{ name: string; description?: string }>> {
  const cfg = resolveConfig(config);
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    if (signal?.aborted) {
      const abortErr = new Error("Jev models call aborted");
      abortErr.name = "AbortError";
      throw abortErr;
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await cfg.fetchImpl(cfg.baseUrl + "/v1/models", {
        headers: { Authorization: "Bearer " + cfg.apiKey },
        signal: controller.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        const text = await res.text().catch(() => "");
        lastError = new JevError(`Jev models HTTP ${res.status}: ${text.slice(0, 300)}`, {
          status: res.status,
          retryable: true,
        });
        if (attempt < cfg.maxAttempts) {
          cfg.onRetry?.(attempt, lastError);
          await sleep(250 * attempt * attempt);
          continue;
        }
        throw lastError;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new JevError(`Jev models HTTP ${res.status}: ${text.slice(0, 500)}`, {
          status: res.status,
          retryable: false,
        });
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new JevError("Jev models returned malformed JSON", { retryable: false });
      }
      const models = (body as { models?: unknown })?.models;
      if (!Array.isArray(models))
        throw new JevError("Jev models response is missing `models`", { retryable: false });
      return models as Array<{ name: string; description?: string }>;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (e instanceof JevError && !e.retryable) throw e;
      lastError = e;
      const transient =
        e.name === "AbortError" || /fetch failed|ECONN|network|timeout|aborted/i.test(e.message);
      if (!transient || attempt === cfg.maxAttempts) throw e;
      cfg.onRetry?.(attempt, e);
      await sleep(250 * attempt * attempt);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  throw lastError ?? new JevError("Jev models call failed", { retryable: false });
}

// --- Typed accessors. Each throws when the answer is missing or malformed,
// so callers never have to narrow a union by hand. ---

export function noul(response: JevResponse, id: string): number {
  const a = response.answers[id];
  if (!a || a.type !== "noul" || typeof (a as NoulAnswer).noul !== "number") {
    throw new JevError(`answer "${id}" is not a valid noul`, { retryable: false });
  }
  return (a as NoulAnswer).noul;
}

export function choice(
  response: JevResponse,
  id: string,
): { choice: string; confidence: number; probabilities: Record<string, number> } {
  const a = response.answers[id];
  if (!a || a.type !== "choice")
    throw new JevError(`answer "${id}" is not a valid choice`, { retryable: false });
  const c = a as ChoiceAnswer;
  return { choice: c.choice, confidence: c.confidence ?? 0, probabilities: c.probabilities ?? {} };
}

export function score(
  response: JevResponse,
  id: string,
): { score: number; confidence: number; legend?: Record<string, string> } {
  const a = response.answers[id];
  if (!a || a.type !== "score")
    throw new JevError(`answer "${id}" is not a valid score`, { retryable: false });
  const s = a as ScoreAnswer;
  return { score: s.score, confidence: s.confidence ?? 0, legend: s.legend };
}

export type { Answer, JevConfig, JevResponse, Questions };
