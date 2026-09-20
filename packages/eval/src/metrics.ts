/**
 * Calibration and ranking metrics for Jev decisions.
 *
 * Jev emits calibrated probabilities, but calibration is not correctness, and
 * thresholds are tuned in production — never validated. These functions close
 * that loop: given predicted probabilities and labeled boolean outcomes from
 * YOUR data, measure how good the decisions were and pick thresholds that
 * survive contact with reality.
 *
 * Pure by design: no Jev calls, no I/O, no globals. Every function takes
 * arrays of numbers and booleans and returns numbers or plain objects.
 */

export interface ConfusionMatrix {
  /** predicted 1, actual 1 */
  tp: number;
  /** predicted 1, actual 0 */
  fp: number;
  /** predicted 0, actual 1 */
  fn: number;
  /** predicted 0, actual 0 */
  tn: number;
}

export interface PrMetrics {
  precision: number;
  recall: number;
  f1: number;
}

/**
 * Mean squared error of the probability against the 0/1 outcome. The standard
 * scalar score for probabilistic predictions; lower is better, 0 is perfect.
 */
export function brierScore(predictions: number[], outcomes: boolean[]): number {
  const n = Math.min(predictions.length, outcomes.length);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const y = outcomes[i] ? 1 : 0;
    const d = predictions[i]! - y;
    sum += d * d;
  }
  return sum / n;
}

/**
 * Expected Calibration Error. Bins predictions into equal-width buckets and
 * sums |avg_confidence - observed_positive_rate| weighted by bin size. A
 * well-calibrated Jev should have a low ECE on representative data.
 */
export function ece(predictions: number[], outcomes: boolean[], bins = 10): number {
  const n = Math.min(predictions.length, outcomes.length);
  if (n === 0) return 0;
  const edges = Array.from({ length: bins + 1 }, (_, i) => i / bins);
  const binConf = new Array<number>(bins).fill(0);
  const binAcc = new Array<number>(bins).fill(0);
  const binCount = new Array<number>(bins).fill(0);
  for (let i = 0; i < n; i++) {
    const p = predictions[i]!;
    // the last bin is inclusive of 1.0
    let idx = Math.floor(p * bins);
    if (idx >= bins) idx = bins - 1;
    if (idx < 0) idx = 0;
    binConf[idx]! += p;
    binAcc[idx]! += outcomes[i] ? 1 : 0;
    binCount[idx]! += 1;
  }
  let total = 0;
  for (let b = 0; b < bins; b++) {
    const c = binCount[b]!;
    if (c === 0) continue;
    total += (c / n) * Math.abs(binConf[b]! / c - binAcc[b]! / c);
  }
  return total;
}

/** Build the 2x2 confusion matrix at a threshold (predict 1 when p >= t). */
export function confusionMatrix(predictions: number[], outcomes: boolean[], threshold: number): ConfusionMatrix {
  const n = Math.min(predictions.length, outcomes.length);
  const cm: ConfusionMatrix = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (let i = 0; i < n; i++) {
    const predicted = predictions[i]! >= threshold;
    const actual = outcomes[i];
    if (predicted && actual) cm.tp++;
    else if (predicted && !actual) cm.fp++;
    else if (!predicted && actual) cm.fn++;
    else cm.tn++;
  }
  return cm;
}

/** Precision, recall, and F1 from a confusion matrix. Zero-safe. */
export function precisionRecallF1(cm: ConfusionMatrix): PrMetrics {
  const precision = cm.tp + cm.fp === 0 ? 0 : cm.tp / (cm.tp + cm.fp);
  const recall = cm.tp + cm.fn === 0 ? 0 : cm.tp / (cm.tp + cm.fn);
  const denom = precision + recall;
  const f1 = denom === 0 ? 0 : (2 * precision * recall) / denom;
  return { precision, recall, f1 };
}

/**
 * ROC AUC via average ranks (Mann-Whitney U). Robust to ties. Returns 0.5 when
 * one class is absent (no discriminative power can be measured).
 */
export function rocAuc(predictions: number[], outcomes: boolean[]): number {
  const n = Math.min(predictions.length, outcomes.length);
  const pos = outcomes.slice(0, n).filter(Boolean).length;
  const neg = n - pos;
  if (pos === 0 || neg === 0) return 0.5;

  // ascending sort so rank 1 is the smallest prediction
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => predictions[a]! - predictions[b]!);
  const ranks = new Array<number>(n).fill(0);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n && predictions[order[j]!]! === predictions[order[i]!]!) j++;
    // average of 1-based ranks i+1 .. j
    const avg = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) ranks[order[k]!] = avg;
    i = j;
  }
  let sumPosRanks = 0;
  for (let k = 0; k < n; k++) if (outcomes[k]) sumPosRanks += ranks[k]!;
  return (sumPosRanks - (pos * (pos + 1)) / 2) / (pos * neg);
}

/**
 * Average precision — the area under the precision-recall curve. Better than
 * ROC AUC on imbalanced data, which is the common case for Jev gates (few
 * destructive calls, few injections). 1 is perfect.
 */
export function prAuc(predictions: number[], outcomes: boolean[]): number {
  const n = Math.min(predictions.length, outcomes.length);
  const totalPos = outcomes.slice(0, n).filter(Boolean).length;
  if (totalPos === 0) return 0;

  // descending by prediction, stable on ties
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => predictions[b]! - predictions[a]!);
  let hits = 0;
  let ap = 0;
  for (let rank = 0; rank < n; rank++) {
    if (outcomes[order[rank]!]) {
      hits++;
      ap += hits / (rank + 1);
    }
  }
  return ap / totalPos;
}
