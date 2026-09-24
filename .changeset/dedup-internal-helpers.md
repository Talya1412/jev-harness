---
"@jev-harness/core": patch
"@jev-harness/omp": patch
"@jev-harness/pi": patch
---

Close the two gaps the redundancy audit left open.

- **core**: the near-duplicate pairs now share their transport plumbing
  instead of four copies of it. `booleanGate` and `scoreQuestions` live in
  an internal `gate-core` module that the package index does NOT export, so
  the public surface is unchanged; both prompt strings, every cap, every
  threshold (including the deliberate 0.7 / 0.6 divergence between the two
  injection entry points), and every missing-answer policy stay exactly as
  shipped, pinned by characterization tests.
- **omp**: the skill router now degrades to core's `localRouteSkill` when the
  Jev call itself fails — previously a Jev outage meant no hint at all. The
  fallback only promotes a lexical match at or above its floor, is labelled
  as lexical overlap (never as a Jev probability), and is recorded in the
  refusal ledger so an outage-routed suggestion is visible in the trail.
- **pi**: the compaction hook adopts `withFailMode` so its fail-open policy
  is stated at the call site rather than hidden in a bare catch. Every other
  hand-rolled catch in the adapters has side effects (session disable,
  refusal records, error-dependent outcomes) that `withFailMode` cannot
  express, so those stay as-is.

Behaviour is unchanged everywhere: no signature moved, no result flipped.
