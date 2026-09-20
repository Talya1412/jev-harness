/**
 * Budget guard: cap how many Jev requests a process may issue per rolling
 * window (and in its lifetime). A hook firing on every tool call can burn
 * through requests when a session goes sideways; the guard turns runaway
 * loops into a loud, retryable-looking error instead of a silent bill.
 *
 * Wrap the config once at adapter startup and pass the wrapped config to
 * everything. The guard counts transport attempts (retries included), so the
 * numbers match what the API actually sees.
 */
import { JevError, type JevConfig } from "./types.js";

export interface BudgetOptions {
  /** Max requests per rolling window. Default 120. */
  maxPerWindow?: number;
  /** Rolling window length in ms. Default 60_000. */
  windowMs?: number;
  /** Lifetime cap for this guard. Unlimited by default. */
  maxTotal?: number;
  /** Called each time a request is rejected by the budget. */
  onLimit?: (info: BudgetLimitInfo) => void;
}

export interface BudgetLimitInfo {
  reason: "window" | "total";
  used: number;
  limit: number;
}

export interface BudgetStats {
  /** Requests issued within the current window. */
  windowCalls: number;
  /** Requests issued since the guard was created (or last reset). */
  totalCalls: number;
  /** Requests rejected because a cap was hit. */
  rejected: number;
}

export interface BudgetGuard {
  /** Return a copy of `config` whose transport enforces the budget. */
  wrap(config: JevConfig): JevConfig;
  stats(): BudgetStats;
  /** Clear all counters and window history. */
  reset(): void;
}

export function createBudgetGuard(opts: BudgetOptions = {}): BudgetGuard {
  const maxPerWindow = Math.max(1, opts.maxPerWindow ?? 120);
  const windowMs = Math.max(1, opts.windowMs ?? 60_000);
  const maxTotal = Math.max(1, opts.maxTotal ?? Number.POSITIVE_INFINITY);

  let timestamps: number[] = [];
  let totalCalls = 0;
  let rejected = 0;

  function pruneWindow(now: number): number[] {
    const cutoff = now - windowMs;
    while (timestamps.length > 0 && timestamps[0]! < cutoff) timestamps.shift();
    return timestamps;
  }

  return {
    wrap(config: JevConfig): JevConfig {
      const parent = config.fetchImpl ?? fetch;
      const wrapped: typeof fetch = async (url, init) => {
        const now = Date.now();
        const window = pruneWindow(now);
        if (window.length >= maxPerWindow) {
          rejected++;
          opts.onLimit?.({ reason: "window", used: window.length, limit: maxPerWindow });
          throw new JevError(
            `Jev budget exhausted: ${window.length} requests in the last ${windowMs}ms (limit ${maxPerWindow}). ` +
              "Raise maxPerWindow or wait for the window to slide.",
            { retryable: false },
          );
        }
        if (totalCalls >= maxTotal) {
          rejected++;
          opts.onLimit?.({ reason: "total", used: totalCalls, limit: maxTotal });
          throw new JevError(
            `Jev budget exhausted: ${totalCalls} lifetime requests (limit ${maxTotal}). ` +
              "Create a new guard or raise maxTotal.",
            { retryable: false },
          );
        }
        window.push(now);
        totalCalls++;
        return parent(url, init);
      };
      return { ...config, fetchImpl: wrapped };
    },
    stats() {
      const window = pruneWindow(Date.now());
      return { windowCalls: window.length, totalCalls, rejected };
    },
    reset() {
      timestamps = [];
      totalCalls = 0;
      rejected = 0;
    },
  };
}
