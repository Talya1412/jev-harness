# @jev-harness/mcp

MCP server (stdio) exposing TypeSafe's **Jev (System One)** decision model as
tools. Works with any MCP client: Claude Code, Cursor, Windsurf, Cline, Codex.

## Tools

| Tool | Backing core call | Purpose |
| --- | --- | --- |
| `jev_ask` | `askJev` | Batch of typed noul / choice / score questions, returns raw `JevResponse` |
| `jev_models` | `listJevModels` | List models for the configured key |
| `jev_route_skills` | `routeSkill` | Route a task to the best skill (or none) |
| `jev_pick_tool` | `pickTool` | Pick the best tool + confirm-required flag |
| `jev_judge_destructive` | `judgeDestructive` | Destructiveness judgment for a tool call |
| `jev_browse_action` | `chooseBrowserAction` | Next browser operation from a page snapshot |
| `jev_rank` | `rankCandidates` | Rank candidate strings best-first |

Every handler catches all errors and returns `isError: true` with a readable
message — the server never dies because Jev is down (fail-open transport).
`jev_judge_destructive` errors mean "unknown", never "confirmed safe".

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
