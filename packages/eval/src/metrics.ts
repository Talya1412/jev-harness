/**
 * Pure evaluation metrics for @jev-harness/eval — no Jev calls, no I/O.
 *
 * Calibration is not correctness: a structurally valid answer can still be
 * wrong. These metrics quantify both, so thresholds get tuned on labeled
 * data instead of vibes.
 */

export interface BinaryPair {
  /** Jev probability of "yes". */
  p: number;
  /** Ground truth, 0 or 1. */
  y: 0 | 1;
}

export interface BinaryMetrics {
  n: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  accuracy: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  /** Mean squared error of the probability against the 0/1 label. */
  brier: number;
  /** Rank-based AUC (Mann–Whitney). null when only one class is present. */
  auc: number | null;
}

export function binaryMetrics(pairs: BinaryPair[], threshold = 0.5): BinaryMetrics {
  const n = pairs.length;
  if (n === 0) {
    return {
      n: 0,
      tp: 0,
      fp: 0,
      tn: 0,
      fn: 0,
      accuracy: 0,
      precision: null,
      recall: null,
      f1: null,
      brier: 0,
      auc: null,
    };
  }
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let brier = 0;
  for (const { p, y } of pairs) {
    const pred = p >= threshold ? 1 : 0;
    if (y === 1 && pred === 1) tp++;
    else if (y === 1 && pred === 0) fn++;
    else if (y === 0 && pred === 1) fp++;
    else tn++;
    brier += (p - y) * (p - y);
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;
  return {
    n,
    tp,
    fp,
    tn,
    fn,
    accuracy: (tp + tn) / n,
    precision,
    recall,
    f1,
    brier: brier / n,
    auc: aucRank(pairs),
  };
}

/** AUC via average ranks with tie handling. */
function aucRank(pairs: BinaryPair[]): number | null {
  const pos = pairs.filter((x) => x.y === 1).length;
  const neg = pairs.length - pos;
  if (pos === 0 || neg === 0) return null;
  const sorted = [...pairs].sort((a, b) => a.p - b.p);
  let i = 0;
  let rankSumPos = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1]!.p === sorted[i]!.p) j++;
    const avgRank = (i + j + 2) / 2; // 1-indexed average rank of the tie group
    for (let k = i; k <= j; k++) if (sorted[k]!.y === 1) rankSumPos += avgRank;
    i = j + 1;
  }
  return (rankSumPos - (pos * (pos + 1)) / 2) / (pos * neg);
}

export interface ReliabilityBin {
  lo: number;
  hi: number;
  count: number;
  avgP: number;
  avgY: number;
}

/** Reliability diagram data: observed frequency per probability bin. */
export function reliabilityBins(pairs: BinaryPair[], bins = 10): ReliabilityBin[] {
  const out: ReliabilityBin[] = [];
  for (let b = 0; b < bins; b++) {
    const lo = b / bins;
    const hi = (b + 1) / bins;
    const inBin = pairs.filter(({ p }) => (b < bins - 1 ? p >= lo && p < hi : p >= lo && p <= hi));
    const count = inBin.length;
    out.push({
      lo,
      hi,
      count,
      avgP: count ? inBin.reduce((s, x) => s + x.p, 0) / count : 0,
      avgY: count ? inBin.reduce((s, x) => s + x.y, 0) / count : 0,
    });
  }
  return out;
}

/** Expected Calibration Error: weighted |avgP − avgY| across bins. 0 is perfect. */
export function ece(pairs: BinaryPair[], bins = 10): number {
  if (pairs.length === 0) return 0;
  return reliabilityBins(pairs, bins).reduce(
    (s, b) => s + (b.count / pairs.length) * Math.abs(b.avgP - b.avgY),
    0,
  );
}

/**
 * PR AUC as average precision: sum of precision-at-hit over positives,
 * divided by the positive count. null when there are no positives.
 */
export function prAuc(pairs: BinaryPair[]): number | null {
  const pos = pairs.filter((x) => x.y === 1).length;
  if (pos === 0) return null;
  const sorted = [...pairs].sort((a, b) => b.p - a.p);
  let tp = 0;
  let fp = 0;
  let ap = 0;
  for (const { y } of sorted) {
    if (y === 1) {
      tp++;
      ap += tp / (tp + fp);
    } else {
      fp++;
    }
  }
  return ap / pos;
}

export interface SweepRow {
  threshold: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  accuracy: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  /** Youden's J = recall − FPR. */
  youdenJ: number;
}

/**
 * Sweep candidate thresholds for a noul question and recommend the one with
 * the best F1 (ties broken by Youden's J). This is how "tuned threshold
 * 0.75" statements should be produced: from labeled data, not folklore.
 */
export function thresholdSweep(
  pairs: BinaryPair[],
  opts: { steps?: number } = {},
): { rows: SweepRow[]; best: SweepRow } {
  const steps = Math.max(1, opts.steps ?? 20);
  const rows: SweepRow[] = [];
  for (let i = 0; i <= steps; i++) {
    const threshold = i / steps;
    const m = binaryMetrics(pairs, threshold);
    const fpr = m.fp + m.tn > 0 ? m.fp / (m.fp + m.tn) : 0;
    rows.push({
      threshold,
      tp: m.tp,
      fp: m.fp,
      tn: m.tn,
      fn: m.fn,
      accuracy: m.accuracy,
      precision: m.precision,
      recall: m.recall,
      f1: m.f1,
      youdenJ: (m.recall ?? 0) - fpr,
    });
  }
  let best = rows[0]!;
  for (const row of rows) {
    const bf = best.f1 ?? -1;
    const rf = row.f1 ?? -1;
    if (rf > bf || (rf === bf && row.youdenJ > best.youdenJ)) best = row;
  }
  return { rows, best };
}

export interface ChoiceRow {
  probabilities: Record<string, number>;
  /** The option Jev picked. */
  picked: string;
  /** The labeled correct option. */
  truth: string;
}

export interface ChoiceMetrics {
  n: number;
  /** Fraction of cases where the winner equals the label. */
  top1: number;
  /** Multiclass Brier score (sum of squared errors over options, averaged). */
  brier: number;
  /** Calibration of `confidence` (max probability) against being right. */
  confidenceEce: number;
}

export function choiceMetrics(rows: ChoiceRow[]): ChoiceMetrics {
  const n = rows.length;
  if (n === 0) return { n: 0, top1: 0, brier: 0, confidenceEce: 0 };
  let correct = 0;
  let brier = 0;
  const conf: BinaryPair[] = [];
  for (const row of rows) {
    const hit = row.picked === row.truth;
    if (hit) correct++;
    const keys = new Set([...Object.keys(row.probabilities), row.truth]);
    for (const k of keys) {
      const diff = (row.probabilities[k] ?? 0) - (k === row.truth ? 1 : 0);
      brier += diff * diff;
    }
    conf.push({ p: row.probabilities[row.picked] ?? 0, y: hit ? 1 : 0 });
  }
  return { n, top1: correct / n, brier: brier / n, confidenceEce: ece(conf) };
}

export interface ScoreRow {
  /** Probability-weighted score Jev returned. */
  score: number;
  /** Labeled level index (0-based into the criteria array). */
  truthIndex: number;
  /** Highest valid level index. */
  maxIndex: number;
}

export interface ScoreMetrics {
  n: number;
  /** Mean absolute error in level units. */
  mae: number;
  /** Fraction within one level of the label. */
  withinOne: number;
  /** Pearson correlation with the label; null when variance is zero. */
  pearson: number | null;
}

export function scoreMetrics(rows: ScoreRow[]): ScoreMetrics {
  const n = rows.length;
  if (n === 0) return { n: 0, mae: 0, withinOne: 0, pearson: null };
  let mae = 0;
  let within = 0;
  for (const row of rows) {
    const d = Math.abs(row.score - row.truthIndex);
    mae += d;
    if (d <= 1 + 1e-9) within++;
  }
  return {
    n,
    mae: mae / n,
    withinOne: within / n,
    pearson: pearsonCorr(
      rows.map((r) => r.score),
      rows.map((r) => r.truthIndex),
    ),
  };
}

export function pearsonCorr(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]!;
    sy += ys[i]!;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

// ---------------------------------------------------------------------------
// Small-sample uncertainty and paired comparison.
//
// Benchmarks here are small (tens to low hundreds of cases), so a point
// estimate hides whether two runs actually differ. Report a Wilson score
// interval for proportions — it keeps its coverage near 0/1 and with small n,
// where the Wald interval does not — and compare two systems on the SAME cases
// with McNemar's exact test, which only looks at the cases where they disagree.
// ---------------------------------------------------------------------------

export interface Interval {
  lo: number;
  hi: number;
}

/** Wilson score interval for a binomial proportion (default 95%). */
export function wilsonInterval(successes: number, n: number, z = 1.96): Interval {
  if (!(n > 0)) return { lo: 0, hi: 1 };
  const phat = successes / n;
  const denom = 1 + (z * z) / n;
  const center = (phat + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((phat * (1 - phat)) / n + (z * z) / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

export interface McNemarResult {
  /** Cases only A got right. */
  aOnly: number;
  /** Cases only B got right. */
  bOnly: number;
  /** Exact two-sided p-value over the discordant pairs (null when none). */
  p: number | null;
}

/** Sum of binomial pmf terms C(n,i)/2^n for i in [0, kMax] — overflow-safe. */
function binomTail(n: number, kMax: number): number {
  let sum = 0;
  let term = Math.pow(0.5, n);
  sum += term;
  for (let i = 1; i <= kMax; i++) {
    term = (term * (n - i + 1)) / i;
    sum += term;
  }
  return sum;
}

/** Exact McNemar test over paired correctness outcomes. */
export function mcnemarTest(pairs: Array<{ a: boolean; b: boolean }>): McNemarResult {
  let aOnly = 0;
  let bOnly = 0;
  for (const { a, b } of pairs) {
    if (a && !b) aOnly++;
    else if (!a && b) bOnly++;
  }
  const n = aOnly + bOnly;
  if (n === 0) return { aOnly, bOnly, p: null };
  const p = Math.min(1, 2 * binomTail(n, Math.min(aOnly, bOnly)));
  return { aOnly, bOnly, p };
}

export interface PairDelta {
  pair: string;
  ids: string[];
  /** Absolute difference between the probabilities of the two members. */
  delta: number;
}

export interface InvarianceReport {
  pairs: number;
  /** Largest |Δp| across all pairs. */
  maxDelta: number;
  meanDelta: number;
  /** Pairs whose |Δp| exceeds the tolerance. */
  violations: PairDelta[];
}

/**
 * Invariance check: cases sharing a `pair` id describe the same action in
 * different words, so their probabilities should be close. Reports the deltas
 * instead of asserting equality — the model is documented as *roughly* stable,
 * not invariant — and CI gates a loose ceiling on it.
 */
export function invarianceDeltas(
  cases: Array<{ id: string; pair?: string; p: number }>,
  tolerance = 0.2,
): InvarianceReport {
  const groups = new Map<string, Array<{ id: string; p: number }>>();
  for (const c of cases) {
    if (!c.pair) continue;
    groups.set(c.pair, [...(groups.get(c.pair) ?? []), { id: c.id, p: c.p }]);
  }
  const violations: PairDelta[] = [];
  let maxDelta = 0;
  let sum = 0;
  let count = 0;
  for (const [pair, members] of groups) {
    if (members.length < 2) continue;
    const ps = members.map((m) => m.p);
    const delta = Math.max(...ps) - Math.min(...ps);
    maxDelta = Math.max(maxDelta, delta);
    sum += delta;
    count++;
    if (delta > tolerance) violations.push({ pair, ids: members.map((m) => m.id), delta });
  }
  return {
    pairs: count,
    maxDelta: count ? maxDelta : 0,
    meanDelta: count ? sum / count : 0,
    violations: violations.sort((a, b) => b.delta - a.delta),
  };
}
