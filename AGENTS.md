# jev-harness — agent memory

## Project Overview

Monorepo of TypeSafe Jev (System One decision model) integrations. Jev returns
calibrated probabilities for typed questions (`noul` / `choice` / `score`) —
it never emits prose. See @README.md for primitives and patterns.

- @packages/core — harness-agnostic client + 28 patterns (`routeSkill`,
  `judgeDestructive` @ threshold 0.5, `chooseBrowserAction`, `pickTool`,
  `rankCandidates`, safety set `verifyClaim`/`detectPromptInjection`/...,
  devops set `commitGate`/`migrationSafety`/`testPrioritizer`/`secretLeak`/
  `dedupeItems`/`logSeverity`) plus infra: `redact` (state scrubbing,
  opt-in via `JevConfig.redact`), `createBudgetGuard` (rolling-window cap),
  `createPersistentCache`/`withPersistentCache` (disk cache with hit rate),
  `createDecisionLog`/`jsonlSink`/`decisionDigest` + `compare` flip-rate,
  `withCache`/`jevBatch`/`withAudit`/`localRouteSkill`, `withFailMode`.
  Families added 2026-09-25 (docs/superpowers/plans/2026-09-25-escalate-prune-review-patterns.md):
  `escalateOnLowConfidence` (tri-state escalation), `pruneContext` (non-destructive
  context pruning), `findingRealness`/`refutationFilter` (review judgments, loss-asymmetric).
  No framework imports. Built first; every adapter imports it.
- @packages/omp — OMP extension (1 tool `jev` + 5 hooks: gate, skill router,
  verbatim compaction, `before_agent_start` hint delivery, opt-in `tool_result`
  prune via OMP_JEV_PRUNE=1). Ships self-contained
  @packages/omp/bundle/extension.js via @packages/omp/scripts/bundle.mjs.
  Wires the budget guard (OMP_JEV_MAX_CALLS_PER_MIN, 0=off) + persistent
  cache (OMP_JEV_CACHE_DIR, OMP_JEV_CACHE_TTL_MS) into every call via
  `jevConfig()`; redaction on for hooks, off for the `jev` tool
  (OMP_JEV_REDACT 1/0 forces). Gate verdicts logged when
  OMP_JEV_DECISION_LOG is set.
- @packages/mcp — MCP server over stdio (12 tools incl. jev_classify/jev_escalate/
  jev_prune/jev_finding_realness/jev_refute), run via `jev-harness-mcp` bin.
- @packages/claude-code — Claude Code plugin: PreToolUse destructive gate +
  skill routing. Ships compiled @packages/claude-code/dist + @packages/claude-code/hooks.
  Redaction on by default (JEV_REDACT=0 disables).
- @packages/pi — Pi extension (5 tools + 2 hooks).
- @packages/cli — `jev` + `jev-gate` binaries: `jev ask/models/eval` and the
  semantic acceptance gate over a diff/file/stdin for CI and subagents.
- @packages/eval — calibration toolkit (`jev-eval`, `jev-tune`): binary
  metrics, reliability bins, threshold sweeps, multiclass/score metrics,
  Wilson CI, exact McNemar, paraphrase-invariance deltas, tune (f1/youden).
  Benchmarks in @packages/eval/golden, one baseline per dataset+question:
  destructive-gate.json (dev, 78) + destructive-gate.holdout.json (89, kept as
  a regression reference — see its $comment) + merge-gate.json (41, the two
  questions jev-gate-action asks over a PR diff). Cases carry
  `slice`/`pair`/`note`; the report breaks metrics down per slice and reports
  invariance; holdout LIVE recording: AUC 0.998, Brier 0.018.
  regression.test.ts globs every `*.baseline.json`, recomputes it from its own
  per-case rows, and enforces per-slice floors (negative-only slices are gated
  on fp==0 instead; obfuscation gets a lower recall floor);
  parity.test.ts pins TS metrics to the shared fixture that jev-py also
  asserts. Scripts: scripts/record-baseline.mjs (live recording; takes an
  optional out-path because a dataset can have several questions; retries the
  Cloudflare 403s that bursts provoke), scripts/check-regression.mjs (report
  vs baseline, aggregate + slices).
- @packages/github — `jev-review` GitHub Action (advisory PR comment).
- @packages/jev-gate-action — `jev-gate` GitHub Action: destructive +
  secret-leak + risk on a PR diff; advisory unless fail_on_block. Its two
  thresholds are measured on @packages/eval/golden/merge-gate.json
  (destructive 0.12, secret_leak 0.07 — both mid-gap, precision 1.00). Bundled
  dist/index.js committed.
- @packages/pr-triage-action — PR triage action (auth impact, risk, route).
- @packages/kit — shared adapter foundation (env config, envelope, router).
- @packages/jev-py — zero-dependency Python port (async client, patterns,
  infra, thresholds, taxonomy, eval+tune). NOT an npm workspace;
  `python -m pytest packages/jev-py` (pythonpath=src configured). test_parity.py
  shares @packages/eval/golden/parity-metrics.json with
  packages/eval/src/parity.test.ts and pins `jev_harness.THRESHOLDS` to
  @packages/eval/golden/parity-thresholds.json (generated from
  core/src/patterns.ts) plus the dual gate's wording against
  golden/destructive-gate-dual.json. Ports `with_map_reduce`,
  `create_refusal_ledger`, `judge_destructive_dual`, and the failure taxonomy;
  every pattern default reads the frozen `THRESHOLDS` table.
- @packages/vscode — VS Code extension (CJS, `node --test test.js`).

## Code Style Guidelines

- ESM only (`"type": "module"`), Node >= 20, TypeScript strict via `tsc -p`.
- Adapters are thin: decision logic lives in `@jev-harness/core`; never
  duplicate core code into an adapter (the OMP bundle inlines core at build
  time via esbuild — that is packaging, not a second source of truth).
- Keep credentials in env vars (`TYPESAFE_API_KEY`, optional
  `TYPESAFE_BASE_URL` / `TYPESAFE_DEFAULT_MODEL` / `JEV_TIMEOUT_MS`);
  never log them.
- Fail open: Jev errors must never block the agent — hooks catch and allow.
  Advisory output, except the destructive gate which is an explicit veto.
- Lint + format with the repo's ESLint (flat config, type-agnostic) and
  Prettier: `npm run lint`, `npm run format` (`npm run qa` runs the whole
  gate). Shared compiler options live in `tsconfig.base.json`; each package
  tsconfig only sets `rootDir` / `outDir` / `include` / `exclude`.
- On a machine with `NODE_ENV=production`, npm omits dev dependencies — use
  `npm install --include=dev` / `npm ci --include=dev` there.
- Never put a literal attack payload in a **shipped** file (a README that
  `files` includes, `dist`, a bundle). The registry's edge appears to apply the
  same class of filter as the Jev API: with the payload in a packaged README,
  `PUT @jev-harness/eval` answered `403 Forbidden` while every other package in
  the same release published fine, and removing it fixed the publish. Payloads
  observed blocked in request bodies: IFS word-splitting, and a runtime's
  shell-exec helper called inline. Describe the technique instead of quoting the
  bytes. Cost two failed 0.4.0 release runs on 2026-09-23.

## Architecture Notes

- Root `npm run build` builds `@jev-harness/core` before all adapters —
  adapters resolve core from the workspace, so core must exist first.
- Cross-workspace deps use `"*"` for every adapter; npm here does not use
  `workspace:*` syntax.
- Committed build output: `packages/omp/bundle/extension.js`,
  `packages/claude-code/dist/`, `packages/github/dist/`,
  `packages/pr-triage-action/dist/index.js`, and
  `packages/jev-gate-action/dist/index.js` are tracked in git (OMP's loader
  can't resolve bare imports; Claude Code executes a .js hook; GitHub
  Actions run their bundled entry directly). `dist/` of
  core/mcp/omp/pi/cli/eval/kit is gitignored. Rebuild + commit the bundle
  and committed dists whenever core or adapter sources change.
- CI (@.github/workflows/ci.yml) runs on push to `[master, main]` +
  PRs: a `lint` job (`format:check` + `lint` + informational `npm audit`),
  a matrix job ubuntu/windows × node 20/22/24
  (`npm ci` → build → typecheck → test), a `python` job running
  `pytest packages/jev-py/tests` (includes the TS parity fixture), and a
  `bundle-drift` job that fails on stale committed artifacts. Every job sets
  `timeout-minutes`. Other workflows: live-eval.yml (manual calibration run
  vs baseline), release.yml (changesets version PR + npm publish with
  provenance), pr-triage.yml. Dependabot (.github/dependabot.yml) covers
  npm, GitHub Actions, and pip weekly.

## Common Workflows

```bash
npm install            # workspace install (root)
npm run build          # core first, then all adapters (+ OMP bundle)
npm run typecheck      # tsc --noEmit per workspace
npm test               # vitest per workspace (--passWithNoTests outside core)
npm run lint           # eslint .
npm run format         # prettier --write .
npm run qa             # build + typecheck + lint + format:check + test
```

- Rebuild one adapter: `npm run build --workspace=@jev-harness/mcp`
  (core, mcp, claude-code, cli, pi) or `npm run bundle
--workspace=@jev-harness/omp` for the OMP bundle alone.
- Test one package: `npm test --workspace=@jev-harness/core`.
- Never commit `.env` (gitignored); `.env.example` is the committed template.
