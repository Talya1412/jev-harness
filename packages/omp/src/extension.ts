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
 * - 'jev_browse_action': pick the next browser action from a snapshot (advisory).
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
  askJev,
  chooseBrowserAction,
  judgeDestructive,
  listJevModels,
  pickTool,
  routeSkill,
  type Questions,
} from "@jev-harness/core";
import { GATE_THRESHOLD, SKILL_MIN_CONFIDENCE, autoOn, envNum, readConfig, redactOn } from "./config.js";
import { COMPACT_DEFAULTS, jevAsker, planCompaction, type CompactDefaults } from "./compact.js";
import { MIN_PROMPT_CHARS, candidatePayload, shortlistSkills, type SkillCandidate } from "./skills.js";

/** `process.env` bound once, so the pure helpers stay testable. */
const ENV = process.env;

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
      const cfg = readConfig(ENV, params.model, redactOn(ENV, "tool"));
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
      const cfg = readConfig(ENV);
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
      const cfg = readConfig(ENV, undefined, redactOn(ENV, "tool"));
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
    name: "jev_browse_action",
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
      const cfg = readConfig(ENV, undefined, redactOn(ENV, "tool"));
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
      const cfg = readConfig(ENV, undefined, redactOn(ENV, "tool"));
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
    if (!autoOn(ENV, "OMP_JEV_GATE")) return;
    try {
      const name = String(event?.toolName ?? "");
      // Only adjudicate tools that can mutate the world; cheap reads skip the call.
      if (!/^(bash|write|edit|delete|move|rm|mcp__)/i.test(name)) return;
      const cfg = readConfig(ENV, undefined, redactOn(ENV, "hook"));
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
    if (!autoOn(ENV, "OMP_JEV_SKILL_ROUTER")) return;
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
      const cfg = readConfig(ENV, undefined, redactOn(ENV, "hook"));
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
  // Fail-open: any Jev error, missing key, unfittable history, or saving too
  // small to matter returns undefined so OMP runs its normal compaction.
  pi.on("session_before_compact", async (event: any) => {
    if (!autoOn(ENV, "OMP_JEV_CONTEXT")) return;
    try {
      const prep = event?.preparation;
      if (!prep || !Array.isArray(prep.messagesToSummarize)) return;

      const effective: CompactDefaults = {
        keepThreshold: envNum(ENV, "OMP_JEV_KEEP_THRESHOLD", COMPACT_DEFAULTS.keepThreshold),
        maxStateTokens: envNum(ENV, "OMP_JEV_MAX_STATE_TOKENS", COMPACT_DEFAULTS.maxStateTokens),
        maxRequestTokens: envNum(ENV, "OMP_JEV_MAX_REQUEST_TOKENS", COMPACT_DEFAULTS.maxRequestTokens),
        truncateHeadChars: envNum(ENV, "OMP_JEV_TRUNCATE_HEAD", COMPACT_DEFAULTS.truncateHeadChars),
        minReductionRatio: envNum(ENV, "OMP_JEV_MIN_REDUCTION", COMPACT_DEFAULTS.minReductionRatio),
      };

      const cfg = readConfig(ENV, undefined, redactOn(ENV, "hook"));
      const outcome = await planCompaction({
        region: [...(prep.messagesToSummarize ?? []), ...(prep.turnPrefixMessages ?? [])],
        ask: jevAsker(cfg),
        effective,
      });

      if (outcome.kind === "defer") {
        pi.logger.debug("jev_compact: deferring to native compaction", {
          reason: outcome.reason,
          ...(outcome.detail ?? {}),
        });
        return;
      }

      const { plan } = outcome;
      pi.logger.debug("jev_compact: reduced", {
        calls: plan.decisions.length,
        dropped: plan.dropped.length,
        savedChars: plan.savedChars,
      });

      return {
        compaction: {
          summary: plan.summary,
          shortSummary:
            "Jev verbatim compaction: " + plan.dropped.length + "/" + plan.decisions.length + " tool outputs truncated",
          firstKeptEntryId: prep.firstKeptEntryId,
          tokensBefore: prep.tokensBefore,
          details: {
            jev: {
              calls: plan.decisions.length,
              dropped: plan.dropped.length,
              savedChars: plan.savedChars,
              keepThreshold: effective.keepThreshold,
            },
          },
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
