# @jev-harness/pi

Pi extension packaging TypeSafe Jev (System One) judgments: five fail-open
tools, an append-only skill-router advisory, and Jev-driven verbatim
compaction. Mirrors the OMP adapter; Pi and OMP share the same extension
factory shape (`export default function (pi: ExtensionAPI)`).

## Pi manifest field

Pi discovers extensions through the [`pi.extensions`](https://github.com/joelhooks/pi-fast-jev-compaction/blob/HEAD/package.json)
array in `package.json` — a list of paths (files or directories) resolved
relative to the package root by Pi's extension loader
(`readPiManifest` reads the `pi` object; `resolveExtensionEntries`
resolves each entry; verified against
`@earendil-works/pi-coding-agent@0.85.1` sources). This package declares:

```json
{ "pi": { "extensions": ["./src/extension.ts"] } }
```

The reference repo points at a directory (`["./extensions"]`); this package
points at the entry file instead so the jiti module import Pi performs per
`loadExtensionModule` resolves unambiguously (no directory-index guessing).

Source: <https://github.com/joelhooks/pi-fast-jev-compaction> —
[`package.json`](https://raw.githubusercontent.com/joelhooks/pi-fast-jev-compaction/HEAD/package.json)
(`"pi": { "extensions": ["./extensions"] }`) and
[`extensions/pi-fast-jev-compaction.ts`](https://raw.githubusercontent.com/joelhooks/pi-fast-jev-compaction/HEAD/extensions/pi-fast-jev-compaction.ts)
(default-export factory, `session_before_compact` returning
`{ compaction: { summary, firstKeptEntryId, tokensBefore, details } }`).

## Install

From the Pi agent directory (global install):

```bash
# from a checkout of jev-harness
pi install ./packages/pi
# or by git URL once published
pi install git:github.com/Talya1412/jev-harness
```

For one run without installing:

```bash
pi -e ./packages/pi
```

Requires Node >= 20 (Pi itself targets Node 24.18; see the reference repo).

## Environment

| Variable                 | Meaning                                                                                                 | Default                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `TYPESAFE_API_KEY`       | TypeSafe API key. Read on every call, never logged. All tools/hooks fail open without it.               | (none — required)                        |
| `TYPESAFE_BASE_URL`      | Jev endpoint override.                                                                                  | core default (`https://api.typesafe.ai`) |
| `TYPESAFE_DEFAULT_MODEL` | Jev model override.                                                                                     | core default (`jev-latest`)              |
| `JEV_TIMEOUT_MS`         | Per-request timeout in ms.                                                                              | 15000                                    |
| `OMP_JEV_KEEP_THRESHOLD` | Shared with the OMP adapter: `noul` keep-scores below this on _both_ call and result mark a pair stale. | `0.2`                                    |

```bash
export TYPESAFE_API_KEY='...'
```

## Tools

All five tools fail open: Jev errors resolve to advisory text, never throw.

- `jev_ask` — raw judgments over an arbitrary JSON `state` plus a
  `questions` map (`noul` / `choice` / `score`).
- `jev_models` — list Jev models available to the configured key.
- `jev_route_skills` — route a message to one skill (or none). Send skill
  descriptions, not bare names.
- `jev_pick_tool` — pick one tool (or none), with a confirmation flag for
  side-effecting choices. Does not execute anything.
- `jev_browse_action` — pick the next browser operation from a page snapshot.
  Does not execute anything.

## Hooks

- `session_before_compact` — collects assistant tool-call / tool-result
  pairs (by `toolCallId`, capped at 40), asks two `noul` questions per
  pair (keep the call, keep the result), and returns verbatim compaction
  when at least one pair is stale on both scores:
  `{ compaction: { summary, firstKeptEntryId, tokensBefore, details } }`.
  Returns `undefined` (Pi falls back to built-in summary) when there is no
  key, no complete pairs, nothing stale, or Jev fails.
- `input` — fire-and-forget skill-router advisory. Notifies when a
  registered tool looks relevant; never blocks, transforms, or handles input.

## Assumptions

- No destructive `tool_call` gate: Pi's `tool_call` event only supports
  fail-closed blocking (`{ block: true }`), and per instructions a risky
  gate was omitted rather than shipped. `jev_pick_tool` exposes the
  confirmation signal to the model instead.
- Pi's `CompactionResult` has no `shortSummary` field (verified in
  `@earendil-works/pi-coding-agent@0.85.1`:
  `{ summary, firstKeptEntryId, tokensBefore, estimatedTokensAfter?, usage?, details? }`),
  so the OMP-adapter `shortSummary` is folded into
  `details: { shortSummary, threshold, decisions }`.
- `input` uses `pi.getAllTools()` (ExtensionAPI method) as the routing
  candidate set; the async judgment notifies via `ctx.ui.notify`.
