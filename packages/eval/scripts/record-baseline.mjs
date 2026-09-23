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
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { askJev } from "@jev-harness/core";
import {
  binaryMetrics,
  estimateCostUsd,
  invarianceDeltas,
  INPUT_USD_PER_MTOK,
  loadDataset,
  reliabilityBins,
  thresholdSweep,
  wilsonInterval,
} from "@jev-harness/eval";

const [
  ,
  ,
  datasetPathArg = "packages/eval/golden/destructive-gate.json",
  questionIdArg = "destructive",
  outPathArg = "",
] = process.argv;
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
const bySlice = new Map();
const invCases = [];
let inputTokens = 0;
const cursor = { i: 0 };
// Gentle by default: the API sits behind Cloudflare, which answers a burst with
// a 403 challenge rather than a 429. Retry with backoff instead of losing a case.
const concurrency = Number(process.env.JEV_EVAL_CONCURRENCY ?? 3);
const maxAttempts = Number(process.env.JEV_EVAL_ATTEMPTS ?? 5);

async function askWithRetry(kase) {
  let last;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await askJev(config, kase.state, dataset.questions);
    } catch (err) {
      last = err;
      if (attempt === maxAttempts) break;
      await new Promise((r) => setTimeout(r, 500 * attempt * attempt));
    }
  }
  throw new Error(`case ${kase.id} failed after ${maxAttempts} attempts: ${last?.message ?? last}`);
}

await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (cursor.i < dataset.cases.length) {
      const kase = dataset.cases[cursor.i++];
      const res = await askWithRetry(kase);
      inputTokens += res.usage?.input_tokens ?? 0;
      const p = res.answers[questionId]?.noul;
      if (typeof p !== "number") throw new Error(`case ${kase.id}: no noul answer`);
      const label = kase.label[questionId];
      const y = label === true || label === "yes" || label === 1 ? 1 : 0;
      const slice = kase.slice ?? "core";
      pairs.push({ p, y });
      // slice/pair ride along so the committed baseline can be re-checked from
      // its own per-case rows (regression.test.ts recomputes, never trusts).
      perCase.push({ id: kase.id, p, y, slice, ...(kase.pair ? { pair: kase.pair } : {}) });
      bySlice.set(slice, [...(bySlice.get(slice) ?? []), { p, y }]);
      invCases.push({ id: kase.id, pair: kase.pair, p });
    }
  }),
);

// Operating threshold the adapters ship with — slice metrics are reported here.
const threshold = Number(process.env.JEV_EVAL_THRESHOLD ?? 0.5);

const m = binaryMetrics(pairs);
const atThreshold = binaryMetrics(pairs, threshold);
const sweep = thresholdSweep(pairs);

const slices = [...bySlice.entries()]
  .map(([slice, sp]) => {
    const sm = binaryMetrics(sp, threshold);
    const positives = sp.filter((x) => x.y === 1).length;
    return {
      slice,
      n: sm.n,
      positives,
      tp: sm.tp,
      fp: sm.fp,
      tn: sm.tn,
      fn: sm.fn,
      precision: sm.precision,
      recall: sm.recall,
      f1: sm.f1,
      auc: sm.auc,
      recallCi: positives > 0 ? wilsonInterval(sm.tp, positives) : null,
    };
  })
  .sort((a, b) => (a.slice < b.slice ? -1 : a.slice > b.slice ? 1 : 0));

const baseline = {
  dataset: datasetPathArg.replace(/\\/g, "/"),
  model,
  recordedAt: new Date().toISOString(),
  questionId,
  n: pairs.length,
  threshold,
  metrics: {
    accuracy: m.accuracy,
    precision: m.precision,
    recall: m.recall,
    f1: m.f1,
    brier: m.brier,
    auc: m.auc,
    suggestedThreshold: sweep.best.threshold,
  },
  operating: {
    tp: atThreshold.tp,
    fp: atThreshold.fp,
    tn: atThreshold.tn,
    fn: atThreshold.fn,
    precision: atThreshold.precision,
    recall: atThreshold.recall,
    accuracy: atThreshold.accuracy,
  },
  slices,
  invariance: invarianceDeltas(invCases, 0.2),
  sweep: sweep.rows.map((r) => ({ threshold: r.threshold, f1: r.f1, youdenJ: r.youdenJ })),
  reliability: reliabilityBins(pairs),
  // Concurrent pushes race, so sort by id: identical re-records must diff clean.
  perCase: perCase.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  inputTokens,
  inputUsdPerMtok: INPUT_USD_PER_MTOK,
  estimatedCostUsd: estimateCostUsd(inputTokens),
};

// A dataset with several questions needs one baseline per question, so the
// output path can be given explicitly; otherwise `<dataset>.baseline.json`.
const outPath = outPathArg
  ? resolve(repoRoot, outPathArg)
  : datasetPath.replace(/\.json$/, ".baseline.json");
writeFileSync(outPath, JSON.stringify(baseline, null, 2) + "\n", "utf8");

console.log("baseline written to", outPath);
console.log("metrics:", JSON.stringify(baseline.metrics));
console.log("n:", pairs.length, "costUsd:", baseline.estimatedCostUsd.toFixed(6));
