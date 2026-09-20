import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { binaryMetrics, ece, prAuc } from "./metrics.js";
import { tune } from "./tune.js";
import type { BinaryPair } from "./metrics.js";

/**
 * Cross-language parity: the same fixture is asserted by this test (TS) and
 * by packages/jev-py/tests/test_parity.py (Python). Both must reproduce the
 * embedded expected values to within tolerance, so metric drift on either
 * side fails CI.
 */
const fixturePath = join(resolve(dirname(fileURLToPath(import.meta.url))), "..", "golden", "parity-metrics.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  pairs: Array<{ p: number; y: 0 | 1 }>;
  threshold: number;
  tolerance: number;
  expected: {
    brier: number;
    auc: number | null;
    accuracy: number;
    confusion: { tp: number; fp: number; tn: number; fn: number };
    precision: number | null;
    recall: number | null;
    f1: number | null;
    ece: number;
    prAuc: number | null;
    tuneBestThreshold: number;
    tuneBestF1: number | null;
    tuneSweepLength: number;
  };
};

const pairs: BinaryPair[] = fixture.pairs.map(({ p, y }) => ({ p, y }));
const tol = fixture.tolerance;
const m = binaryMetrics(pairs, fixture.threshold);
const t = tune(pairs);

describe("TS metrics reproduce the shared parity fixture", () => {
  it("brier", () => expect(Math.abs(m.brier - fixture.expected.brier)).toBeLessThanOrEqual(tol));
  it("auc (tie-safe Mann-Whitney)", () => expect(Math.abs((m.auc ?? 0) - fixture.expected.auc!)).toBeLessThanOrEqual(tol));
  it("accuracy", () => expect(Math.abs(m.accuracy - fixture.expected.accuracy)).toBeLessThanOrEqual(tol));
  it("confusion counts", () => {
    expect(m.tp).toBe(fixture.expected.confusion.tp);
    expect(m.fp).toBe(fixture.expected.confusion.fp);
    expect(m.tn).toBe(fixture.expected.confusion.tn);
    expect(m.fn).toBe(fixture.expected.confusion.fn);
  });
  it("precision/recall/f1", () => {
    expect(Math.abs((m.precision ?? 0) - fixture.expected.precision!)).toBeLessThanOrEqual(tol);
    expect(Math.abs((m.recall ?? 0) - fixture.expected.recall!)).toBeLessThanOrEqual(tol);
    expect(Math.abs((m.f1 ?? 0) - fixture.expected.f1!)).toBeLessThanOrEqual(tol);
  });
  it("ece (binned calibration)", () => expect(Math.abs(ece(pairs, fixture.bins) - fixture.expected.ece)).toBeLessThanOrEqual(tol));
  it("prAuc (average precision)", () => expect(Math.abs((prAuc(pairs) ?? 0) - fixture.expected.prAuc!)).toBeLessThanOrEqual(tol));
  it("tune: best threshold, best f1, sweep length", () => {
    expect(Math.abs(t.bestThreshold - fixture.expected.tuneBestThreshold)).toBeLessThanOrEqual(tol);
    expect(Math.abs((t.atBest.f1 ?? 0) - fixture.expected.tuneBestF1!)).toBeLessThanOrEqual(tol);
    expect(t.sweep).toHaveLength(fixture.expected.tuneSweepLength);
  });
});
