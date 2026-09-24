/**
 * Verbatim compaction: Jev decides *what to drop*, never rewrites what is kept.
 *
 * A summary is lossy — a path, exact error, or constraint can vanish even when
 * it matters later. Here every kept byte is byte-identical to the input; only
 * tool results Jev judges unnecessary are replaced by a head plus a note.
 *
 * This module is pure: no ExtensionAPI, no network. The adapter wires
 * `planCompaction` to `session_before_compact` and supplies the asker.
 */
import { askJev, noul, type JevConfig, type Questions } from "@jev-harness/core";

export interface CompactDefaults {
  keepThreshold: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  truncateHeadChars: number;
  minReductionRatio: number;
}

/** Thresholds chosen from measurement, not taste; see the adapter README. */
export const COMPACT_DEFAULTS: CompactDefaults = {
  keepThreshold: 0.2,
  maxStateTokens: 25000,
  maxRequestTokens: 30000,
  truncateHeadChars: 300,
  minReductionRatio: 0.25,
};

export interface FlatMsg {
  role: string;
  text: string;
  toolUses: Array<{ id: string; tool: string; input: unknown }>;
  toolResults: Array<{ id: string; text: string }>;
}

export interface CompactCall {
  id: string;
  tool: string;
  input: unknown;
  resultChars: number;
  resultText: string | null;
}

/** Read a result body that is either a plain string or a list of content parts. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((x: any) => (typeof x === "string" ? x : typeof x?.text === "string" ? x.text : ""))
      .filter((s) => s !== "")
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

/**
 * Flatten harness messages into the flat shape the scorer reasons over.
 *
 * Three spellings reach this function and all three must resolve to the same
 * shape, because getting it wrong is invisible: the plan simply finds no calls
 * and defers forever.
 * - Anthropic-style blocks inside one message: `tool_use` + `tool_result`.
 * - OMP's own blocks: `{ type: "toolCall", id, name, arguments }` in an
 *   assistant message.
 * - OMP's own result message: `{ role: "toolResult", toolCallId, toolName,
 *   content }` — a WHOLE message, with no `toolUses` to pair against.
 *
 * The last case is why a `toolResult` message's body is routed to
 * {@link FlatMsg.toolResults} and never to `text`: a body left in `text`
 * would be re-emitted verbatim by the render path (defeating the truncation)
 * and would keep {@link collectCalls} from ever seeing a result. A message
 * with no `toolCallId` keeps its text so an unrecognised shape still loses
 * nothing.
 */
export function flatten(messages: readonly unknown[]): FlatMsg[] {
  const out: FlatMsg[] = [];
  for (const raw of messages) {
    const m = (raw ?? {}) as Record<string, unknown>;
    const role = String(m.role ?? "unknown");
    const blocks = Array.isArray(m.content) ? (m.content as any[]) : [];
    const texts: string[] = [];
    // A bare-string body is a legal spelling for user/developer/toolResult
    // messages; dropping it would lose real conversation text.
    if (typeof m.content === "string" && m.content !== "") texts.push(m.content);
    const toolUses: FlatMsg["toolUses"] = [];
    const toolResults: FlatMsg["toolResults"] = [];
    for (const b of blocks) {
      if (!b || typeof b !== "object") {
        if (typeof b === "string") texts.push(b);
        continue;
      }
      if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
      else if (b.type === "tool_use" || b.type === "tool_call" || b.type === "toolCall") {
        toolUses.push({
          id: String(b.id ?? b.toolCallId ?? ""),
          tool: String(b.name ?? b.toolName ?? "tool"),
          input: b.input ?? b.arguments ?? b.args ?? {},
        });
      } else if (b.type === "tool_result" || b.type === "toolResult") {
        toolResults.push({
          id: String(b.tool_use_id ?? b.toolUseId ?? b.toolCallId ?? ""),
          text: contentText(b.content),
        });
      }
    }
    if (role === "toolResult") {
      const id = String(m.toolCallId ?? "");
      if (id !== "") {
        // The body belongs to the result record, never to the message text:
        // text here would be re-emitted verbatim by the render path.
        toolResults.push({
          id,
          text: blocks.length > 0 ? contentText(m.content) : texts.join("\n"),
        });
        texts.length = 0;
      }
      // No id: keep whatever text we found, so an unrecognised shape loses nothing.
    }
    out.push({ role, text: texts.join("\n"), toolUses, toolResults });
  }
  return out;
}

/**
 * Pair each tool_use with its result. A call with no result is still scored
 * (the record of having tried matters); a result with no call is not.
 */
export function collectCalls(msgs: readonly FlatMsg[]): CompactCall[] {
  const byId = new Map<string, CompactCall>();
  for (const m of msgs) {
    for (const u of m.toolUses) {
      if (u.id && !byId.has(u.id)) {
        byId.set(u.id, {
          id: u.id,
          tool: u.tool,
          input: u.input,
          resultChars: 0,
          resultText: null,
        });
      }
    }
    for (const r of m.toolResults) {
      const c = byId.get(r.id);
      if (c) {
        c.resultChars = r.text.length;
        c.resultText = r.text;
      }
    }
  }
  return [...byId.values()];
}

/**
 * Token heuristic, calibrated to land slightly above Jev's own reported count:
 * a word per six letters, half a token per digit, ~one per other symbol.
 */
export function estimateTokens(s: string): number {
  let tok = 0;
  for (const ch of s) {
    if (/[A-Za-z]/.test(ch)) tok += 1 / 6;
    else if (/[0-9]/.test(ch)) tok += 0.5;
    else tok += 1;
  }
  return Math.ceil(tok) + 8;
}

/** Render the compact state: full conversation, results replaced by size notes. */
export function buildCompactState(msgs: readonly FlatMsg[]): unknown {
  return {
    conversation: msgs.map((m) => ({
      role: m.role,
      text:
        m.text.length > 4000
          ? m.text.slice(0, 3000) + "\n...[truncated]...\n" + m.text.slice(-900)
          : m.text,
      tool_calls: m.toolUses.map((u) => ({ id: u.id, tool: u.tool, input: u.input })),
      tool_results: m.toolResults.map((r) => ({
        id: r.id,
        note: "ok, " + r.text.length + " chars (omitted)",
        isError: /^\s*(error|Error|ERROR)/.test(r.text),
      })),
    })),
  };
}

function questionsForCall(c: CompactCall): Questions {
  const q: Questions = {};
  Object.assign(q, {
    ["call_" + c.id]: {
      type: "noul",
      instructions:
        "Tool call " +
        c.id +
        " (" +
        c.tool +
        ") should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next",
    },
  });
  Object.assign(q, {
    ["result_" + c.id]: {
      type: "noul",
      instructions:
        "The full output of tool call " +
        c.id +
        " (" +
        c.tool +
        ", " +
        c.resultChars +
        " chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do",
    },
  });
  return q;
}

/** Both per-call questions, as one map the client can send in a single request. */
export function reduceCallQuestions(calls: readonly CompactCall[]): Questions {
  const q: Questions = {};
  for (const c of calls) Object.assign(q, questionsForCall(c));
  return q;
}

/** Split calls into request-sized batches so state + questions fit the budget. */
export function batchCompactCalls(
  calls: readonly CompactCall[],
  stateTokens: number,
  budget: number,
): CompactCall[][] {
  const perCall = estimateTokens(JSON.stringify(reduceCallQuestions(calls.slice(0, 1))));
  const maxPerBatch = Math.max(1, Math.floor((budget - stateTokens - 20) / Math.max(1, perCall)));
  const out: CompactCall[][] = [];
  for (let i = 0; i < calls.length; i += maxPerBatch) out.push(calls.slice(i, i + maxPerBatch));
  return out;
}

/** A keep/drop decision for one call, with the probabilities behind it. */
export interface CompactionDecision {
  call: CompactCall;
  action: "keep" | "drop_result";
  keepCall: number;
  keepResult: number;
}

export interface CompactionPrep {
  region: readonly unknown[];
  /** Returns P(keep) for each question id; must be fail-open per id. */
  ask: (state: unknown, questions: Questions) => Promise<Record<string, number>>;
  effective: CompactDefaults;
}

export interface CompactionPlan {
  decisions: CompactionDecision[];
  dropped: CompactionDecision[];
  savedChars: number;
  totalChars: number;
  /** The verbatim transcript that replaces the summarized region. */
  summary: string;
}

/** Why a region was left to native compaction. */
export type DeferralReason =
  "no-messages" | "no-calls" | "state-too-large" | "insufficient-reduction";

export type CompactionOutcome =
  | { kind: "compacted"; plan: CompactionPlan }
  | { kind: "defer"; reason: DeferralReason; detail?: Record<string, number> };

/**
 * Decide what to drop, then render the replacement transcript.
 *
 * Returns a deferral (never a throw) whenever Jev's input would not fit, no
 * call is scoreable, or the saving would be too small to be worth the call —
 * in every such case the caller should fall back to native compaction.
 */
export async function planCompaction(prep: CompactionPrep): Promise<CompactionOutcome> {
  const region = [...prep.region];
  if (region.length === 0) return { kind: "defer", reason: "no-messages" };

  const flat = flatten(region);
  const calls = collectCalls(flat);
  if (calls.length === 0) return { kind: "defer", reason: "no-calls" };

  const state = buildCompactState(flat);
  const stateTokens = estimateTokens(JSON.stringify(state));
  if (stateTokens > prep.effective.maxStateTokens) {
    return {
      kind: "defer",
      reason: "state-too-large",
      detail: { stateTokens, maxStateTokens: prep.effective.maxStateTokens },
    };
  }

  const batches = batchCompactCalls(calls, stateTokens, prep.effective.maxRequestTokens);
  const answers = new Map<string, number>();
  for (const batch of batches) {
    const partial = await prep.ask(state, reduceCallQuestions(batch));
    for (const [id, p] of Object.entries(partial)) answers.set(id, p);
  }
  // A missing answer keeps its content: dropping needs a positive score.
  const keepProb = (id: string): number => answers.get(id) ?? 1;

  const decisions: CompactionDecision[] = calls.map((c) => {
    const keepCall = keepProb("call_" + c.id);
    const keepResult = keepProb("result_" + c.id);
    // allowDroppingCalls defaults false: a low score loses the output, never the record.
    const action =
      keepResult >= prep.effective.keepThreshold ? ("keep" as const) : ("drop_result" as const);
    return { call: c, action, keepCall, keepResult };
  });

  const dropped = decisions.filter(
    (d) => d.action === "drop_result" && d.call.resultChars > prep.effective.truncateHeadChars,
  );
  const savedChars = dropped.reduce(
    (n, d) => n + (d.call.resultChars - prep.effective.truncateHeadChars),
    0,
  );
  const totalChars = calls.reduce((n, c) => n + c.resultChars, 0);
  if (totalChars === 0 || savedChars / totalChars < prep.effective.minReductionRatio) {
    return { kind: "defer", reason: "insufficient-reduction", detail: { savedChars, totalChars } };
  }

  const truncById = new Map(dropped.map((d) => [d.call.id, d.call] as const));

  /**
   * Render one tool result. The head is always kept; the tail is replaced by a
   * note naming the recovered size. Two things matter here and both used to be
   * wrong:
   * - the head is taken from `resultText` when the region carried a body and
   *   from the rendered text otherwise, so a result whose body never reached
   *   this map is HELD (head + note) rather than dropped or replaced by a bare
   *   marker;
   * - the note is part of the returned string, never a falsy part of a
   *   `filter(Boolean)` list, so truncation can never silently delete output.
   */
  const renderResult = (id: string, fallback: string): string => {
    const t = truncById.get(id);
    if (!t) return "[tool_result id=" + id + "] " + fallback;
    const head = prep.effective.truncateHeadChars;
    const body = t.resultText ?? fallback;
    const omitted = Math.max(0, body.length - head);
    return (
      "[tool_result id=" +
      id +
      "] " +
      body.slice(0, head) +
      (omitted > 0
        ? "\n[..." + omitted + " chars omitted by jev_compact; re-run the tool to recover]"
        : "")
    );
  };

  // A result id carried by its own message is rendered there, once. The inline
  // branch below exists only for the Anthropic block spelling, where a
  // truncated result would otherwise be announced without its head.
  const carried = new Set<string>();
  for (const m of flat) for (const r of m.toolResults) carried.add(r.id);

  const render = (msgs: readonly FlatMsg[]): string =>
    msgs
      .map((m) => {
        const parts: string[] = [];
        for (const r of m.toolResults) parts.push(renderResult(r.id, r.text));
        for (const u of m.toolUses) {
          parts.push(
            "[tool_use id=" + u.id + " name=" + u.tool + " input=" + JSON.stringify(u.input) + "]",
          );
          if (!carried.has(u.id) && truncById.has(u.id)) parts.push(renderResult(u.id, ""));
        }
        if (m.text) parts.unshift(m.text);
        return parts.filter(Boolean).join("\n");
      })
      .filter(Boolean)
      .join("\n\n");

  const summary =
    "Verbatim history retained; " +
    dropped.length +
    " tool output(s) truncated by Jev decisions.\n\n" +
    render(flat);

  return { kind: "compacted", plan: { decisions, dropped, savedChars, totalChars, summary } };
}

/**
 * Network-backed asker for {@link planCompaction}: one `askJev` per batch over
 * the same state, merging the per-id probabilities and failing open per id.
 */
export function jevAsker(cfg: JevConfig): CompactionPrep["ask"] {
  return async (state, questions) => {
    const response = await askJev(cfg, state as object, questions);
    const out: Record<string, number> = {};
    for (const id of Object.keys(response.answers)) {
      try {
        out[id] = noul(response, id);
      } catch {
        out[id] = 1;
      }
    }
    return out;
  };
}
