# Publishing the @jev-harness packages to npm

The repo is an npm workspace monorepo. The publishable packages share one
version (changesets `fixed` group) and depend on each other via `"*"`
(resolved inside the workspace, rewritten by `changeset version` on publish).

## Publishable vs private

| Package | Publish? | Notes |
|---|---|---|
| `@jev-harness/core` | ✅ | no workspace deps |
| `@jev-harness/kit` | ✅ | depends on core |
| `@jev-harness/eval` | ✅ | depends on core; ships `jev-eval` + `jev-tune` bins |
| `@jev-harness/cli` | ✅ | depends on core, eval, kit; ships `jev` bin |
| `@jev-harness/mcp` | ✅ | depends on core; ships MCP server bin |
| `@jev-harness/omp` | ✅ | standalone bundle, no workspace deps |
| `@jev-harness/pi` | ✅ | depends on core, kit |
| `@jev-harness/claude-code` | ✅ | depends on core; bundle is committed |
| `@jev-harness/github` | ✅ | depends on core; `dist/action.js` committed |
| `@jev-harness/playground` | ❌ | `private: true` — run it locally or host it yourself |
| `@jev-harness/pr-triage-action` | ❌ | `private: true` — consumed as a GitHub Action via `dist/index.js` |
| `@jev-harness/jev-gate-action` | ❌ | `private: true` — same shape as pr-triage-action |
| `@jev-harness/vscode` | ❌ | VS Code extension — package as a `.vsix`, not npm |
| `jev-py` (Python) | ❌ npm | publish to PyPI separately (`python -m build`, `twine upload`) |

## Release flow (changesets — the automated path)

1. **One-time setup**
   - npm token with publish rights to the `@jev-harness` scope, stored as the
     `NPM_TOKEN` repository secret.
   - The `@jev-harness` scope must exist on npm — create the org at
     <https://www.npmjs.com/org/new> (free for public packages) or rename
     first.
2. **Cut a release from any PR**: run `npm run changeset` locally, describe
   the change, and commit the generated `.changeset/*.md` file.
3. **Merge to master.** `.github/workflows/release.yml` (changesets/action)
   opens/updates a *Version Packages* PR; merging it publishes all changed
   packages with **npm provenance** (`id-token: write` +
   `--provenance`, repository fields are already set).

## Manual fallback

```sh
# pin inter-package ranges if publishing without changesets
grep -n '"@jev-harness/[^"]*": "\*"' packages/*/package.json

npm run build && npm run typecheck && npm test
npm run release   # npm publish --workspaces --access public --provenance
```

Check each package's " Tarball Details " in `npm publish --dry-run`:
`dist/` + `README.md` + `LICENSE` in, test files out. The `prepack` scripts
(where present) rebuild `dist/` automatically.

## GitHub Action (not npm)

`packages/pr-triage-action` is distributed as a GitHub Action, not a
package. Its `dist/index.js` is committed, so users reference it directly:

```yaml
- uses: Talya1412/jev-harness/packages/pr-triage-action@main
  with:
    typesafe_api_key: ${{ secrets.TYPESAFE_API_KEY }}
```

(Optionally wrap it with `actions/checkout` first if the runner needs the
repo context; see `packages/pr-triage-action/README.md` for the full
example.)
