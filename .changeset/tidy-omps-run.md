---
"@jev-harness/core": minor
"@jev-harness/kit": minor
"@jev-harness/omp": minor
"@jev-harness/pi": patch
"@jev-harness/mcp": patch
"@jev-harness/claude-code": patch
"@jev-harness/cli": patch
"@jev-harness/eval": minor
---

Fix three defects in the OMP adapter that made shipped features inert, and give the
adapters one shared foundation.

**OMP adapter: features that could not run**

- Verbatim compaction never activated. It matched only the Anthropic wire spellings
  (`tool_use` / `tool_result`); real OMP transcripts carry `toolCall` content blocks and
  separate `role: "toolResult"` messages. On a real 1,505-message transcript `flatten()`
  found 0 calls before and 720 after, and a region that used to defer `no-calls` now
  yields a plan. A truncated tool result also keeps its head plus a recoverable note
  instead of being dropped by the final join.
- The `input` skill router could never fire: `ExtensionContext` has no `skills` member and
  `{`additionalContext`}` is not an `InputEventResult` field. The roster is now read from
  the skill roots on disk and the hint is delivered through `before_agent_start`, which
  the host turns into a message the model actually sees.
- The `tool_call` gate could fail CLOSED. The host maps a timed-out handler to
  `{ block: true }`, and core's retry budget could exceed the host's 30 s handler
  timeout. The gate now threads the host `AbortSignal` and self-imposes an 8 s deadline,
  so it always settles and always fails open.

**OMP adapter: surface and cost**

- Five tools collapse to one `jev` tool with a `mode` parameter. `jev_ask` and
  `jev_models` are gone: OMP core already ships a native TypeSafe integration
  (`eval` prelude `judge()` / `judge_batch()`, `omp models typesafe`).
- The destructive gate asks two questions with an explicit abstain and returns
  `allow` / `block` / `confirm`, so a genuine-but-uncertain call has a path forward
  instead of a silent hard block.
- Added a failure taxonomy, a refusal ledger, a ranked-merge skill router with debounce
  and single-flight, and documentation for five previously undocumented env vars.

**One shared foundation**

`@jev-harness/kit` is now the single env→config rule; `pi`, `mcp`, `claude-code` and
`omp` use it, each keeping its own redaction policy through an explicit option rather
than a private copy. Removes a dead dependency, a duplicated lexical shortlist (which
existed in three places, one of them imported by nobody), and six copies of the same
credential reader.

**Thresholds measured, not guessed**

`THRESHOLDS` centralises every tuned number. The dual gate's dataset and baseline were
recorded live: AUC 1.000, Brier 0.0165, and a noiseless plateau of [0.40, 0.56] — one
case narrower than the previously documented [0.4, 0.6]. The interpreter invocation that
the old single-question gate blocked at 0.84 now scores 0.07.

**New in core**: `THRESHOLDS`, `judgeDestructiveDual`, `classifyJevFailure` /
`policyForFailure`, `createRefusalLedger`, `withMapReduce`.
