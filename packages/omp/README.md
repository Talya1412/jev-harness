# @jev-harness/omp — Jev tools + auto-hooks for Oh My Pi

OMP-native adapter over `@jev-harness/core` (TypeSafe's Jev / System One).
Registers 5 tools (called on demand) and 3 opt-in automatic hooks.

## Install

```sh
# from the harness repo
npm run build --workspace @jev-harness/omp
omp plugin install ./packages/omp
```

Or copy the built entry into your agent dir so OMP loads it as an extension:

```sh
cp packages/omp/dist/extension.js ~/.omp/agent/extensions/jev-tools.js
```

The `package.json` `omp.extensions` field points at `./dist/extension.js`.

## Tools (always registered)

| Tool | What it does |
| --- | --- |
| `jev_ask` | Typed noul/choice/score questions over an arbitrary state. Returns the raw Jev response (JSON + details). |
| `jev_models` | Lists the System One models available to the key. |
| `jev_route_skills` | Ranks skill names against a task via `routeSkill` (core). Advisory hint, never loads anything. |
| `jev_browse_action` | Picks the next browser action from a page snapshot via `chooseBrowserAction` (core). Advisory — validates nothing, executes nothing. |
| `jev_pick_tool` | Picks one tool for a task + flags confirmation via `pickTool` (core). Advisory — executes nothing. |

## Hooks (all require `OMP_JEV_AUTO=1`)

| Hook | Off-switch | Behavior |
| --- | --- | --- |
| `tool_call` destructive gate | `OMP_JEV_GATE=0` | Judges `bash\|write\|edit\|delete\|move\|rm\|mcp__*` calls via `judgeDestructive`, blocks at ≥ 0.75. **Fail-open**: every line including the logger call is inside try/catch and resolves to allow. |
| `input` skill router | `OMP_JEV_SKILL_ROUTER=0` | Routes the message via `routeSkill`, returns `{ additionalContext: "[jev] Consider loading skill: <name>" }` only at confidence ≥ 0.5. Append-only — never rewrites the system prefix (provider prompt cache stays intact). |
| `session_before_compact` verbatim compaction | `OMP_JEV_CONTEXT=0` | Two `noul` questions per tool call (keep the call / keep its result verbatim), batched in parallel. Keeps bytes identical, truncates dropped results to a head + recoverable note. Returns `{ compaction: { summary, shortSummary, firstKeptEntryId, tokensBefore, details } }` or `undefined` to fall back to native compaction. Fail-open. Never hooks the per-request `context` event. |

## Environment variables

| Var | Default | Meaning |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | (required) | System One API key. Read from the environment only — never hardcoded, never logged. |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | Endpoint override. |
| `TYPESAFE_DEFAULT_MODEL` | `jev-latest` | Model override (per-call `model` param wins). |
| `JEV_TIMEOUT_MS` | `15000` | Per-request timeout in ms. |
| `OMP_JEV_AUTO` | off | Master switch: set to `1` to enable all auto hooks. |
| `OMP_JEV_GATE` | on (when auto) | Set to `0` to disable the `tool_call` gate. |
| `OMP_JEV_SKILL_ROUTER` | on (when auto) | Set to `0` to disable the `input` skill suggestion. |
| `OMP_JEV_CONTEXT` | on (when auto) | Set to `0` to disable verbatim compaction. |
| `OMP_JEV_KEEP_THRESHOLD` | `0.2` | Keep probability threshold for compaction. |
| `OMP_JEV_MAX_STATE_TOKENS` | `25000` | Compaction state budget; larger histories defer to native compaction. |
| `OMP_JEV_MAX_REQUEST_TOKENS` | `30000` | Compaction per-request budget (drives batching). |
| `OMP_JEV_TRUNCATE_HEAD` | `300` | Kept head chars for truncated tool results. |
| `OMP_JEV_MIN_REDUCTION` | `0.25` | Minimum saved/total char ratio before returning a compaction. |

## Layout

- `src/extension.ts` — default-export factory `(pi: ExtensionAPI) => void`; all tools + hooks.
- `src/index.ts` — re-exports the factory.
