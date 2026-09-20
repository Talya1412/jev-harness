/**
 * Threshold tuning. Sweep candidate thresholds across a labeled set and pick
 * the one that optimizes an objective (F1 by default). Pure: takes arrays,
 * returns a summary object — the CLI (`./cli.js`) handles I/O around this.
 */
import {
  brierScore,
  confusionMatrix,
  ece,
  precisionRecallF1,
  prAuc,
  rocAuc,
  type ConfusionMatrix,
  type PrMetrics,
} from "./metrics.js";

export type TuneObjective = "f1" | "youden";

export interface TuneSummary {
  n: number;
  positives: number;
  objective: TuneObjective;
  bestThreshold: number;
  atBest: PrMetrics & ConfusionMatrix;
  brier: number;
  ece: number;
  rocAuc: number;
  prAuc: number;
  /** candidates examined, best-first by objective */
  sweep: Array<{ threshold: number } & PrMetrics>;
}

/** Candidate thresholds to evaluate: every unique prediction plus 0.5. */
function candidateThresholds(predictions: number[]): number[] {
  const set = new Set<number>(predictions);
  set.add(0.5);
  const arr = [...set].filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  return arr;
}

function youden(cm: ConfusionMatrix): number {
  // TPR - FPR; higher is better. Both zero-safe.
  const tpr = cm.tp + cm.fn === 0 ? 0 : cm.tp / (cm.tp + cm.fn);
  const fpr = cm.fp + cm.tn === 0 ? 0 : cm.fp / (cm.fp + cm.tn);
  return tpr - fpr;
}

/**
 * Find the best threshold for a labeled set. `predictions` are the
 * probabilities Jev returned; `outcomes` are the ground-truth booleans from
 * your labeled data.
 */
export function tune(
  predictions: number[],
  outcomes: boolean[],
  objective: TuneObjective = "f1",
): TuneSummary {
  const n = Math.min(predictions.length, outcomes.length);
  const positives = outcomes.slice(0, n).filter(Boolean).length;
  const candidates = candidateThresholds(predictions.slice(0, n));

  const sweep = candidates.map((t) => {
    const cm = confusionMatrix(predictions, outcomes, t);
    const pr = precisionRecallF1(cm);
    return { threshold: t, ...pr, ...cm };
  });

  const scored = sweep.map((s) => {
    const value = objective === "youden" ? youden(s) : s.f1;
    return { s, value };
  });
  scored.sort((a, b) => b.value - a.value);

  const best = scored[0]!.s;
  // rebuild best's record aligned to the sweep shape
  const atBest = {
    threshold: best.threshold,
    precision: best.precision,
    recall: best.recall,
    f1: best.f1,
    tp: best.tp,
    fp: best.fp,
    fn: best.fn,
    tn: best.tn,
  };

  return {
    n,
    positives,
    objective,
    bestThreshold: best.threshold,
    atBest: {
      precision: best.precision,
      recall: best.recall,
      f1: best.f1,
      tp: best.tp,
      fp: best.fp,
      fn: best.fn,
      tn: best.tn,
    },
    brier: brierScore(predictions, outcomes),
    ece: ece(predictions, outcomes),
    rocAuc: rocAuc(predictions, outcomes),
    prAuc: prAuc(predictions, outcomes),
    // sweep sorted best-first by the chosen objective
    sweep: scored.map(({ s }) => ({
      threshold: s.threshold,
      precision: s.precision,
      recall: s.recall,
      f1: s.f1,
    })),
  };
}
