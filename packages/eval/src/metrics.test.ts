import { describe, it, expect } from "vitest";
import {
  binaryMetrics,
  ece,
  reliabilityBins,
  thresholdSweep,
  choiceMetrics,
  scoreMetrics,
  pearsonCorr,
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
