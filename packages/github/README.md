# @jev-harness/github

A GitHub Action that runs a [TypeSafe Jev](https://typesafe.ai)-driven pull-request review: it composes three core patterns — `judgeDestructive`, `triageUrgency`, and `routeSkill` (used to pick a reviewer) — into one **advisory** PR comment.

**Fail-open by design.** A missing API key, a Jev outage, or a missing `gh` never fails the workflow — the comment is still posted (or printed) so the PR is never blocked. The only authoritative gate remains the destructive veto in `@jev-harness/core`; this action surfaces it, it does not enforce it.

## Use

```yaml
# .github/workflows/jev-review.yml
name: jev-review
on:
  pull_request:
    types: [opened, synchronize]
jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: Talya1412/jev-harness/packages/github@master
        env:
          TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          PR_TITLE: ${{ github.event.pull_request.title }}
          PR_BODY: ${{ github.event.pull_request.body }}
```

## Inputs

| Input | Required | Default | Purpose |
|---|---|---|---|
| `typesafe-api-key` | no | — | Jev API key. Unset → fail-open comment, no Jev call. |
| `pr-number` | no | event number | PR to comment on. |
| `pr-title` / `pr-body` | no | event values | PR title and body. |
| `pr-diff` | no | `git diff origin/HEAD...` | Diff text to judge. |
| `reviewers` | no | auto/peer/security/perf | JSON array of `{name, description}`. |
| `post` | no | `true` | `false` to only print the comment. |
| `destructive-threshold` | no | `0.75` | Override the destructive-block threshold. |

## Output

A comment like:

```markdown
## Jev review

> Advisory only. Jev emits calibrated probabilities; thresholds and side effects stay in your workflow.

| decision | result |
| --- | --- |
| destructive | BLOCKED (p=0.90) |
| urgency | Critical (3.10) |
| reviewer | security (conf=0.85) |

**PR:** rewrite auth
```

When a Jev call fails, the header becomes `## Jev review (degraded)`, unavailable rows show `_unavailable_`, and the errors are folded under a `<details>` block — but the comment is still posted.

## Programmatic use

The review logic is exported for non-Action callers:

```ts
import { runReview, DEFAULT_REVIEWERS } from "@jev-harness/github";

const { comment, decisions, degraded } = await runReview(
  { apiKey: process.env.TYPESAFE_API_KEY! },
  { title: "rewrite auth", body: "...", diff: "..." },
);
```

## License

Apache-2.0.
