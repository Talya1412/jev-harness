/**
 * Resolve the Jev client config from the environment — the shared rule for
 * every adapter: TYPESAFE_API_KEY (required or optional), TYPESAFE_BASE_URL,
 * TYPESAFE_DEFAULT_MODEL, JEV_TIMEOUT_MS, JEV_REDACT. The key is never
 * hardcoded and never logged.
 *
 * Adapter-specific policy is passed in, never guessed here: a caller whose
 * redaction rule depends on context (hooks redact tool input and history,
 * an explicit jev_ask keeps full fidelity) supplies `redact`.
 */
import { DEFAULT_BASE_URL, DEFAULT_MODEL, type JevConfig } from "@jev-harness/core";

/** Environment source. Defaults to `process.env`; tests inject a plain map. */
export type Env = Record<string, string | undefined>;

export interface ResolveEnvConfigOptions {
  /** Per-call model override (wins over TYPESAFE_DEFAULT_MODEL). */
  modelOverride?: string;
  /**
   * When true, a missing TYPESAFE_API_KEY throws a clear error (strict
   * adapters). When false, the config is returned with an empty key and the
   * caller's fail-open handling applies.
   */
  requireKey?: boolean;
  /**
   * This caller's redaction decision, overriding the `JEV_REDACT !== "0"`
   * default. A caller that renders "off" as an absent field (core's documented
   * default) drops the field itself after the fact.
   */
  redact?: boolean;
  /** Explicit overrides for apiKey/baseUrl/model/timeoutMs/redact; win over the env. */
  overrides?: Partial<JevConfig>;
  /** Environment source; defaults to `process.env`. */
  env?: Env;
}

/** Largest timeout Node's setTimeout honours; larger values overflow to ~1ms. */
export const MAX_TIMEOUT_MS = 2147483647;

/**
 * Parse a timeout-ms value, capping at MAX_TIMEOUT_MS so a huge value
 * cannot overflow Node's setTimeout into a ~1ms timeout. Shared by the kit
 * (JEV_TIMEOUT_MS) and the CLIs (--timeout-ms, jev-gate).
 */
export function parseTimeoutMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(Math.floor(n), MAX_TIMEOUT_MS);
}

export function resolveEnvConfig(opts: ResolveEnvConfigOptions = {}): JevConfig {
  const env = opts.env ?? process.env;
  const overrides = opts.overrides ?? {};
  const apiKey = (overrides.apiKey ?? env.TYPESAFE_API_KEY ?? "").trim();
  if (opts.requireKey && !apiKey) {
    throw new Error(
      "TYPESAFE_API_KEY is not set. Export it in your shell or add it to your harness env file.",
    );
  }
  const config: JevConfig = {
    apiKey,
    baseUrl: (
      (overrides.baseUrl ?? env.TYPESAFE_BASE_URL ?? "").trim() || DEFAULT_BASE_URL
    ).replace(/\/+$/, ""),
    model:
      (overrides.model ?? opts.modelOverride ?? "").trim() ||
      (env.TYPESAFE_DEFAULT_MODEL ?? "").trim() ||
      DEFAULT_MODEL,
    // Adapters built on the kit send tool input and history as state; redaction
    // is on unless JEV_REDACT=0 or the caller passes its own decision.
    redact: opts.redact ?? overrides.redact ?? (env.JEV_REDACT ?? "").trim() !== "0",
  };
  const timeoutMs = overrides.timeoutMs ?? parseTimeoutMs(env.JEV_TIMEOUT_MS);
  if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;
  return config;
}
