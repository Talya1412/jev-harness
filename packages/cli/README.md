# @jev-harness/cli

Two binaries for **[TypeSafe Jev](https://typesafe.ai)** — the System One
decision model:

- **`jev`** — the unified command line: `ask`, `models`, `classify`,
  `eval`. Debug question design without building an adapter, and run
  evaluations without remembering package names.
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

### `jev classify` — the same questions over a whole corpus

Reads a JSONL corpus and asks the **same** typed questions of every item, then
optionally reduces the answers.

```bash
# one JSON object per line in posts.jsonl
jev classify --items posts.jsonl --questions q.json

# inline questions, corpus on stdin, one result line per item
cat logs.jsonl | jev classify --items - --questions \
  '{"severity":{"type":"choice","instructions":"how severe?","criteria":{"low":"cosmetic","high":"outage"}}}'

# reduce the per-item verdicts into one final answer, written to a file
jev classify --items posts.jsonl --questions q.json --reduce reduce.json --out verdicts.jsonl
```

- `--questions` takes a map of id → question, **or one question object**
  (wrapped as id `answer`).
- `--reduce` takes one question: `{instructions, criteria, type?}` where
  `criteria` is an object of options (choice) or an ordered array of levels
  (score). It judges a **capped digest of the per-item verdicts — 200 items /
  4000 characters, core's caps in `packages/core/src/infra.ts`
  (`MAX_REDUCE_ITEMS` / `MAX_REDUCE_CHARS`), never the corpus** — so the
  reduce cost stays flat as the corpus grows.
- `--out <file>` writes the JSONL there; stdout is the default. Each line is
  `{"index": n, "answers": {...}}`, a failing item is
  `{"index": n, "error": "..."}`, and the last line is `{"reduced": ...}`
  when a reduce ran.
- `--concurrency <n>` sets item judgments in flight (default 4).

**Cost**: one request per item — `items × questions` worth of judgments, plus
one reduce call.

#### Partial failures

One bad item never aborts the corpus:

```text
$ jev classify --items items.jsonl --questions q.json
{"index":0,"answers":{"q":{"type":"noul","noul":0.75}}}
{"index":1,"error":"Jev HTTP 400: bad item payload"}
{"index":2,"answers":{"q":{"type":"noul","noul":0.75}}}
item 1: Jev HTTP 400: bad item payload          # stderr
1 of 3 item(s) failed                           # stderr
$ echo $?
1
```

The failed indices (and the reason) go to stderr, every success is still
written, and the exit code is `1`. Core's `withMapReduce` is atomic, so a
batch rejected with 400/413/422 is retried item by item to attribute the
failure — up to twice the calls for that batch. Failures that say nothing
about one item (missing key, 401/403, 429, 5xx, network) still abort with
exit `1` and are not retried per item.

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
