# @jev-harness/cli

A small CI/subagent gate around one TypeSafe Jev judgment.

## Install

From the monorepo:

```sh
npm install
npm run build --workspace=@jev-harness/cli
```

The binary is `jev-gate`.

## Usage

Judge a diff:

```sh
jev-gate --diff -c "all exported functions are documented"
```

Judge a file or piped output:

```sh
jev-gate --file ./report.txt --criteria "the report contains no failures"
npm test 2>&1 | jev-gate "zero test failures" --json
```

Exit codes:

- `0`: Jev probability meets the threshold.
- `1`: Jev judged the criteria below the threshold.
- `2`: the gate could not evaluate (missing key, invalid arguments, unreadable file, or API error).

Use `--fail-open` only when the surrounding pipeline explicitly prefers availability over enforcement. It reports the error but exits `0`.

## Scope

This is a semantic acceptance check, not a replacement for tests, linters, typecheckers, or security scanners. The state is sent to TypeSafe's hosted Jev API; do not pipe secrets or credentials into it.
