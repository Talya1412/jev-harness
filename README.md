# jev-harness

[![CI](https://github.com/Talya1412/jev-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/Talya1412/jev-harness/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@jev-harness/core.svg)](https://www.npmjs.com/package/@jev-harness/core)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

Integrations for **[TypeSafe Jev](https://typesafe.ai)** — the System One decision model — across fourteen packages spanning agent harnesses, CI actions, CLIs, and editor extensions.

Jev is not a chat model. You send it a `state` plus typed `questions` and it returns **calibrated probabilities** your code acts on directly. That makes it the right tool for routing, ranking, gating, and verification — anywhere you currently pay a chat model to emit JSON you immediately parse.

## Packages

| Package                                                      | Harness                                         | Transport                    | Capabilities                                                                   |
| ------------------------------------------------------------ | ----------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------ |
| [`@jev-harness/core`](packages/core)                         | —                                               | —                            | Client, primitives, 23 patterns, redaction, budget guard, caches, decision log |
| [`@jev-harness/omp`](packages/omp)                           | [Oh My Pi](https://github.com/can1357/oh-my-pi) | Extension                    | 5 tools + 3 hooks (incl. verbatim compaction)                                  |
| [`@jev-harness/mcp`](packages/mcp)                           | Any MCP client                                  | MCP over stdio               | 7 tools                                                                        |
| [`@jev-harness/claude-code`](packages/claude-code)           | Claude Code                                     | Plugin                       | PreToolUse gate + prompt skill routing                                         |
| [`@jev-harness/pi`](packages/pi)                             | Pi                                              | Extension                    | 5 tools + 2 hooks                                                              |
| [`@jev-harness/eval`](packages/eval)                         | —                                               | `jev-eval` + `jev-tune` CLIs | Labeled-dataset evaluation, calibration, threshold sweeps, golden baselines    |
| [`@jev-harness/github`](packages/github)                     | GitHub Actions                                  | Action                       | `jev-review`: advisory PR review comment (fail-open)                           |
| [`@jev-harness/jev-gate-action`](packages/jev-gate-action)   | GitHub Actions                                  | Action                       | Semantic acceptance gate: destructive + secret-leak + risk on a PR diff        |
| [`@jev-harness/pr-triage-action`](packages/pr-triage-action) | GitHub Actions                                  | Action                       | PR triage: auth impact, risk score, review routing                             |
| [`@jev-harness/kit`](packages/kit)                           | —                                               | —                            | Shared adapter foundation: env config, result envelope, core-pattern plumbing  |
| [`@jev-harness/playground`](packages/playground)             | —                                               | `npm run playground`         | Local web playground: state + questions → live probabilities                   |
| [`@jev-harness/cli`](packages/cli)                           | CI / subagent workflows                         | `jev` + `jev-gate` CLIs      | `jev ask/models/eval` terminal access + `jev-gate` semantic acceptance gate    |
| [`jev-py`](packages/jev-py)                                  | Python                                          | stdlib-only client           | Async client, 12+ patterns, eval + tune (parity-tested against the TS metrics) |
| [`@jev-harness/vscode`](packages/vscode)                     | VS Code                                         | Extension                    | Destructive-change gate + claim verification, fail-open                        |

## Why Jev

**Cheaper than a chat model for closed-set decisions.** Input tokens bill at $0.042/Mtok and output tokens are free, because Jev emits probabilities, not prose. One call can carry many questions at once — they are evaluated independently against the same state, so batching is nearly free.

**Typed by construction.** A `choice` question cannot return a string outside its criteria map. It can still be _wrong_ — calibration is not correctness — so keep thresholds and side effects in your own code and validate on your own labeled data.

## The three primitives

| Primitive | Asks                           | Returns                                                                                      |
| --------- | ------------------------------ | -------------------------------------------------------------------------------------------- |
| `noul`    | Whether a condition holds      | `noul`: P(yes), 0–1. No separate confidence field; ~0.5 means yes and no are equally likely. |
| `choice`  | One of a defined set           | `choice` (winner key) + `probabilities` + `confidence`                                       |
| `score`   | Degree along an ordered rubric | `score` (probability-weighted, can land between levels) + `probabilities` + `confidence`     |

Mix them freely in one call:

```ts
import { askJev, choice, noul } from "@jev-harness/core";

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
    route: {
      type: "choice",
      instructions: "Who should review this?",
      criteria: {
        auto: "No human needed",
        peer: "Normal review",
        security: "Needs a security reviewer",
      },
    },
  },
);

noul(res, "touches_auth"); // 0.97
score(res, "risk"); // { score: 2.02, ... }
choice(res, "route").choice; // "security"
```

## Reusable patterns

`@jev-harness/core` ships the patterns we validated in production, so every harness behaves identically:

- **`routeSkill`** — pick the right skill for a request. Sending **descriptions** matters: names alone route "test the login page in a browser" to a desktop-automation skill instead of the browser-testing one.
- **`judgeDestructive`** — gate a tool call on whether it destroys data. Tuned threshold 0.75.
- **`chooseBrowserAction`** — pick one browser action from a numbered element table. Advisory only; the caller validates the index against the live snapshot.
- **`pickTool`** — choose one tool from a candidate set and flag confirmation-worthy side effects.
- **`rankCandidates`** — score a list of strings against a task, best-first.
- **`gateInjection`** — gate untrusted tool results and fetched pages for prompt injection _before_ they reach the model. Threshold 0.7.
- **`verifyStep`** — did the finished work actually satisfy the task? Jev as a cheap critic; loop only when `done` is false.
- **`needsClarification`** — detect a genuine fork (two materially different readings) so the agent asks before burning tokens on a wrong guess.
- **`isDuplicate`** — semantic dedup of memory entries and tool results in one batched call.
- **`routeEffort`** — decide whether a task deserves the expensive model or the cheap fast tier.

Safety and verification patterns (`verifyClaim`, `detectPromptInjection`, `needsMoreContext`, `judgeRegression`, `triageUrgency`, `chooseSubagent`, `debateJudge`) and devops patterns (`commitGate`, `migrationSafety`, `testPrioritizer`, `secretLeak`, `dedupeItems`, `logSeverity`) ship in the same package — every one is a single batched call with overridable thresholds.

## Keeping secrets and money under control

- **Redaction** — `JevConfig.redact: true` scrubs likely secrets and direct identifiers (AWS keys, JWTs, private keys, GitHub/Slack tokens, `sk-` keys, auth headers, env secret assignments, URL credentials, connection strings, emails) from `state` before the request leaves the machine. Fail-open, opt-in at the client level; the OMP and Claude Code hooks enable it by default (`OMP_JEV_REDACT=0` / `JEV_REDACT=0` to disable).
- **Budget guard** — `createBudgetGuard` caps requests per rolling window and per lifetime, so a runaway hook loop becomes a loud error instead of a bill.
- **Persistent cache** — `createPersistentCache` + `withPersistentCache` serve exact-repeat judgments from disk across restarts, with hit-rate stats.

## Observability

`createDecisionLog` records one structured row per judgment — kind, model, a stable digest of (kind, state, questions), answers, threshold, action, latency — and `compare()` computes agreement/flip-rate between two logs over matching digests. That is the raw material for threshold and model-version tuning: set `OMP_JEV_DECISION_LOG` to a path and the OMP gate appends every verdict as JSONL.

## Caching, coalescing, failure policy

Hooks fire per tool call, so core ships the cost controls that keep them cheap:

- **`createCachedClient`** — TTL cache keyed on (model, state, questions). Repeated identical judgments — the destructive gate seeing the same call twice — stop costing requests.
- **`createCoalescer`** — merges concurrent `ask` calls that share the same state into ONE batched request; Jev evaluates the merged questions independently, so answers are identical to separate calls.
- **`withFailMode`** — make the safety policy explicit at each call site: `"open"` (allow on error), `"closed"` (deny on error), or `"throw"`.

## Writing a new adapter

[`@jev-harness/kit`](packages/kit) is the shared adapter foundation — the OMP and Pi adapters are both built on it. It owns the host-independent parts: env credential resolution, the `{ content, details }` tool-result envelope, fail-open error rendering, core-pattern call plumbing, and the lexical skill prefilter. Bring your own host schemas (zod, typebox, …) and hook wiring; the kit does the rest.

## Playground

Tuning question wording is the main design activity — [`@jev-harness/playground`](packages/playground) makes it fast:

```bash
npm run playground   # → http://localhost:4173
```

Paste a state, pick a preset (destructive gate, PR triage, injection gate, skill routing), edit the questions, and watch the probabilities move. When a question looks right, validate it on labeled data with eval.

The same workflow lives in the terminal via the **[`jev` CLI](packages/cli)**:

```bash
jev ask --questions '{"gate":{"type":"noul","instructions":"destructive?"}}'   # inline questions
jev ask --state state.json --questions questions.json                          # files
jev eval --dataset cases.jsonl --out report.json                               # calibration
```

`jev ask` prints the raw JSON response — probabilities per question, usage included — so question wording can be iterated without an adapter.

## Evaluating thresholds

Every threshold in this repo is a starting point, not ground truth. [`@jev-harness/eval`](packages/eval) runs a labeled dataset through your questions and reports accuracy, Brier, AUC, ECE, a reliability diagram, and a **max-F1 threshold sweep** per question:

```bash
TYPESAFE_API_KEY=... jev eval --dataset cases.jsonl --out report.json
```

The repo ships its own **golden baseline** — a live recording of the destructive-gate question over 38 labeled tool calls ([`packages/eval/golden`](packages/eval/golden)): AUC 0.996, Brier 0.051, accuracy 94.7% at the suggested 0.15 threshold, ~$0.0006 per run. A vitest regression gate re-derives those numbers on every CI run, and a manual [`live-eval` workflow](.github/workflows/live-eval.yml) re-runs the dataset against the real API and fails on quality drops. Re-record with `node packages/eval/scripts/record-baseline.mjs`.

Recorded finding worth knowing: `chmod -R 777 /` and fork bombs score LOW against the destructive-gate question, because its wording enumerates data-destruction examples (deletion, force-push, dropped tables) rather than system-abuse ones. Question wording is a design surface — this is what the eval toolkit is for.

## Configuration

Every adapter resolves credentials the same way:

| Variable                                     | Required | Default                         | Purpose                                                              |
| -------------------------------------------- | -------- | ------------------------------- | -------------------------------------------------------------------- |
| `TYPESAFE_API_KEY`                           | yes      | —                               | Bearer token from [console.typesafe.ai](https://console.typesafe.ai) |
| `TYPESAFE_BASE_URL`                          | no       | `https://api.typesafe.ai`       | Override the API host                                                |
| `TYPESAFE_DEFAULT_MODEL`                     | no       | `jev-latest`                    | Pin a model version once thresholds are tuned                        |
| `JEV_TIMEOUT_MS`                             | no       | `15000`                         | Per-request timeout                                                  |
| `JEV_REDACT` / `OMP_JEV_REDACT`              | no       | on (hooks)                      | `"0"` disables state redaction                                       |
| `OMP_JEV_MAX_CALLS_PER_MIN`                  | no       | `120`                           | Rolling-window budget for the OMP adapter; `0` disables              |
| `OMP_JEV_CACHE_DIR` / `OMP_JEV_CACHE_TTL_MS` | no       | `~/.omp/cache/jev-harness`, 24h | Persistent judgment cache                                            |
| `OMP_JEV_DECISION_LOG`                       | no       | —                               | Path to a JSONL file for gate decision records                       |

Credentials are read from the environment and never logged.

## Safety model

- **Fail open by default.** A Jev outage must never block your agent. Every hook catches its own errors and resolves to "allow".
- **Advisory, not authoritative.** Tools report a decision; code executes it. The one exception is the destructive gate, which is explicitly a veto.
- **State redaction before transport.** Tool input, diffs, and history routinely embed secrets; they are scrubbed before any request leaves the machine.
- **Budget-capped hooks.** A runaway loop hits the budget guard and fails open loudly instead of quietly spending.
- **No mid-conversation model switching.** Measured: switching models mid-stream invalidates the provider prompt cache and cost one deployment `$19.53` across 309 requests.
- **Append-only context injection.** Skill hints are appended to the user turn, never used to rewrite the system prefix.

## Development

```bash
npm install        # add --include=dev when NODE_ENV=production
npm run build      # core first, then every adapter (+ committed bundles)
npm run typecheck
npm test
npm run lint       # ESLint
npm run format     # Prettier
npm run qa         # build + typecheck + lint + format:check + test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the release flow and the rules on
committed build artifacts, and [SECURITY.md](SECURITY.md) to report a
vulnerability.

## License

Apache-2.0. See [LICENSE](LICENSE).
