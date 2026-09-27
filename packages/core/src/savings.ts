/**
 * Savings accounting: turn a decision log into the one number the operator
 * actually wants — how much of the API spend was avoided, and how much was
 * unavoidable.
 *
 * Every figure is separated into MEASURED and ESTIMATED, because the difference
 * is the whole point: a decision record carries real latency and a real answer,
 * while the cost of a call that never happened can only be an estimate from
 * a comparable call that did. Mixing the two silently is how a savings
 * dashboard becomes fiction.
 */
import type { DecisionRecord } from "./decision-log.js";

/** Input price per million tokens for the configured model (Jev 1.13: $0.042). */
export const DEFAULT_INPUT_USD_PER_MTOK = 0.042;

export interface SavingsSummary {
  /** Decisions read from the log. */
  decisions: number;
  /** Decisions a closed-form rule answered, keyed by rule id. */
  skipped: Record<string, number>;
  /** Decisions that spent a request, keyed by the action the caller took. */
  judged: Record<string, number>;
  /** MEASURED: summed latency of the judged calls, in ms. */
  judgedLatencyMs: number;
  /** MEASURED: how many judged calls returned a blocking verdict. */
  blocked: number;
  /**
   * ESTIMATED: tokens a skipped call would have sent, taken as the MEAN of the
   * judged calls' own recorded state size when available. Zero when the log
   * carries no size signal — never invented.
   */
  meanJudgedTokens: number;
  /** ESTIMATED: dollars avoided by the skips, at the configured price. */
  estimatedUsdAvoided: number;
  /** ESTIMATED: milliseconds avoided, at the judged calls' mean latency. */
  estimatedMsAvoided: number;
}

const round = (n: number, places = 6) => Number(n.toFixed(places));

/**
 * Classification is by the record itself, never by a separate counter: an
 * action beginning `skip:` is a decision no request paid for, and anything else
 * is a call that did. That keeps a log written by an older adapter readable
 * here without a migration.
 */
export function summarizeSavings(
  records: readonly DecisionRecord[],
  opts: { usdPerMTok?: number; meanJudgedTokens?: number } = {},
): SavingsSummary {
  const price = opts.usdPerMTok ?? DEFAULT_INPUT_USD_PER_MTOK;
  const skipped: Record<string, number> = {};
  const judged: Record<string, number> = {};
  let judgedLatencyMs = 0;
  let blocked = 0;
  let judgedCount = 0;

  for (const r of records) {
    const action = String(r.action ?? "unknown");
    if (action.startsWith("skip:")) {
      const rule = action.slice("skip:".length) || "unknown";
      skipped[rule] = (skipped[rule] ?? 0) + 1;
      continue;
    }
    judged[action] = (judged[action] ?? 0) + 1;
    judgedCount++;
    judgedLatencyMs += Number.isFinite(r.latencyMs) ? r.latencyMs : 0;
    if (action === "block" || action === "confirm") blocked++;
  }

  // The token count is NOT on a decision record, so it must be supplied by the
  // caller that measured it (the OMP cache, say). Absent that, the estimate is
  // zero — a fabricated token count would make the dollar figure fiction.
  const meanJudgedTokens = Math.max(0, opts.meanJudgedTokens ?? 0);
  const skipCount = Object.values(skipped).reduce((a, b) => a + b, 0);
  const meanJudgedMs = judgedCount > 0 ? judgedLatencyMs / judgedCount : 0;

  return {
    decisions: records.length,
    skipped,
    judged,
    judgedLatencyMs,
    blocked,
    meanJudgedTokens,
    // Nine places: per-call costs are micro-dollars, so a coarser rounding
    // would erase the very difference the figure exists to show.
    estimatedUsdAvoided: round((skipCount * meanJudgedTokens * price) / 1_000_000, 9),
    estimatedMsAvoided: Math.round(skipCount * meanJudgedMs),
  };
}

/** One line per rule, for a terminal; MEASURED and ESTIMATED never mix. */
export function formatSavings(s: SavingsSummary): string {
  const lines = [
    `decisions          ${s.decisions}`,
    `judged (MEASURED)  ${Object.values(s.judged).reduce((a, b) => a + b, 0)}  latency ${s.judgedLatencyMs} ms, blocked ${s.blocked}`,
    `skipped (no call)  ${Object.values(s.skipped).reduce((a, b) => a + b, 0)}`,
  ];
  for (const [rule, n] of Object.entries(s.skipped).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${rule.padEnd(24)} ${n}`);
  }
  lines.push(
    `avoided (ESTIMATED from ${s.meanJudgedTokens} tok/call)  $${s.estimatedUsdAvoided}  ~${s.estimatedMsAvoided} ms`,
  );
  return lines.join("\n");
}
