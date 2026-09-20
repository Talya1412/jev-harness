# jev-harness — agent memory

## Project Overview

Monorepo of TypeSafe Jev (System One decision model) integrations. Jev returns
calibrated probabilities for typed questions (`noul` / `choice` / `score`) —
it never emits prose. See @README.md for primitives and patterns.

- @packages/core — harness-agnostic client + patterns (`routeSkill`,
  `judgeDestructive` @ threshold 0.75, `chooseBrowserAction`, `pickTool`,
  `rankCandidates`). No framework imports. Built first; every adapter imports it.
- @packages/omp — OMP extension (5 tools + 3 hooks). Ships self-contained
  @packages/omp/bundle/extension.js via @packages/omp/scripts/bundle.mjs.
- @packages/mcp — MCP server over stdio (7 tools), run via `jev-harness-mcp` bin.
- @packages/claude-code — Claude Code plugin: PreToolUse destructive gate +
  skill routing. Ships compiled @packages/claude-code/dist + @packages/claude-code/hooks.
- @packages/pi — Pi extension (5 tools + 2 hooks).
- @packages/cli — `jev-gate` binary: one Jev judgment over a diff/file/stdin
  for CI and subagent gates.

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
- Committed build output: `packages/omp/bundle/extension.js` and
  `packages/claude-code/dist/` are tracked in git (OMP's loader can't
  resolve bare imports; Claude Code executes a .js hook). `dist/` of
  core/mcp/omp/pi is gitignored. Commit the bundle + claude-code dist
  whenever core or adapter sources change.
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
