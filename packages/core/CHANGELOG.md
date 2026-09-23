# @jev-harness/core

## 0.4.0

### Minor Changes

- [`2007a3c`](https://github.com/Talya1412/jev-harness/commit/2007a3c47f5bc05a4c3489edd446c233d136b8af) Thanks [@Talya1412](https://github.com/Talya1412)! - Grow the destructive-gate evaluation from a 38-case golden set into a two-split
  benchmark, and add the statistics it needs.

  Datasets (`packages/eval/golden`):

  - `destructive-gate.json` — dev/tuning split, 69 cases over core, obfuscation,
    false-positive-trap and paraphrase slices.
  - `destructive-gate.holdout.json` — holdout split, 74 cases, adding steering
    (text that argues for its own classification) and distractor slices. Never
    used to choose wording. Live recording: AUC 0.996, Brier 0.020, precision
    1.00, recall 0.974.

  Cases may carry `slice`, `pair` and `note`. The report breaks the confusion
  matrix down per slice with Wilson 95% intervals and summarizes paraphrase
  invariance across `pair` groups. New exports: `wilsonInterval`, `mcnemarTest`,
  `invarianceDeltas`, `SliceMetrics`.

  The vitest regression gate now recomputes **both** baselines from their own
  per-case rows and enforces per-slice floors; `check-regression.mjs` fails on
  slice regressions as well as aggregate ones, and the `live-eval` workflow runs
  both splits.

## 0.3.0

### Minor Changes

- [`35f21a9`](https://github.com/Talya1412/jev-harness/commit/35f21a97b5b4e64de850562e9b9ed5732ab8793f) Thanks [@Talya1412](https://github.com/Talya1412)! - Tune the destructive gate on data: broaden the `judgeDestructive` question to
  name system abuse (disk wipes, broad permission changes, fork bombs, mass
  kills, shutdown) as well as data destruction, and lower the default threshold
  from 0.75 to 0.5.

  On the 38-case golden baseline the old wording at 0.75 scored precision 1.00 /
  recall 0.75 — it missed `chmod -R 777 /` (0.37), a fork bomb (0.17),
  `npm publish` (0.55), `shutdown` (0.51), and an overwrite (0.65). The new
  wording separates the same set perfectly (AUC 1.000, Brier 0.013) with a
  0.4–0.6 plateau, so 0.5 sits mid-plateau for margin against run-to-run
  variance. The golden baseline is re-recorded, and the default changes in
  core, OMP, Claude Code, VS Code, and the GitHub review action; the Python port
  mirrors it. `jev-gate-action`'s diff-level gate keeps its own threshold.

## 0.2.2

### Patch Changes

- [`18ac30f`](https://github.com/Talya1412/jev-harness/commit/18ac30f7c6554bb1d9b1e358006284b0d641b728) Thanks [@Talya1412](https://github.com/Talya1412)! - Reformat the sources with Prettier, clear the lint findings, and rebuild the
  committed bundles. No behavior change; also fills in package metadata
  (`keywords`, `publishConfig`).

## 0.2.1

### Patch Changes

- [`b25554c`](https://github.com/Talya1412/jev-harness/commit/b25554cb7081763d510293f83053055fd7d55711) Thanks [@Talya1412](https://github.com/Talya1412)! - Production hardening across the monorepo.

  core: bound all Jev HTTP calls (timeout, retry, signal, response validation on listJevModels); batch/flush helpers now reject every queued caller instead of hanging on invalid input; audit log capped (1000-entry ring); redaction preserves Date/Map/Set state and recognizes Google API keys; withFailMode no longer lets a throwing observer break the fail-open policy; pattern payloads capped (browser elements/page text, rank candidates, migration SQL) with truncation markers; reserved 'none' candidate names rejected; isDuplicate no longer duplicates the item into every instruction; in-memory cache is true LRU and skips the models endpoint; decision digest is circular-safe; persistent cache only caches string bodies.

  cli/eval: `jev eval` exits non-zero on failures (0/1/2 taxonomy, `--no-fail` opt-out), aborts fail fast, request/cost accounting counts every attempt and output tokens, single-pass tune sweep (O(n log n)), JSONL errors carry line numbers, neutral paths in the golden fixture and deterministic per-case ordering in the baseline recorder.

  packaging/adapters: claude-code hook, github action, and gate/triage bundles are self-contained (esbuild-inlined core) so marketplace and Actions installs work without npm install; gh posting uses execFileSync (no shell); gate/triage read the documented github_token input; LICENSE shipped in every published package; engines/sideEffects/default export conditions added; internal workspace deps pinned ^0.2.0; claude-code plugin manifests stamped from package.json at build time.

  ci: least-privilege permissions and concurrency guards on every workflow; new bundle-drift job fails CI on stale committed bundles; actions pinned to current majors.

## 0.2.0

### Minor Changes

- [`8601008`](https://github.com/Talya1412/jev-harness/commit/8601008c9409a1e2bd63eb2cc7a4b6f75fdf53d3) Thanks [@Talya1412](https://github.com/Talya1412)! - First calibrated release of the harness surface: 21 decision patterns (incl. commitGate, migrationSafety, testPrioritizer, secretLeak, dedupeItems, logSeverity), state redaction before anything leaves the machine, a rolling-window budget guard, a disk-backed persistent cache with hit-rate stats, decision logging with flip-rate comparison, and transport infra (cache, batch, audit, local fail-open router).
