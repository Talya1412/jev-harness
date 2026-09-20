# @jev-harness/playground

A local playground for **[TypeSafe Jev](https://typesafe.ai)** — the System
One decision model. Paste a `state`, paste typed `questions`, and watch the
calibrated probabilities come back: no chat model, no JSON parsing, no
guessing about thresholds.

## Run

```bash
# from the repo root — the server reads TYPESAFE_API_KEY from the environment
npm run playground
# → http://localhost:4173  (binds 0.0.0.0; honors PORT)
```

Requires `TYPESAFE_API_KEY` in the server environment (`TYPESAFE_BASE_URL`,
`TYPESAFE_DEFAULT_MODEL`, and `JEV_TIMEOUT_MS` are honored too).

## What it does

- **Four presets** — destructive gate, PR triage, injection gate, skill
  routing — each filling realistic state + questions to edit from.
- **Typed rendering** — `noul` shows P(yes) as a bar; `choice` shows the
  winner plus per-option probability bars; `score` shows the weighted level
  with per-level probabilities.
- **Cost chips** — latency, token counts, and the input-token cost estimate
  (Jev output tokens are free).
- **Raw response** — the full JSON, one click away.

## Architecture

Zero dependencies beyond `@jev-harness/core`:

- `src/server.mjs` — `node:http` static server for `public/` plus a thin
  `POST /api/ask` proxy. The API key stays in the server environment and is
  never sent to the browser; the page talks only to this server.
- `public/index.html` — single-file UI (vanilla JS + CSS, no build step).

The playground is a developer tool, not a deployment target — it exists to
make question design fast: edit the wording, re-run, watch the probabilities
move. When a question looks right, lock it in with labeled-data validation
via [`@jev-harness/eval`](../eval).

## License

Apache-2.0.
