---
"@jev-harness/core": patch
---

Production hardening across the monorepo.

core: bound all Jev HTTP calls (timeout, retry, signal, response validation on listJevModels); batch/flush helpers now reject every queued caller instead of hanging on invalid input; audit log capped (1000-entry ring); redaction preserves Date/Map/Set state and recognizes Google API keys; withFailMode no longer lets a throwing observer break the fail-open policy; pattern payloads capped (browser elements/page text, rank candidates, migration SQL) with truncation markers; reserved 'none' candidate names rejected; isDuplicate no longer duplicates the item into every instruction; in-memory cache is true LRU and skips the models endpoint; decision digest is circular-safe; persistent cache only caches string bodies.

cli/eval: `jev eval` exits non-zero on failures (0/1/2 taxonomy, `--no-fail` opt-out), aborts fail fast, request/cost accounting counts every attempt and output tokens, single-pass tune sweep (O(n log n)), JSONL errors carry line numbers, neutral paths in the golden fixture and deterministic per-case ordering in the baseline recorder.

packaging/adapters: claude-code hook, github action, and gate/triage bundles are self-contained (esbuild-inlined core) so marketplace and Actions installs work without npm install; gh posting uses execFileSync (no shell); gate/triage read the documented github_token input; LICENSE shipped in every published package; engines/sideEffects/default export conditions added; internal workspace deps pinned ^0.2.0; claude-code plugin manifests stamped from package.json at build time.

ci: least-privilege permissions and concurrency guards on every workflow; new bundle-drift job fails CI on stale committed bundles; actions pinned to current majors.
