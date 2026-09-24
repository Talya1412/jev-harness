/**
 * One place where a Jev transport failure is turned into a decision.
 *
 * The adapter used to fail open everywhere with a blanket `catch`: an invalid
 * API key, an unknown model, and a transient socket blip all produced the same
 * silent "skip". That hides a misconfiguration forever — the hooks simply stop
 * working and nothing says why. `classifyJevFailure` + `policyForFailure`
 * (core) separate the cases the caller must act on from the ones it must not:
 *
 * - `auth` / `model`: not retryable, and the session stops spending calls —
 *   every later attempt fails the same way, and each one costs latency inside a
 *   host handler that is on a budget.
 * - `rate_limit`: back off this long before the next call.
 * - `network`: transient, and deliberately quiet.
 * - `server` / `unknown`: surface it.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  createRefusalLedger,
  classifyJevFailure,
  policyForFailure,
  type JevFailureKind,
} from "@jev-harness/core";

/** One recorded refusal, as the ledger holds it. */
export interface RefusalEntry {
  key: string;
  reason: string;
  at: number;
  count: number;
}

/**
 * The refusal ledger plus its durable trace.
 *
 * `createRefusalLedger` (core) deduplicates repeats, which is what makes the
 * memory view readable — but an in-memory ring dies with the process, and the
 * whole point of recording a refusal is to explain a declined action to
 * someone who was not watching. When `OMP_JEV_DECISION_LOG` is set, each
 * distinct refusal is therefore also appended as one JSON line, the same file
 * the gate's decision log writes to.
 *
 * Never throws: a refusal that cannot be written is still a refusal that
 * happened, and losing the trace must not break the hook that recorded it.
 */
export function createTracedLedger(path: string | undefined, max = 200) {
  const ledger = createRefusalLedger({ max });
  const sink = (path ?? "").trim();
  const seen = new Set<string>();
  return {
    record(key: string, reason: string, at?: number): void {
      ledger.record(key, reason, at);
      if (sink === "") return;
      // Only the FIRST occurrence of a distinct refusal is written: the ledger
      // already folds repeats into a count, so the file stays readable.
      const id = key + "\u0000" + reason;
      if (seen.has(id)) return;
      seen.add(id);
      try {
        mkdirSync(dirname(sink), { recursive: true });
        appendFileSync(
          sink,
          JSON.stringify({
            ts: new Date(at ?? Date.now()).toISOString(),
            kind: "omp_refusal",
            key,
            reason,
          }) + "\n",
          "utf8",
        );
      } catch {
        // An unwritable trace must not break the hook.
      }
    },
    entries(): readonly RefusalEntry[] {
      return ledger.entries();
    },
  };
}

/** The outcome of a failure, in terms of what the adapter does next. */
export interface FailureDecision {
  kind: JevFailureKind;
  /** Stop asking Jev until the process restarts. */
  disableSession: boolean;
  /** Keep it out of the logs (transient noise). */
  silent: boolean;
  /** Wait this long before the next call; 0 when there is nothing to wait for. */
  backoffMs: number;
  /** One line for the log, naming the kind and whether it disabled the session. */
  message: string;
}

/**
 * Turn a caught error into a decision. Never throws: whatever `fetch` or the
 * client rejected with is legal input, including a bare string.
 */
export function decideOnFailure(error: unknown, where: string): FailureDecision {
  const kind = classifyJevFailure(error);
  const policy = policyForFailure(kind, error);
  return {
    kind,
    disableSession: policy.disableSession,
    silent: policy.silent,
    backoffMs: policy.retryable ? policy.backoffMs : 0,
    message:
      "jev " +
      where +
      ": " +
      kind +
      " failure" +
      (policy.disableSession ? " — disabling Jev for this session" : "") +
      ": " +
      describe(error),
  };
}

/** Error text for a log line, bounded so a huge body cannot flood the log. */
function describe(error: unknown): string {
  if (error instanceof Error) return (error.message || error.name).slice(0, 300);
  if (typeof error === "string") return error.slice(0, 300);
  try {
    return JSON.stringify(error).slice(0, 300);
  } catch {
    return String(error).slice(0, 300);
  }
}

/** Minimal logger surface; matches `pi.logger` without importing it. */
export interface FailureLogger {
  warn(message: string, extra?: unknown): void;
  debug(message: string, extra?: unknown): void;
}

/**
 * Report a failure through a host logger according to its policy, and say
 * whether the caller should still trust Jev for this session.
 *
 * Every call into the logger is itself guarded: the logger is host code, and a
 * throw from it must never turn a logged failure into a broken hook.
 */
export function reportFailure(
  logger: FailureLogger,
  decision: FailureDecision,
): { disabled: boolean } {
  try {
    if (decision.silent) logger.debug(decision.message);
    else logger.warn(decision.message);
  } catch {
    // Logger unavailable — the decision still stands.
  }
  return { disabled: decision.disableSession };
}
