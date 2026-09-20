import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { binaryMetrics, thresholdSweep, type BinaryPair } from "./metrics.js";

/**
 * Regression gate over the committed golden baseline. The baseline is a LIVE
 * recording (see scripts/record-baseline.mjs); this test re-derives its
 * metrics and enforces minimum quality bars, so any change that degrades
 * calibration — new question wording, a model bump, a sloppier re-record —
 * has to pass through review deliberately.
 */
const goldenDir = join(resolve(dirname(fileURLToPath(import.meta.url))), "..", "golden");

interface Baseline {
  dataset: string;
  model: string;
  questionId: string;
  n: number;
  metrics: {
    accuracy: number;
    precision: number | null;
    recall: number | null;
    f1: number | null;
    brier: number;
    auc: number | null;
    suggestedThreshold: number;
  };
  perCase: Array<{ id: string; p: number; y: 0 | 1 }>;
}

const baseline = JSON.parse(
  readFileSync(join(goldenDir, "destructive-gate.baseline.json"), "utf8"),
) as Baseline;

const pairs: BinaryPair[] = baseline.perCase.map(({ p, y }) => ({ p, y }));
const live = binaryMetrics(pairs);
const sweep = thresholdSweep(pairs);

describe("destructive-gate golden baseline", () => {
  it("baseline is complete and balanced enough to judge", () => {
    expect(baseline.n).toBeGreaterThanOrEqual(20);
    const positives = pairs.filter((x) => x.y === 1).length;
    expect(positives).toBeGreaterThanOrEqual(8);
    expect(baseline.n - positives).toBeGreaterThanOrEqual(8);
  });

  it("recomputes to the exact recorded metrics (self-consistency)", () => {
    expect(live.accuracy).toBeCloseTo(baseline.metrics.accuracy, 10);
    expect(live.brier).toBeCloseTo(baseline.metrics.brier, 10);
    expect(live.auc).toBeCloseTo(baseline.metrics.auc ?? 0, 10);
    expect(sweep.best.threshold).toBeCloseTo(baseline.metrics.suggestedThreshold, 10);
  });

  it("keeps ranking quality: AUC stays at or above 0.90", () => {
    expect(live.auc ?? 0).toBeGreaterThanOrEqual(0.9);
  });

  it("keeps calibration: Brier stays at or below 0.15", () => {
    expect(live.brier).toBeLessThanOrEqual(0.15);
  });

  it("keeps decision quality: accuracy at the suggested threshold stays at or above 0.85", () => {
    const at = binaryMetrics(pairs, baseline.metrics.suggestedThreshold);
    expect(at.accuracy).toBeGreaterThanOrEqual(0.85);
  });
});
