# @jev-harness/eval

Calibration and threshold-tuning metrics for [TypeSafe Jev](https://typesafe.ai) decisions, plus the `jev-tune` CLI.

Jev emits calibrated probabilities, but **calibration is not correctness**, and thresholds are tuned in production — never validated. This package closes that loop: given predicted probabilities and labeled boolean outcomes from *your* data, measure how good the decisions were and pick thresholds that survive contact with reality.

Pure by design: no Jev calls, no I/O, no globals in the library layer. The CLI reads a labeled dataset and prints a report.

## Install

```bash
npm install @jev-harness/eval
```

## Metrics

| Function | Returns | Notes |
|---|---|---|
| `brierScore(predictions, outcomes)` | `number` | Mean squared error vs 0/1 outcome. 0 is perfect. |
| `ece(predictions, outcomes, bins?)` | `number` | Expected Calibration Error. Lower is better. |
| `confusionMatrix(predictions, outcomes, threshold)` | `{tp,fp,fn,tn}` | Predict 1 when `p >= threshold`. |
| `precisionRecallF1(cm)` | `{precision, recall, f1}` | Zero-safe. |
| `rocAuc(predictions, outcomes)` | `number` | Rank-based (Mann-Whitney), tie-safe. 0.5 = chance. |
| `prAuc(predictions, outcomes)` | `number` | Average precision. Better than ROC AUC on imbalanced data. |
| `tune(predictions, outcomes, objective?)` | `TuneSummary` | Sweep thresholds; `"f1"` (default) or `"youden"`. |

```ts
import { tune } from "@jev-harness/eval";

const s = tune(
  [0.05, 0.1, 0.9, 0.95, 0.5, 0.5],
  [false, false, true, true, false, true],
  "f1",
);
// s.bestThreshold, s.atBest.f1, s.brier, s.ece, s.rocAuc, s.prAuc, s.sweep[]
```

## `jev-tune` CLI

```bash
cat labels.jsonl | npx jev-tune
jev-tune -f eval.jsonl --json
jev-tune -o youden < destructive-labels.jsonl
```

Dataset formats:

- **JSONL** — one object per line: `{"p": 0.82, "y": true}`
- **JSON array** — `[{"p":0.2,"y":false}, {"p":0.9,"y":true}]`

Keys are forgiving: probability is `p` | `prediction` | `prob` | `probability` | `score`; outcome is `y` | `outcome` | `label` | `actual` | `target` (boolean or `0`/`1`).

### Options

```
-f, --file <path>      Read the dataset from a file (default: stdin)
-o, --objective <o>    'f1' (default) or 'youden' (TPR-FPR)
    --json              Print the summary as JSON
-h, --help            Show help
```

### Example output

```
jev-tune  threshold sweep

data      n=6  positives=3  (50.0%)
objective f1  ->  best threshold = 0.600

at best   precision=1.000  recall=1.000  f1=1.000
          tp=3  fp=0  fn=0  tn=3

calibration
  brier   0.0725    (lower is better; 0 is perfect)
  ece     0.2000    (lower is better)
  rocAuc  1.0000    (0.5 = chance, 1 = perfect ranking)
  prAuc   1.0000    (better than ROC AUC on imbalanced data)

top thresholds (best-first)
  t=0.600  f1=1.000  p=1.000  r=1.000
  ...
```

## License

Apache-2.0.
