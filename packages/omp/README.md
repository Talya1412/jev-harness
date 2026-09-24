# @jev-harness/omp — Jev tools + auto-hooks for Oh My Pi

OMP-native adapter over `@jev-harness/core` (TypeSafe's Jev / System One).
Registers ONE advisory tool (`jev`, three `mode`s) and 3 opt-in automatic
hooks (4 handler registrations: the skill router uses `input` to observe the
prompt and `before_agent_start` to deliver its hint).

## Install

```sh
# from the harness repo
npm run build --workspace @jev-harness/omp
omp plugin install ./packages/omp
```

Or copy the built entry into your agent dir so OMP loads it as an extension:

```sh
cp packages/omp/bundle/extension.js ~/.omp/agent/extensions/jev-tools.js
```

The `package.json` `omp.extensions` field points at `./bundle/extension.js`.

## Tools (always registered)

| Tool  | `loadMode`     | What it does                                                                                                                                                                                                                                                                                                                                                                       |
| ----- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jev` | `discoverable` | One advisory tool, `mode` selects the pattern. `route_skills` ranks skill names against a task (or abstains); `browse_action` picks the next browser operation from a snapshot; `pick_tool` picks one tool for a task and flags whether it needs confirmation. Every mode returns a decision and executes nothing — validate it against the live snapshot or roster before acting. |

`loadMode: "discoverable"` is deliberate: OMP mounts a discoverable tool under
`xd://` or BM25 search instead of the top-level schema, so the large
three-mode schema stays off every request. Nothing here duplicates OMP's own
tooling — the previous `jev_ask` re-implemented the native `judge()` /
`judge_batch()` prelude available inside `eval`, and `jev_models` duplicated
`omp models typesafe`, so both were removed.

## Hooks (all require `OMP_JEV_AUTO=1`)

| Hook                                         | Off-switch               | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tool_call` destructive gate                 | `OMP_JEV_GATE=0`         | Dual gate via `judgeDestructiveDual`: one `noul` (P(destructive)) plus one `choice` over what the call actually does. `block` only when the score clears 0.5 **and** the category is `destructive` with confidence ≥ 0.5; `confirm` when the score is high but the category disagrees, abstains, or is unsure — that returns a block whose reason tells the model to re-issue the same call once the user confirms it explicitly, instead of a bare refusal with no way forward. Records every refusal in a refusal ledger. **Fail-open, twice over**: every path including the logger resolves without throwing, and the judgment is bounded by an 8 s self-deadline combined with the host's abort signal, so the handler always settles before the host's 30 s `toolCallTimeoutMs` (which maps a timeout to `{ block: true }`).                                                   |
| `input` + `before_agent_start` skill router  | `OMP_JEV_SKILL_ROUTER=0` | Reads the skill roster from disk (the same `skills/` roots OMP's discovery scans: `.omp/skills`, `~/.omp/agent/skills`, `~/.agents/skills`) and narrows it with kit's `lexicalShortlist`, then ranks the shortlist with `routeSkill`, promoting only at confidence ≥ 0.5 **and** only when the user has not already named a skill. One request in flight (a burst is serialized, never stacked), a superseded answer is discarded rather than delivered, and answers are cached per prompt. Prompts arriving inside a ~250 ms window are coalesced; a lone prompt is never delayed, because the host awaits this hook before submitting the message. The hint is delivered as a one-shot custom message on the next `before_agent_start`, which the host converts into a developer message — the system prompt is never rewritten, so the provider prompt-cache prefix is untouched. |
| `session_before_compact` verbatim compaction | `OMP_JEV_CONTEXT=0`      | Two `noul` questions per tool call (keep the call / keep its result verbatim), batched in parallel. Keeps bytes identical; a dropped result keeps its head verbatim plus a note naming the omitted size and how to recover it. Returns `{ compaction: { summary, shortSummary, firstKeptEntryId, tokensBefore, details } }` or `undefined` to fall back to native compaction. Fail-open, and it never hooks the per-request `context` event.                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## Environment variables

| Var                          | Default                    | Meaning                                                                                                                                                      |
| ---------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TYPESAFE_API_KEY`           | (required)                 | System One API key. Read from the environment only — never hardcoded, never logged.                                                                          |
| `TYPESAFE_BASE_URL`          | `https://api.typesafe.ai`  | Endpoint override.                                                                                                                                           |
| `TYPESAFE_DEFAULT_MODEL`     | `jev-latest`               | Model override (per-call `model` param wins).                                                                                                                |
| `JEV_TIMEOUT_MS`             | `15000`                    | Per-request timeout in ms.                                                                                                                                   |
| `OMP_JEV_AUTO`               | off                        | Master switch: set to `1` to enable all auto hooks.                                                                                                          |
| `OMP_JEV_GATE`               | on (when auto)             | Set to `0` to disable the `tool_call` gate.                                                                                                                  |
| `OMP_JEV_SKILL_ROUTER`       | on (when auto)             | Set to `0` to disable skill routing (`input` + `before_agent_start`).                                                                                        |
| `OMP_JEV_CONTEXT`            | on (when auto)             | Set to `0` to disable verbatim compaction.                                                                                                                   |
| `OMP_JEV_KEEP_THRESHOLD`     | `0.2`                      | Keep probability threshold for compaction.                                                                                                                   |
| `OMP_JEV_MAX_STATE_TOKENS`   | `25000`                    | Compaction state budget; larger histories defer to native compaction.                                                                                        |
| `OMP_JEV_MAX_REQUEST_TOKENS` | `30000`                    | Compaction per-request budget (drives batching).                                                                                                             |
| `OMP_JEV_TRUNCATE_HEAD`      | `300`                      | Kept head chars for truncated tool results.                                                                                                                  |
| `OMP_JEV_MIN_REDUCTION`      | `0.25`                     | Minimum saved/total char ratio before returning a compaction.                                                                                                |
| `OMP_JEV_MAX_CALLS_PER_MIN`  | `120`                      | Rolling per-minute cap on Jev requests, shared by tools and hooks. `0` disables the cap.                                                                     |
| `OMP_JEV_CACHE_DIR`          | `~/.omp/cache/jev-harness` | Directory for the cross-session judgment cache.                                                                                                              |
| `OMP_JEV_CACHE_TTL_MS`       | `86400000` (1 day)         | How long a cached judgment stays valid.                                                                                                                      |
| `OMP_JEV_DECISION_LOG`       | unset (in-memory only)     | Path to a JSONL file; every gate decision is appended there for offline review.                                                                              |
| `OMP_JEV_REDACT`             | unset                      | `1` redacts secrets in ALL state; `0` disables redaction everywhere. Unset redacts hooks only — tools send full fidelity because the model chose that state. |

## Resilience

- **Budget guard.** `OMP_JEV_MAX_CALLS_PER_MIN` caps runaway loops; the cap is
  shared by every tool and hook.
- **Persistent cache.** Identical judgments are free hits across sessions
  (`OMP_JEV_CACHE_DIR`, `OMP_JEV_CACHE_TTL_MS`).
- **Failure taxonomy.** A transport failure is classified
  (`classifyJevFailure`) and handled by policy (`policyForFailure`) rather
  than swallowed: an `auth` or `model` failure disables Jev for the session —
  every later call would fail identically while burning a host handler's
  latency budget — `rate_limit` backs off, `network` stays quiet, and anything
  else is surfaced in the logs.
- **Refusal ledger.** Gate blocks, routing abstains, and compaction deferrals
  are recorded with their reason, so a declined action leaves a trace instead of
  vanishing.
- **Fail-open.** Apart from an explicit destructive `block`, no Jev failure ever
  stops the agent.

## Layout

- `src/extension.ts` — default-export factory `(pi: ExtensionAPI) => void`; all tools + hooks.
- `src/compact.ts` — pure verbatim-compaction planning + rendering (no host, no network).
- `src/router.ts` — pure skill-roster loading and the single-flight, cached ranked-merge router.
- `src/failure.ts` — the one place a Jev transport failure becomes a decision.
- `src/config.ts` — env parsing, thresholds re-exported from core, deadline helper.
- `src/index.ts` — re-exports the factory.
