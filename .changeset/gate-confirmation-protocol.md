---
"@jev-harness/omp": minor
---

Make the gate's confirmation protocol real.

The refusal message tells the model to re-issue the same call once the user has
confirmed it, but a `tool_call` event carries only `{ toolName, input }` — the
gate cannot see the conversation, so a restated confirmation was invisible to it
and the identical call blocked forever. That is a broken promise rather than a
safety property: it stranded the user who did exactly what they were told to do.

A blocked call is now remembered by digest, and the SAME call is allowed once
the user has spoken (the `input` hook is the clock). Any edit changes the digest,
so a modified call is judged afresh. The state lives on the extension instance
and resets on `session_start`/`session_switch`/`session_shutdown`, so an
exemption can never leak from one session into another — a first cut used
process-wide state, and the new session-boundary test caught it.
