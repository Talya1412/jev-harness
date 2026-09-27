---
"@jev-harness/core": minor
"@jev-harness/omp": minor
---

Stop a "done" that nothing verified, widen the skill roster, and report the
savings.

- **omp**: a new opt-in `session_stop` hook refuses a settle when the session
  changed something and no check has passed since. The rule is deterministic
  first (read from the session's own tool calls) and the one Jev question may
  only LOOSEN the verdict, so a probability can never invent a block. Off
  unless `OMP_JEV_STOP=1`, because a blocking hook must be asked for.
- **omp**: the skill roster now mirrors OMP's own discovery (12 roots instead
  of 3), so the router can no longer rank a skill the host never loaded.
- **omp**: `mode: "savings"` reports skipped vs judged decisions from the
  decision log at zero request cost, keeping MEASURED and ESTIMATED apart.
- **core**: `summarizeSavings` / `formatSavings` turn a decision log into that
  report.
- **core** + **omp** (earlier in this release train): a read-only pre-filter
  that skips the gate for provably non-mutating commands, and a
  `validateQuestions` that rejects the question shapes the API silently
  mis-reads.
