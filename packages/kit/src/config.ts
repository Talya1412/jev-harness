/**
 * Resolve the Jev client config from the environment — the shared rule for
 * every adapter: TYPESAFE_API_KEY (required or optional), TYPESAFE_BASE_URL,
 * TYPESAFE_DEFAULT_MODEL, JEV_TIMEOUT_MS. The key is never hardcoded and
 * never logged.
 */
import { DEFAULT_BASE_URL, DEFAULT_MODEL, type JevConfig } from "@jev-harness/core";

export interface ResolveEnvConfigOptions {
  /** Per-call model override (wins over TYPESAFE_DEFAULT_MODEL). */
  modelOverride?: string;
  /**
   * When true, a missing TYPESAFE_API_KEY throws a clear error (strict
   * adapters). When false, the config is returned with an empty key and the
   * caller's fail-open handling applies.
   */
  requireKey?: boolean;
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
  const apiKey = (process.env.TYPESAFE_API_KEY ?? "").trim();
  if (opts.requireKey && !apiKey) {
    throw new Error(
      "TYPESAFE_API_KEY is not set. Export it in your shell or add it to your harness env file.",
    );
  }
  const config: JevConfig = {
    apiKey,
    baseUrl: ((process.env.TYPESAFE_BASE_URL ?? "").trim() || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model:
      (opts.modelOverride ?? "").trim() ||
      (process.env.TYPESAFE_DEFAULT_MODEL ?? "").trim() ||
      DEFAULT_MODEL,
    // Adapters built on the kit send tool input and history as state; redaction
    // is on unless JEV_REDACT=0.
    redact: (process.env.JEV_REDACT ?? "").trim() !== "0",
  };
  const timeoutMs = parseTimeoutMs(process.env.JEV_TIMEOUT_MS);
  if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;
  return config;
}
