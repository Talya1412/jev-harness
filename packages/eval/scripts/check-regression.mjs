#!/usr/bin/env node
/**
 * Compare a fresh jev-eval report against the committed baseline and exit
 * non-zero on quality regressions. Used by .github/workflows/live-eval.yml;
 * runnable locally:
 *
 *   node packages/eval/dist/bin.js --dataset packages/eval/golden/destructive-gate.json --out report.json
 *   node packages/eval/scripts/check-regression.mjs report.json packages/eval/golden/destructive-gate.baseline.json
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

console.log(
  [
    `model             fresh=${report.model}  baseline=${baseline.model}`,
    `auc               fresh=${auc?.toFixed(4)}  baseline=${baseAuc.toFixed(4)}  (max drop ${MAX_AUC_DROP})`,
    `accuracy@${baseThreshold.toFixed(2)}  fresh=${accuracyAtBaseline.toFixed(4)}  baseline=${baseline.metrics.accuracy.toFixed(4)}  (max drop ${MAX_ACCURACY_DROP})`,
    `brier             fresh=${metric.noul.brier.toFixed(4)}  baseline=${baseline.metrics.brier.toFixed(4)}`,
  ].join("\n"),
);

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

if (failed) process.exit(1);
console.log("PASS: no calibration regression against baseline");
