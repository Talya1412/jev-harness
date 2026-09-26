# @jev-harness/mcp

## 0.6.0

### Minor Changes

- [`70c594d`](https://github.com/Talya1412/jev-harness/commit/70c594d5658e04a7237ec2c8b90e05f19c3f39c2) Thanks [@Talya1412](https://github.com/Talya1412)! - Expose core map-reduce as `jev_classify`: the same typed questions over a whole corpus.

  Core has shipped `withMapReduce` with no consumer: the dominant real-world Jev workload
  (score 100k posts, bucket 24k rows, classify 1,018 papers) was impossible from any adapter,
  so a caller with 1,000 items had to loop by hand and give up the batching, capping and
  reduce. The three corpus-facing surfaces now expose it:

  - `jev_classify` on the MCP server: `items` (strings or JSON), `questions`, optional `reduce`
    and `concurrency`. Returns `{ perItem, reduced, failures, reduceSkipped, usage }`.
  - `jev classify` in the CLI: JSONL corpus in (`--items`), one JSON result line per item out,
    `--questions` / `--reduce` / `--out` / `--concurrency`. Partial failures name the failing
    indices on stderr while every success is still emitted (exit 1).
  - `jev_classify` in the Pi extension, with the same semantics.

  The reduce step judges a capped digest of the per-item verdicts (200 items / 4000 chars in
  core), never the corpus. Core map-reduce is atomic, so a payload rejection (400/413/422) is
  retried item by item to attribute the failure; batch-level failures (missing key, auth, rate
  limit, network) keep failing the whole call.

  Cost is one request per item: `items x questions` judgments, plus one reduce call.

- [`1e93910`](https://github.com/Talya1412/jev-harness/commit/1e93910e389a6d72ff7a609d7f91fa7263aaeea5) Thanks [@Talya1412](https://github.com/Talya1412)! - Wire the three researched backlog features end-to-end.

  - **core**: four new patterns — `escalateOnLowConfidence` (tri-state
    accepted/escalated/unresolved; noul gates on an uncertainty band, choice/
    score on a confidence bar; anchor-free one-attempt escalation that always
    preserves the first result), `pruneContext` (state-size guard with zero
    requests before anything is judged, head+note replacement, input never
    mutated, error-shaped output on a strictly lower drop bar), and the review
    pair `findingRealness` + `refutationFilter` (asymmetric loss: drop only
    above 0.75 AND classed non-protected; missing answers always keep; severity
    never silently coerced).
  - **mcp**: `jev_escalate`, `jev_prune`, `jev_finding_realness`,
    `jev_refute` tools with fail-open envelopes and PROVISIONAL thresholds
    flagged in their schemas.
  - **omp**: opt-in `tool_result` prune hook (`OMP_JEV_PRUNE=1`, default off —
    every rewrite invalidates the provider prompt-cache prefix): idempotent,
    hard-caps oversized output locally instead of asking Jev, self-deadlines
    below the host's handler budget, fails open to the original result.

  Eight THRESHOLDS keys carry provenance (prune bars MEASURED cross-repo,
  escalate/refute/findingReal PROVISIONAL and labeled). Parity fixture and the
  jev-py thresholds table were updated in lockstep so TS and Python both pin the
  same 28-key frozen table.

### Patch Changes

- [`9996f9c`](https://github.com/Talya1412/jev-harness/commit/9996f9cdf0f3091e3f02dcd357d1f160aec664cf) Thanks [@Talya1412](https://github.com/Talya1412)! - Fix three defects in the OMP adapter that made shipped features inert, and give the
  adapters one shared foundation.

  **OMP adapter: features that could not run**

  - Verbatim compaction never activated. It matched only the Anthropic wire spellings
    (`tool_use` / `tool_result`); real OMP transcripts carry `toolCall` content blocks and
    separate `role: "toolResult"` messages. On a real 1,505-message transcript `flatten()`
    found 0 calls before and 720 after, and a region that used to defer `no-calls` now
    yields a plan. A truncated tool result also keeps its head plus a recoverable note
    instead of being dropped by the final join.
  - The `input` skill router could never fire: `ExtensionContext` has no `skills` member and
    `{`additionalContext`}` is not an `InputEventResult` field. The roster is now read from
    the skill roots on disk and the hint is delivered through `before_agent_start`, which
    the host turns into a message the model actually sees.
  - The `tool_call` gate could fail CLOSED. The host maps a timed-out handler to
    `{ block: true }`, and core's retry budget could exceed the host's 30 s handler
    timeout. The gate now threads the host `AbortSignal` and self-imposes an 8 s deadline,
    so it always settles and always fails open.

  **OMP adapter: surface and cost**

  - Five tools collapse to one `jev` tool with a `mode` parameter. `jev_ask` and
    `jev_models` are gone: OMP core already ships a native TypeSafe integration
    (`eval` prelude `judge()` / `judge_batch()`, `omp models typesafe`).
  - The destructive gate asks two questions with an explicit abstain and returns
    `allow` / `block` / `confirm`, so a genuine-but-uncertain call has a path forward
    instead of a silent hard block.
  - Added a failure taxonomy, a refusal ledger, a ranked-merge skill router with debounce
    and single-flight, and documentation for five previously undocumented env vars.

  **One shared foundation**

  `@jev-harness/kit` is now the single env→config rule; `pi`, `mcp`, `claude-code` and
  `omp` use it, each keeping its own redaction policy through an explicit option rather
  than a private copy. Removes a dead dependency, a duplicated lexical shortlist (which
  existed in three places, one of them imported by nobody), and six copies of the same
  credential reader.

  **Thresholds measured, not guessed**

  `THRESHOLDS` centralises every tuned number. The dual gate's dataset and baseline were
  recorded live: AUC 1.000, Brier 0.0165, and a noiseless plateau of [0.40, 0.56] — one
  case narrower than the previously documented [0.4, 0.6]. The interpreter invocation that
  the old single-question gate blocked at 0.84 now scores 0.07.

  **New in core**: `THRESHOLDS`, `judgeDestructiveDual`, `classifyJevFailure` /
  `policyForFailure`, `createRefusalLedger`, `withMapReduce`.

- Updated dependencies [[`716583b`](https://github.com/Talya1412/jev-harness/commit/716583bed9c8770ee980735a2d9e81ed24c47cf7), [`1e93910`](https://github.com/Talya1412/jev-harness/commit/1e93910e389a6d72ff7a609d7f91fa7263aaeea5), [`9996f9c`](https://github.com/Talya1412/jev-harness/commit/9996f9cdf0f3091e3f02dcd357d1f160aec664cf)]:
  - @jev-harness/core@0.6.0
  - @jev-harness/kit@0.6.0

## 0.5.0

### Minor Changes

- [`44ce141`](https://github.com/Talya1412/jev-harness/commit/44ce14196a9e6a345f63ba9f9f131801b8b7dddb) Thanks [@Talya1412](https://github.com/Talya1412)! - Grow the benchmark further and use it to tune the merge gate.

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

### Patch Changes

- Updated dependencies [[`44ce141`](https://github.com/Talya1412/jev-harness/commit/44ce14196a9e6a345f63ba9f9f131801b8b7dddb)]:
  - @jev-harness/core@0.5.0

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

### Patch Changes

- Updated dependencies [[`2007a3c`](https://github.com/Talya1412/jev-harness/commit/2007a3c47f5bc05a4c3489edd446c233d136b8af)]:
  - @jev-harness/core@0.4.0

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

### Patch Changes

- Updated dependencies [[`35f21a9`](https://github.com/Talya1412/jev-harness/commit/35f21a97b5b4e64de850562e9b9ed5732ab8793f)]:
  - @jev-harness/core@0.3.0

## 0.2.2

### Patch Changes

- [`18ac30f`](https://github.com/Talya1412/jev-harness/commit/18ac30f7c6554bb1d9b1e358006284b0d641b728) Thanks [@Talya1412](https://github.com/Talya1412)! - Reformat the sources with Prettier, clear the lint findings, and rebuild the
  committed bundles. No behavior change; also fills in package metadata
  (`keywords`, `publishConfig`).
- Updated dependencies [[`18ac30f`](https://github.com/Talya1412/jev-harness/commit/18ac30f7c6554bb1d9b1e358006284b0d641b728)]:
  - @jev-harness/core@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [[`b25554c`](https://github.com/Talya1412/jev-harness/commit/b25554cb7081763d510293f83053055fd7d55711)]:
  - @jev-harness/core@0.2.1

## 0.2.0

### Patch Changes

- Updated dependencies [[`8601008`](https://github.com/Talya1412/jev-harness/commit/8601008c9409a1e2bd63eb2cc7a4b6f75fdf53d3)]:
  - @jev-harness/core@0.2.0
