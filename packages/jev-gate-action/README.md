# @jev-harness/jev-gate-action

Semantic acceptance gate for pull requests, powered by [TypeSafe Jev](https://typesafe.ai).

One batched Jev call judges the PR diff on three signals:

- **destructive** — merging would destroy data, history, or system state
- **secret_leak** — the diff embeds a real credential
- **risk** — 0–4 severity if the change is wrong after merge

The default posture is **advisory**: outputs + a job summary. Set
`fail_on_block: "true"` to turn a `block` verdict into a failing check.

Fail-open by design: a missing `TYPESAFE_API_KEY`, a non-PR event, or a Jev
outage skips the gate with a notice instead of blocking the PR. `strict:
"true"` inverts that.

## Usage

```yaml
name: gate
on: [pull_request]
jobs:
  jev-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: Talya1412/jev-harness/packages/jev-gate-action@master
        env:
          TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}
        with:
          destructive_threshold: "0.12" # block at P(destructive) >= 0.12
          secret_threshold: "0.07" # block at P(secret leak) >= 0.07
          fail_on_block: "false" # advisory by default
```

## Outputs

| output        | meaning                                       |
| ------------- | --------------------------------------------- |
| `destructive` | P(merging destroys data/history/system state) |
| `secret_leak` | P(diff embeds a real credential)              |
| `risk`        | probability-weighted risk score, 0–4          |
| `verdict`     | `block` or `pass`                             |

## Where the defaults come from

Both thresholds are measured on [`packages/eval/golden/merge-gate.json`](../eval/golden/merge-gate.json)
— 41 labeled PR diffs (12 destructive, 8 real-credential, 21 benign/placeholder) — and each sits mid-gap between
the highest-scoring benign diff and the lowest-scoring one it must catch:

| question      | default | precision | recall | at the previous default |
| ------------- | ------- | --------- | ------ | ----------------------- |
| `destructive` | 0.12    | 1.00      | 0.92   | 0.75 → recall 0.42      |
| `secret_leak` | 0.07    | 1.00      | 1.00   | 0.60 → recall 0.50      |

Mid-gap, not the edge of the plateau: re-recording moves individual
probabilities by ~0.01, so the distance to the nearest benign diff is what keeps
the default stable.

Reproduce with `node packages/eval/scripts/record-baseline.mjs packages/eval/golden/merge-gate.json destructive packages/eval/golden/merge-gate.destructive.baseline.json`;
CI's vitest gate re-checks both baselines on every run.

## Thresholds are starting points

The numbers above come from 41 diffs in one repository's style. Treat them as a
starting point, not ground truth: record your own labeled baseline with
`@jev-harness/eval` and re-tune before enabling `fail_on_block`.

Two things worth knowing before you give this gate the power to block:

- **Precision is what earns the right to block.** Secret detection is
  false-positive-prone everywhere (published evaluations put Gitleaks at ~46%
  precision); start advisory, watch what it flags, and only then set
  `fail_on_block: "true"`.
- **Do the non-negotiables in code.** A `DROP TABLE`, a deleted namespace, or a
  removed backup job is a rule, not a judgment. Deterministic checks catch those
  with no model in the path; Jev is the extra pair of eyes on the diffs that do
  not fit a pattern. `destructive` is advisory for exactly that reason — it is a
  high-recall first pass, not a replacement for policy.
