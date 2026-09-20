/**
 * Standardized failure policy for Jev-driven decisions.
 *
 * The harness safety model says: fail open by default, because a Jev outage
 * must never block the agent. But some callers want the opposite (a gate
 * that denies when it cannot judge), and tests want the raw error. This
 * helper makes the policy explicit at the call site instead of burying a
 * bare try/catch in every adapter.
 *
 * ```ts
 * const verdict = await withFailMode("open",
 *   () => judgeDestructive(config, call),
 *   { open: { destructive: 0, blocked: false }, closed: { destructive: 1, blocked: true } },
 * );
 * ```
 *
 * "open" returns `outcomes.open` on any error (allow), "closed" returns
 * `outcomes.closed` (deny), "throw" rethrows. `outcomes.onError` receives
 * every error for logging — never log the API key, and JevError messages
 * are safe to surface.
 */
export type FailMode = "open" | "closed" | "throw";

export interface FailOutcomes<T> {
  /** Value used when the mode is "open" and an error occurred. */
  open: T;
  /** Value used when the mode is "closed" and an error occurred. */
  closed: T;
  /** Optional observer for the error (logging, counters). Called before the policy applies. */
  onError?: (err: unknown) => void;
}

export async function withFailMode<T>(mode: FailMode, fn: () => Promise<T>, outcomes: FailOutcomes<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    try {
      outcomes.onError?.(err);
    } catch {
      // A throwing observer must never break the fail-open/closed contract.
    }
    if (mode === "throw") throw err;
    return mode === "open" ? outcomes.open : outcomes.closed;
  }
}
