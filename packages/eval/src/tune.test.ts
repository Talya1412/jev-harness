import { describe, it, expect } from "vitest";
import { tune } from "../src/tune.js";

describe("tune", () => {
  it("finds a separating threshold with perfect F1", () => {
    const predictions = [0.05, 0.1, 0.9, 0.95];
    const outcomes = [false, false, true, true];
    const s = tune(predictions, outcomes, "f1");
    expect(s.atBest.f1).toBe(1);
    expect(s.atBest.precision).toBe(1);
    expect(s.atBest.recall).toBe(1);
    // a threshold between the two clusters
    expect(s.bestThreshold).toBeGreaterThanOrEqual(0.1);
    expect(s.bestThreshold).toBeLessThanOrEqual(0.9);
  });

  it("reports n, positives, and the ranking metrics", () => {
    const s = tune([0.1, 0.4, 0.35, 0.8], [false, false, true, true]);
    expect(s.n).toBe(4);
    expect(s.positives).toBe(2);
    expect(s.rocAuc).toBeCloseTo(0.75, 6);
    expect(s.prAuc).toBeCloseTo(0.83333, 4);
    expect(s.brier).toBeGreaterThan(0);
  });

  it("sorts the sweep best-first by the objective", () => {
    const s = tune([0.05, 0.95, 0.5, 0.5], [false, true, false, true]);
    for (let i = 1; i < s.sweep.length; i++) {
      expect(s.sweep[i - 1]!.f1).toBeGreaterThanOrEqual(s.sweep[i]!.f1);
    }
  });

  it("honours the youden objective", () => {
    // maximize TPR-FPR: with a single positive at 0.9 and negatives at 0.1,
    // any threshold in (0.1, 0.9] gives TPR=1, FPR=0 -> youden 1.
    const s = tune([0.1, 0.1, 0.9], [false, false, true], "youden");
    expect(s.bestThreshold).toBeGreaterThan(0.1);
    expect(s.bestThreshold).toBeLessThanOrEqual(0.9);
  });

  it("handles an all-one-class dataset without throwing", () => {
    const s = tune([0.2, 0.9], [true, true]);
    expect(s.n).toBe(2);
    expect(s.positives).toBe(2);
  });
});
