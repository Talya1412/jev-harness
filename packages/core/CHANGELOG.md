# @jev-harness/core

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
