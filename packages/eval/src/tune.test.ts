import { describe, it, expect } from "vitest";
import { tune } from "../src/tune.js";
import type { BinaryPair } from "../src/metrics.js";

function pairs(...rows: Array<[number, boolean]>): BinaryPair[] {
  return rows.map(([p, y]) => ({ p, y: y ? (1 as const) : (0 as const) }));
}

describe("tune", () => {
  it("finds a separating threshold with perfect F1", () => {
    const s = tune(pairs([0.05, false], [0.1, false], [0.9, true], [0.95, true]), "f1");
    expect(s.atBest.f1).toBe(1);
    expect(s.atBest.precision).toBe(1);
    expect(s.atBest.recall).toBe(1);
    // a threshold between the two clusters
    expect(s.bestThreshold).toBeGreaterThanOrEqual(0.1);
    expect(s.bestThreshold).toBeLessThanOrEqual(0.9);
  });

  it("reports n, positives, and the ranking metrics", () => {
    const s = tune(pairs([0.1, false], [0.4, false], [0.35, true], [0.8, true]));
    expect(s.n).toBe(4);
    expect(s.positives).toBe(2);
    expect(s.rocAuc).toBeCloseTo(0.75, 6);
    expect(s.prAuc).toBeCloseTo(0.83333, 4);
    expect(s.brier).toBeGreaterThan(0);
  });

  it("sorts the sweep best-first by the objective", () => {
    const s = tune(pairs([0.05, false], [0.95, true], [0.5, false], [0.5, true]));
    for (let i = 1; i < s.sweep.length; i++) {
      expect(s.sweep[i - 1]!.f1 ?? -1).toBeGreaterThanOrEqual(s.sweep[i]!.f1 ?? -1);
    }
  });

  it("honours the youden objective", () => {
    // maximize TPR-FPR: with a single positive at 0.9 and negatives at 0.1,
    // any threshold in (0.1, 0.9] gives TPR=1, FPR=0 -> youden 1.
    const s = tune(pairs([0.1, false], [0.1, false], [0.9, true]), "youden");
    expect(s.bestThreshold).toBeGreaterThan(0.1);
    expect(s.bestThreshold).toBeLessThanOrEqual(0.9);
  });

  it("handles an all-one-class dataset without throwing", () => {
    const s = tune(pairs([0.2, true], [0.9, true]));
    expect(s.n).toBe(2);
    expect(s.positives).toBe(2);
    expect(s.rocAuc).toBeNull();
    expect(s.prAuc).toBeCloseTo(1, 6);
  });

  it("handles an empty dataset without throwing", () => {
    const s = tune([]);
    expect(s.n).toBe(0);
    expect(s.bestThreshold).toBe(0.5);
    expect(s.rocAuc).toBeNull();
  });
});
