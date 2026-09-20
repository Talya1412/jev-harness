# jev-harness — agent memory

## Project Overview

Monorepo of TypeSafe Jev (System One decision model) integrations. Jev returns
calibrated probabilities for typed questions (`noul` / `choice` / `score`) —
it never emits prose. See @README.md for primitives and patterns.

- @packages/core — harness-agnostic client + patterns (`routeSkill`,
  `judgeDestructive` @ threshold 0.75, `chooseBrowserAction`, `pickTool`,
  `rankCandidates`) and the safety/verification set (`verifyClaim`,
  `detectPromptInjection`, `needsMoreContext`, `judgeRegression`,
  `triageUrgency`, `chooseSubagent`, `debateJudge`) plus transport infra
  (`withCache`, `jevBatch`, `withAudit`/`createAuditLog`, `localRouteSkill`).
  No framework imports. Built first; every adapter imports it.
- @packages/omp — OMP extension (5 tools + 3 hooks). Ships self-contained
  @packages/omp/bundle/extension.js via @packages/omp/scripts/bundle.mjs.
- @packages/mcp — MCP server over stdio (7 tools), run via `jev-harness-mcp` bin.
- @packages/claude-code — Claude Code plugin: PreToolUse destructive gate +
  skill routing. Ships compiled @packages/claude-code/dist + @packages/claude-code/hooks.
- @packages/pi — Pi extension (5 tools + 2 hooks).
- @packages/cli — `jev-gate` binary: one Jev judgment over a diff/file/stdin
  for CI and subagent gates.
- @packages/eval — pure calibration/tuning metrics (`brierScore`, `ece`,
  `rocAuc`, `prAuc`, `confusionMatrix`, `precisionRecallF1`) + `tune` sweep +
  `jev-tune` CLI. No Jev calls, no I/O in the lib layer; the CLI reads
  JSONL/JSON-array labeled data and prints best threshold + metrics.
- @packages/github — GitHub Action (`jev-review`): composes `judgeDestructive`
  + `triageUrgency` + `routeSkill` into an advisory PR comment. Posts via `gh`;
  fail-open (missing key or outage never fails the run). Ships `action.yml` +
  @packages/github/dist/action.js.
- @packages/jev-py — zero-dependency Python port of core (async client over
  `urllib`+`asyncio`, 3 primitives, all 12 patterns, transport infra) and
  `eval` (metrics + `tune`). `jev-tune` console script. Pure-stdlib: no
  runtime deps; `pytest` is a dev extra. NOT an npm workspace (no
  package.json) — run tests with `python -m pytest` from the package dir.
- @packages/playground — dependency-free static web UI (HTML/CSS/JS, no
  build). Composes state+questions, calls Jev or runs a deterministic mock
  when no key, and visualizes probabilities with a live threshold slider.
  Serve with `python -m http.server`. NOT an npm workspace.
- @packages/vscode — VS Code extension (CommonJS). Two fail-open commands:
  destructive-change gate + RAG verification gate. Decision logic in
  @packages/vscode/jev.js (minimal CJS port of core, injectable transport).
  Tests via `node --test` (no VS Code runtime needed).

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

## Architecture Notes

- Root `npm run build` builds `@jev-harness/core` before all adapters —
  adapters resolve core from the workspace, so core must exist first.
- Cross-workspace deps use `"*"` (claude-code pins `"^0.1.0"`); npm here
  does not use `workspace:*` syntax.
- Committed build output: `packages/omp/bundle/extension.js`,
  `packages/claude-code/dist/`, and `packages/github/dist/` are tracked in git
  (OMP's loader can't resolve bare imports; Claude Code executes a .js hook;
  GitHub Actions run `dist/action.js`). `dist/` of core/mcp/omp/pi/cli/eval is
  gitignored. Commit the bundle + claude-code + github dist whenever core or
  adapter sources change.
- CI (@.github/workflows/ci.yml) runs on push to `[master, main]` +
  PRs, matrix ubuntu/windows × node 20/22/24:
  `npm ci` → build → typecheck → test.

## Common Workflows

```bash
npm install            # workspace install (root)
npm run build          # core first, then all adapters (+ OMP bundle)
npm run typecheck      # tsc --noEmit per workspace
npm test               # vitest per workspace (--passWithNoTests outside core)
```

- Rebuild one adapter: `npm run build --workspace=@jev-harness/mcp`
  (core, mcp, claude-code, cli, pi) or `npm run bundle
  --workspace=@jev-harness/omp` for the OMP bundle alone.
- Test one package: `npm test --workspace=@jev-harness/core`.
- Never commit `.env` (gitignored); `.env.example` is the committed template.
