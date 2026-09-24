# @jev-harness/mcp

MCP server (stdio) exposing TypeSafe's **Jev (System One)** decision model as
tools. Works with any MCP client: Claude Code, Cursor, Windsurf, Cline, Codex.

## Tools

| Tool                    | Backing core call         | Purpose                                                                   |
| ----------------------- | ------------------------- | ------------------------------------------------------------------------- |
| `jev_ask`               | `askJev`                  | Batch of typed noul / choice / score questions, returns raw `JevResponse` |
| `jev_models`            | `listJevModels`           | List models for the configured key                                        |
| `jev_route_skills`      | `routeSkill`              | Route a task to the best skill (or none)                                  |
| `jev_pick_tool`         | `pickTool`                | Pick the best tool + confirm-required flag                                |
| `jev_judge_destructive` | `judgeDestructive`        | Destructiveness judgment for a tool call                                  |
| `jev_browse_action`     | `chooseBrowserAction`     | Next browser operation from a page snapshot                               |
| `jev_rank`              | `rankCandidates`          | Rank candidate strings best-first                                         |
| `jev_classify`          | `withMapReduce`           | The same questions over a whole corpus, with an optional reduce           |
| `jev_escalate`          | `escalateOnLowConfidence` | Ask once, re-ask once when the gate says the answers are uncertain        |
| `jev_prune`             | `pruneContext`            | Non-destructive pruning: drops return replacement text                    |
| `jev_finding_realness`  | `findingRealness`         | Is a review finding real enough to report (and at what severity)?         |
| `jev_refute`            | `refutationFilter`        | Drop refuted findings conservatively — protected classes survive          |

Every handler catches all errors and returns `isError: true` with a readable
message — the server never dies because Jev is down (fail-open transport).
`jev_judge_destructive` errors mean "unknown", never "confirmed safe".

### `jev_classify` — a corpus in, one answer per item

The map-reduce workload: the **same** typed questions asked of every item.

```jsonc
{
  "items": ["log line 1", { "path": "src/a.ts", "diff": "..." }], // strings or JSON
  "questions": {
    "sev": {
      "type": "choice",
      "instructions": "how bad?",
      "criteria": { "low": "...", "high": "..." },
    },
  },
  "reduce": { "instructions": "summarize the verdicts", "criteria": ["calm", "incident"] }, // optional
  "concurrency": 4, // optional, default 4
}
```

Returns `{ perItem, reduced, failures, reduceSkipped, usage }`:

- `perItem` is index-aligned with `items` — one entry per item, `null` where
  that item failed.
- `reduced` is the answer to the one final question, or `null` (no `reduce`,
  or the reduce was skipped).
- `failures` names the failed indices with their message; the other answers
  still come back. A failure that says nothing about one item (missing key,
  401/403, 429, 5xx, network) still fails the whole call.
- The reduce never sees the corpus. It judges a **digest of the per-item
  verdicts — capped at 200 items and 4000 characters** (core's caps in
  `packages/core/src/infra.ts`, `MAX_REDUCE_ITEMS` / `MAX_REDUCE_CHARS`), so
  the reduce cost stays flat however large the corpus grows. Any item failure
  skips the reduce (`reduceSkipped` says why) because the digest would be
  incomplete.

**Cost**: one request per item, so `items × questions` worth of judgments —
batching is per item, not per corpus. Items are sent exactly as given;
objects are not stringified.

### `jev_escalate` — one pass, then at most one re-ask

```jsonc
{
  "state": { "topic": "release" },
  "questions": {
    "gate": {
      "type": "choice",
      "instructions": "confident?",
      "criteria": { "yes": "go", "stop": "hold" },
    },
    "ship": { "type": "noul", "instructions": "ship it?" },
  },
  "gateQuestionId": "gate",
  "threshold": 0.6, // optional, choice/score gates — default 0.6 (PROVISIONAL)
  "band": [0.3, 0.7], // optional, noul gates — default [0.3, 0.7] (PROVISIONAL)
  "secondModel": "jev-2", // optional: the model for the single escalation pass
}
```

Returns `{outcome, answers, first, second?, gateScore, threshold, target, escalated, error?}`:

- `accepted` — the gate was confident: **one request**, first answers stand.
- `escalated` — the gate was uncertain and the second pass ran: same
  questions, **no first answers passed** (an anchor-free second opinion);
  `answers` = `second` and `first` is always preserved.
- `unresolved` — nothing to act on; `error` says why (`gate-question-missing`,
  `no-escalation-target`, or the escalation-side failure) and `first` is still
  preserved.
- Both default bars — confidence `0.6`, band `[0.3, 0.7]` — are
  **PROVISIONAL** (vendor-cited, never locally measured). Tune `threshold` /
  `band` against your own outcomes before relying on them.
- `secondModel` resolves with the configured key; if it cannot be resolved the
  call proceeds with no second pass and `target` / `error` report that
  honestly.

### `jev_prune` — non-destructive context pruning

```jsonc
{
  "items": [{ "id": "log-1", "text": "...", "kind": "output" }], // kind: output | error | diagnostic
  "keepThreshold": 0.5, // optional, default 0.5
  "dropThreshold": 0.25, // optional, default 0.25
  "errorDropThreshold": 0.1, // optional, default 0.1
  "headChars": 300, // optional, default 300
  "minChars": 2000, // optional, default 2000
  "maxItemsPerRequest": 64, // optional, default 64
  "maxStateTokens": 25000, // optional, default 25000
}
```

**Contract: nothing is deleted.** The input is never edited; every drop
decision carries a `replacement` string (verbatim `headChars` + a provenance
note) and the **caller keeps the original text**. Returns
`{decisions, deferred, reason}`:

- `decisions` — index-aligned `{id, keep, score, chars, replacement?,
omittedChars?}`; `replacement` exists only on drops.
- `deferred: true` + `reason: "state-too-large"` — the size guard refused the
  pass before spending **any** request; every item reports keep.
- Missing/malformed answers **keep** — unjudged is never read as droppable.
- Default bars (keep `0.5`, drop `0.25`, error/diagnostic `0.1`) are MEASURED
  cross-repo; items shorter than `minChars` (2000) keep without a question.

### `jev_finding_realness` — is this finding real?

```jsonc
{ "finding": { "path": "src/a.ts", "content": "...", "severity": "low" }, "threshold": 0.5 } // threshold optional
```

One request, two questions (noul `realness` + choice `severity`). Returns
`{realness, report, severity, severityProvided}`:

- `report = realness >= threshold`; the **default 0.5 is PROVISIONAL**
  (upstream has no threshold at all) — calibrate on your own findings before
  relying on it.
- Unreadable realness → `realness: -1, report: false` (an unjudged marker,
  never a probability); severity stays untouched and `severityProvided`
  records whether you supplied one. The model's label passes through verbatim
  — never coerced to `"low"`.
- Caller `severity` / `category` are metadata only and are never sent (no
  anchoring).

### `jev_refute` — drop refuted findings, conservatively

```jsonc
{
  "findings": [{ "path": "src/a.ts", "content": "..." }],
  "evidence": "...",
  "refutedThreshold": 0.75,
} // both options optional
```

Returns `{refuted, kept, scores}`. The asymmetry is deliberate: drop **only**
when the refute score is `>= refutedThreshold` **and** the class is proven
non-protected — otherwise keep:

- Missing/malformed refute or class answers **keep** (unjudged is not a
  verdict).
- `memory-safety`, `concurrency`, `linkage`, `behavioural-change`,
  `unused-param` survive any score; only `ordinary` findings are droppable.
- **Default 0.75 is PROVISIONAL** and deliberately high — a false removal costs
  far more than a false keep; calibrate before lowering.
- Batched at 32 findings per request; `evidence` rides once at the top of the
  shared state.

## Install

```sh
npm install
npm run build --workspace @jev-harness/mcp
```

Set the key (never hardcoded, never logged):

```sh
export TYPESAFE_API_KEY=...
# optional:
# export TYPESAFE_BASE_URL=https://api.typesafe.ai
# export TYPESAFE_DEFAULT_MODEL=jev-latest
# export JEV_TIMEOUT_MS=15000
```

## Claude Code

```sh
claude mcp add jev-harness-mcp -e TYPESAFE_API_KEY=... -- node <repo>/packages/mcp/dist/index.js
```

## Cursor

Settings > MCP > New Global MCP Server (stdio command):

- Command: `node <repo>/packages/mcp/dist/index.js`
- Env: `TYPESAFE_API_KEY=...`

## Generic mcpServers JSON (Windsurf, Cline, Codex, ...)

```json
{
  "mcpServers": {
    "jev-harness": {
      "command": "node",
      "args": ["<repo>/packages/mcp/dist/index.js"],
      "env": { "TYPESAFE_API_KEY": "..." }
    }
  }
}
```
