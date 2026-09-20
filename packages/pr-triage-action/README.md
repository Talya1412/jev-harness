# @jev-harness/pr-triage-action

A GitHub Action that runs **[TypeSafe Jev](https://typesafe.ai)** (the System
One decision model) on every pull request — the exact example from the
root README, shipped as a reusable action.

One batched Jev call per PR asks three independent questions against the
diff:

| Question | Type | Returns |
|---|---|---|
| Does this change affect authentication or session security? | `noul` | probability 0–1 |
| Security and correctness risk of merging as-is | `score` | 0–4 (None → Critical) |
| Who should review this? | `choice` | `auto` \| `peer` \| `security` |

Output lands in action outputs, the job summary, a single upserted PR
comment (never spam — one comment, updated), and optional `jev:*` labels.

## Safety model

- **Fail-open.** No `TYPESAFE_API_KEY`, a non-PR event, or a Jev outage
  skips triage with a `::notice::` instead of blocking the PR. Set
  `strict: "true"` to invert this for repos that want a hard gate.
- **Advisory.** Labels and comments never block merges on their own — wire
  the `route` output into your branch protection or a separate gate job if
  you want enforcement.

## Usage

```yaml
name: PR triage
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  issues: write        # comment + labels go through the issues API
  pull-requests: write

jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Talya1412/jev-harness/packages/pr-triage-action@master
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
        env:
          TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}
```

This repo dogfoods the same action via
[`.github/workflows/pr-triage.yml`](../../.github/workflows/pr-triage.yml).
Without `TYPESAFE_API_KEY` the run is a no-op with a notice — safe to leave
enabled.

## Inputs

| Input | Default | Purpose |
|---|---|---|
| `github_token` | `${{ github.token }}` | Token for diff/comment/labels |
| `comment` | `"true"` | Upsert the triage comment |
| `labels` | `"true"` | Apply `jev:*` labels |
| `auth_label_threshold` | `"0.7"` | `jev:auth` at/above this probability |
| `risk_label_threshold` | `"4"` | `jev:risk-high` at/above this score |
| `max_diff_chars` | `"60000"` | Diff characters sent to Jev (larger diffs are truncated) |
| `strict` | `"false"` | Fail the job when triage cannot run |

## Outputs

| Output | Meaning |
|---|---|
| `touches_auth` | Probability the change touches auth/session security |
| `risk` | Probability-weighted risk score (0–4) |
| `route` | `auto` \| `peer` \| `security` |
| `route_confidence` | Confidence of the route choice |
| `comment_url` | URL of the upserted comment |

## Calibration

The defaults are starting points, not ground truth. Label a few dozen of
your own PRs and run [`@jev-harness/eval`](../eval) to pick thresholds that
match your risk asymmetry before trusting the labels.

## Layout

- `action.yml` — action manifest (node20).
- `src/main.ts` — implementation; bundled with `@jev-harness/core` inlined
  into `dist/index.js` (committed, no runtime deps).
- `scripts/bundle.mjs` — esbuild bundling step.

## License

Apache-2.0.
