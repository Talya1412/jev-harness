/**
 * Pure configuration helpers for the OMP adapter.
 *
 * Kept free of any ExtensionAPI reference so they can be unit-tested without a
 * harness instance. `env` is passed in rather than read from `process.env` so
 * tests never have to mutate global state.
 */
import { THRESHOLDS, type JevConfig } from "@jev-harness/core";
import { parseTimeoutMs, resolveEnvConfig } from "@jev-harness/kit";

export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Destructive-gate cutoff. Measured on the labeled golden dataset: the swept
 * optimum is a 0.4-0.6 plateau with no false positives and no false negatives,
 * so the shared 0.5 sits mid-margin against run-to-run variance. Re-exported
 * from core so the adapter never carries its own copy of a tuned number.
 */
export const GATE_THRESHOLD = THRESHOLDS.destructiveGate;

/** Minimum confidence before the skill router injects a suggestion. */
export const SKILL_MIN_CONFIDENCE = THRESHOLDS.skillRouting;

/**
 * Self-imposed cap on how long the `tool_call` gate may spend inside the host's
 * handler budget. OMP aborts a `tool_call` handler at
 * `extensionHandlers.toolCallTimeoutMs` (default 30_000) and maps BOTH a
 * timeout and a throw to `{ block: true }` — so a handler that outlives the
 * budget fails CLOSED and freezes every mutating tool call. Core retries
 * transient failures 3x at 15 s plus backoff (~46 s worst case), over that
 * budget; this deadline keeps the handler settling while it still can, and the
 * catch at the call site turns the resulting abort into "allow".
 *
 * 8 s: far above a healthy call (200-400 ms typical) while bounding the worst
 * case well under the host budget.
 */
export const GATE_DEADLINE_MS = 8_000;

/**
 * Combine the host's signal with a self-imposed deadline, so the caller aborts
 * on EITHER. `AbortSignal.any` needs Node >= 20.3; the manual path keeps the
 * adapter working on an older runtime (the engine floor is Node 20).
 */
export function withDeadline(host: AbortSignal | undefined, ms: number): AbortSignal {
  const timer = AbortSignal.timeout(ms);
  if (!host) return timer;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([host, timer]);
  const ctl = new AbortController();
  const abort = () => ctl.abort();
  if (host.aborted) abort();
  else host.addEventListener("abort", abort, { once: true });
  timer.addEventListener("abort", abort, { once: true });
  return ctl.signal;
}

export type Env = Record<string, string | undefined>;

/**
 * Read the Jev client config from the environment, or throw when unkeyed.
 *
 * The env→config rule itself lives in @jev-harness/kit — the shared adapter
 * foundation — so this wrapper carries ONLY what is OMP's to decide:
 * - a missing key is a hard error here (every call site already sits inside a
 *   fail-open catch, so throwing is how the hook declines cleanly);
 * - `redact` is positional and OPTIONAL, and when the caller does not decide
 *   the field is left ABSENT so core's documented default applies. Kit would
 *   otherwise default it on from `JEV_REDACT`; OMP's own policy is the
 *   context-dependent `redactOn` (`OMP_JEV_REDACT`), and a tool that keeps
 *   full fidelity would break if this silently turned redaction on.
 * - the timeout always resolves to a number (kit omits it when unset), so a
 *   caller never has to apply core's default itself.
 */
export function readConfig(env: Env, modelOverride?: string, redact?: boolean): JevConfig {
  const cfg = resolveEnvConfig({
    env,
    modelOverride,
    requireKey: true,
    // parseTimeoutMs also caps at MAX_TIMEOUT_MS, which the previous inline
    // Number() did not: a huge value would overflow setTimeout into ~1ms.
    overrides: { timeoutMs: parseTimeoutMs(env.JEV_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS },
  });
  if (redact === undefined) delete cfg.redact;
  else cfg.redact = redact;
  return cfg;
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
