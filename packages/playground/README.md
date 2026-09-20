# jev playground

A dependency-free web UI for composing Jev (System One) decisions and inspecting the calibrated probabilities — including a **live threshold slider** that flips a gate between BLOCKED and ALLOW in real time.

## Run

No build, no install. Serve the directory with any static server:

```bash
cd packages/playground
python3 -m http.server 5173
# open http://localhost:5173
```

## Using it

1. **config** (left): base URL, API key, model. Leave the key empty and the **mock** toggle on to demo the UI without any backend. (Real browser calls to `api.typesafe.ai` will be cross-origin; run a CORS proxy or point `baseUrl` at one.)
2. **state** (middle): arbitrary JSON sent as the `state`.
3. **questions** (middle): add as many `noul` / `choice` / `score` questions as you like — they are batched into one call.
4. **run jev** → **answers** (right): each answer renders as probability bars. For `noul`, drag the threshold to watch the gate flip. For `choice`, the picked option is marked. For `score`, the rubric cell under the score lights up.

## Files

- `index.html` — structure
- `style.css` — theme (CSS variables, matches the repo's dark aesthetic)
- `app.js` — logic: question editor, fetch/mock transport, rendering

The mock transport (`mockResponse` in `app.js`) produces deterministic-ish probabilities from the state content so the UI is fully demoable without a key.
