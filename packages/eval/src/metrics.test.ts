import { describe, it, expect } from "vitest";
import {
  brierScore,
  ece,
  confusionMatrix,
  precisionRecallF1,
  rocAuc,
  prAuc,
} from "../src/metrics.js";

describe("brierScore", () => {
  it("is 0 for perfect predictions", () => {
    expect(brierScore([1, 0, 1, 0], [true, false, true, false])).toBe(0);
  });

  it("is 0.25 for constant 0.5 with a 50/50 split", () => {
    expect(brierScore([0.5, 0.5], [true, false])).toBeCloseTo(0.25, 10);
  });

  it("returns 0 on empty input without throwing", () => {
    expect(brierScore([], [])).toBe(0);
  });

  it("truncates to the shorter array", () => {
    expect(brierScore([1, 1, 1], [true])).toBe(0);
  });
});

describe("ece", () => {
  it("is 0 for a perfectly calibrated constant-0.5 set", () => {
    expect(ece([0.5, 0.5, 0.5, 0.5], [true, false, true, false], 10)).toBeCloseTo(0, 10);
  });

  it("penalizes an over-confident wrong set", () => {
    // all predicted 0.9, half actually true -> confidence 0.9 vs accuracy 0.5
    const e = ece([0.9, 0.9], [true, false], 10);
    expect(e).toBeGreaterThan(0.3);
  });

  it("is 0 on empty input", () => {
    expect(ece([], [])).toBe(0);
  });
});

describe("confusionMatrix", () => {
  it("counts tp/fp/fn/tn at a threshold", () => {
    const cm = confusionMatrix([0.9, 0.8, 0.1, 0.2], [true, true, false, false], 0.5);
    expect(cm).toEqual({ tp: 2, fp: 0, fn: 0, tn: 2 });
  });

  it("counts false positives when the threshold is low", () => {
    const cm = confusionMatrix([0.2, 0.3, 0.9], [false, false, true], 0.15);
    expect(cm).toEqual({ tp: 1, fp: 2, fn: 0, tn: 0 });
  });
});

describe("precisionRecallF1", () => {
  it("is 1/1/1 for a perfect matrix", () => {
    const r = precisionRecallF1({ tp: 4, fp: 0, fn: 0, tn: 4 });
    expect(r).toEqual({ precision: 1, recall: 1, f1: 1 });
  });

  it("is zero-safe when there are no positive predictions", () => {
    const r = precisionRecallF1({ tp: 0, fp: 0, fn: 3, tn: 1 });
    expect(r).toEqual({ precision: 0, recall: 0, f1: 0 });
  });
});

describe("rocAuc", () => {
  it("ranks separable classes above chance", () => {
    expect(rocAuc([0.1, 0.4, 0.35, 0.8], [false, false, true, true])).toBeCloseTo(0.75, 6);
  });

  it("is 1 for perfectly separable classes", () => {
    expect(rocAuc([0.1, 0.9], [false, true])).toBeCloseTo(1, 6);
  });

  it("returns 0.5 when one class is absent", () => {
    expect(rocAuc([0.1, 0.9], [false, false])).toBe(0.5);
    expect(rocAuc([0.1, 0.9], [true, true])).toBe(0.5);
  });

  it("handles ties with average ranks", () => {
    // two positives and two negatives all at 0.5 -> no separation -> 0.5
    expect(rocAuc([0.5, 0.5, 0.5, 0.5], [true, false, true, false])).toBeCloseTo(0.5, 6);
  });
});

describe("prAuc", () => {
  it("computes average precision for a separable case", () => {
    expect(prAuc([0.1, 0.4, 0.35, 0.8], [false, false, true, true])).toBeCloseTo(0.83333, 4);
  });

  it("is 1 for perfectly separable positives-on-top", () => {
    expect(prAuc([0.9, 0.8, 0.1, 0.2], [true, true, false, false])).toBeCloseTo(1, 6);
  });

  it("is 0 when there are no positives", () => {
    expect(prAuc([0.9, 0.1], [false, false])).toBe(0);
  });
});
