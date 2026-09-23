# jev-harness (VS Code)

Inline Jev (System One) decisions in VS Code. Two fail-open gates:

- **jev: review active file for destructive changes** — runs the `judgeDestructive` gate (threshold 0.75, the one true veto) over the active editor's content and shows `P(destructive)` + a `BLOCKED` / `ALLOW` verdict in a side panel.
- **jev: verify selection as a claim** — treats the selection as a claim and the file body as the source, runs the RAG verification gate, and shows `SUPPORTED` / `UNSUPPORTED`.

Fail-open by design: with no API key, the commands only explain — nothing is ever hard-stopped.

## Configure

`Code` → `Settings` → search `jev-harness`:

| setting                 | default                   | notes                                           |
| ----------------------- | ------------------------- | ----------------------------------------------- |
| `jev-harness.apiKey`    | `""`                      | TypeSafe key. Falls back to `TYPESAFE_API_KEY`. |
| `jev-harness.baseUrl`   | `https://api.typesafe.ai` | Point at a proxy if your network requires it.   |
| `jev-harness.model`     | `jev-latest`              |                                                 |
| `jev-harness.threshold` | `0.75`                    | Destructive-gate threshold.                     |

## Run from source (dev)

Open `packages/vscode` in VS Code and press `F5` (an Extension Development Host launches the commands). Or build a `.vsix` with `npx @vscode/vsce package` after `npm i`.

## Test the core (no VS Code needed)

```bash
cd packages/vscode && npm test               # uses node:test + a fake transport
```

`jev.js` is a minimal CJS port of `@jev-harness/core` (`askJev` + `noul`/`choice`/`score` + the three patterns the commands use), with an injectable transport so it is unit-tested without VS Code. It mirrors 3 core patterns (`judgeDestructive`, `verifyClaim`, `triageUrgency`) and must be hand-synced when their wording changes — there is no build step linking them.

## License

Apache-2.0.
