# Publishing the @jev-harness packages to npm

The repo is an npm workspace monorepo. All packages share version `0.1.0`
and depend on each other via `"*"` (resolved inside the workspace). Before
publishing you must pin those inter-package ranges — npm refuses to publish
a package whose dependency is `"*"` pointing at a workspace sibling without
a real version.

## Publishable vs private

| Package | Publish? | Notes |
|---|---|---|
| `@jev-harness/core` | ✅ | no workspace deps |
| `@jev-harness/kit` | ✅ | depends on core |
| `@jev-harness/eval` | ✅ | depends on core; ships `jev-eval` bin |
| `@jev-harness/cli` | ✅ | depends on core, eval, kit; ships `jev` bin |
| `@jev-harness/mcp` | ✅ | depends on core; ships MCP server bin |
| `@jev-harness/omp` | ✅ | standalone bundle, no workspace deps |
| `@jev-harness/pi` | ✅ | depends on core, kit |
| `@jev-harness/claude-code` | ✅ | depends on core; bundle is committed |
| `@jev-harness/playground` | ❌ | `private: true` — run it locally or host it yourself |
| `@jev-harness/pr-triage-action` | ❌ | `private: true` — consumed as a GitHub Action via `dist/index.js` |

## One-time setup

1. **npm account + token.** Create an access token at
   <https://www.npmjs.com/settings/~/tokens> (a *Granular* token scoped to
   publish for the `@jev-harness` org, or a classic *Automation* token).
   The `@jev-harness` scope must exist on npm — create the org at
   <https://www.npmjs.com/org/new> (free for public packages) or change the
   package names first.
2. **Export the token** in the shell you publish from:
   ```sh
   export NODE_AUTH_TOKEN=npm_xxxxxxxxxxxx
   ```
3. **Pin inter-package versions.** Replace every `"@jev-harness/*": "*"`
   with the concrete range, e.g. `"^0.1.0"`:
   ```sh
   # quick check of what needs pinning
   grep -n '"@jev-harness/[^"]*": "\*"' packages/*/package.json
   ```
   `packages/claude-code` already uses `"^0.1.0"`; the others need the swap.
4. **Verify each package ships what you expect:**
   ```sh
   npm run build && npm run typecheck && npm test
   for p in core kit eval cli mcp omp pi claude-code; do
     echo "== $p =="; npm publish --dry-run -w @jev-harness/$p
   done
   ```
   Check the " Tarball Details " block: package size, file count, and that
   `dist/` + `README.md` + `LICENSE` are included and no test files leak in.

## Publishing

From the repo root, in dependency order (core → kit → eval → cli, then the
independents):

```sh
npm publish -w @jev-harness/core
npm publish -w @jev-harness/kit
npm publish -w @jev-harness/eval
npm publish -w @jev-harness/cli
npm publish -w @jev-harness/mcp
npm publish -w @jev-harness/omp
npm publish -w @jev-harness/pi
npm publish -w @jev-harness/claude-code
```

Notes:

- First publish of each package must **not** use `--access` explicitly for
  public orgs; if the org is private-default, add `--access public`.
- The `prepack` scripts (where present) rebuild `dist/` automatically, so a
  clean checkout publishes the same artifact CI verified.
- The `bin` entries (`jev`, `jev-eval`, MCP server) are wired in each
  package's `package.json`; npm links them on global install.

## After the first release

- Tag the commit: `git tag v0.1.0 && git push origin v0.1.0`.
- For later releases use
  [`changesets`](https://github.com/changesets/changesets) or bump all
  `version` fields together, then re-pin the inter-package ranges before
  publishing again.
- Optional: add provenance by publishing from CI with
  `id-token: write` + `npm publish --provenance` (works with the existing
  GitHub Actions workflow once you add a release job).

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
