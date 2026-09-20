#!/usr/bin/env node
/**
 * Record a live calibration baseline for a golden dataset.
 *
 *   TYPESAFE_API_KEY=... node packages/eval/scripts/record-baseline.mjs \
 *     packages/eval/golden/destructive-gate.json destructive
 *
 * Writes `<dataset>.baseline.json` next to the dataset: per-case
 * probabilities, aggregate metrics, and the suggested threshold. Commit the
 * result — packages/eval/src/regression.test.ts and the live-eval workflow
 * both treat it as the reference point.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { askJev } from "@jev-harness/core";
import {
  binaryMetrics,
  estimateCostUsd,
  INPUT_USD_PER_MTOK,
  loadDataset,
  reliabilityBins,
  thresholdSweep,
} from "@jev-harness/eval";

const [, , datasetPathArg = "packages/eval/golden/destructive-gate.json", questionIdArg = "destructive"] = process.argv;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const datasetPath = resolve(repoRoot, datasetPathArg);

function loadKey() {
  if (process.env.TYPESAFE_API_KEY && process.env.TYPESAFE_API_KEY.trim() !== "") {
    return process.env.TYPESAFE_API_KEY.trim();
  }
  throw new Error("TYPESAFE_API_KEY is not set. Export it or pass it through the environment.");
}

const model = process.env.JEV_EVAL_MODEL ?? "jev-latest";
const config = { apiKey: loadKey(), model };
const dataset = loadDataset(datasetPath);
const questionId = questionIdArg;
const question = dataset.questions[questionId];
if (!question) {
  throw new Error(`dataset ${datasetPathArg} has no question "${questionId}"`);
}
if (question.type !== "noul") {
  throw new Error(`this script records noul baselines; "${questionId}" is ${question.type}`);
}

const pairs = [];
const perCase = [];
let inputTokens = 0;
const cursor = { i: 0 };
const concurrency = 6;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (cursor.i < dataset.cases.length) {
      const kase = dataset.cases[cursor.i++];
      const res = await askJev(config, kase.state, dataset.questions);
      inputTokens += res.usage?.input_tokens ?? 0;
      const p = res.answers[questionId]?.noul;
      if (typeof p !== "number") throw new Error(`case ${kase.id}: no noul answer`);
      const label = kase.label[questionId];
      const y = label === true || label === "yes" || label === 1 ? 1 : 0;
      pairs.push({ p, y });
      perCase.push({ id: kase.id, p, y });
    }
  }),
);

const m = binaryMetrics(pairs);
const sweep = thresholdSweep(pairs);

const baseline = {
  dataset: datasetPathArg.replace(/\\/g, "/"),
  model,
  recordedAt: new Date().toISOString(),
  questionId,
  n: pairs.length,
  metrics: {
    accuracy: m.accuracy,
    precision: m.precision,
    recall: m.recall,
    f1: m.f1,
    brier: m.brier,
    auc: m.auc,
    suggestedThreshold: sweep.best.threshold,
  },
  sweep: sweep.rows.map((r) => ({ threshold: r.threshold, f1: r.f1, youdenJ: r.youdenJ })),
  reliability: reliabilityBins(pairs),
  // Concurrent pushes race, so sort by id: identical re-records must diff clean.
  perCase: perCase.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  inputTokens,
  inputUsdPerMtok: INPUT_USD_PER_MTOK,
  estimatedCostUsd: estimateCostUsd(inputTokens),
};

const outPath = datasetPath.replace(/\.json$/, ".baseline.json");
writeFileSync(outPath, JSON.stringify(baseline, null, 2) + "\n", "utf8");

console.log("baseline written to", outPath);
console.log("metrics:", JSON.stringify(baseline.metrics));
console.log("n:", pairs.length, "costUsd:", baseline.estimatedCostUsd.toFixed(6));
