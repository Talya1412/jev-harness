---
"@jev-harness/omp": patch
---

Register the hooks once per host, so a stale copy cannot double-instrument it.

OMP loads every `.js`/`.ts` file in its extensions directory as an extension, and
a build copy left under a name that still ends in `.js` (for example
`jev-harness.js.bak-20260927`) counts. Five such backups from one afternoon meant
several stop gates armed in the same process, each able to refuse a settle, with
no way to unregister the stale ones without a restart — the gate looked "stuck"
for six turns and the cause was the file layout, not the logic.

The extension now instruments a host once; a second call is a silent no-op. This
is defence in depth: keeping backups out of the extensions directory is still the
operator's job, and the guard makes forgetting it harmless.
