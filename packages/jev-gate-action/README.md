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
          destructive_threshold: "0.75" # block at P(destructive) >= 0.75
          secret_threshold: "0.6" # block at P(secret leak) >= 0.6
          fail_on_block: "false" # advisory by default
```

## Outputs

| output        | meaning                                       |
| ------------- | --------------------------------------------- |
| `destructive` | P(merging destroys data/history/system state) |
| `secret_leak` | P(diff embeds a real credential)              |
| `risk`        | probability-weighted risk score, 0–4          |
| `verdict`     | `block` or `pass`                             |

## Thresholds are starting points

0.75 / 0.6 are defaults, not ground truth. Record your own labeled baseline
with `@jev-harness/eval` (see `packages/eval/golden/`) and tune before
enabling `fail_on_block`.
