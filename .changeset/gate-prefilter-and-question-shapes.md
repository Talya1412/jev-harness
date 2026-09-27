---
"@jev-harness/core": minor
"@jev-harness/omp": minor
---

Reject malformed questions before spending a request, and skip the gate for
provably read-only commands.

- **core**: `validateQuestions` now checks the SHAPES that used to be silently
  mis-read, rather than only counting entries. A `choice` whose `criteria` is an
  array or a `{ options: [...] }` wrapper is rejected — the API answered such a
  question as ONE option at confidence 1.0, so a caller never learned it asked
  badly. `score` levels must be an ordered array of 2-10 strings; a `noul`
  criteria, when present, must be prose or a `{true,false}` map.
- **omp**: the `tool_call` gate asks Jev about every `bash` call, including
  pure reads. A closed-form allowlist (`gate-prefilter.ts`) now recognises
  commands that are provably non-mutating (plain reads, listing subcommands,
  and only the read-shaped arguments of multi-purpose commands) and skips the
  request. A skip means "do not judge", never "approve": anything unrecognised
  or arguably mutating still reaches Jev, and each skip is logged with its rule
  id. Measured on real bash traffic: 28% absorbed, zero false positives.
