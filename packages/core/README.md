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

const res = await askJev(
  { apiKey: process.env.TYPESAFE_API_KEY! },
  {
    diff: "Changed the login redirect URL and session cookie flags.",
  },
  {
    touches_auth: {
      type: "noul",
      instructions: "Does this change affect authentication or session security?",
    },
    risk: {
      type: "score",
      instructions: "Security risk level",
      criteria: ["None", "Low", "Moderate", "High", "Critical"],
    },
  },
);

noul(res, "touches_auth"); // 0.97
score(res, "risk").score; // 2.02
```

## API

### Transport

| Function                                               | Purpose                                                                                               |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `askJev(config, state, questions, signal?)`            | One System One call; batches every question into a single request.                                    |
| `listJevModels(config)`                                | Models available to the key.                                                                          |
| `noul(res, id)` / `choice(res, id)` / `score(res, id)` | Typed accessors. Each throws on a missing or wrong-typed answer, so you never narrow a union by hand. |
| `validateQuestions(questions)`                         | Validates before spending a request.                                                                  |

### Patterns

| Function                                                             | Purpose                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routeSkill(config, message, skills, opts?)`                         | Pick the right skill for a request. Pass descriptions.                                                                                                                                                                                                                                 |
| `judgeDestructive(config, call, opts?)`                              | Whether a tool call destroys data. Default threshold 0.5.                                                                                                                                                                                                                              |
| `chooseBrowserAction(config, input, opts?)`                          | One browser action from a numbered element table. Advisory.                                                                                                                                                                                                                            |
| `pickTool(config, input, opts?)`                                     | One tool from a candidate set, with a confirmation flag.                                                                                                                                                                                                                               |
| `rankCandidates(config, task, candidates, opts?)`                    | Score a list best-first.                                                                                                                                                                                                                                                               |
| `gateInjection(config, { source, content }, opts?)`                  | Prompt-injection gate for untrusted content before it reaches the model. Default threshold 0.7.                                                                                                                                                                                        |
| `detectPromptInjection(config, { content, role?, context? }, opts?)` | The same injection decision screened at a different point: content about to be appended to an already-trusted conversation. Default threshold 0.6. See `THRESHOLDS.detectPromptInjection`.                                                                                             |
| `verifyStep(config, { task, report, evidence? }, opts?)`             | Did the work satisfy the task? Cheap post-hoc critic. Default threshold 0.6.                                                                                                                                                                                                           |
| `needsClarification(config, { message, recent? }, opts?)`            | Detect a genuine ambiguity fork worth one clarifying question. Default threshold 0.5.                                                                                                                                                                                                  |
| `isDuplicate(config, item, existing, opts?)`                         | Semantic dedup; one batched request, one `noul` per candidate. Default threshold 0.5.                                                                                                                                                                                                  |
| `routeEffort(config, { task, context? }, opts?)`                     | Cheap-vs-expensive model routing for a task. Default threshold 0.5.                                                                                                                                                                                                                    |
| `judgeDestructiveDual(config, call, opts?)`                          | Destructive gate with a way forward: one `noul` plus one `choice` in a single request, returning `allow` / `block` / `confirm`. `confirm` means "genuine but uncertain — re-issue with explicit user confirmation" instead of a silent hard block. Never throws on a malformed answer. |

```ts
const verdict = await judgeDestructiveDual(config, { tool: "bash", input: { cmd } });
if (verdict.decision === "block") return veto(verdict);
if (verdict.decision === "confirm") return askUser(verdict);
```

Every numeric threshold lives in one frozen object — import it instead of hardcoding a number,
so tuning after measuring on your own labeled data reaches every harness at once:

```ts
import { THRESHOLDS } from "@jev-harness/core";

THRESHOLDS.destructiveGate; // 0.5 — judgeDestructive / judgeDestructiveDual
THRESHOLDS.skillRouting; // 0.5 — routeSkill
THRESHOLDS.gateInjection; // 0.7 — gateInjection (pre-context screen)
THRESHOLDS.detectPromptInjection; // 0.6 — detectPromptInjection (append-to-trusted screen)
// One decision, two entry points: the 0.1 gap is deliberate but UNMEASURED —
// no injection dataset exists in @jev-harness/eval. Don't merge the keys
// without recording one and measuring the change first.
THRESHOLDS.duplicate; // 0.5 — isDuplicate / dedupeItems / commitGate secret floor
THRESHOLDS.categoryConfidence; // 0.5 — below this the dual gate confirms instead of blocking
```

The remaining public defaults live in the same object (`verifyStep`, `clarification`,
`effortRouting`, `browserAction`, `toolPick`, `toolRisk`, `claimSupport`,
`contextSufficiency`, `regression`, `subagentPick`, `delegation`, `commitSafe`,
`secretLeak`, `localRouterFloor`); every pattern keeps its per-call override.

### Caching, coalescing, failure policy

| Export                                                | Purpose                                                                                                                                                                                  |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createJevCache({ ttlMs?, maxEntries? })`             | Bounded TTL cache for Jev responses.                                                                                                                                                     |
| `createCachedClient(config, opts?)`                   | `ask()` with transparent response caching.                                                                                                                                               |
| `createCoalescer(config, { windowMs? })`              | Merges concurrent same-state `ask` calls into one request.                                                                                                                               |
| `stableStringify(value)` / `fnv1a(text)`              | Deterministic JSON and hashing for custom keys.                                                                                                                                          |
| `withFailMode(mode, fn, { open, closed, onError? })`  | Explicit fail-open / fail-closed / throw policy per call site.                                                                                                                           |
| `withMapReduce(config, items, buildQuestions, opts?)` | The same questions over a huge corpus: one call per item (bounded concurrency), plus one optional reduce call whose state is a capped digest of the per-item answers — never the corpus. |
| `createRefusalLedger({ now?, max? })`                 | Refusals folded by exact `(key, reason)`: one fixed sentence per diagnosis, never the same sentence twice. Newest 200 distinct entries kept.                                             |

### Failure taxonomy

Classify a caught error once, then apply its policy. Nothing here throws, so it works on whatever
you caught — including a bare `TypeError` from `fetch`.

| Export                    | Purpose                                                                                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `classifyJevFailure(err)` | 401/403 → `auth`, 404 + "model" → `model`, 429 → `rate_limit`, fetch/abort → `network`, ≥500 → `server`, else `unknown`.                                              |
| `policyForFailure(kind)`  | `retryable`, `backoffMs` (honours `Retry-After`, else 30s), `disableSession`, `silent`. Pass the error to tighten a policy whose `retryable: false` is already final. |
| `retryAfterMs(err)`       | `Retry-After` in ms, from a `Headers`, a `Map`, a plain object, or an HTTP date.                                                                                      |

`auth` and `model` disable the session (retrying can never succeed); `network` retries silently;
`rate_limit` waits out the advertised window.

### Config

```ts
interface JevConfig {
  apiKey: string; // required
  baseUrl?: string; // default https://api.typesafe.ai
  model?: string; // default jev-latest
  timeoutMs?: number; // default 15000
  maxAttempts?: number; // default 3 (429 / 5xx / network only)
  fetchImpl?: typeof fetch; // injectable, for tests
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
