# jev-harness

Integrations for **[TypeSafe Jev](https://typesafe.ai)** — the System One decision model — across four agent harnesses.

Jev is not a chat model. You send it a `state` plus typed `questions` and it returns **calibrated probabilities** your code acts on directly. That makes it the right tool for routing, ranking, gating, and verification — anywhere you currently pay a chat model to emit JSON you immediately parse.

## Packages

| Package | Harness | Transport | Capabilities |
|---|---|---|---|
| [`@jev-harness/core`](packages/core) | — | — | Client, primitives, reusable patterns (no framework imports) |
| [`@jev-harness/omp`](packages/omp) | [Oh My Pi](https://github.com/can1357/oh-my-pi) | Extension | 5 tools + 3 hooks (incl. verbatim compaction) |
| [`@jev-harness/mcp`](packages/mcp) | Any MCP client | MCP over stdio | 7 tools |
| [`@jev-harness/claude-code`](packages/claude-code) | Claude Code | Plugin | PreToolUse gate + prompt skill routing |
| [`@jev-harness/pi`](packages/pi) | Pi | Extension | 5 tools + 2 hooks |

## Why Jev

**Cheaper than a chat model for closed-set decisions.** Input tokens bill at $0.042/Mtok and output tokens are free, because Jev emits probabilities, not prose. One call can carry many questions at once — they are evaluated independently against the same state, so batching is nearly free.

**Typed by construction.** A `choice` question cannot return a string outside its criteria map. It can still be *wrong* — calibration is not correctness — so keep thresholds and side effects in your own code and validate on your own labeled data.

## The three primitives

| Primitive | Asks | Returns |
|---|---|---|
| `noul` | Whether a condition holds | `noul`: P(yes), 0–1. No separate confidence field; ~0.5 means yes and no are equally likely. |
| `choice` | One of a defined set | `choice` (winner key) + `probabilities` + `confidence` |
| `score` | Degree along an ordered rubric | `score` (probability-weighted, can land between levels) + `probabilities` + `confidence` |

Mix them freely in one call:

```ts
import { askJev, choice, noul } from "@jev-harness/core";

const res = await askJev({ apiKey: process.env.TYPESAFE_API_KEY! }, {
  diff: "Changed the login redirect URL and session cookie flags.",
}, {
  touches_auth: { type: "noul", instructions: "Does this change affect authentication or session security?" },
  risk: {
    type: "score",
    instructions: "Security risk level",
    criteria: ["None", "Low", "Moderate", "High", "Critical"],
  },
  route: {
    type: "choice",
    instructions: "Who should review this?",
    criteria: { auto: "No human needed", peer: "Normal review", security: "Needs a security reviewer" },
  },
});

noul(res, "touches_auth");   // 0.97
score(res, "risk");          // { score: 2.02, ... }
choice(res, "route").choice; // "security"
```

## Reusable patterns

`@jev-harness/core` ships the patterns we validated in production, so every harness behaves identically:

- **`routeSkill`** — pick the right skill for a request. Sending **descriptions** matters: names alone route "test the login page in a browser" to a desktop-automation skill instead of the browser-testing one.
- **`judgeDestructive`** — gate a tool call on whether it destroys data. Tuned threshold 0.75.
- **`chooseBrowserAction`** — pick one browser action from a numbered element table. Advisory only; the caller validates the index against the live snapshot.
- **`pickTool`** — choose one tool from a candidate set and flag confirmation-worthy side effects.
- **`rankCandidates`** — score a list of strings against a task, best-first.

## Configuration

Every adapter resolves credentials the same way:

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `TYPESAFE_API_KEY` | yes | — | Bearer token from [console.typesafe.ai](https://console.typesafe.ai) |
| `TYPESAFE_BASE_URL` | no | `https://api.typesafe.ai` | Override the API host |
| `TYPESAFE_DEFAULT_MODEL` | no | `jev-latest` | Pin a model version once thresholds are tuned |
| `JEV_TIMEOUT_MS` | no | `15000` | Per-request timeout |

Credentials are read from the environment and never logged.

## Safety model

- **Fail open by default.** A Jev outage must never block your agent. Every hook catches its own errors and resolves to "allow".
- **Advisory, not authoritative.** Tools report a decision; code executes it. The one exception is the destructive gate, which is explicitly a veto.
- **No mid-conversation model switching.** Measured: switching models mid-stream invalidates the provider prompt cache and cost one deployment `$19.53` across 309 requests.
- **Append-only context injection.** Skill hints are appended to the user turn, never used to rewrite the system prefix.

## Development

```bash
npm install
npm run build
npm run typecheck
npm test
```

## License

Apache-2.0. See [LICENSE](LICENSE).
