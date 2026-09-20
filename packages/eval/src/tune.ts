/**
 * Threshold tuning on top of the metrics in ./metrics.js. Sweep candidate
 * thresholds across a labeled set and pick the one that optimizes an
 * objective (F1 by default). Pure: takes pairs, returns a summary object —
 * the CLI (`./tune-bin.ts` + `./tune-cli.ts`) handles I/O around this.
 */
import { binaryMetrics, ece, prAuc, type BinaryPair, type BinaryMetrics } from "./metrics.js";

export type TuneObjective = "f1" | "youden";

export interface TuneSummary {
  n: number;
  positives: number;
  objective: TuneObjective;
  bestThreshold: number;
  atBest: BinaryMetrics;
  /** Brier score — threshold-independent, computed at the default 0.5 pass. */
  brier: number;
  /** Expected Calibration Error — threshold-independent. */
  ece: number;
  /** Rank AUC (Mann–Whitney); null when only one class is present. */
  rocAuc: number | null;
  /** Average precision; null when there are no positives. */
  prAuc: number | null;
  /** Candidates examined, best-first by the chosen objective. */
  sweep: Array<{ threshold: number; precision: number | null; recall: number | null; f1: number | null }>;
}

/** Candidate thresholds to evaluate: every unique prediction plus 0.5. */
function candidateThresholds(pairs: BinaryPair[]): number[] {
  const set = new Set<number>(pairs.map(({ p }) => p));
  set.add(0.5);
  return [...set].filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
}

/** Youden's J = TPR − FPR; higher is better. Both rates are zero-safe. */
function youdenJ(m: BinaryMetrics): number {
  const tpr = m.tp + m.fn === 0 ? 0 : m.tp / (m.tp + m.fn);
  const fpr = m.fp + m.tn === 0 ? 0 : m.fp / (m.fp + m.tn);
  return tpr - fpr;
}

/**
 * Find the best threshold for a labeled set of (probability, outcome) pairs.
 * This is how "tuned threshold 0.75" statements get produced: from data, not
 * folklore. Candidates are the observed probabilities (plus 0.5), so the
 * sweep is exact rather than a fixed grid.
 */
export function tune(pairs: BinaryPair[], objective: TuneObjective = "f1"): TuneSummary {
  const positives = pairs.filter(({ y }) => y === 1).length;
  const overall = binaryMetrics(pairs);
  const candidates = candidateThresholds(pairs);

  const scored = candidates.map((threshold) => {
    const m = binaryMetrics(pairs, threshold);
    const value = objective === "youden" ? youdenJ(m) : (m.f1 ?? -1);
    return { threshold, m, value };
  });
  scored.sort((a, b) => b.value - a.value);

  const best = scored[0]!;
  return {
    n: pairs.length,
    positives,
    objective,
    bestThreshold: best.threshold,
    atBest: best.m,
    brier: overall.brier,
    ece: ece(pairs),
    rocAuc: overall.auc,
    prAuc: prAuc(pairs),
    sweep: scored.map(({ threshold, m }) => ({
      threshold,
      precision: m.precision,
      recall: m.recall,
      f1: m.f1,
    })),
  };
}
