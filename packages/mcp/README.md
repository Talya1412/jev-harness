# @jev-harness/mcp

MCP server (stdio) exposing TypeSafe's **Jev (System One)** decision model as
tools. Works with any MCP client: Claude Code, Cursor, Windsurf, Cline, Codex.

## Tools

| Tool                    | Backing core call     | Purpose                                                                   |
| ----------------------- | --------------------- | ------------------------------------------------------------------------- |
| `jev_ask`               | `askJev`              | Batch of typed noul / choice / score questions, returns raw `JevResponse` |
| `jev_models`            | `listJevModels`       | List models for the configured key                                        |
| `jev_route_skills`      | `routeSkill`          | Route a task to the best skill (or none)                                  |
| `jev_pick_tool`         | `pickTool`            | Pick the best tool + confirm-required flag                                |
| `jev_judge_destructive` | `judgeDestructive`    | Destructiveness judgment for a tool call                                  |
| `jev_browse_action`     | `chooseBrowserAction` | Next browser operation from a page snapshot                               |
| `jev_rank`              | `rankCandidates`      | Rank candidate strings best-first                                         |
| `jev_classify`          | `withMapReduce`       | The same questions over a whole corpus, with an optional reduce           |

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
