# @jev-harness/core

Harness-agnostic client and reusable patterns for **[TypeSafe Jev](https://typesafe.ai)** — the System One decision model.

No framework imports. Works in Node 18+, Bun, Deno, and edge runtimes that provide `fetch`.

## Install

```bash
npm install @jev-harness/core
```

## Usage

```ts
import { askJev, noul, choice, score } from "@jev-harness/core";

const res = await askJev({ apiKey: process.env.TYPESAFE_API_KEY! }, {
  diff: "Changed the login redirect URL and session cookie flags.",
}, {
  touches_auth: { type: "noul", instructions: "Does this change affect authentication or session security?" },
  risk: {
    type: "score",
    instructions: "Security risk level",
    criteria: ["None", "Low", "Moderate", "High", "Critical"],
  },
});

noul(res, "touches_auth");          // 0.97
score(res, "risk").score;           // 2.02
```

## API

### Transport

| Function | Purpose |
|---|---|
| `askJev(config, state, questions, signal?)` | One System One call; batches every question into a single request. |
| `listJevModels(config)` | Models available to the key. |
| `noul(res, id)` / `choice(res, id)` / `score(res, id)` | Typed accessors. Each throws on a missing or wrong-typed answer, so you never narrow a union by hand. |
| `validateQuestions(questions)` | Validates before spending a request. |

### Patterns

| Function | Purpose |
|---|---|
| `routeSkill(config, message, skills, opts?)` | Pick the right skill for a request. Pass descriptions. |
| `judgeDestructive(config, call, opts?)` | Whether a tool call destroys data. Default threshold 0.75. |
| `chooseBrowserAction(config, input, opts?)` | One browser action from a numbered element table. Advisory. |
| `pickTool(config, input, opts?)` | One tool from a candidate set, with a confirmation flag. |
| `rankCandidates(config, task, candidates, opts?)` | Score a list best-first. |

### Config

```ts
interface JevConfig {
  apiKey: string;                 // required
  baseUrl?: string;               // default https://api.typesafe.ai
  model?: string;                 // default jev-latest
  timeoutMs?: number;             // default 15000
  maxAttempts?: number;           // default 3 (429 / 5xx / network only)
  fetchImpl?: typeof fetch;       // injectable, for tests
  onRetry?: (attempt, error) => void;
}
```

## Error handling

All failures throw `JevError` with `status` (when HTTP) and `retryable`. Automatic retries cover 429, 5xx, network errors, and timeouts with quadratic backoff. A 4xx other than 429 is never retried.

Adapters built on this package **fail open**: a Jev outage resolves to "allow"/"no suggestion" rather than blocking the host agent.

## Notes on Jev semantics

- `confidence` reflects the concentration of a probability distribution, not the correctness of the workflow. Tune thresholds on your own labeled data.
- A structurally valid answer can still be wrong. Keep side effects and thresholds in your code.
- Text-only, English-primary, 64k tokens per request.

## License

Apache-2.0.
