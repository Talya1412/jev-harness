# @jev-harness/eval

Evaluation and calibration toolkit for **[TypeSafe Jev](https://typesafe.ai)** —
the System One decision model. The README of `@jev-harness/core` says it
plainly: *calibration is not correctness, so validate on your own labeled
data*. This package is the tooling for that validation: run a labeled
dataset through your questions and get accuracy, calibration, and a
recommended threshold per question.

## Install

```bash
npm install @jev-harness/eval
```

## Quick start (CLI)

```bash
export TYPESAFE_API_KEY=...
jev-eval --dataset cases.jsonl --out report.json
```

Example output:

```
Jev eval — 24 cases, model jev-latest, 2026-09-20T10:00:00.000Z
  requests 24  input tokens 3120  output tokens 0  est. cost $0.000131

touches_auth (noul, 24 scored)
  accuracy 91.7%  precision 90.0%  recall 94.7%  f1 92.3%
  brier 0.0612  auc 0.972  ece 0.0380
  suggested threshold (max F1): 0.55  (f1 92.3%, youdenJ 0.842)
  reliability: [0.0–0.1) n=3 avgP=0.04 avgY=0.00 | [0.8–0.9) n=5 avgP=0.84 avgY=0.80 | [0.9–1.0) n=14 avgP=0.96 avgY=1.00
```

`est. cost` uses Jev's input pricing ($0.042/Mtok); output tokens are free.

## Dataset format

**JSONL** — one case per line, optionally carrying a shared `questions` map:

```jsonl
{"questions": {"touches_auth": {"type": "noul", "instructions": "Does this change affect authentication or session security?"}}, "state": {"diff": "changed login redirect"}, "label": {"touches_auth": true}}
{"state": {"diff": "bumped a dev dependency"}, "label": {"touches_auth": false}}
```

**JSON** — one object:

```json
{
  "questions": { "risk": { "type": "score", "instructions": "Risk level", "criteria": ["None", "Low", "Moderate", "High", "Critical"] } },
  "cases": [ { "id": "c1", "state": { "diff": "..." }, "label": { "risk": "High" } } ]
}
```

A bare array of cases works too — pair it with `--questions questions.json`.

**Labels** are plain values, coerced per question type:

| Type | Accepts |
|---|---|
| `noul` | `true`/`false`, `"yes"`/`"no"`, `0`/`1` |
| `choice` | the criteria key as a string |
| `score` | the level name, or its 0-based index |

Cases with a missing or non-coercible label are skipped (counted, not fatal).

## What you get per question

| Type | Metrics |
|---|---|
| `noul` | accuracy, precision, recall, F1 at your threshold, Brier, rank AUC, ECE, reliability diagram, and a **threshold sweep** with the max-F1 (Youden tiebreak) recommendation |
| `choice` | top-1 accuracy, multiclass Brier, calibration of `confidence` against being right |
| `score` | MAE in level units, within-1 rate, Pearson correlation with the label |

The suggested threshold is a starting point from *your* data — keep final
thresholds and side effects in your code, and prefer a threshold that
matches the cost asymmetry of your workflow (a destructive-gate veto and a
skill hint should not share one).

## Programmatic use

```ts
import { loadDataset, runEval, formatReport } from "@jev-harness/eval";

const dataset = loadDataset("cases.jsonl");
const report = await runEval({ apiKey: process.env.TYPESAFE_API_KEY! }, dataset, { concurrency: 4 });
console.log(formatReport(report));
```

## CLI options

| Flag | Default | Purpose |
|---|---|---|
| `--dataset <path>` | (required) | JSON or JSONL dataset |
| `--questions <path>` | — | Question map JSON, merged under per-line questions |
| `--out <path>` | — | Also write the full report as JSON |
| `--model <name>` | `jev-latest` | Pin the model under test |
| `--base-url <url>` | `https://api.typesafe.ai` | API override |
| `--timeout-ms <n>` | `15000` | Per-request timeout |
| `--concurrency <n>` | `4` | Cases in flight |
| `--no-sweep` | off | Skip the noul threshold sweep |
| `--sweep-steps <n>` | `20` | Sweep resolution |

Failing cases never abort the run: they are listed in the report. The CLI
exits 0 with the report; a missing key or unreadable dataset exits non-zero.

## CI usage

Run the golden set on PRs that touch question wording, thresholds, or the
model pin, and diff the report — calibration drift shows up as a changed
suggested threshold or rising ECE before your users notice.

## License

Apache-2.0.
