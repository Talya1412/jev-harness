/**
 * Resolve the Jev client config from the environment.
 *
 * Rule: the API key always comes from `process.env.TYPESAFE_API_KEY`
 * (or an explicit override passed by the caller) — it is never hardcoded
 * and never logged. Optional overrides: TYPESAFE_BASE_URL,
 * TYPESAFE_DEFAULT_MODEL, JEV_TIMEOUT_MS.
 */
import { DEFAULT_BASE_URL, DEFAULT_MODEL, type JevConfig } from "@jev-harness/core";

function parseTimeoutMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

/**
 * Build a JevConfig from env + optional explicit overrides.
 * Throws a clear error naming TYPESAFE_API_KEY when no key is available.
 */
export function resolveJevConfig(overrides: Partial<JevConfig> = {}): JevConfig {
  const apiKey = (overrides.apiKey ?? process.env.TYPESAFE_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error(
      "TYPESAFE_API_KEY is not set. Export it in your environment " +
        "(e.g. export TYPESAFE_API_KEY=...) or add it to the MCP client " +
        "config under env, then restart the server.",
    );
  }
  const config: JevConfig = {
    apiKey,
    baseUrl: overrides.baseUrl ?? process.env.TYPESAFE_BASE_URL ?? DEFAULT_BASE_URL,
    model: overrides.model ?? process.env.TYPESAFE_DEFAULT_MODEL ?? DEFAULT_MODEL,
  };
  const timeoutMs = overrides.timeoutMs ?? parseTimeoutMs(process.env.JEV_TIMEOUT_MS);
  if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;
  return config;
}
