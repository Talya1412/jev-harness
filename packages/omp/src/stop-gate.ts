/**
 * Stop gate: refuse a "done" that has no verification behind it.
 *
 * Two invariants, both learned the hard way in this repo:
 *  1. DETERMINISTIC FIRST — which edits happened and whether any check has
 *     PASSED since is read from the session's own tool calls, no model needed.
 *  2. A JUDGMENT MAY ONLY LOOSEN — Jev is asked once, only after the rule above
 *     already says "block", and only so it can say the change needed no check
 *     (docs-only, formatting). A probability can never invent a block; that is
 *     the failure mode the old probabilistic gate was removed for.
 *
 * Pure: no ExtensionAPI, no network, so the predicate is testable alone.
 */

/** Names that mean "read or change a file", by the tool's own identity. */
const EDIT_TOOLS = /^(?:write|edit|ast_edit|multiedit|notebookedit|apply_patch|patch)$/i;

/**
 * A target that is a NON-workspace sink — an xd:// tool device, a fanout
 * destination — is not a file edit. This module shipped once counting
 * `write { path: "xd://report_issue" }` as a changed file, and the resulting
 * refusal fired on a session that had changed nothing on disk: exactly the
 * false block that gets a gate removed. Detection is by target scheme, not by
 * running the check later and hoping no session ever does this.
 */
const NON_FILE_TARGET = /^(?:[a-z][a-z0-9+.-]*):\/\//i;

/** True when an edit tool was pointed at a real workspace file. */
function isWorkspaceEdit(input: Record<string, unknown>): boolean {
  const paths = pathsFromInput(input);
  if (paths.length === 0) return false;
  return paths.some((p) => !NON_FILE_TARGET.test(p));
}

/** Commands that count as verification when they run and succeed. */
const CHECK_PATTERN =
  /(?:^|[\s&|;])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|lint|typecheck|check|build|qa|verify)\b|\b(?:npx|pnpx)\s+(?:vitest|jest|tsc|eslint|prettier|playwright)\b|\b(?:vitest|jest|pytest|tsc|eslint)\b|\bcargo\s+(?:test|check|clippy|build)\b|\bgo\s+(?:test|build|vet)\b|\b(?:pytest|ruff|mypy)\b|\bdotnet\s+(?:test|build)\b|\bmake\b|\bgradle\b|\bmvn\b/i;

/** A bash command that mutates the workspace, as opposed to reading it. */
const MUTATING_PATTERN =
  /\b(?:rm|del|mv|move|cp|copy|mkdir|rmdir|touch|sed\s+-i|tee)\b|>{1,2}\s*\S|\bgit\s+(?:commit|push|reset|clean|checkout|restore|apply|merge|rebase|stash)\b|\bnpm\s+(?:install|i|publish|version)\b|\bpip\s+install\b/i;

export interface StopGateFileEdit {
  /** Tool that performed the edit. */
  tool: string;
  /** File path the tool was pointed at, when the arguments name one. */
  path: string;
  /** Index of the call in the flattened session, for ordering only. */
  at: number;
}

export interface StopGateCheck {
  /** The command that ran. */
  command: string;
  /** False when the result looked like an error. */
  passed: boolean;
  at: number;
}

export interface StopGateEvidence {
  edits: StopGateFileEdit[];
  checks: StopGateCheck[];
  /** True when at least one mutating bash command ran after the last check. */
  mutationsAfterLastCheck: number;
  /**
   * Set when the transcript states after the last edit that no check applies.
   * Optional so a caller that only has tool facts still compiles.
   */
  statedNoCheckApplies?: boolean;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

/** The text of a tool result body, across the spellings OMP and Anthropic use. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((x) => {
        if (typeof x === "string") return x;
        const r = asRecord(x);
        return typeof r.text === "string" ? r.text : "";
      })
      .filter((s) => s !== "")
      .join("\n");
  }
  if (content == null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return "";
  }
}

/** A result body is a failure when it says so, or when the host flagged it. */
function looksFailed(body: string, flag: unknown): boolean {
  if (flag === true) return true;
  const head = body.slice(0, 400);
  return (
    /^\s*(?:error|Error|ERROR|failed|FAILED|Traceback|panic:)/.test(head) ||
    /"is_error"\s*:\s*true/.test(head) ||
    /\bexit(?:ed)?\s+(?:code\s+)?[1-9]/.test(head) ||
    /\b[1-9]\d*\s+fail(?:ed|ures?)\b/i.test(head)
  );
}

/** Every file path an edit tool was pointed at. */
function pathsFromInput(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ["file_path", "filePath", "path", "file", "target"]) {
    const v = input[key];
    if (typeof v === "string" && v !== "") out.push(v);
  }
  // ast_edit / patch style: a list of paths.
  const list = input.paths ?? input.files;
  if (Array.isArray(list)) for (const p of list) if (typeof p === "string") out.push(p);
  return out;
}

/** Argument name that may carry a shell command, across providers. */
function commandFromInput(input: Record<string, unknown>): string | null {
  for (const key of ["cmd", "command", "script"]) {
    const v = input[key];
    if (typeof v === "string" && v !== "") return v;
  }
  return null;
}

/**
 * Every command string worth inspecting in a call, wherever it hides.
 *
 * The gate is BLIND to how this harness actually runs checks: almost nothing
 * reaches it as a top-level `bash` call. A host tool is driven from the code
 * runners (`fabric_exec`, `eval`, `run_code`), so `omp.bash({ cmd: "npm test" })`
 * appears as a `fabric_exec` call whose INPUT is JavaScript, and `subprocess.run`
 * as an `eval` call. Judging only `bash` made every check invisible, so a session
 * that ran the full suite before finishing was still refused — the second and
 * worse false negative found on 2026-09-27.
 *
 * So: collect the direct command, then mine the code-runner sources for shell
 * commands. Quoted strings only, so ordinary identifier text is not mistaken for
 * a command, and a call can contribute MANY commands (a runner that runs a test
 * and then a grep is judged on both).
 */
const CODE_RUNNER_TOOLS = /^(?:fabric_exec|eval|run_code|run|code)$/i;

/** Longest-first so a source string is never truncated mid-command. */
const SHELL_HINTS =
  "npm|pnpm|yarn|bun|npx|pnpx|vitest|jest|pytest|tsc|eslint|prettier|cargo|go|dotnet|make|gradle|mvn|node|python3?|bash|sh|cmd|powershell|pwsh|make";

function commandsFromCall(tool: string, input: Record<string, unknown>): string[] {
  const out: string[] = [];
  const direct = commandFromInput(input);
  if (direct !== null) out.push(direct);
  if (!CODE_RUNNER_TOOLS.test(tool)) return out;

  // Any string value in the call may carry code; look inside each.
  const sources: string[] = [];
  const walk = (v: unknown, depth = 0): void => {
    if (depth > 4 || v == null) return;
    if (typeof v === "string") {
      if (v.length > 0 && v.length < 100_000) sources.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (typeof v === "object") for (const x of Object.values(v as object)) walk(x, depth + 1);
  };
  walk(input);

  // Quoted strings that mention a check-ish binary are candidate commands.
  const quoted = new RegExp(
    `["'\`]([^"'\`\n]{0,300}?(?:${SHELL_HINTS})[^"'\`\n]{0,300}?)["'\`]`,
    "gi",
  );
  for (const src of sources) {
    for (const m of src.matchAll(quoted)) {
      const candidate = m[1]!.trim();
      if (candidate !== "" && !out.includes(candidate)) out.push(candidate);
    }
  }
  return out;
}

/**
 * Walk the session's messages in order and collect the only two facts the rule
 * needs: which files were edited, and which checks passed.
 *
 * Three block spellings reach this function (Anthropic `tool_use` blocks, OMP
 * `toolCall` blocks, and OMP's whole-message `role:"toolResult"`), and a result
 * is paired by id so a check's exit status is attributed to the right call.
 */
export function collectStopEvidence(messages: readonly unknown[]): StopGateEvidence {
  const edits: StopGateFileEdit[] = [];
  const checks: StopGateCheck[] = [];
  const mutatingAt: number[] = [];
  const pending = new Map<
    string,
    { kind: "edit" | "check" | "mutate"; tool: string; path: string; command: string }
  >();
  let at = 0;

  const recordCall = (id: string, tool: string, input: Record<string, unknown>) => {
    if (EDIT_TOOLS.test(tool)) {
      // A write aimed at a non-file sink (xd:// device, fanout) changes no
      // workspace file and must never arm the gate.
      if (!isWorkspaceEdit(input)) return;
      const paths = pathsFromInput(input).filter((p) => !NON_FILE_TARGET.test(p));
      edits.push({ tool, path: paths[0] ?? "", at });
      pending.set(id, { kind: "edit", tool, path: paths[0] ?? "", command: "" });
      return;
    }
    // A call may carry several commands (a code runner can invoke more than
    // one shell step); each is judged on its own so a passing test is not lost
    // because a later grep in the same call did not match.
    let sawMutating = false;
    let firstCommand: string | null = null;
    for (const command of commandsFromCall(tool, input)) {
      firstCommand ??= command;
      if (CHECK_PATTERN.test(command)) {
        checks.push({ command, passed: true, at }); // flipped by the result below
        pending.set(id, { kind: "check", tool, path: "", command });
      } else if (MUTATING_PATTERN.test(command)) {
        sawMutating = true;
      }
    }
    if (firstCommand === null) return;
    if (sawMutating && !pending.has(id)) {
      pending.set(id, { kind: "mutate", tool, path: "", command: firstCommand });
      mutatingAt.push(at);
    } else if (sawMutating) {
      mutatingAt.push(at);
    }
  };

  const recordResult = (id: string, body: string, flag: unknown) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (p.kind !== "check") return;
    // A check that FAILED does not count as verification. The last entry wins
    // by position, so a later pass on the same command matters more.
    const passed = !looksFailed(body, flag);
    const last = checks[checks.length - 1];
    if (last && last.command === p.command) last.passed = passed;
  };

  for (const raw of messages) {
    const m = asRecord(raw);
    const blocks = Array.isArray(m.content) ? (m.content as unknown[]) : [];
    // A whole-message toolResult (OMP's spelling): pair by toolCallId.
    const msgId = typeof m.toolCallId === "string" ? m.toolCallId : "";
    if (msgId !== "") {
      recordResult(msgId, resultText(m.content), asRecord(m).isError);
      at++;
      continue;
    }
    for (const b of blocks) {
      const blk = asRecord(b);
      const type = String(blk.type ?? "");
      if (type === "tool_use" || type === "tool_call" || type === "toolCall") {
        const id = String(blk.id ?? blk.toolCallId ?? "");
        const tool = String(blk.name ?? blk.toolName ?? "tool");
        recordCall(id, tool, asRecord(blk.input ?? blk.arguments ?? blk.args));
      } else if (type === "tool_result" || type === "toolResult") {
        const id = String(blk.tool_use_id ?? blk.toolUseId ?? blk.toolCallId ?? "");
        recordResult(id, resultText(blk.content), blk.is_error ?? blk.isError);
      }
    }
    at++;
  }

  const lastCheckAt = checks.filter((c) => c.passed).reduce((n, c) => Math.max(n, c.at), -1);
  return {
    edits,
    checks,
    mutationsAfterLastCheck: mutatingAt.filter((a) => a > lastCheckAt).length,
    statedNoCheckApplies: statesNoCheckApplies(messages, edits),
  };
}

/**
 * The escape the refusal message promises, made real: "or state explicitly that
 * no check applies to this change and stop again".
 *
 * The message offered a way forward the code did not implement, so a session
 * with no verifiable change (a tool-device dispatch, a docs edit) was refused on
 * every settle, forever — the same broken-promise class as the tool_call gate.
 * Recognition is deliberately strict and only counts a statement made AFTER the
 * last edit; anything vaguer keeps the block.
 */
const NO_CHECK_PHRASES = [
  /no check (?:applies|is needed|needed|required|applies here)/i,
  /(?:nothing|no code) (?:to|needs?) (?:test|verify|check)/i,
  /does not need (?:a |any )?(?:test|check|verification)/i,
  /docs[- ]only|documentation[- ]only|comment[- ]only|formatting[- ]only/i,
  /not applicable to (?:this|the) change/i,
  /cannot be verified by (?:a )?(?:test|check)/i,
];

/** Free text of a message, across the block spellings a transcript uses. */
function messageText(m: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof m.content === "string") parts.push(m.content);
  if (Array.isArray(m.content)) {
    for (const b of m.content as unknown[]) {
      const blk = asRecord(b);
      if (blk.type === "text" && typeof blk.text === "string") parts.push(blk.text);
    }
  }
  return parts.join("\n");
}

/**
 * True when the transcript states, in the model's own words after the last
 * edit, that no check applies. Returned as a separate fact so the deterministic
 * rule stays pure and the caller can decide how much to trust it.
 */
export function statesNoCheckApplies(
  messages: readonly unknown[],
  edits: readonly StopGateFileEdit[],
): boolean {
  if (edits.length === 0) return false;
  const lastEditAt = edits.reduce((n, e) => Math.max(n, e.at), -1);
  let at = 0;
  for (const raw of messages) {
    const m = asRecord(raw);
    if (at > lastEditAt) {
      const text = messageText(m);
      if (text !== "" && NO_CHECK_PHRASES.some((re) => re.test(text))) return true;
    }
    at++;
  }
  return false;
}

export type StopGateVerdict =
  | { block: false; reason: "no-changes" | "verified" | "nothing-to-verify" }
  | { block: true; reason: "unverified-edits"; files: string[]; lastCheck: string | null };

/**
 * The deterministic rule. Block ONLY when the session changed something and no
 * check has passed since — the exact shape of "edited then claimed done".
 */
export function decideStop(evidence: StopGateEvidence): StopGateVerdict {
  if (evidence.edits.length === 0) return { block: false, reason: "no-changes" };
  // The documented escape: a plain statement that no check applies is a
  // verification answer, not a loophole, and it must actually work.
  if (evidence.statedNoCheckApplies === true) {
    return { block: false, reason: "nothing-to-verify" };
  }
  const lastEditAt = evidence.edits.reduce((n, e) => Math.max(n, e.at), -1);
  const lastPassed = evidence.checks
    .filter((c) => c.passed)
    .reduce<StopGateCheck | null>((best, c) => (best === null || c.at > best.at ? c : best), null);
  if (lastPassed !== null && lastPassed.at > lastEditAt) {
    return { block: false, reason: "verified" };
  }
  const files = [...new Set(evidence.edits.map((e) => e.path).filter((p) => p !== ""))];
  return { block: true, reason: "unverified-edits", files, lastCheck: lastPassed?.command ?? null };
}

/**
 * The message the model sees when it is refused. It names the files and the
 * last thing that ran, so the next attempt can be specific instead of blind.
 */
export function stopGateReason(files: readonly string[], lastCheck: string | null): string {
  const named = files.length > 0 ? files.slice(0, 5).join(", ") : "the workspace";
  const tail =
    lastCheck !== null
      ? `The last check that passed was \`${lastCheck}\`, before the most recent change.`
      : "No check has passed in this session.";
  return (
    `jev stop gate: ${named} changed, but nothing has verified it since. ${tail} ` +
    "Run the project's checks (test, build, lint, or type-check) and fix what fails, " +
    "or state explicitly that no check applies to this change and stop again."
  );
}

/** The questions asked only to let a judgment LOOSEN a deterministic block. */
export function verificationQuestions(
  files: readonly string[],
): Record<string, { type: "noul"; instructions: string }> {
  return {
    needs_check: {
      type: "noul",
      instructions:
        "The change below is finished and needs no test, build, lint, or type-check to be trustworthy " +
        "(for example documentation, comments, formatting-only edits, or a change to a file no code consumes). " +
        "Answer yes only when running any check would be pointless: " +
        (files.length > 0 ? files.slice(0, 5).join(", ") : "the changed files"),
    },
  };
}
