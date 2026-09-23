# Contributing

Thanks for taking the time to contribute. This is an npm-workspace monorepo of
[TypeSafe Jev](https://typesafe.ai) integrations — agent harness adapters, CI
actions, CLIs, and editor extensions.

For a deeper tour of the architecture, read [`AGENTS.md`](AGENTS.md) and the
[`README`](README.md).

## Prerequisites

- Node.js >= 20 (see [`.nvmrc`](.nvmrc); `nvm use` picks it up)
- npm (the repo pins `packageManager` in the root `package.json`)
- Python 3.9+ only if you work on `packages/jev-py`

## Setup

```bash
npm install
npm run build      # core first, then kit, eval, and every adapter
```

> On a machine with `NODE_ENV=production`, npm omits dev dependencies. Pass
> `--include=dev` to `npm install` / `npm ci` in that case.

## Everyday commands

```bash
npm run build          # compile all workspaces (+ committed bundles)
npm run typecheck      # tsc --noEmit per workspace
npm test               # vitest per workspace (+ jev-py is separate)
npm run lint           # eslint .
npm run format         # prettier --write .
npm run format:check   # prettier --check .
npm run qa             # build + typecheck + lint + format:check + test
```

Single workspace:

```bash
npm test --workspace=@jev-harness/core
npm run build --workspace=@jev-harness/mcp
npm run bundle --workspace=@jev-harness/omp   # rebuild the OMP bundle only
```

Python:

```bash
python -m pytest packages/jev-py/tests -q
```

## Guidelines

- **ESM only**, TypeScript strict via `tsc`. Lint and format with the repo's
  ESLint + Prettier config — run `npm run qa` before pushing; CI enforces it.
- **Adapters stay thin.** Decision logic lives in `@jev-harness/core`; never
  duplicate core code into an adapter. The OMP bundle inlines core at build time
  — that is packaging, not a second source of truth.
- **Fail open.** Jev errors must never block the agent — hooks catch and allow.
  Output is advisory, except the destructive gate, which is an explicit veto.
- **Never log credentials.** Keep `TYPESAFE_API_KEY` and friends in the
  environment; never commit `.env` (only `.env.example` is tracked).

## Committed build artifacts

A few bundles are checked into git because their consumers load them directly
(OMP has no bare-import resolution, Claude Code executes a compiled hook, and
GitHub Actions run their bundled entrypoint). **Whenever you change `core` or an
adapter's sources, rebuild and commit them:**

```bash
npm run build
git add packages/omp/bundle packages/claude-code/dist packages/claude-code/.claude-plugin \
        packages/github/dist packages/pr-triage-action/dist/index.js packages/jev-gate-action/dist/index.js
```

CI's `bundle-drift` job rebuilds these and fails on any diff.

## Releases (changesets)

Published packages share one version (`fixed` group). To ship a change:

1. Run `npm run changeset` and describe the change; commit the generated
   `.changeset/*.md`.
2. Merge to `master`. The release workflow opens a **Version Packages** PR.
3. Merging that PR publishes to npm with provenance.

## Pull requests

- Keep changes focused; one logical change per PR.
- Add tests for behavior changes and a changeset for published-package changes.
- Fill in the PR template and make sure CI is green.
- Report security issues privately — see [`SECURITY.md`](SECURITY.md).

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
