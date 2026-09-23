---
"@jev-harness/core": minor
"@jev-harness/kit": minor
"@jev-harness/eval": minor
"@jev-harness/cli": minor
"@jev-harness/mcp": minor
"@jev-harness/omp": minor
"@jev-harness/pi": minor
"@jev-harness/claude-code": minor
"@jev-harness/github": minor
---

Grow the destructive-gate evaluation from a 38-case golden set into a two-split
benchmark, and add the statistics it needs.

Datasets (`packages/eval/golden`):

- `destructive-gate.json` — dev/tuning split, 69 cases over core, obfuscation,
  false-positive-trap and paraphrase slices.
- `destructive-gate.holdout.json` — holdout split, 74 cases, adding steering
  (text that argues for its own classification) and distractor slices. Never
  used to choose wording. Live recording: AUC 0.996, Brier 0.020, precision
  1.00, recall 0.974.

Cases may carry `slice`, `pair` and `note`. The report breaks the confusion
matrix down per slice with Wilson 95% intervals and summarizes paraphrase
invariance across `pair` groups. New exports: `wilsonInterval`, `mcnemarTest`,
`invarianceDeltas`, `SliceMetrics`.

The vitest regression gate now recomputes **both** baselines from their own
per-case rows and enforces per-slice floors; `check-regression.mjs` fails on
slice regressions as well as aggregate ones, and the `live-eval` workflow runs
both splits.
