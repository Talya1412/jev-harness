---
"@jev-harness/core": minor
"@jev-harness/omp": minor
"@jev-harness/mcp": minor
---

Wire the three researched backlog features end-to-end.

- **core**: four new patterns — `escalateOnLowConfidence` (tri-state
  accepted/escalated/unresolved; noul gates on an uncertainty band, choice/
  score on a confidence bar; anchor-free one-attempt escalation that always
  preserves the first result), `pruneContext` (state-size guard with zero
  requests before anything is judged, head+note replacement, input never
  mutated, error-shaped output on a strictly lower drop bar), and the review
  pair `findingRealness` + `refutationFilter` (asymmetric loss: drop only
  above 0.75 AND classed non-protected; missing answers always keep; severity
  never silently coerced).
- **mcp**: `jev_escalate`, `jev_prune`, `jev_finding_realness`,
  `jev_refute` tools with fail-open envelopes and PROVISIONAL thresholds
  flagged in their schemas.
- **omp**: opt-in `tool_result` prune hook (`OMP_JEV_PRUNE=1`, default off —
  every rewrite invalidates the provider prompt-cache prefix): idempotent,
  hard-caps oversized output locally instead of asking Jev, self-deadlines
  below the host's handler budget, fails open to the original result.

Eight THRESHOLDS keys carry provenance (prune bars MEASURED cross-repo,
escalate/refute/findingReal PROVISIONAL and labeled). Parity fixture and the
jev-py thresholds table were updated in lockstep so TS and Python both pin the
same 28-key frozen table.
