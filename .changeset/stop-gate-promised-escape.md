---
"@jev-harness/omp": patch
---

Make the stop gate's documented escape actually work.

The refusal says "or state explicitly that no check applies to this change and
stop again" — but nothing implemented that, and the gate keeps no memory between
settles, so a session whose change cannot be verified (a tool-device dispatch, a
docs-only edit) was refused on every turn, forever. Same broken-promise class as
the tool_call gate fixed earlier.

A statement made AFTER the last edit that no check applies (docs-only,
nothing to test, no check is needed, ...) now clears the block. Recognition is
strict and position-checked, so a vague "done" still blocks, and one made before
the last edit does not count.
