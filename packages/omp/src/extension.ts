/**
 * Jev tools + auto-hooks for Oh My Pi (OMP-native adapter).
 *
 * Exposes TypeSafe's System One model (Jev) as LLM-callable tools and as
 * opt-in automatic hooks. All Jev traffic goes through '@jev-harness/core',
 * which owns retries, timeouts, and the typed answer accessors.
 *
 * Tools (always registered, called on demand):
 * - 'jev': ONE advisory tool whose `mode` parameter selects the pattern —
 *   `route_skills` (rank the skill roster against a task), `browse_action`
 *   (next browser action from a snapshot), `pick_tool` (one tool for a task,
 *   plus a confirmation flag).
 *
 * Why one tool: the three modes share a shape (state in, ranked judgment out)
 * and carry large schemas, and OMP mounts a 'discoverable' tool under `xd://`
 * or BM25 search rather than the top-level schema — so one tool costs one
 * entry in that surface instead of three. Nothing here re-implements OMP's
 * native `eval` prelude (`judge()` / `judge_batch()`) or
 * `omp models typesafe`, which is why the old `jev_ask` and `jev_models`
 * tools were removed.
 *
 * Hooks (all require 'OMP_JEV_AUTO=1', each with its own off-switch):
 * - 'tool_call': destructive gate — dual gate with a confirm path, fail-open.
 * - 'before_agent_start': skill suggestion, delivered as a custom message.
 * - 'session_before_compact': verbatim compaction, fail-open.
 *
 * Auth: TYPESAFE_API_KEY from the environment (never hardcoded, never logged).
 * Optional overrides: TYPESAFE_BASE_URL, TYPESAFE_DEFAULT_MODEL, JEV_TIMEOUT_MS.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  chooseBrowserAction,
  createBudgetGuard,
  createDecisionLog,
  createPersistentCache,
  decisionDigest,
  judgeDestructiveDual,
  jsonlSink,
  pickTool,
  routeSkill,
  withPersistentCache,
  type JevConfig,
} from "@jev-harness/core";
import {
  GATE_DEADLINE_MS,
  GATE_THRESHOLD,
  SKILL_MIN_CONFIDENCE,
  autoOn,
  envNum,
  readConfig,
  redactOn,
  withDeadline,
} from "./config.js";
import { COMPACT_DEFAULTS, jevAsker, planCompaction, type CompactDefaults } from "./compact.js";
import { createTracedLedger, decideOnFailure, reportFailure } from "./failure.js";
import {
  MIN_PROMPT_CHARS,
  createSkillRouter,
  defaultSkillDirs,
  loadSkillRoster,
  localRoute,
  localRouteHint,
  skillHint,
  userAlreadyChose,
  type RosterSkill,
} from "./router.js";

/** `process.env` bound once, so the pure helpers stay testable. */
const ENV = process.env;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Process-wide resilience layer shared by every tool and hook:
 * - budget guard caps runaway loops (default 120 requests/min, OMP_JEV_MAX_CALLS_PER_MIN to tune, 0 = off)
 * - persistent cache turns repeat judgments into free hits across sessions
 */
const maxPerMin = envNum(ENV, "OMP_JEV_MAX_CALLS_PER_MIN", 120);
const guard =
  maxPerMin > 0 ? createBudgetGuard({ maxPerWindow: maxPerMin, windowMs: 60_000 }) : null;
const persistentCache = createPersistentCache({
  dir: (ENV.OMP_JEV_CACHE_DIR ?? "").trim() || join(homedir(), ".omp", "cache", "jev-harness"),
  ttlMs: envNum(ENV, "OMP_JEV_CACHE_TTL_MS", DAY_MS),
});

/** readConfig + resilience wrapping. Unifies every askJev call site. */
function jevConfig(modelOverride?: string, redact?: boolean): JevConfig {
  let cfg = readConfig(ENV, modelOverride, redact);
  if (guard) cfg = guard.wrap(cfg);
  return withPersistentCache(cfg, persistentCache);
}

/** Gate decisions: in-memory ring always, JSONL when OMP_JEV_DECISION_LOG is set. */
const gateLog = createDecisionLog(
  (ENV.OMP_JEV_DECISION_LOG ?? "").trim()
    ? { sink: jsonlSink((ENV.OMP_JEV_DECISION_LOG ?? "").trim()) }
    : {},
);

/**
 * Refusals and abstains, so a declined action leaves a trail. A gate block, a
 * routing abort, and a compaction deferral are decisions whose reason the model
 * never sees; without this they simply vanish. When OMP_JEV_DECISION_LOG is
 * set, each distinct refusal is also appended there as one JSON line — the same
 * file the gate's decision log uses — so the trace survives the process.
 *
 * Exported as a test seam: a hook's ledger record is part of its contract (the
 * degraded router path's entry especially), and `index.ts` does not re-export
 * this, so the package's public API is unchanged.
 */
export const refusals = createTracedLedger(ENV.OMP_JEV_DECISION_LOG);

/**
 * Set once an `auth` or `model` failure proves the configured key/model
 * cannot work. Every later call fails identically while still spending the host
 * handler's latency budget, so the hooks stand down until the process restarts.
 * A non-fatal failure never sets it, so a transient blip cannot disable Jev.
 */
let sessionDisabled = false;

/** Skill roster + scheduling, per session (the roster is read once per turn). */
const skillRouter = createSkillRouter({
  judge: async (text, candidates) => {
    const cfg = jevConfig(undefined, redactOn(ENV, "hook"));
    const result = await routeSkill(cfg, text, candidates, {
      minConfidence: SKILL_MIN_CONFIDENCE,
      maxCandidates: candidates.length,
    });
    return { skill: result.skill, confidence: result.confidence };
  },
});

export default function jevExtension(pi: ExtensionAPI): void {
  const z = pi.zod;

  pi.registerTool({
    name: "jev",
    label: "Jev",
    description:
      "Ask TypeSafe's Jev (System One) for one narrow, calibrated judgment over a state, then act on the " +
      "probability in code. Pick mode: 'route_skills' ranks skill names against a task (returns the best " +
      "name, or null to abstain); 'browse_action' picks the next browser operation from a page snapshot; " +
      "'pick_tool' picks one tool for a task and flags whether it needs confirmation. Every mode is ADVISORY " +
      "— it returns a decision, it never executes anything, and you must validate the choice before acting " +
      "(an element index against the live snapshot, a tool name against the real roster). " +
      "For typed questions you want to ask yourself (noul/choice/score over arbitrary state), use the " +
      "native judge() prelude inside eval — it is the same model and needs no tool call.",
    loadMode: "discoverable",
    approval: "read",
    parameters: z.object({
      mode: z
        .enum(["route_skills", "browse_action", "pick_tool"])
        .describe("Which judgment to make."),
      task: z
        .string()
        .optional()
        .describe("route_skills / pick_tool: the task, request, or question to judge."),
      skills: z
        .array(z.object({ name: z.string(), description: z.string().optional() }))
        .optional()
        .describe(
          "route_skills: candidate skills to rank. Descriptions matter — without them a browser task " +
            "routes to a desktop-automation skill.",
        ),
      tools: z
        .array(
          z.object({
            name: z.string(),
            description: z.string(),
            args: z
              .record(z.string(), z.string())
              .optional()
              .describe("Map of arg name -> type/description, for closed-set args."),
          }),
        )
        .optional()
        .describe("pick_tool: candidate tools to choose from."),
      context: z
        .string()
        .optional()
        .describe("pick_tool: extra context, e.g. a recent error or the file being worked on."),
      goal: z.string().optional().describe("browse_action: what the user wants on the page."),
      elements: z
        .array(
          z.object({
            index: z
              .string()
              .describe(
                "Stable element index from the snapshot, e.g. '3' or '5:2' for a select option.",
              ),
            label: z.string().describe("Human-visible label."),
            role: z.string().optional().describe("ARIA role, e.g. combobox / button / link."),
            value: z.string().optional().describe("Current value, if any."),
            operations: z
              .array(z.string())
              .describe("Operations this element supports, e.g. ['CLICK','TYPE_TEXT']."),
          }),
        )
        .optional()
        .describe("browse_action: numbered interactive elements from the current snapshot."),
      page: z
        .object({ url: z.string(), title: z.string().optional(), text: z.string().optional() })
        .optional()
        .describe("browse_action: current page context."),
      recent_actions: z
        .array(
          z.object({
            action: z.string(),
            kind: z.string().optional(),
            page_changed: z.boolean().optional(),
          }),
        )
        .optional()
        .describe("browse_action: last few actions taken."),
    }),
    async execute(
      _id: string,
      params: any,
      signal?: AbortSignal,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }> {
      const abort = signal ?? undefined;
      const cfg = jevConfig(undefined, redactOn(ENV, "tool"));
      const text = (value: unknown) => JSON.stringify(value, null, 2);

      if (params.mode === "route_skills") {
        const candidates = (params.skills ?? []) as Array<{ name: string; description?: string }>;
        const result = await routeSkill(cfg, String(params.task ?? ""), candidates, {
          signal: abort,
        });
        const out = {
          skill: result.skill,
          confidence: result.confidence,
          probabilities: result.probabilities,
          hint:
            result.skill === null
              ? "No listed skill is relevant."
              : "Consider loading skill: " + result.skill,
        };
        return { content: [{ type: "text", text: text(out) }], details: out };
      }

      if (params.mode === "browse_action") {
        const result = await chooseBrowserAction(
          cfg,
          {
            goal: String(params.goal ?? ""),
            page: params.page ?? { url: "" },
            elements: params.elements ?? [],
            recentActions: (params.recent_actions ?? []).map((r: any) => ({
              action: String(r?.action ?? ""),
              kind: r?.kind,
              pageChanged: r?.page_changed,
            })),
          },
          { signal: abort },
        );
        return { content: [{ type: "text", text: text(result) }], details: result };
      }

      const result = await pickTool(
        cfg,
        { task: String(params.task ?? ""), tools: params.tools ?? [], context: params.context },
        { signal: abort },
      );
      const out = {
        tool: result.tool,
        confidence: result.confidence,
        risky_probability: result.risky,
        confirm_required: result.confirmRequired,
        act: result.act,
      };
      return { content: [{ type: "text", text: text(out) }], details: out };
    },
  });
  // ---- Selective auto-Jev hooks (opt-in via OMP_JEV_AUTO=1) -----------------
  // Why opt-in: these spend a Jev call per qualifying event. Cheap but latency
  // is real (~200-400ms), so the user enables it deliberately. Each hook is
  // independently gated so one can be turned off.

  // Gate 1 — tool_call: block a tool call Jev judges dangerous before it runs.
  //
  // Two independent fail-open mechanisms, because this handler runs under a host
  // budget that fails CLOSED:
  // 1. every path including the logger resolves without throwing, and
  // 2. the judgment is bounded by a self-imposed deadline (GATE_DEADLINE_MS)
  //    combined with the host signal the handler receives.
  // OMP reports a 'tool_call' handler that throws OR never settles as
  // { block: true } (runner.ts maps both the timeout and the error case), so the
  // deadline is what keeps a slow Jev call from freezing every mutating tool.
  // The catch below turns the resulting abort into "allow".
  pi.on("tool_call", async (event: any, ctx: any) => {
    if (!autoOn(ENV, "OMP_JEV_GATE") || sessionDisabled) return;
    try {
      const name = String(event?.toolName ?? "");
      // Only adjudicate tools that can mutate the world; cheap reads skip the call.
      if (!/^(bash|write|edit|delete|move|rm|mcp__)/i.test(name)) return;
      const cfg = jevConfig(undefined, redactOn(ENV, "hook"));
      const startedAt = Date.now();
      const verdict = await judgeDestructiveDual(
        cfg,
        { tool: name, input: event?.input ?? {}, cwd: process.cwd() },
        { threshold: GATE_THRESHOLD, signal: withDeadline(ctx?.signal, GATE_DEADLINE_MS) },
      );
      gateLog.record({
        ts: new Date().toISOString(),
        kind: "omp_gate",
        model: cfg.model ?? "unknown",
        digest: decisionDigest("omp_gate", { tool: name, input: event?.input ?? {} }, [
          "destructive",
          "category",
        ]),
        answers: { destructive: verdict.destructive, category: verdict.category },
        threshold: GATE_THRESHOLD,
        action: verdict.decision,
        latencyMs: Date.now() - startedAt,
      });
      if (verdict.decision === "allow") return;

      // 'confirm' is a genuine-but-unproven case: the noul was high but the
      // category disagreed, abstained, or was low-confidence. A bare refusal
      // would strand the model (this is how a plain python3 script.py was
      // blocked with no way forward), so the reason names the legal move:
      // re-issue the SAME call once the user has confirmed it explicitly.
      refusals.record("gate:" + name, verdict.decision + ":" + verdict.category);
      if (verdict.decision === "block") {
        return {
          block: true,
          reason:
            "jev gate: destructive (" +
            verdict.destructive.toFixed(2) +
            ", category=" +
            verdict.category +
            "). The tool alone cannot undo this. If the user has explicitly asked for it, re-issue " +
            "the same call with that confirmation stated in the task; otherwise use a safer equivalent " +
            "(delete the specific path, not a glob) or ask the user first.",
        };
      }
      return {
        block: true,
        reason:
          "jev gate: possibly destructive but UNPROVEN (" +
          verdict.destructive.toFixed(2) +
          ", category=" +
          verdict.category +
          ", confidence=" +
          verdict.confidence.toFixed(2) +
          "). Ask the user to confirm this exact call; if they confirm, state that confirmation and " +
          "re-issue it unchanged.",
      };
    } catch (err) {
      // Fail open, but not SILENTLY: the failure kind decides whether the
      // adapter keeps spending calls this session (auth/model) or shrugs off a
      // transient blip. A logger throw must not become a block either.
      const decision = decideOnFailure(err, "gate");
      const { disabled } = reportFailure(pi.logger, decision);
      if (disabled) sessionDisabled = true;
      refusals.record("gate:error", decision.kind);
      return; // allow
    }
  });

  // Gate 2 — skill router: suggest ONE skill for the incoming prompt.
  //
  // Two things were wrong with the previous wiring and both are fixed by
  // construction here:
  // - the roster came from ctx.skills, a member that does not exist on OMP's
  //   ExtensionContext, so the hook could never see a candidate. It now reads
  //   the same skill directories OMP's own discovery scans (router.ts).
  // - the suggestion was returned as { additionalContext }, which is NOT a
  //   field of InputEventResult (its fields are handled/text/images), so a
  //   suggestion could never reach the model. It now travels as a custom
  //   before_agent_start message, which the host converts into a developer
  //   message for the request.
  //
  // Why before_agent_start and not 'input': 'input' fires only in interactive
  // mode and its result cannot inject text. Routing is debounced, single-flight
  // and cached (router.ts), so a burst of prompts costs at most one call.
  let pendingHint: string | null = null;
  pi.on("input", async (event: any, ctx: any) => {
    if (!autoOn(ENV, "OMP_JEV_SKILL_ROUTER") || sessionDisabled) return;
    // Hoisted so the catch can run the degraded local router over the SAME
    // inputs. They are assigned before the Jev call on every path that reaches
    // it, and stay empty if this hook fails before that point — in which case
    // the fallback has no roster and correctly declines to guess.
    let text = "";
    let roster: RosterSkill[] = [];
    try {
      text = String(event?.text ?? event?.prompt ?? "");
      if (text.length < MIN_PROMPT_CHARS) return;
      roster = loadSkillRoster(defaultSkillDirs(ctx?.cwd ?? process.cwd()));
      if (roster.length === 0) {
        refusals.record("router:roster", "empty-roster");
        return;
      }
      // The user already named a skill: promote nothing, override nobody.
      if (userAlreadyChose(text, roster)) {
        refusals.record("router:user-selected", "already-chosen");
        return;
      }
      const answer = await skillRouter.route(text, roster);
      if (answer === null) {
        refusals.record("router", "superseded-or-debounced");
        return;
      }
      if (answer.skill === null) {
        refusals.record("router:abstain", "below-confidence");
        return;
      }
      const hint = skillHint(answer);
      if (hint !== null) pendingHint = hint;
    } catch (err) {
      const decision = decideOnFailure(err, "skill router");
      const { disabled } = reportFailure(pi.logger, decision);
      if (disabled) sessionDisabled = true;
      refusals.record("router:error", decision.kind);
      // Degraded path. The judgment failed, so Jev's abstain is not an answer:
      // fall back to keyword overlap over the same roster, and promote only a
      // match that clears LOCAL_ROUTE_MIN_SCORE. A wrong hint is worse than no
      // hint, so an unconvincing match leaves the user with no suggestion and
      // says so in the trail.
      const fallback = localRoute(text, roster);
      refusals.record(
        "router:local-fallback",
        fallback === null ? decision.kind + ":no-match" : decision.kind + ":" + fallback.skill,
      );
      if (fallback !== null) {
        pi.logger.debug("jev_router: local fallback", {
          skill: fallback.skill,
          score: fallback.score,
          failure: decision.kind,
        });
        pendingHint = localRouteHint(fallback);
      }
    }
  });

  // The hint is delivered on the NEXT turn's request context. It never rewrites
  // the system prompt, so the provider prompt-cache prefix is untouched, and it
  // is consumed once so it cannot repeat every turn.
  pi.on("before_agent_start", async () => {
    if (pendingHint === null) return;
    const hint = pendingHint;
    pendingHint = null;
    return {
      message: {
        customType: "jev-skill-hint",
        content: hint,
        display: false,
        attribution: "agent" as const,
      },
    };
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
        maxRequestTokens: envNum(
          ENV,
          "OMP_JEV_MAX_REQUEST_TOKENS",
          COMPACT_DEFAULTS.maxRequestTokens,
        ),
        truncateHeadChars: envNum(ENV, "OMP_JEV_TRUNCATE_HEAD", COMPACT_DEFAULTS.truncateHeadChars),
        minReductionRatio: envNum(ENV, "OMP_JEV_MIN_REDUCTION", COMPACT_DEFAULTS.minReductionRatio),
      };

      const cfg = jevConfig(undefined, redactOn(ENV, "hook"));
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
            "Jev verbatim compaction: " +
            plan.dropped.length +
            "/" +
            plan.decisions.length +
            " tool outputs truncated",
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
      // Fail open — native compaction must still happen — but say why, and
      // stand down for the session when the key or model is the problem.
      const decision = decideOnFailure(err, "compact");
      const { disabled } = reportFailure(pi.logger, decision);
      if (disabled) sessionDisabled = true;
      refusals.record("compact:error", decision.kind);
      return;
    }
  });
}
