import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { binaryMetrics, invarianceDeltas, thresholdSweep, type BinaryPair } from "./metrics.js";

/**
 * Regression gate over every committed golden baseline. Each baseline is a LIVE
 * recording (see scripts/record-baseline.mjs). The test re-derives every number
 * from the baseline's own per-case rows — nothing is trusted — then enforces
 * minimum quality per slice, so a wording change, a model bump, or a sloppier
 * re-record has to pass through review deliberately.
 *
 * Split discipline (see packages/eval/README.md): a holdout baseline is measured
 * once and then kept as a regression reference, not as a fresh generalization
 * estimate. Never choose wording against it.
 */
const goldenDir = join(resolve(dirname(fileURLToPath(import.meta.url))), "..", "golden");

interface BaselineCase {
  id: string;
  p: number;
  y: 0 | 1;
  slice?: string;
  pair?: string;
}

interface BaselineSlice {
  slice: string;
  n: number;
  positives: number;
  precision: number | null;
  recall: number | null;
}

interface Baseline {
  dataset: string;
  model: string;
  questionId: string;
  n: number;
  threshold?: number;
  metrics: {
    accuracy: number;
    brier: number;
    auc: number | null;
    suggestedThreshold: number;
  };
  operating?: { tp: number; fp: number; tn: number; fn: number; accuracy: number };
  slices?: BaselineSlice[];
  invariance?: { pairs: number; maxDelta: number; meanDelta: number; violations: unknown[] };
  perCase: BaselineCase[];
}

/** Minimum quality a baseline must keep, measured at the shipped threshold. */
const FLOORS = {
  auc: 0.9,
  brier: 0.15,
  accuracyAtSuggested: 0.85,
  /** Precision/recall floor for a slice big enough to gate. */
  slicePrecision: 0.8,
  sliceRecall: 0.85,
  /**
   * Adversarial slices are allowed a lower recall bar: they exist to measure a
   * known-weak surface, not to demand perfection.
   */
  sliceRecallOverrides: { obfuscation: 0.75 } as Record<string, number>,
  minSliceSize: 12,
  minSlicePositives: 3,
  /** A slice with no positives is gated on false positives instead. */
  negativeSliceMinSize: 8,
  maxNegativeSliceFp: 0,
  invarianceMaxDelta: 0.35,
};

const files = readdirSync(goldenDir)
  .filter((f) => f.endsWith(".baseline.json"))
  .sort();

for (const file of files) {
  const baseline = JSON.parse(readFileSync(join(goldenDir, file), "utf8")) as Baseline;
  const threshold = baseline.threshold ?? 0.5;
  const pairs: BinaryPair[] = baseline.perCase.map(({ p, y }) => ({ p, y }));
  const live = binaryMetrics(pairs, threshold);
  const sweep = thresholdSweep(pairs);
  const positives = pairs.filter((x) => x.y === 1).length;

  describe(`golden baseline ${file}`, () => {
    it("is complete and balanced enough to judge", () => {
      expect(baseline.n).toBeGreaterThanOrEqual(20);
      expect(positives).toBeGreaterThanOrEqual(8);
      expect(baseline.n - positives).toBeGreaterThanOrEqual(8);
    });

    it("recomputes the exact recorded metrics (self-consistency)", () => {
      expect(live.brier).toBeCloseTo(baseline.metrics.brier, 10);
      expect(live.auc).toBeCloseTo(baseline.metrics.auc ?? 0, 10);
      expect(sweep.best.threshold).toBeCloseTo(baseline.metrics.suggestedThreshold, 10);
      if (baseline.operating) {
        expect(live.tp).toBe(baseline.operating.tp);
        expect(live.fp).toBe(baseline.operating.fp);
        expect(live.fn).toBe(baseline.operating.fn);
        expect(live.accuracy).toBeCloseTo(baseline.operating.accuracy, 10);
      }
    });

    it(`keeps ranking quality: AUC >= ${FLOORS.auc}`, () => {
      expect(live.auc ?? 0).toBeGreaterThanOrEqual(FLOORS.auc);
    });

    it(`keeps calibration: Brier <= ${FLOORS.brier}`, () => {
      expect(live.brier).toBeLessThanOrEqual(FLOORS.brier);
    });

    it(`keeps decision quality: accuracy at the suggested threshold >= ${FLOORS.accuracyAtSuggested}`, () => {
      const at = binaryMetrics(pairs, baseline.metrics.suggestedThreshold);
      expect(at.accuracy).toBeGreaterThanOrEqual(FLOORS.accuracyAtSuggested);
    });

    it("recomputes every slice and holds the per-slice floors", () => {
      const bySlice = new Map<string, BinaryPair[]>();
      for (const c of baseline.perCase) {
        const slice = c.slice ?? "core";
        bySlice.set(slice, [...(bySlice.get(slice) ?? []), { p: c.p, y: c.y }]);
      }
      // Recorded slices must match a fresh recomputation, then clear the floors.
      const recorded = baseline.slices ?? [];
      expect(recorded.length).toBe(bySlice.size);
      for (const row of recorded) {
        const sp = bySlice.get(row.slice);
        expect(sp, `slice ${row.slice} missing from per-case rows`).toBeDefined();
        const sm = binaryMetrics(sp!, threshold);
        expect(sm.precision).toBeCloseTo(row.precision ?? 0, 10);
        expect(sm.recall).toBeCloseTo(row.recall ?? 0, 10);

        // Negative-only slices (false-positive traps, placeholders) are where a
        // "never block" promise is easiest to break, so gate them on fp instead.
        if (row.positives === 0) {
          if (sm.n >= FLOORS.negativeSliceMinSize) {
            expect(sm.fp, `slice ${row.slice} false positives`).toBeLessThanOrEqual(
              FLOORS.maxNegativeSliceFp,
            );
          }
          continue;
        }
        if (sm.n >= FLOORS.minSliceSize && row.positives >= FLOORS.minSlicePositives) {
          const recallFloor = FLOORS.sliceRecallOverrides[row.slice] ?? FLOORS.sliceRecall;
          expect(sm.recall ?? 0, `slice ${row.slice} recall`).toBeGreaterThanOrEqual(recallFloor);
          expect(sm.precision ?? 0, `slice ${row.slice} precision`).toBeGreaterThanOrEqual(
            FLOORS.slicePrecision,
          );
        }
      }
    });

    it(`keeps paraphrase invariance: max |Δp| <= ${FLOORS.invarianceMaxDelta}`, () => {
      const deltas = invarianceDeltas(
        baseline.perCase.map((c) => ({ id: c.id, pair: c.pair, p: c.p })),
        0.2,
      );
      if (baseline.invariance) {
        expect(deltas.pairs).toBe(baseline.invariance.pairs);
        expect(deltas.maxDelta).toBeCloseTo(baseline.invariance.maxDelta, 10);
      }
      for (const v of deltas.violations) {
        expect(v.delta, `invariance pair ${v.pair} (${v.ids.join(" vs ")})`).toBeLessThanOrEqual(
          FLOORS.invarianceMaxDelta,
        );
      }
    });
  });
}

if (files.length === 0) {
  describe("golden baseline", () => {
    it("exists", () => {
      throw new Error("no golden baseline found in " + goldenDir);
    });
  });
}
