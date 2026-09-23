---
"@jev-harness/core": minor
"@jev-harness/kit": minor
"@jev-harness/eval": minor
"@jev-harness/cli": minor
"@jev-harness/mcp": minor
"@jev-harness/omp": minor
"@jev-harness/pi": minor
"@jev-harness/claude-code": minor
"@jev-harness/github": minor
---

Grow the benchmark further and use it to tune the merge gate.

- Cases: the destructive-gate sets grew to **78 dev / 89 holdout**, adding more
  obfuscation (interpreted-language deletion, `rev`/`xxd` decoding, here-strings,
  embedded quotes) and more paraphrase pairs, so the paraphrase slices are now
  big enough to gate. Holdout live recording: AUC 0.998, Brier 0.018, precision
  1.00, recall 0.980.
- New dataset `merge-gate.json` (41 labeled PR diffs) measures the two questions
  `jev-gate-action` asks over a diff. At the previously shipped 0.75 the
  destructive question scored precision 1.00 / recall 0.42 — it missed 7 of the
  12 labeled destructive merges. Measured mid-gap defaults are now
  **destructive 0.12** (precision 1.00, recall 0.92) and **secret_leak 0.07**
  (precision 1.00, recall 1.00). Still advisory unless `fail_on_block`.
- `record-baseline.mjs` takes an optional output path (a dataset may ask several
  questions), retries the Cloudflare 403 bursts, and records per-slice metrics;
  the regression gate globs **every** `*.baseline.json`, recomputes it from its
  own per-case rows, and enforces per-slice floors — negative-only slices
  (traps, placeholders) are gated on zero false positives instead.
- Repo hygiene: `.github/secret_scanning.yml` keeps the credential-shaped
  fixtures out of secret scanning; the `typescript` Dependabot ignore is
  narrowed to major versions only, so minor/patch updates flow again.
