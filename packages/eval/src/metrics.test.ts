import { describe, it, expect } from "vitest";
import {
  binaryMetrics,
  ece,
  invarianceDeltas,
  mcnemarTest,
  reliabilityBins,
  thresholdSweep,
  choiceMetrics,
  scoreMetrics,
  pearsonCorr,
  wilsonInterval,
} from "../src/metrics.js";

const clean = [
  { p: 0.9, y: 1 as const },
  { p: 0.2, y: 0 as const },
  { p: 0.6, y: 1 as const },
  { p: 0.3, y: 0 as const },
];

describe("binaryMetrics", () => {
  it("computes confusion, accuracy, f1, brier and auc", () => {
    const m = binaryMetrics(clean, 0.5);
    expect(m).toMatchObject({
      n: 4,
      tp: 2,
      fp: 0,
      tn: 2,
      fn: 0,
      accuracy: 1,
      precision: 1,
      recall: 1,
    });
    expect(m.f1).toBe(1);
    expect(m.brier).toBeCloseTo(0.075, 10);
    expect(m.auc).toBe(1);
  });

  it("applies the threshold", () => {
    const m = binaryMetrics(clean, 0.7);
    expect(m).toMatchObject({ tp: 1, fp: 0, tn: 2, fn: 1, accuracy: 0.75 });
    expect(m.precision).toBe(1);
    expect(m.recall).toBe(0.5);
    expect(m.f1).toBeCloseTo(2 / 3, 10);
  });

  it("returns null auc when only one class is present", () => {
    expect(binaryMetrics([{ p: 0.9, y: 1 }]).auc).toBeNull();
  });

  it("ranks a pessimistic model at auc 0", () => {
    expect(
      binaryMetrics([
        { p: 0.8, y: 0 },
        { p: 0.4, y: 1 },
      ]).auc,
    ).toBe(0);
  });

  it("handles ties with average ranks", () => {
    // pos 0.5, neg 0.5 → one tie → auc 0.5
    expect(
      binaryMetrics([
        { p: 0.5, y: 1 },
        { p: 0.5, y: 0 },
      ]).auc,
    ).toBe(0.5);
  });
});

describe("ece + reliabilityBins", () => {
  it("measures calibration error per bin", () => {
    const pairs = [
      { p: 0.8, y: 1 as const },
      { p: 0.8, y: 0 as const },
      { p: 0.8, y: 1 as const },
      { p: 0.8, y: 0 as const },
    ];
    const bins = reliabilityBins(pairs);
    const bin = bins.find((b) => b.count > 0)!;
    expect(bin.lo).toBeCloseTo(0.8);
    expect(bin.avgP).toBeCloseTo(0.8);
    expect(bin.avgY).toBeCloseTo(0.5);
    expect(ece(pairs)).toBeCloseTo(0.3, 10);
  });
});

describe("thresholdSweep", () => {
  it("recommends a threshold that separates the classes", () => {
    const { rows, best } = thresholdSweep(clean, { steps: 20 });
    expect(rows).toHaveLength(21);
    expect(best.f1).toBe(1);
    expect(best.threshold).toBeGreaterThanOrEqual(0.25);
    expect(best.threshold).toBeLessThanOrEqual(0.9);
  });

  it("breaks f1 ties by Youden's J", () => {
    // Every threshold in (0.3, 0.6] has f1=1; the highest threshold in that
    // range has the best J (lowest FPR at the same recall).
    const pairs = [
      { p: 0.9, y: 1 as const },
      { p: 0.4, y: 0 as const },
    ];
    const { best } = thresholdSweep(pairs, { steps: 20 });
    expect(best.threshold).toBeGreaterThanOrEqual(0.45);
    expect(best.threshold).toBeLessThanOrEqual(0.6);
  });
});

describe("choiceMetrics", () => {
  it("scores top-1, multiclass brier and confidence calibration", () => {
    const m = choiceMetrics([
      { probabilities: { a: 0.8, b: 0.2 }, picked: "a", truth: "a" },
      { probabilities: { a: 0.6, b: 0.4 }, picked: "a", truth: "b" },
    ]);
    expect(m.n).toBe(2);
    expect(m.top1).toBe(0.5);
    expect(m.brier).toBeCloseTo(0.4, 10);
    expect(m.confidenceEce).toBeCloseTo(0.4, 10);
  });
});

describe("scoreMetrics", () => {
  it("scores ordinal error and correlation", () => {
    const m = scoreMetrics([
      { score: 1.2, truthIndex: 1, maxIndex: 4 },
      { score: 2.8, truthIndex: 3, maxIndex: 4 },
      { score: 0.5, truthIndex: 0, maxIndex: 4 },
    ]);
    expect(m.mae).toBeCloseTo(0.3, 10);
    expect(m.withinOne).toBe(1);
    expect(m.pearson!).toBeGreaterThan(0.99);
  });
});

describe("pearsonCorr", () => {
  it("returns null with zero variance", () => {
    expect(pearsonCorr([1, 1, 1], [1, 2, 3])).toBeNull();
  });

  it("is 1 for a perfect line", () => {
    expect(pearsonCorr([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
  });
});

describe("wilsonInterval", () => {
  it("stays inside [0, 1] and brackets the estimate", () => {
    const ci = wilsonInterval(9, 10);
    expect(ci.lo).toBeGreaterThan(0.5);
    expect(ci.lo).toBeLessThan(0.9);
    expect(ci.hi).toBeGreaterThan(0.9);
    expect(ci.hi).toBeLessThanOrEqual(1);
  });

  it("is wide for a tiny sample", () => {
    const ci = wilsonInterval(2, 2);
    expect(ci.lo).toBeLessThan(0.5);
    expect(ci.hi).toBe(1);
  });

  it("degenerates to [0, 1] with no observations", () => {
    expect(wilsonInterval(0, 0)).toEqual({ lo: 0, hi: 1 });
  });
});

describe("mcnemarTest", () => {
  it("returns null p when the systems never disagree", () => {
    const r = mcnemarTest([
      { a: true, b: true },
      { a: false, b: false },
    ]);
    expect(r.aOnly).toBe(0);
    expect(r.bOnly).toBe(0);
    expect(r.p).toBeNull();
  });

  it("is significant when one system wins every disagreement", () => {
    // 8 discordant pairs, all won by A: two-sided exact p = 2 * 2^-8.
    const pairs = Array.from({ length: 8 }, () => ({ a: true, b: false }));
    const r = mcnemarTest(pairs);
    expect(r.aOnly).toBe(8);
    expect(r.p!).toBeCloseTo(0.0078125, 10);
  });

  it("is not significant on an even split", () => {
    const pairs = [
      { a: true, b: false },
      { a: false, b: true },
    ];
    expect(mcnemarTest(pairs).p!).toBeCloseTo(1, 10);
  });
});

describe("invarianceDeltas", () => {
  it("groups by pair and reports the largest delta", () => {
    const r = invarianceDeltas([
      { id: "a1", pair: "p", p: 0.9 },
      { id: "a2", pair: "p", p: 0.8 },
      { id: "b1", pair: "q", p: 0.2 },
      { id: "b2", pair: "q", p: 0.21 },
    ]);
    expect(r.pairs).toBe(2);
    expect(r.maxDelta).toBeCloseTo(0.1, 10);
    expect(r.violations).toHaveLength(0);
  });

  it("flags pairs beyond the tolerance", () => {
    const r = invarianceDeltas(
      [
        { id: "a1", pair: "p", p: 0.95 },
        { id: "a2", pair: "p", p: 0.4 },
      ],
      0.2,
    );
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]!.pair).toBe("p");
    expect(r.violations[0]!.delta).toBeCloseTo(0.55, 10);
  });

  it("ignores singleton pairs and unpaired cases", () => {
    const r = invarianceDeltas([
      { id: "a", pair: "solo", p: 0.9 },
      { id: "b", p: 0.1 },
    ]);
    expect(r.pairs).toBe(0);
    expect(r.maxDelta).toBe(0);
  });
});
