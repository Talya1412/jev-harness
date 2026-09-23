/**
 * Pure configuration helpers for the OMP adapter.
 *
 * Kept free of any ExtensionAPI reference so they can be unit-tested without a
 * harness instance. `env` is passed in rather than read from `process.env` so
 * tests never have to mutate global state.
 */
import { DEFAULT_BASE_URL, DEFAULT_MODEL, type JevConfig } from "@jev-harness/core";

export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Destructive-gate cutoff. Chosen from the labeled golden dataset: the swept
 * optimum is a 0.4-0.6 plateau with no false positives and no false negatives,
 * so 0.5 sits mid-margin against run-to-run variance.
 */
export const GATE_THRESHOLD = 0.5;

/** Minimum confidence before the skill router injects a suggestion. */
export const SKILL_MIN_CONFIDENCE = 0.5;

export type Env = Record<string, string | undefined>;

/** Read the Jev client config from the environment, or throw when unkeyed. */
export function readConfig(env: Env, modelOverride?: string, redact?: boolean): JevConfig {
  const apiKey = (env.TYPESAFE_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error(
      "TYPESAFE_API_KEY is not set. Export it in your shell or add it to your harness env file.",
    );
  }
  const timeoutRaw = (env.JEV_TIMEOUT_MS ?? "").trim();
  const timeoutMs =
    timeoutRaw !== "" && Number.isFinite(Number(timeoutRaw))
      ? Number(timeoutRaw)
      : DEFAULT_TIMEOUT_MS;
  return {
    apiKey,
    baseUrl: (env.TYPESAFE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: (modelOverride ?? "").trim() || env.TYPESAFE_DEFAULT_MODEL || DEFAULT_MODEL,
    timeoutMs,
    redact,
  };
}

/**
 * Redaction policy. Hooks (gate, skill router, compaction) redact by default:
 * their state carries tool input and history that routinely embeds secrets.
 * The `jev_ask` tool keeps full fidelity by default — the model chose that
 * state deliberately. `OMP_JEV_REDACT=1` turns redaction on everywhere,
 * `OMP_JEV_REDACT=0` off everywhere.
 */
export function redactOn(env: Env, context: "hook" | "tool"): boolean {
  const raw = (env.OMP_JEV_REDACT ?? "").trim();
  if (raw === "0") return false;
  if (raw === "1") return true;
  return context === "hook";
}

/** Master switch (`OMP_JEV_AUTO=1`) plus a per-hook off-switch: setting the named variable to "0" disables that one hook without touching the others. */
export function autoOn(env: Env, name: string): boolean {
  return (env.OMP_JEV_AUTO ?? "").trim() === "1" && (env[name] ?? "1").trim() !== "0";
}

/** Read a numeric env override, falling back when unset or unparseable. */
export function envNum(env: Env, name: string, fallback: number): number {
  const raw = (env[name] ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
