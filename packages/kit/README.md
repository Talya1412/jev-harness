# @jev-harness/kit

The shared foundation for **[TypeSafe Jev](https://typesafe.ai)** (System
One) harness adapters. Everything an adapter needs that is independent of
the host — env credentials, the tool-result envelope, core-pattern call
plumbing, and the lexical skill prefilter — with **no host imports**:
schemas, formatting, and hook wiring stay in each adapter.

Used by `@jev-harness/omp` and `@jev-harness/pi`; the base for writing new
adapters.

## API

| Export                                                | Purpose                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `resolveEnvConfig(opts?)`                             | Resolve `TYPESAFE_API_KEY` / `TYPESAFE_BASE_URL` / `TYPESAFE_DEFAULT_MODEL` / `JEV_TIMEOUT_MS` / `JEV_REDACT` into a `JevConfig`. `requireKey: true` throws on a missing key (strict adapters); otherwise the empty-key config flows through the caller's fail-open path. `redact` is the caller's own decision (it overrides `JEV_REDACT`); `overrides` and `env` are for explicit callers and tests. |
| `createJevToolkit({ requireKey? })`                   | Config + core-pattern plumbing (`ask`, `models`, `routeSkills`, `pickTool`, `browseAction`), resolved fresh per call with an optional per-call model override.                                                                                                                                                                                                                                         |
| `okResult(text, details?)` / `errorResult(tool, err)` | The standard `{ content: [{ type: "text", text }], details }` envelope and fail-open error rendering.                                                                                                                                                                                                                                                                                                  |
| `lexicalShortlist(text, roster, opts?)`               | Score skill names against a message before spending a Jev call; falls back to the full roster when nothing matches lexically.                                                                                                                                                                                                                                                                          |

## Failure policies

The kit does not decide for you — the two policies the repo ships:

- **Strict (OMP)**: `createJevToolkit({ requireKey: true })`; a missing key
  or Jev error surfaces to the host tool machinery.
- **Fail-open (Pi)**: `createJevToolkit({ requireKey: false })` + catch-all
  in each tool execute that renders `errorResult(tool, err)`. A Jev outage
  never stalls the agent.

## Redaction policies

Redaction is a per-call-site decision, never a kit-wide default:

- **Hooks** (Claude Code PreToolUse / UserPromptSubmit, OMP's gate and skill
  router) send tool input and history: they redact unless `JEV_REDACT=0`
  (`OMP_JEV_REDACT` overrides per context in the OMP adapter).
- **Tools** (`createJevToolkit`, the MCP server) send state the model or
  caller deliberately submitted: full fidelity, and the env knob is ignored.
- Claude Code renders "off" as an ABSENT `redact` field, so the sent payload
  is byte-identical to the pre-kit behavior.

## License

Apache-2.0.
