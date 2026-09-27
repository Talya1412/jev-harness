---
"@jev-harness/omp": patch
---

Teach the stop gate where checks actually run.

Almost nothing reaches the gate as a top-level `bash` call: this harness drives
shell steps from the code runners (`fabric_exec`, `eval`, `run_code`), so
`omp.bash({ cmd: "npm test" })` arrives as a `fabric_exec` call whose input is
JavaScript. Judging only the `bash` tool made every real check invisible, so a
session that ran the full suite before finishing was still refused with "nothing
has verified it since" — a false negative that fired for real on 2026-09-27.

The gate now also mines the call's own strings for quoted shell commands when the
tool is a code runner, and judges every command it finds, so one passing test is
not lost behind a later grep in the same call. Identifier text is not mistaken
for a command. Replayed against the real session (1,207 messages) it now finds 35
checks where it previously found none.
