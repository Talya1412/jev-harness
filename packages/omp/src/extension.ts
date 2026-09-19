/**
 * Jev tools + auto-hooks for Oh My Pi (OMP-native adapter).
 *
 * Exposes TypeSafe's System One model (Jev) as LLM-callable tools and as
 * opt-in automatic hooks. All Jev traffic goes through '@jev-harness/core',
 * which owns retries, timeouts, and the typed answer accessors.
 *
 * Tools (always registered, called on demand):
 * - 'jev_ask': typed noul/choice/score questions over an arbitrary state.
 * - 'jev_models': list the System One models available to the key.
 * - 'jev_route_skills': rank the skill roster against a task (advisory).
 * - 'jev_browse_goal': pick the next browser action from a snapshot (advisory).
 * - 'jev_pick_tool': pick one tool for a task + flag confirmation (advisory).
 *
 * Hooks (all require 'OMP_JEV_AUTO=1', each with its own off-switch):
 * - 'tool_call': destructive gate, fail-open.
 * - 'input': skill suggestion as append-only additionalContext.
 * - 'session_before_compact': verbatim compaction, fail-open.
 *
 * Auth: TYPESAFE_API_KEY from the environment (never hardcoded, never logged).
 * Optional overrides: TYPESAFE_BASE_URL, TYPESAFE_DEFAULT_MODEL, JEV_TIMEOUT_MS.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  askJev,
  chooseBrowserAction,
  judgeDestructive,
  listJevModels,
  noul,
  pickTool,
  routeSkill,
  type JevConfig,
  type Questions,
} from "@jev-harness/core";

const DEFAULT_TIMEOUT_MS = 15_000;
const GATE_THRESHOLD = 0.75;
const SKILL_MIN_CONFIDENCE = 0.5;

function readConfig(modelOverride?: string): JevConfig {
  const apiKey = (process.env.TYPESAFE_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error(
      "TYPESAFE_API_KEY is not set. Add it to ~/.omp/agent/.env or export it before launching omp."
    );
  }
  const timeoutRaw = (process.env.JEV_TIMEOUT_MS ?? "").trim();
  const timeoutMs =
    timeoutRaw !== "" && Number.isFinite(Number(timeoutRaw))
      ? Number(timeoutRaw)
      : DEFAULT_TIMEOUT_MS;
  return {
    apiKey,
        baseUrl: (process.env.TYPESAFE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: (modelOverride ?? "").trim() || process.env.TYPESAFE_DEFAULT_MODEL || DEFAULT_MODEL,
    timeoutMs,
  };
}

/** Master switch plus a per-hook off-switch ('<name>=0' disables one hook). */
function autoOn(env: string): boolean {
  return (
    (process.env.OMP_JEV_AUTO ?? "").trim() === "1" &&
    (process.env[env] ?? "1").trim() !== "0"
  );
}

function envNum(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export default function jevExtension(pi: ExtensionAPI): void {
  const z = pi.zod;

  const questionSchema = z
    .object({
      type: z.enum(["noul", "choice", "score"]).describe("Question primitive"),
      instructions: z.string().describe("The single narrow judgment to make"),
      criteria: z
        .union([z.array(z.string()), z.record(z.string(), z.string())])
        .optional()
        .describe("For choice: {key: description}. For score: ordered [low..high] levels."),
    })
    .passthrough();

  pi.registerTool({
    name: "jev_ask",
    label: "Jev Ask",
    description:
      "Ask TypeSafe's Jev (System One) typed questions about a state and get calibrated probabilities. " +
      "questions is a map of id -> {type: 'noul'|'choice'|'score', instructions, criteria?}. " +
      "noul returns P(yes); choice returns the winning key + probabilities + confidence; score returns a " +
      "probability-weighted level. Use for routing, ranking, extraction, verification, and confidence-gated " +
      "decisions where code needs semantic judgment rather than generated text.",
    parameters: z.object({
      state: z
        .union([z.string(), z.record(z.string(), z.any()), z.array(z.any())])
        .describe("The content to judge — text, or a JSON object with named fields referenced by backticked paths."),
      questions: z.record(z.string(), questionSchema).describe("Map of question id -> question definition."),
      model: z.string().optional().describe("Override model (default jev-latest)."),
    }),
    loadMode: "essential",
    approval: "read",
    async execute(_id: string, params: any, signal?: AbortSignal) {
      const cfg = readConfig(params.model);
      const result = await askJev(cfg, params.state, params.questions as unknown as Questions, signal ?? undefined);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "jev_models",
    label: "Jev Models",
    description: "List the TypeSafe System One models available to the configured API key.",
    parameters: z.object({}),
    loadMode: "essential",
    approval: "read",
    async execute(_id: string, _params: any, _signal?: AbortSignal) {
      const cfg = readConfig();
      const models = await listJevModels(cfg);
      const text = JSON.stringify(models, null, 2);
      return { content: [{ type: "text", text }], details: { models } };
    },
  });

  pi.registerTool({
    name: "jev_route_skills",
    label: "Jev Route Skills",
    description:
      "Rank the installed skill roster against a task description using one Jev call. " +
      "Pass the task text and the candidate skill names; returns a relevance ranking plus a " +
      "no-skill-needed probability. Advisory: decide from the result, do not blindly load the top hit.",
    loadMode: "discoverable",
    parameters: z.object({
      task: z.string().describe("The user's task or first message to route."),
      skills: z.array(z.string()).describe("Candidate skill names to rank."),
    }),
    approval: "read",
    async execute(_id: string, params: any, signal?: AbortSignal) {
      const cfg = readConfig();
      const result = await routeSkill(
        cfg,
        params.task,
        params.skills.map((name: string) => ({ name })),
        { signal: signal ?? undefined }
      );
      const hint =
        result.skill !== null
          ? "Consider loading skill: " + result.skill
          : "No listed skill is relevant.";
      return {
        content: [{ type: "text", text: hint + "\n\n" + JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "jev_browse_goal",
    label: "Jev Browse Goal",
    description:
      "Given a goal and a numbered element table from a page snapshot, ask Jev to pick the single next browser action. " +
      "Returns the operation plus the chosen target. " +
      "ADVISORY: this tool does not execute anything — validate the returned index against the live snapshot and act in code.",
    parameters: z.object({
      goal: z.string().describe("What the user wants to achieve on the page."),
      elements: z.array(z.object({
        index: z.string().describe("Stable element index from the snapshot, e.g. '3' or '5:2' for a select option."),
        label: z.string().describe("Human-visible label."),
        role: z.string().optional().describe("ARIA role, e.g. combobox / button / link."),
        value: z.string().optional().describe("Current value, if any."),
        operations: z.array(z.string()).describe("Operations this element supports, e.g. ['CLICK','TYPE_TEXT']."),
      })).describe("Numbered interactive elements from the current snapshot."),
      page: z.object({ url: z.string(), title: z.string().optional(), text: z.string().optional() }).describe("Current page context."),
      recent_actions: z.array(z.object({ action: z.string(), kind: z.string().optional(), page_changed: z.boolean().optional() })).optional().describe("Last few actions taken."),
    }),
    loadMode: "discoverable",
    approval: "read",
    async execute(_id: string, params: any, signal?: AbortSignal) {
      const cfg = readConfig();
      const result = await chooseBrowserAction(
        cfg,
        {
          goal: params.goal,
          page: params.page,
          elements: params.elements,
          recentActions: (params.recent_actions ?? []).map((r: any) => ({
            action: String(r?.action ?? ""),
            kind: r?.kind,
            pageChanged: r?.page_changed,
          })),
        },
        { signal: signal ?? undefined }
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "jev_pick_tool",
    label: "Jev Pick Tool",
    description:
      "Given a task and a list of candidate tools with their schemas, ask Jev which single tool to use and whether it needs confirmation. " +
      "Best when the candidate set is enumerable (few tools, closed-set args). ADVISORY: this does not execute the tool.",
    parameters: z.object({
      task: z.string().describe("What the user is asking for."),
      tools: z.array(z.object({
        name: z.string(),
        description: z.string(),
        args: z.record(z.string(), z.string()).optional().describe("Map of arg name -> type/description, for closed-set args."),
      })).describe("Candidate tools to choose from."),
      context: z.string().optional().describe("Extra context, e.g. recent error or file being worked on."),
    }),
    loadMode: "discoverable",
    approval: "read",
    async execute(_id: string, params: any, signal?: AbortSignal) {
      const cfg = readConfig();
      const result = await pickTool(
        cfg,
        { task: params.task, tools: params.tools, context: params.context },
        { signal: signal ?? undefined }
      );
      const out = {
        tool: result.tool,
        confidence: result.confidence,
        risky_probability: result.risky,
        confirm_required: result.confirmRequired,
        act: result.act,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        details: out,
      };
    },
  });

  // ---- Selective auto-Jev hooks (opt-in via OMP_JEV_AUTO=1) -----------------
  // Why opt-in: these spend a Jev call per qualifying event. Cheap but latency
  // is real (~200-400ms), so the user enables it deliberately. Each hook is
  // independently gated so one can be turned off.

  // Gate 1 — tool_call: block a tool call Jev judges dangerous before it runs.
  // Fail-open on any error: a Jev outage must never freeze the agent.
  pi.on("tool_call", async (event: any) => {
    if (!autoOn("OMP_JEV_GATE")) return;
    try {
      const name = String(event?.toolName ?? "");
      // Only adjudicate tools that can mutate the world; cheap reads skip the call.
      if (!/^(bash|write|edit|delete|move|rm|mcp__)/i.test(name)) return;
      const cfg = readConfig();
      const verdict = await judgeDestructive(
        cfg,
        { tool: name, input: event?.input ?? {}, cwd: process.cwd() },
        { threshold: GATE_THRESHOLD }
      );
      if (verdict.blocked) {
        return {
          block: true,
          reason: "jev gate: destructive effect likely (" + verdict.destructive.toFixed(2) + "). Re-issue with explicit confirmation or adjust the command.",
        };
      }
    } catch (err) {
      // CRITICAL: a 'tool_call' handler that throws blocks the tool (fail-closed).
      // Any Jev failure must therefore resolve to "allow" — never let the gate
      // become a single point of failure for every mutating action. The logger
      // call itself is guarded for the same reason.
      try {
        pi.logger.warn("jev gate: allowed on error (fail-open)", { error: String(err) });
      } catch {
        // Logger unavailable — still allow.
      }
      return; // allow
    }
  });

  // Gate 2 — input: silently suggest a skill for the incoming message.
  // Advisory only: injects ONE line, never blocks, never loads anything itself.
  // Append-only: returns additionalContext and never rewrites the system prefix,
  // so the provider prompt-cache prefix stays intact between turns.
  (pi.on as (name: string, handler: (event: any, ctx: any) => unknown) => void)("input", async (event: any, ctx: any) => {
    if (!autoOn("OMP_JEV_SKILL_ROUTER")) return;
    try {
      const text = String(event?.text ?? event?.prompt ?? "");
      if (text.length < 12) return;
      let roster: Array<{ name: string; description: string }> = [];
      try {
        roster = ((ctx?.skills ?? []) as Array<any>)
          .map((s) => ({ name: String(s?.name ?? ""), description: String(s?.description ?? "") }))
          .filter((s) => s.name !== "");
      } catch {
        roster = [];
      }
      if (roster.length === 0) return;
      // Cheap lexical prefilter keeps the choice set small before spending a call.
      const lower = text.toLowerCase();
      const scored = roster.map((s) => {
        const parts = s.name.toLowerCase().split(/[-_]/);
        let score = 0;
        for (const part of parts) {
          if (part.length > 3 && lower.includes(part)) score += 2;
          // also match the acronym form: fh6-modding -> "fh6"
          if (part.length <= 4 && lower.includes(part)) score += 1;
        }
        return { name: s.name, score };
      });
      const lexical = scored.filter((x) => x.score > 0).map((x) => x.name);
      // If nothing matched lexically, still give Jev the roster when it is small
      // enough for a choice; otherwise abstain rather than spend a weak call.
      const shortlist = (lexical.length > 0 ? lexical : roster.map((s) => s.name)).slice(0, 12);
      if (shortlist.length === 0) return;
      // Names alone are ambiguous, so send a one-line description per candidate
      // (core builds the choice criteria from these).
      const byName = new Map<string, string>();
      for (const s of roster) {
        byName.set(s.name, s.description.replace(/\s+/g, " ").slice(0, 180));
      }
      const cfg = readConfig();
      const result = await routeSkill(
        cfg,
        text,
        shortlist.map((name) => ({ name, description: byName.get(name) ?? "" })),
        { minConfidence: SKILL_MIN_CONFIDENCE, maxCandidates: 12 }
      );
      if (result.skill !== null) {
        return { additionalContext: "[jev] Consider loading skill: " + result.skill };
      }
    } catch (err) {
      try {
        pi.logger.debug("jev skill router skipped", { error: String(err) });
      } catch {
        // Logger unavailable — skip silently.
      }
      return;
    }
  });

  // ---- Verbatim compaction --------------------------------------------------
  // Why this shape: a summary is lossy — a path, exact error, or constraint can
  // vanish even when it matters later. Here Jev only decides *what to drop*;
  // everything kept stays byte-identical. Never rewrites text.
  //
  // Integration point: `session_before_compact` ONLY. We deliberately do NOT
  // hook the per-request `context` event (that invalidates the provider prompt
  // cache every turn).
  //
  // Fail-open: any Jev error, missing key, or unfittable history returns
  // undefined so OMP runs its normal compaction instead.
  const COMPACT_DEFAULTS = {
    keepThreshold: 0.2, // measured: real scores sit 0.2-0.4, so 0.5 keeps nearly everything
    maxStateTokens: 25000,
    maxRequestTokens: 30000,
    truncateHeadChars: 300,
    minReductionRatio: 0.25,
  };

  // OMP message -> the flat shape the scorer reasons over.
  type FlatMsg = {
    role: string;
    text: string;
    toolUses: Array<{ id: string; tool: string; input: unknown }>;
    toolResults: Array<{ id: string; text: string }>;
  };

  function flatten(messages: readonly unknown[]): FlatMsg[] {
    const out: FlatMsg[] = [];
    for (const raw of messages) {
      const m = raw as Record<string, unknown>;
      const role = String(m.role ?? "unknown");
      const blocks = Array.isArray(m.content) ? (m.content as any[]) : [];
      const texts: string[] = [];
      const toolUses: FlatMsg["toolUses"] = [];
      const toolResults: FlatMsg["toolResults"] = [];
      for (const b of blocks) {
        if (!b || typeof b !== "object") {
          if (typeof b === "string") texts.push(b);
          continue;
        }
        if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
        else if (b.type === "tool_use" || b.type === "tool_call") {
          toolUses.push({
            id: String(b.id ?? b.toolCallId ?? ""),
            tool: String(b.name ?? b.toolName ?? "tool"),
            input: b.input ?? b.args ?? {},
          });
        } else if (b.type === "tool_result") {
          const c = b.content;
          let tr = "";
          if (typeof c === "string") tr = c;
          else if (Array.isArray(c)) tr = c.map((x: any) => (typeof x === "string" ? x : x?.text ?? "")).join("\n");
          else if (c != null) tr = JSON.stringify(c);
          toolResults.push({ id: String(b.tool_use_id ?? b.toolUseId ?? ""), text: tr });
        }
      }
      out.push({ role, text: texts.join("\n"), toolUses, toolResults });
    }
    return out;
  }

  // Pair each tool_use with its result; a call with no result is still scored
  // (the record of having tried matters), a result with no call is not.
  interface CompactCall {
    id: string;
    tool: string;
    input: unknown;
    resultChars: number;
    resultText: string | null;
  }

  function collectCalls(msgs: readonly FlatMsg[]): CompactCall[] {
    const byId = new Map<string, CompactCall>();
    for (const m of msgs) {
      for (const u of m.toolUses) {
        if (u.id && !byId.has(u.id)) {
          byId.set(u.id, { id: u.id, tool: u.tool, input: u.input, resultChars: 0, resultText: null });
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

  function estimateTokens(s: string): number {
    // Calibrated heuristic: a word per six letters, half a token per digit,
    // ~one per other symbol. Lands slightly above Jev's own reported count.
    let tok = 0;
    for (const ch of s) {
      if (/[A-Za-z]/.test(ch)) tok += 1 / 6;
      else if (/[0-9]/.test(ch)) tok += 0.5;
      else tok += 1;
    }
    return Math.ceil(tok) + 8;
  }

  // Render the compact state: full conversation, results replaced by size notes.
  function buildCompactState(msgs: readonly FlatMsg[], calls: readonly CompactCall[]): unknown {
    const callById = new Map(calls.map((c) => [c.id, c]));
    void callById;
    return {
      conversation: msgs.map((m) => ({
        role: m.role,
        text: m.text.length > 4000 ? m.text.slice(0, 3000) + "\n...[truncated]...\n" + m.text.slice(-900) : m.text,
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
          "Tool call " + c.id + " (" + c.tool + ") should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next",
      },
    });
    Object.assign(q, {
      ["result_" + c.id]: {
        type: "noul",
        instructions:
          "The full output of tool call " + c.id + " (" + c.tool + ", " + c.resultChars + " chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do",
      },
    });
    return q;
  }

  function reduceCallQuestions(calls: readonly CompactCall[]): Questions {
    const q: Questions = {};
    for (const c of calls) Object.assign(q, questionsForCall(c));
    return q;
  }

  function batchCompactCalls(calls: readonly CompactCall[], stateTokens: number, budget: number): CompactCall[][] {
    const perCall = estimateTokens(JSON.stringify(reduceCallQuestions(calls.slice(0, 1))));
    const maxPerBatch = Math.max(1, Math.floor((budget - stateTokens - 20) / Math.max(1, perCall)));
    const out: CompactCall[][] = [];
    for (let i = 0; i < calls.length; i += maxPerBatch) out.push(calls.slice(i, i + maxPerBatch));
    return out;
  }

  pi.on("session_before_compact", async (event: any) => {
    if (!autoOn("OMP_JEV_CONTEXT")) return;
    try {
      const prep = event?.preparation;
      if (!prep || !Array.isArray(prep.messagesToSummarize)) return;
      const region = [...(prep.messagesToSummarize ?? []), ...(prep.turnPrefixMessages ?? [])];
      if (region.length === 0) return;

      const flat = flatten(region);
      const calls = collectCalls(flat);
      if (calls.length === 0) return; // nothing scoreable -> let OMP compact normally

      const cfg = readConfig();
      const keepThreshold = envNum("OMP_JEV_KEEP_THRESHOLD", COMPACT_DEFAULTS.keepThreshold);
      const maxStateTokens = envNum("OMP_JEV_MAX_STATE_TOKENS", COMPACT_DEFAULTS.maxStateTokens);
      const maxRequestTokens = envNum("OMP_JEV_MAX_REQUEST_TOKENS", COMPACT_DEFAULTS.maxRequestTokens);
      const truncateHead = envNum("OMP_JEV_TRUNCATE_HEAD", COMPACT_DEFAULTS.truncateHeadChars);
      const minReduction = envNum("OMP_JEV_MIN_REDUCTION", COMPACT_DEFAULTS.minReductionRatio);

      const state = buildCompactState(flat, calls);
      const stateTokens = estimateTokens(JSON.stringify(state));
      if (stateTokens > maxStateTokens) {
        pi.logger.warn("jev_compact: state too large, deferring to native compaction", { stateTokens, maxStateTokens });
        return;
      }

      const batches = batchCompactCalls(calls, stateTokens, maxRequestTokens);
      // Fan out: independent questions over the same state run in parallel.
      const results = await Promise.all(batches.map((b) => askJev(cfg, state, reduceCallQuestions(b))));

      // Merge per-batch answers; an unparseable answer keeps its content (fail-open).
      const probs = new Map<string, number>();
      for (const r of results) {
        for (const id of Object.keys(r.answers)) {
          try {
            probs.set(id, noul(r, id));
          } catch {
            probs.set(id, 1);
          }
        }
      }
      const keepProb = (id: string): number => probs.get(id) ?? 1;

      const decisions = calls.map((c) => {
        const keepCall = keepProb("call_" + c.id);
        const keepResult = keepProb("result_" + c.id);
        // allowDroppingCalls defaults false: a low score loses the output, never the record.
        const action = keepResult >= keepThreshold ? ("keep" as const) : ("drop_result" as const);
        return { call: c, action, keepCall, keepResult };
      });

      const dropped = decisions.filter((d) => d.action === "drop_result" && d.call.resultChars > truncateHead);
      const savedChars = dropped.reduce((n, d) => n + (d.call.resultChars - truncateHead), 0);
      const totalChars = calls.reduce((n, c) => n + c.resultChars, 0);
      if (totalChars === 0 || savedChars / totalChars < minReduction) {
        pi.logger.debug("jev_compact: insufficient reduction, deferring", { savedChars, totalChars });
        return;
      }

      // Build the verbatim summary: kept text stays byte-identical; dropped
      // results become head + a recoverable note.
      const truncById = new Map(dropped.map((d) => [d.call.id, d.call] as const));
      const render = (msgs: readonly FlatMsg[]): string =>
        msgs
          .map((m) => {
            const parts: string[] = [];
            if (m.text) parts.push(m.text);
            for (const u of m.toolUses) {
              const t = truncById.get(u.id);
              parts.push("[tool_use id=" + u.id + " name=" + u.tool + " input=" + JSON.stringify(u.input) + "]");
              if (t && t.resultText != null) {
                const full: string = t.resultText;
                parts.push(
                  "[tool_result id=" + u.id + "] " + full.slice(0, truncateHead) +
                  "\n[..." + (t.resultChars - truncateHead) + " chars omitted by jev_compact; re-run the tool to recover]"
                );
              }
            }
            for (const r of m.toolResults) {
              if (m.toolUses.some((w) => w.id === r.id)) continue;
              const t = truncById.get(r.id);
              if (t && t.resultText != null) {
                const full: string = t.resultText;
                parts.push(
                  "[tool_result id=" + r.id + "] " + full.slice(0, truncateHead) +
                  "\n[..." + (t.resultChars - truncateHead) + " chars omitted by jev_compact]"
                );
              } else {
                parts.push("[tool_result id=" + r.id + "] " + r.text);
              }
            }
            return parts.filter(Boolean).join("\n");
          })
          .filter(Boolean)
          .join("\n\n");

      const summary =
        "Verbatim history retained; " + dropped.length + " tool output(s) truncated by Jev decisions.\n\n" + render(flat);

      pi.logger.debug("jev_compact: reduced", {
        calls: calls.length,
        dropped: dropped.length,
        batches: batches.length,
        savedChars,
      });

      return {
        compaction: {
          summary,
          shortSummary: "Jev verbatim compaction: " + dropped.length + "/" + calls.length + " tool outputs truncated",
          firstKeptEntryId: prep.firstKeptEntryId,
          tokensBefore: prep.tokensBefore,
          details: { jev: { calls: calls.length, dropped: dropped.length, savedChars, keepThreshold } },
        },
      };
    } catch (err) {
      // Fail open — native compaction must still happen.
      try {
        pi.logger.warn("jev_compact failed, falling back to native compaction", { error: String(err) });
      } catch {
        // Logger unavailable — fall back silently.
      }
      return;
    }
  });
}
