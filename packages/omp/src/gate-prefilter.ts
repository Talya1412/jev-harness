/**
 * Gate pre-filter: a strict, closed-form allowlist for `tool_call` skips.
 *
 * The gate filtered on the tool NAME only, so every `bash` call spent a Jev
 * round trip; measured on this machine's cache, 512 judged calls produced 3
 * destructive verdicts and 94% that could never be blocked.
 *
 * The contract is asymmetric on purpose:
 * - a match means "do not spend", NEVER "approve" — a skip returns the same
 *   `undefined` the gate already returns for a tool it does not adjudicate.
 * - anything unrecognised, ambiguous, or arguably mutating reaches Jev. A
 *   false `mutating` costs one request; a false `read-only` grants silent
 *   permission, so every uncertainty resolves toward the call.
 * - a loose "looks benign" list was measured at ~21% error in BOTH directions
 *   (`node script.js` read as read-only, a redirect behind a pipe, `cmd /c del`
 *   invisible). Hence an allowlist of exact shapes, never a classifier.
 */

/**
 * Commands whose entire contract is to read. Anything that can write, spawn a
 * shell, run code, or reach an editor is absent BY CONSTRUCTION — the absence
 * is the safety property, not a gap to be filled later.
 */
const READ_COMMANDS = new Set([
  "dir",
  "ls",
  "cat",
  "type",
  "head",
  "tail",
  "wc",
  "find",
  "findstr",
  "grep",
  "rg",
  "sort",
  "uniq",
  "which",
  "where",
  "echo",
  "pwd",
  "cd",
  "env",
  "date",
  "ver",
  "whoami",
  "hostname",
  "stat",
  "file",
  "du",
  "df",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "printenv",
  "true",
  "false",
]);

/**
 * Heads in {@link READ_COMMANDS} that are only read-only for SOME arguments, so
 * their arguments must match an explicit pattern. A head absent here accepts
 * any arguments (its contract cannot write at all).
 *
 * Every entry exists because the first draft of this file was WRONG about it:
 * a `forfiles /c "cmd /c del @path"` and a `git tag -d` both classified as
 * read-only and would have skipped Jev for a destructive call.
 */
const ARG_RULES: Record<string, RegExp> = {
  // Bare `env` prints the environment; `env FOO=1 cmd` EXECUTES cmd.
  env: /^$/,
  // Bare `hostname` reads it; `hostname name` sets it.
  hostname: /^$/,
  // `date` prints; `date -s ...` sets the clock. A +format string is a read.
  date: /^(?:\+[^\s]*)?$/,
  // `certutil -hashfile F HASH` is a read; -decode/-encode/-addstore write.
  certutil: /^-hashfile\b/,
  // `sort -o out in` writes; every other sort flag is stdout-only.
  sort: /^(?![\s\S]*(?:^|\s)-o(?:\S+)?(?:\s|$))[\s\S]*$/,
  // `file -C` / `--compile` writes a compiled magic file.
  file: /^(?![\s\S]*(?:^|\s)(?:-C\b|--compile\b))[\s\S]*$/,
};

/** Flags that turn an otherwise-readable multi-purpose command into a writer. */
const ARG_HAZARDS: Array<[string, RegExp]> = [
  ["find", /(?:^|\s)(?:-fprint|-fprintf|-fls)(?:\S*)?(?:\s|$)/],
  ["uniq", /\s\S+\s+\S+/], // `uniq in out` writes the second positional
];

/**
 * Subcommands of multi-purpose tools that only read. The tool itself is NOT in
 * {@link READ_COMMANDS} because its other subcommands write.
 */
const READ_SUBCOMMANDS: Record<string, RegExp> = {
  // List/inspect only: `remote` and `branch` are reads only with a listing
  // flag, and `tag`/`config` only in their read forms — a bare `git tag v1`,
  // `git tag -d v1`, `git remote add`, or `git branch -D` all WRITE a ref or
  // the config. Those argument shapes are the second half of the rule.
  git: /^(?:(?:log|status|diff|show|ls-remote|rev-parse|describe|ls-files|ls-tree|shortlog|blame)(?:\s|$)|remote(?:\s+(?:-v|show|get-url)(?:\s|$)|$)|branch(?:\s+(?:-a|--all|-l|--list|--show-current|-v|--verbose|-r|--remotes)(?:\s|$)|$)|tag(?:\s+(?:-l|--list|--contains|--points-at)(?:\s|$)|$)|stash\s+list(?:\s|$)|config\s+(?:--get|--get-all|--list|-l|--get-regexp)(?:\s|$)|--version|--help)/,
  gh: /^(?:api|pr\s+(?:view|list|diff|checks|status)|run\s+(?:view|list)|repo\s+view|auth\s+status|issue\s+(?:view|list)|release\s+(?:view|list)|search\s+\w+|label\s+list)\b/,
  npm: /^(?:ls|list|view|info|outdated|why|--version|-v)\b/,
  pnpm: /^(?:ls|list|view|why|outdated|--version|-v)\b/,
  bun: /^(?:pm\s+ls|--version|-v)\b/,
  sed: /^-n\b/,
  node: /^--version$/,
  python: /^--version$/,
  python3: /^--version$/,
  curl: /^[^|;]*(?:$)/,
  cargo: /^(?:tree|metadata|--version)\b/,
  go: /^(?:version|env|list)\b/,
  omp: /^(?:models|stats|--version|-v)\b/,
};

/**
 * Shell metacharacters and flags that make a line unsafe to judge lexically, or
 * that turn an otherwise-readable command into a writer. Presence of any of
 * these abandons the allowlist and sends the call to Jev.
 */
const DISQUALIFYING = [
  ">", // redirection, including >> and >file
  "`", // command substitution
  "$(", // command substitution
  "<(", // process substitution
  "&&", // sequencing hides later writes
  "||",
  "|| ",
  ";",
  "-exec",
  "-delete",
  "-ok",
  "sed -i",
  "sed --in-place",
  "tee",
  // NOTE: no bare "-o"/"-O" entry here. `grep -o`, `rg -o`, `ps -o` are reads and
  // are exactly the calls this allowlist exists to spare; the two writers that
  // motivated a global rule are guarded by head instead — curl by
  // curlIsReadOnly(), sort by its ARG_RULES entry.
  "remove-item",
  "set-content",
  "out-file",
  "new-item",
  "start-process",
  "invoke-expression",
  "iex ",
  "taskkill",
  "kill ",
];

/** Flags that are read-only for otherwise-ambiguous tools. */
function curlIsReadOnly(rest: string): boolean {
  // A curl that writes to a file (-o/-O/--output/--remote-name) mutates.
  return !/(?:^|\s)(?:-o|-O|--output|--remote-name)(?:\s|$|=)/.test(rest);
}

/** Strip a `cmd /c "..."` / `cmd /c ...` wrapper, if present. */
function unwrap(command: string): string {
  const m = /^cmd(?:\.exe)?\s+\/[ck]\s+(.+)$/is.exec(command.trim());
  if (!m) return command.trim();
  let inner = m[1].trim();
  if (
    (inner.startsWith('"') && inner.endsWith('"') && inner.length > 1) ||
    (inner.startsWith("'") && inner.endsWith("'") && inner.length > 1)
  ) {
    inner = inner.slice(1, -1);
  }
  return inner.trim();
}

/** The first token of a segment, with any directory and `.exe` stripped. */
function headOf(segment: string): string {
  const first = segment.split(/\s+/)[0] ?? "";
  return first
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(?:exe|cmd|bat|com)$/i, "")
    .toLowerCase();
}

/**
 * Decide whether one bash command is provably read-only.
 *
 * Returns a rule id when the command may be skipped, or `null` when it must go
 * to Jev. The rule id is returned (not a boolean) so a caller can log WHICH
 * rule granted the skip — the allowlist's own decisions are then auditable.
 */
export function classifyBashReadOnly(command: string): string | null {
  const raw = typeof command === "string" ? command.trim() : "";
  if (raw === "") return null;
  if (raw.length > 2000) return null; // long lines hide shapes; do not guess

  const core = unwrap(raw);
  const lower = core.toLowerCase();
  for (const bad of DISQUALIFYING) {
    if (lower.includes(bad)) return null;
  }
  // A pipe is only safe when BOTH sides are read commands; this is checked by
  // splitting below, so a bare "|" itself is allowed through to the splitter.
  const segments = core
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (segments.length === 0) return null;

  const rules: string[] = [];
  for (const segment of segments) {
    const head = headOf(segment);
    const rest = segment.slice(segment.split(/\s+/)[0]?.length ?? 0).trim();
    if (head === "") return null;

    if (READ_COMMANDS.has(head)) {
      // `cat > file` is caught by DISQUALIFYING; `type` is a read builtin.
      const argRule = ARG_RULES[head];
      if (argRule && !argRule.test(rest)) return null;
      const hazard = ARG_HAZARDS.find(([h]) => h === head);
      if (hazard && hazard[1].test(rest)) return null;
      rules.push("read-command:" + head);
      continue;
    }
    if (head in ARG_RULES) {
      // Not a blanket read: only this argument shape is (e.g. certutil -hashfile).
      if (!ARG_RULES[head].test(rest)) return null;
      rules.push("read-arg:" + head);
      continue;
    }
    if (head === "cmd" || head === "sh" || head === "bash" || head === "zsh" || head === "pwsh") {
      return null; // a nested shell is never lexically safe
    }
    if (head === "powershell" || head === "powershell.exe") return null;
    const sub = READ_SUBCOMMANDS[head];
    if (sub) {
      if (!sub.test(rest)) return null;
      if (head === "curl" && !curlIsReadOnly(rest)) return null;
      if (head === "sed" && /(?:^|\s)-i\b|--in-place/.test(rest)) return null;
      if (head === "gh" && /\s-[Xx]?\s*(POST|PUT|PATCH|DELETE)/i.test(rest)) return null;
      rules.push("read-subcommand:" + head);
      continue;
    }
    // `find . -name x -exec rm {} +` is caught by DISQUALIFYING; `find` alone is
    // a read, but only when it carries no exec/delete (checked above).
    return null;
  }
  return rules.length > 0 ? rules.join("+") : null;
}
