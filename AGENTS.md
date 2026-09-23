# jev-harness — agent memory

## Project Overview

Monorepo of TypeSafe Jev (System One decision model) integrations. Jev returns
calibrated probabilities for typed questions (`noul` / `choice` / `score`) —
it never emits prose. See @README.md for primitives and patterns.

- @packages/core — harness-agnostic client + 21 patterns (`routeSkill`,
  `judgeDestructive` @ threshold 0.5, `chooseBrowserAction`, `pickTool`,
  `rankCandidates`, safety set `verifyClaim`/`detectPromptInjection`/...,
  devops set `commitGate`/`migrationSafety`/`testPrioritizer`/`secretLeak`/
  `dedupeItems`/`logSeverity`) plus infra: `redact` (state scrubbing,
  opt-in via `JevConfig.redact`), `createBudgetGuard` (rolling-window cap),
  `createPersistentCache`/`withPersistentCache` (disk cache with hit rate),
  `createDecisionLog`/`jsonlSink`/`decisionDigest` + `compare` flip-rate,
  `withCache`/`jevBatch`/`withAudit`/`localRouteSkill`, `withFailMode`.
  No framework imports. Built first; every adapter imports it.
- @packages/omp — OMP extension (5 tools + 3 hooks). Ships self-contained
  @packages/omp/bundle/extension.js via @packages/omp/scripts/bundle.mjs.
  Wires the budget guard (OMP_JEV_MAX_CALLS_PER_MIN, 0=off) + persistent
  cache (OMP_JEV_CACHE_DIR, OMP_JEV_CACHE_TTL_MS) into every call via
  `jevConfig()`; redaction on for hooks, off for jev_ask (OMP_JEV_REDACT
  1/0 forces). Gate verdicts logged when OMP_JEV_DECISION_LOG is set.
- @packages/mcp — MCP server over stdio (7 tools), run via `jev-harness-mcp` bin.
- @packages/claude-code — Claude Code plugin: PreToolUse destructive gate +
  skill routing. Ships compiled @packages/claude-code/dist + @packages/claude-code/hooks.
  Redaction on by default (JEV_REDACT=0 disables).
- @packages/pi — Pi extension (5 tools + 2 hooks).
- @packages/cli — `jev` + `jev-gate` binaries: `jev ask/models/eval` and the
  semantic acceptance gate over a diff/file/stdin for CI and subagents.
- @packages/eval — calibration toolkit (`jev-eval`, `jev-tune`): binary
  metrics, reliability bins, threshold sweeps, multiclass/score metrics,
  Wilson CI, exact McNemar, paraphrase-invariance deltas, tune (f1/youden).
  Benchmark for the destructive gate in @packages/eval/golden, TWO splits:
  @packages/eval/golden/destructive-gate.json (dev/tuning, 69 cases) and
  @packages/eval/golden/destructive-gate.holdout.json (holdout, 74 cases —
  never used to choose wording). Cases carry `slice`/`pair`/`note`; the
  report breaks metrics down per slice and reports invariance; holdout LIVE
  recording: AUC 0.996, Brier 0.020. regression.test.ts recomputes both
  baselines from their per-case rows and enforces per-slice floors;
  parity.test.ts pins TS metrics to the shared fixture that jev-py also
  asserts. Scripts: scripts/record-baseline.mjs (live recording; retries the
  Cloudflare 403s that bursts provoke), scripts/check-regression.mjs (report
  vs baseline, aggregate + slices).
- @packages/github — `jev-review` GitHub Action (advisory PR comment).
- @packages/jev-gate-action — `jev-gate` GitHub Action: destructive +
  secret-leak + risk on a PR diff; advisory unless fail_on_block. Bundled
  dist/index.js committed.
- @packages/pr-triage-action — PR triage action (auth impact, risk, route).
- @packages/kit — shared adapter foundation (env config, envelope, router).
- @packages/jev-py — zero-dependency Python port (async client, patterns,
  infra, eval+tune). NOT an npm workspace; `python -m pytest packages/jev-py`
  (pythonpath=src configured). test_parity.py shares @packages/eval/golden/
  parity-metrics.json with packages/eval/src/parity.test.ts.
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
