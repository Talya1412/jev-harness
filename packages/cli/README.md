# @jev-harness/cli

Two binaries for **[TypeSafe Jev](https://typesafe.ai)** — the System One
decision model:

- **`jev`** — the unified command line: `ask`, `models`, `eval`. Debug
  question design without building an adapter, and run evaluations without
  remembering package names.
- **`jev-gate`** — a small CI/subagent gate around one Jev judgment over a
  git diff, file, or stdin.

## Install

```bash
npm install -g @jev-harness/cli   # or: npx @jev-harness/cli <command>
```

From the monorepo:

```sh
npm install
npm run build --workspace=@jev-harness/cli
```

Requires `TYPESAFE_API_KEY` in the environment (`TYPESAFE_BASE_URL`,
`TYPESAFE_DEFAULT_MODEL`, `JEV_TIMEOUT_MS` are honored too).

## `jev` — commands

### `jev ask` — one batched ask

```bash
# inline questions, default {} state
jev ask --questions '{"gate":{"type":"noul","instructions":"destructive?"}}'

# state and questions from files
jev ask --state state.json --questions questions.json

# envelope on stdin: {"state": ..., "questions": ...}
cat request.json | jev ask

# '-' reads that input from stdin
jev ask --state - --questions questions.json < state.json
```

Prints the full JSON response (`answers` with calibrated probabilities per
question, plus usage) to stdout — pipe it into `jq` or a file.
`--model`, `--base-url`, and `--timeout-ms` override the environment for one call.

### `jev models`

```bash
jev models   # → ["jev-latest", ...]
```

### `jev eval`

Delegates to [`jev-eval`](../eval) — same flags:

```bash
jev eval --dataset cases.jsonl --out report.json
```

## `jev-gate` — usage

Judge a diff:

```sh
jev-gate --diff -c "all exported functions are documented"
```

Judge a file or piped output:

```sh
jev-gate --file ./report.txt --criteria "the report contains no failures"
npm test 2>&1 | jev-gate "zero test failures" --json
```

Exit codes for `jev-gate`:

- `0`: Jev probability meets the threshold.
- `1`: Jev judged the criteria below the threshold.
- `2`: the gate could not evaluate (missing key, invalid arguments, unreadable file, or API error).

Use `--fail-open` only when the surrounding pipeline explicitly prefers availability over enforcement. It reports the error but exits `0`.

## Exit codes (`jev`)

| Code | Meaning                                                |
| ---- | ------------------------------------------------------ |
| 0    | Success                                                |
| 1    | Runtime error (missing key, API failure)               |
| 2    | Usage error (bad flags, invalid JSON, unknown command) |

## Programmatic use

```ts
import { runCli } from "@jev-harness/cli";

const code = await runCli(["ask", "--questions", "..."], {
  fetchImpl: mockFetch,   // injectable for tests
  stdin: "",              // pre-read stdin
  out: (s) => ...,        // output sinks
  err: (s) => ...,
});
```

## Scope

This is a semantic acceptance check, not a replacement for tests, linters,
typecheckers, or security scanners. The state is sent to TypeSafe's hosted
Jev API; do not pipe secrets or credentials into it.

## License

Apache-2.0.
