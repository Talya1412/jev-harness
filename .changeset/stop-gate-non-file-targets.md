---
"@jev-harness/omp": patch
---

Stop the verification gate from arming on a write that touches no file.

`write { path: "xd://report_issue" }` dispatches to a tool device (`write: { scope: "device" }` in OMP's own URL registry); it changes nothing on disk. The gate counted it as a changed file and refused a settle on a session with no edits at all — the exact false block that gets a gate removed, and it fired for real the first day the gate was enabled.

Edit detection now requires a target that is not a scheme URL, and a mixed
list keeps only the real paths.
