# @jev-harness/claude-code

Claude Code plugin that brings TypeSafe's Jev (System One) judgments into
Claude Code sessions:

- **PreToolUse gate** — asks Jev (`judgeDestructive`) whether a
  Bash/Write/Edit-like tool call is destructive and denies it at or above
  the threshold. Fails **open**: any error allows the call through the
  normal permission flow.
- **UserPromptSubmit advisor** — asks Jev (`routeSkill`) which known skill
  fits the prompt and appends an advisory line via `additionalContext`.
  It never rewrites or blocks the prompt.

## Install

Add the marketplace, then install the plugin:

```sh
claude plugin marketplace add Talya1412/jev-harness
claude plugin install jev-harness@jev-harness
```

For local development (this repo):

```sh
claude --plugin-dir packages/claude-code
```

Then build the hook once so `dist/hooks/jev-hook.js` exists:

```sh
npm --workspace @jev-harness/claude-code run build
```

## Configuration (environment variables)

The key is never hardcoded and never logged. All settings come from the
environment:

| Variable                    | Required | Default      | Purpose                                                                                                                         |
| --------------------------- | -------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `TYPESAFE_API_KEY`          | yes      | —            | TypeSafe API key. Without it both hooks stay silent (fail open).                                                                |
| `TYPESAFE_BASE_URL`         | no       | core default | API base override.                                                                                                              |
| `TYPESAFE_DEFAULT_MODEL`    | no       | `jev-latest` | Jev model override. Also settable as the `model` plugin `userConfig`.                                                           |
| `JEV_TIMEOUT_MS`            | no       | 15000        | Per-request timeout in ms.                                                                                                      |
| `JEV_DESTRUCTIVE_THRESHOLD` | no       | `0.75`       | `destructive` probability at or above which PreToolUse denies. Also settable as the `destructiveThreshold` plugin `userConfig`. |
| `JEV_SKILL_CONFIDENCE`      | no       | `0.5`        | Minimum routing confidence before the advisor speaks. Also settable as the `skillConfidence` plugin `userConfig`.               |
| `JEV_SKILLS_JSON`           | no       | —            | Inline JSON array of `{ name, description }` skill candidates.                                                                  |
| `JEV_SKILLS_FILE`           | no       | —            | Path to a JSON file with the same shape (used when `JEV_SKILLS_JSON` is unset).                                                 |

Export the plugin `userConfig` values (`apiKey`, `model`,
`destructiveThreshold`, `skillConfidence`) as the matching environment
variables above before starting Claude Code, e.g.:

```sh
export TYPESAFE_API_KEY="<your TypeSafe key>"
export JEV_DESTRUCTIVE_THRESHOLD="0.75"
```

With no skills configured (`JEV_SKILLS_JSON`/`JEV_SKILLS_FILE` unset or
empty) the UserPromptSubmit hook exits silently and the prompt proceeds
untouched.

## Layout

- `.claude-plugin/plugin.json` — plugin manifest.
- `.claude-plugin/marketplace.json` — marketplace descriptor.
- `hooks/hooks.json` — PreToolUse + UserPromptSubmit registrations.
- `hooks/jev-hook.ts` — hook implementation (built to `dist/hooks/jev-hook.js`).

## Schema conformance

- `hooks/hooks.json` follows the plugin hooks schema in the [Claude Code plugins reference](https://code.claude.com/docs/en/plugins-reference) (`{ "hooks": { <Event>: [{ "matcher", "hooks": [{ "type": "command", "command" }] }] } }`, `hooks/hooks.json` location), with event semantics and the `command`-hook stdin/stdout JSON contract from [Claude Code hooks](https://code.claude.com/docs/en/hooks) (`PreToolUse` `permissionDecision` deny + `permissionDecisionReason`; `UserPromptSubmit` `additionalContext` append).
- `.claude-plugin/plugin.json` (`name`, `version`, `description`, `userConfig` with typed sensitive/non-sensitive options) and `.claude-plugin/marketplace.json` (`name`, `owner`, `plugins[]` with `name`/`source`/`description`/`version`) mirror the manifests of the reference plugin [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) (`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` via `https://api.github.com/repos/tamaratran/fast-jev-compaction/git/trees/HEAD?recursive=1` + raw.githubusercontent.com). That plugin's `hooks/hooks.json` uses the early-access function-hooks `{"modules": [...]}` module format; this adapter instead uses the stable `command`-hook format above so it installs on any current Claude Code without the function-hooks preview flag.
