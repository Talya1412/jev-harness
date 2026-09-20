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

interface ThresholdCounts {
  threshold: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
}

/**
 * Exact confusion counts at every candidate threshold in one pass.
 * Sort predictions once (O(n log n)), then sweep the decision boundary
 * from above the max score down: each step flips one score group from
 * "predicted negative" to "predicted positive". Ties share a threshold,
 * so a group moves together — matching binaryMetrics(pairs, t)'s p >= t.
 */
function sweepCounts(sorted: BinaryPair[], candidates: number[]): ThresholdCounts[] {
  const positives = sorted.filter(({ y }) => y === 1).length;
  const negatives = sorted.length - positives;
  // Group indices by distinct score, descending.
  const groups: Array<{ p: number; tp: number; fp: number }> = [];
  for (const { p, y } of sorted) {
    const last = groups[groups.length - 1];
    if (last && last.p === p) {
      if (y === 1) last.tp++;
      else last.fp++;
    } else {
      groups.push({ p, tp: y === 1 ? 1 : 0, fp: y === 1 ? 0 : 1 });
    }
  }
  const byThreshold = new Map<number, ThresholdCounts>();
  let tp = 0;
  let fp = 0;
  let g = 0;
  // Walk thresholds high-to-low so each score group flips to "positive"
  // exactly once, when the boundary passes below its score.
  for (const t of [...candidates].sort((a, b) => b - a)) {
    // Everything with score >= t is predicted positive.
    while (g < groups.length && groups[g]!.p >= t) {
      tp += groups[g]!.tp;
      fp += groups[g]!.fp;
      g++;
    }
    byThreshold.set(t, { threshold: t, tp, fp, tn: negatives - fp, fn: positives - tp });
  }
  return candidates.map((t) => byThreshold.get(t)!);
}

function countsToMetrics(c: ThresholdCounts, brier: number, auc: number | null): BinaryMetrics {
  const n = c.tp + c.fp + c.tn + c.fn;
  const precision = c.tp + c.fp > 0 ? c.tp / (c.tp + c.fp) : null;
  const recall = c.tp + c.fn > 0 ? c.tp / (c.tp + c.fn) : null;
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;
  return {
    n,
    tp: c.tp,
    fp: c.fp,
    tn: c.tn,
    fn: c.fn,
    accuracy: n > 0 ? (c.tp + c.tn) / n : 0,
    precision,
    recall,
    f1,
    brier,
    auc,
  };
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

  // One sort + one incremental pass replaces a full binaryMetrics (with its
  // own sort for AUC) per candidate: O(n log n) total, not O(n^2 log n).
  const sortedDesc = [...pairs].sort((a, b) => b.p - a.p);
  const counts = sweepCounts(sortedDesc, candidates);
  const scored = counts.map((c) => {
    const m = countsToMetrics(c, overall.brier, overall.auc);
    const value = objective === "youden" ? youdenJ(m) : (m.f1 ?? -1);
    return { threshold: c.threshold, m, value };
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
