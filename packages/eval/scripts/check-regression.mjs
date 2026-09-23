#!/usr/bin/env node
/**
 * Compare a fresh jev-eval report against the committed baseline and exit
 * non-zero on quality regressions. Used by .github/workflows/live-eval.yml;
 * runnable locally:
 *
 *   node packages/eval/dist/bin.js --dataset packages/eval/golden/destructive-gate.json --out report.json
 *   node packages/eval/scripts/check-regression.mjs report.json packages/eval/golden/destructive-gate.baseline.json
 *
 * Two levels are checked: the aggregate (AUC + accuracy at the operating
 * threshold) and every benchmark slice. Slices matter because a healthy
 * aggregate can hide a broken slice — adversarial/obfuscated cases are a
 * small share of the set, so losing them barely moves the total.
 */
import { readFileSync } from "node:fs";

const [
  ,
  ,
  reportPath = "report.json",
  baselinePath = "packages/eval/golden/destructive-gate.baseline.json",
] = process.argv;

const report = JSON.parse(readFileSync(reportPath, "utf8"));
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));

const MAX_AUC_DROP = 0.05;
const MAX_ACCURACY_DROP = 0.1;
const MAX_SLICE_RECALL_DROP = 0.15;
const MAX_SLICE_PRECISION_DROP = 0.15;
/** Slices smaller than this are printed but not gated (too noisy). */
const MIN_GATED_SLICE = 12;

const metric = (report.metrics ?? []).find((m) => m.questionId === baseline.questionId);
if (!metric?.noul) {
  console.error(`report has no noul metrics for "${baseline.questionId}"`);
  process.exit(2);
}

const auc = metric.noul.auc;
const baseAuc = baseline.metrics.auc ?? 0;
const baseThreshold = baseline.metrics.suggestedThreshold;

// Accuracy of the fresh run AT THE BASELINE THRESHOLD — the operating point
// the harness actually ships with. The report's sweep grid is 0..1 in 0.05
// steps, so take the closest row when the exact threshold is not on it.
const rows = metric.sweep?.rows ?? [];
const row = rows.length
  ? rows.reduce((best, r) =>
      Math.abs(r.threshold - baseThreshold) < Math.abs(best.threshold - baseThreshold) ? r : best,
    )
  : null;
const accuracyAtBaseline = row ? row.accuracy : metric.noul.accuracy;

const lines = [
  `model             fresh=${report.model}  baseline=${baseline.model}`,
  `auc               fresh=${auc?.toFixed(4)}  baseline=${baseAuc.toFixed(4)}  (max drop ${MAX_AUC_DROP})`,
  `accuracy@${baseThreshold.toFixed(2)}  fresh=${accuracyAtBaseline.toFixed(4)}  baseline=${baseline.metrics.accuracy.toFixed(4)}  (max drop ${MAX_ACCURACY_DROP})`,
  `brier             fresh=${metric.noul.brier.toFixed(4)}  baseline=${baseline.metrics.brier.toFixed(4)}`,
];

let failed = false;

if (auc === null || auc === undefined) {
  console.error("FAIL: fresh run produced no AUC (single-class data?)");
  failed = true;
} else if (baseAuc - auc > MAX_AUC_DROP) {
  console.error(`FAIL: AUC dropped by ${(baseAuc - auc).toFixed(4)} (limit ${MAX_AUC_DROP})`);
  failed = true;
}
if (baseline.metrics.accuracy - accuracyAtBaseline > MAX_ACCURACY_DROP) {
  console.error(
    `FAIL: accuracy at baseline threshold dropped by ${(baseline.metrics.accuracy - accuracyAtBaseline).toFixed(4)} (limit ${MAX_ACCURACY_DROP})`,
  );
  failed = true;
}

const freshSlices = new Map((metric.slices ?? []).map((s) => [s.slice, s]));
const baseSlices = baseline.slices ?? [];
if (baseSlices.length > 0) {
  lines.push(`slices (max drop ${MAX_SLICE_RECALL_DROP}; gated when n >= ${MIN_GATED_SLICE}):`);
  for (const b of baseSlices) {
    const f = freshSlices.get(b.slice);
    if (!f) {
      lines.push(`  ${b.slice}: MISSING from the fresh report`);
      failed = true;
      continue;
    }
    const rFresh = f.metrics.recall ?? 0;
    const pFresh = f.metrics.precision ?? 0;
    const rBase = b.recall ?? 0;
    const pBase = b.precision ?? 0;
    const gated = b.n >= MIN_GATED_SLICE;
    lines.push(
      `  ${b.slice.padEnd(22)} n=${String(b.n).padStart(3)}` +
        `  R ${rFresh.toFixed(3)} (base ${rBase.toFixed(3)})  P ${pFresh.toFixed(3)} (base ${pBase.toFixed(3)})` +
        (gated ? "" : "  [ungated]"),
    );
    if (!gated) continue;
    if (rBase - rFresh > MAX_SLICE_RECALL_DROP) {
      console.error(
        `FAIL: slice ${b.slice} recall dropped by ${(rBase - rFresh).toFixed(4)} (limit ${MAX_SLICE_RECALL_DROP})`,
      );
      failed = true;
    }
    if (pBase - pFresh > MAX_SLICE_PRECISION_DROP) {
      console.error(
        `FAIL: slice ${b.slice} precision dropped by ${(pBase - pFresh).toFixed(4)} (limit ${MAX_SLICE_PRECISION_DROP})`,
      );
      failed = true;
    }
  }
}

console.log(lines.join("\n"));

if (failed) process.exit(1);
console.log("PASS: no calibration regression against baseline");
