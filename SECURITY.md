# Security Policy

## Supported versions

The `@jev-harness/*` packages are released together on the current minor line.
Security fixes land on the latest published version; older versions are not
patched.

| Line  | Supported          |
| ----- | ------------------ |
| 0.2.x | :white_check_mark: |
| < 0.2 | :x:                |

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report privately through GitHub's
[private vulnerability reporting](https://github.com/Talya1412/jev-harness/security/advisories/new)
(Security tab → _Report a vulnerability_). If you cannot use that channel, open
a minimal public issue that only asks for a private contact point — never
include exploit details.

Please include:

- the affected package(s) and version(s),
- a minimal reproduction or proof of concept,
- the impact you believe it has,
- any suggested fix.

You can expect an acknowledgement within a few days. Please give us a
reasonable window to ship a fix before any public disclosure.

## Scope and design notes

These are intentional design decisions, not vulnerabilities:

- **Fail-open by default.** Every Jev-backed hook catches its own errors and
  resolves to "allow". A Jev outage or a malformed model response must never
  block the host agent. Making the destructive gate fail-closed is a deliberate
  opt-in at the call site, not the default.
- **Jev output is advisory.** Tools report a decision; your code executes it.
  The one exception is the destructive gate, which is an explicit veto.
- **Calibration is not correctness.** A probability near 1.0 is not a guarantee;
  validate thresholds on your own labeled data (`@jev-harness/eval`).

Controls that exist to reduce blast radius:

- **Credential handling.** `TYPESAFE_API_KEY` is read from the environment and
  never logged. `resolveConfig` rejects an empty key before any request is made.
- **State redaction.** `JevConfig.redact` scrubs likely secrets and direct
  identifiers (AWS keys, JWTs, private keys, GitHub/Slack/`sk-` tokens, auth
  headers, env secret assignments, URL credentials, connection strings, emails)
  from `state` before it leaves the machine. Enabled by default in the OMP and
  Claude Code hooks (`OMP_JEV_REDACT=0` / `JEV_REDACT=0` to disable).
- **Budget guard.** `createBudgetGuard` caps requests per rolling window so a
  runaway hook loop becomes a loud error instead of a bill.
- **Secrets are never committed.** `.env` is gitignored; only `.env.example` is
  tracked.

## Dependency updates

Dependabot is configured (`.github/dependabot.yml`) for npm, GitHub Actions, and
the `jev-py` Python package on a weekly cadence. Enable **Dependabot security
updates** in this repository's Settings → Code security for automatic patch PRs.
