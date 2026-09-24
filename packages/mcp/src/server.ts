/**
 * MCP server over stdio exposing TypeSafe's Jev (System One) decision
 * model as tools. Works with any MCP client (Claude Code, Cursor,
 * Windsurf, Cline, Codex, ...).
 *
 * Uses the low-level `Server` + `setRequestHandler(ListTools/CallTool)`
 * pattern, stable across SDK 1.x — no zod dependency required.
 *
 * Fail-open transport: every tool handler catches ALL errors and returns
 * an MCP tool result with `isError: true`. Handlers never throw, so a
 * Jev outage or bad input can never kill the server process.
 */
import { Server } from "@modelcontextprotocol/sdk/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  askJev,
  chooseBrowserAction,
  escalateOnLowConfidence,
  findingRealness,
  judgeDestructive,
  JevError,
  listJevModels,
  pickTool,
  pruneContext,
  rankCandidates,
  refutationFilter,
  routeSkill,
  withMapReduce,
  type Answer,
  type JevConfig,
  type MapReduceOptions,
  type Questions,
  type ReviewFinding,
} from "@jev-harness/core";
import { resolveJevConfig } from "./config.js";

export const SERVER_NAME = "jev-harness-mcp";
export const SERVER_VERSION = "0.1.0";

function ok(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
} {
  return { content: [{ type: "text", text: message }], isError: true };
}

function reqString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error('"' + key + '" must be a non-empty string');
  }
  return v;
}

function reqArray(args: Record<string, unknown>, key: string): unknown[] {
  const v = args[key];
  if (!Array.isArray(v)) throw new Error('"' + key + '" must be an array');
  return v;
}

function optNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asRecord(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new Error('"' + what + '" must be an object');
  }
  return v as Record<string, unknown>;
}

/**
 * A reduce question: core takes its parts rather than a whole Question
 * (packages/core/src/infra.ts, MapReduceOptions.reduce).
 */
function asReduceQuestion(v: unknown): MapReduceOptions["reduce"] {
  const rec = asRecord(v, "reduce");
  const instructions = rec.instructions;
  if (typeof instructions !== "string" || instructions.length === 0) {
    throw new Error('"reduce.instructions" must be a non-empty string');
  }
  if (rec.criteria === undefined) {
    throw new Error(
      '"reduce.criteria" is required: an object of options, or an ordered array of levels',
    );
  }
  const criteria = Array.isArray(rec.criteria)
    ? rec.criteria.map((level) => String(level))
    : (asRecord(rec.criteria, "reduce.criteria") as Record<string, string>);
  const type =
    rec.type === "noul" || rec.type === "choice" || rec.type === "score" ? rec.type : undefined;
  return { instructions, criteria, type };
}

/**
 * The noul uncertainty band: exactly two finite numbers, [low, high].
 * Absent means "core's default"; a wrong shape is caller error and fails
 * into the isError envelope like every other bad argument.
 */
function asBand(v: unknown): [number, number] | undefined {
  if (v === undefined) return undefined;
  if (
    !Array.isArray(v) ||
    v.length !== 2 ||
    v.some((n) => typeof n !== "number" || !Number.isFinite(n))
  ) {
    throw new Error('"band" must be an array of exactly 2 numbers');
  }
  return [v[0], v[1]];
}

/** Narrow the optional PruneCandidate kind; anything else reads as no kind (default bars apply). */
function asPruneKind(v: unknown): "output" | "error" | "diagnostic" | undefined {
  if (v === "output") return "output";
  if (v === "error") return "error";
  if (v === "diagnostic") return "diagnostic";
  return undefined;
}

/** One ReviewFinding from caller JSON; required fields are checked, optional strings pass through (unknown shapes become undefined). */
function asFinding(v: unknown, what: string): ReviewFinding {
  const rec = asRecord(v, what);
  if (typeof rec.path !== "string" || rec.path.length === 0) {
    throw new Error('"' + what + '.path" must be a non-empty string');
  }
  if (typeof rec.content !== "string") {
    throw new Error('"' + what + '.content" must be a string');
  }
  return {
    path: rec.path,
    content: rec.content,
    existingCode: typeof rec.existingCode === "string" ? rec.existingCode : undefined,
    suggestionCode: typeof rec.suggestionCode === "string" ? rec.suggestionCode : undefined,
    severity: typeof rec.severity === "string" ? rec.severity : undefined,
    category: typeof rec.category === "string" ? rec.category : undefined,
    diff: typeof rec.diff === "string" ? rec.diff : undefined,
    context: typeof rec.context === "string" ? rec.context : undefined,
  };
}

/** The API rejected this item payload — the only item-specific failure. */
const ITEM_LEVEL_STATUS = new Set([400, 413, 422]);

/**
 * Core withMapReduce is atomic: it rejects the whole call when any item
 * fails, and fail-open handling belongs at the caller. A corpus tool cannot
 * afford to drop every answer for one bad item, so only a payload rejection
 * (400/413/422) counts as a per-item failure; config, auth, rate-limit,
 * server, and network errors stay batch-level and keep the atomic behaviour.
 */
function isBatchLevelError(err: unknown): boolean {
  if (err instanceof JevError) {
    return err.status === undefined || !ITEM_LEVEL_STATUS.has(err.status);
  }
  return true;
}

/** Item judgments in flight while attributing failures. Core default is 4. */
const DEFAULT_MAP_CONCURRENCY = 4;

interface ClassifyOutcome {
  perItem: Array<Record<string, Answer> | null>;
  reduced: Answer | null;
  failures: Array<{ index: number; error: string }>;
  reduceSkipped?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** One request per item, so the totals are what the run actually spent. */
function mergeUsage(
  a?: { input_tokens?: number; output_tokens?: number },
  b?: { input_tokens?: number; output_tokens?: number },
): { input_tokens?: number; output_tokens?: number } | undefined {
  if (a === undefined && b === undefined) return undefined;
  return {
    input_tokens: (a?.input_tokens ?? 0) + (b?.input_tokens ?? 0),
    output_tokens: (a?.output_tokens ?? 0) + (b?.output_tokens ?? 0),
  };
}

/**
 * Sum usage across every Jev response in the run. The wrapped fetch is the
 * only place the responses pass through, so the reducer and the items are
 * both counted without changing what core sees.
 */
function collectUsage(config: JevConfig): {
  config: JevConfig;
  usage: () => { input_tokens?: number; output_tokens?: number } | undefined;
} {
  let totals: { input_tokens?: number; output_tokens?: number } | undefined;
  const inner = config.fetchImpl ?? fetch;
  const wrapped: typeof fetch = async (url, init) => {
    const res = await inner(url, init);
    if (res.ok) {
      try {
        const body = (await res.clone().json()) as { usage?: typeof totals };
        if (body?.usage) totals = mergeUsage(totals, body.usage);
      } catch {
        // Usage is best-effort: an unreadable body must never break a call.
      }
    }
    return res;
  };
  return { config: { ...config, fetchImpl: wrapped }, usage: () => totals };
}

/**
 * The same questions over every item, then an optional reduce — core
 * withMapReduce plus per-item attribution. A batch rejected by one bad item
 * is retried item by item (bounded by concurrency) so every answer survives
 * and each failure is named; that costs up to 2x calls for the batch. The
 * reduce step needs a complete answer set, so any failure skips it and
 * reduceSkipped says why.
 */
async function classifyCorpus(
  config: JevConfig,
  items: readonly unknown[],
  questions: Questions,
  opts: { reduce?: MapReduceOptions["reduce"]; concurrency?: number; signal?: AbortSignal },
): Promise<ClassifyOutcome> {
  const collector = collectUsage(config);
  try {
    const { perItem, reduced } = await withMapReduce(collector.config, items, () => questions, {
      reduce: opts.reduce,
      concurrency: opts.concurrency,
      signal: opts.signal,
    });
    return { perItem, reduced, failures: [], usage: collector.usage() };
  } catch (err) {
    if (isBatchLevelError(err)) throw err;
    return await attributeItemFailures(collector, items, questions, opts, err);
  }
}

/** Retry a rejected batch one item at a time so each failure gets its index. */
async function attributeItemFailures(
  collector: ReturnType<typeof collectUsage>,
  items: readonly unknown[],
  questions: Questions,
  opts: { reduce?: MapReduceOptions["reduce"]; concurrency?: number; signal?: AbortSignal },
  batchErr: unknown,
): Promise<ClassifyOutcome> {
  const perItem: Array<Record<string, Answer> | null> = new Array(items.length).fill(null);
  const failures: Array<{ index: number; error: string }> = [];
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_MAP_CONCURRENCY));
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        // One item per call; core concurrency is the outer pool job.
        const one = await withMapReduce(collector.config, [items[index]], () => questions, {
          concurrency: 1,
          signal: opts.signal,
        });
        perItem[index] = one.perItem[0] ?? {};
      } catch (err) {
        if (isBatchLevelError(err)) throw err;
        failures.push({ index, error: err instanceof Error ? err.message : String(err) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  failures.sort((a, b) => a.index - b.index);
  const reduce = opts.reduce;
  const skipped =
    reduce === undefined
      ? undefined
      : failures.length > 0
        ? failures.length +
          " of " +
          items.length +
          " item(s) failed, so the reduce digest would be incomplete"
        : "reduce failed: " + (batchErr instanceof Error ? batchErr.message : String(batchErr));
  return {
    perItem,
    reduced: null,
    failures,
    reduceSkipped: skipped,
    usage: collector.usage(),
  };
}

/** Exported so the tool contract can be asserted without starting a server. */
export const TOOLS: Tool[] = [
  {
    name: "jev_ask",
    description:
      "Ask Jev (System One) a batch of typed questions — noul (yes/no probability), choice, or score — about an arbitrary JSON state. Returns the raw JevResponse with calibrated probabilities.",
    inputSchema: {
      type: "object",
      properties: {
        state: {
          description: "Arbitrary JSON state the questions are judged against.",
        },
        questions: {
          type: "object",
          description:
            "Map of id -> question. Each question: {type: 'noul'|'choice'|'score', instructions: string, criteria?: object|array}. Choice needs >=2 criteria entries; score needs >=2 ordered levels.",
          additionalProperties: { type: "object" },
        },
        model: {
          type: "string",
          description: "Optional model override for this call only.",
        },
      },
      required: ["state", "questions"],
    },
  },
  {
    name: "jev_models",
    description: "List the Jev models available to the configured TYPESAFE_API_KEY.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "jev_route_skills",
    description:
      "Route a task to the best skill (or none) using Jev choice judgment over skill descriptions.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The user request to route." },
        skills: {
          type: "array",
          description: "Candidate skills with names and descriptions.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              description: { type: "string" },
            },
            required: ["name"],
          },
        },
        minConfidence: {
          type: "number",
          description: "Minimum confidence to pick a skill (default 0.5).",
        },
      },
      required: ["task", "skills"],
    },
  },
  {
    name: "jev_pick_tool",
    description:
      "Select the single best tool for a task and flag whether it needs confirmation. Returns {tool, confidence, risky, confirmRequired, act}. Does not execute the tool: validate the choice and its confirmation flag before acting.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The task to accomplish." },
        tools: {
          type: "array",
          description: "Candidate tools with names and descriptions.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              description: { type: "string" },
            },
            required: ["name", "description"],
          },
        },
        context: { type: "string", description: "Optional extra context." },
      },
      required: ["task", "tools"],
    },
  },
  {
    name: "jev_judge_destructive",
    description:
      "Judge whether a tool call would destroy or irreversibly change data/history/system state. Returns {destructive: 0..1, blocked: boolean}. On error the result is isError — treat as unknown, not as confirmed-safe.",
    inputSchema: {
      type: "object",
      properties: {
        tool: { type: "string", description: "Tool name, e.g. 'bash' or 'write'." },
        input: { description: "The exact tool input that would be executed." },
        cwd: { type: "string", description: "Optional working directory." },
      },
      required: ["tool", "input"],
    },
  },
  {
    name: "jev_browse_action",
    description:
      "Pick the single next browser operation that best advances a goal, given a page snapshot. Does not execute anything. Returns {operation, target, confidence, act}.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What the browsing task should achieve." },
        page: {
          type: "object",
          description: "Current page snapshot.",
          properties: {
            url: { type: "string" },
            title: { type: "string" },
            text: { type: "string" },
          },
          required: ["url"],
        },
        elements: {
          type: "array",
          description: "Observed interactive elements.",
          items: {
            type: "object",
            properties: {
              index: { type: "string" },
              label: { type: "string" },
              role: { type: "string" },
              value: { type: "string" },
              operations: { type: "array", items: { type: "string" } },
            },
            required: ["index", "label", "operations"],
          },
        },
        recentActions: {
          type: "array",
          description: "Recently taken actions.",
          items: { type: "object" },
        },
      },
      required: ["goal", "page", "elements"],
    },
  },
  {
    name: "jev_rank",
    description:
      "Rank candidate strings against a task with Jev score judgments. Returns best-first [{candidate, fitness}].",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The task candidates serve." },
        candidates: {
          type: "array",
          description: "Candidate strings to rank.",
          items: { type: "string" },
        },
      },
      required: ["task", "candidates"],
    },
  },
  {
    name: "jev_classify",
    description:
      "Run the SAME typed questions over a large corpus — strings or arbitrary JSON items — with one request per item (cost = items x questions). An optional reduce sums the per-item verdicts into one final answer. Returns {perItem (index-aligned, null where an item failed), reduced, failures, reduceSkipped, usage}. Failures are reported per index without dropping the other answers. The reduce digest is capped at 200 items / 4000 chars of verdicts (core), so it scales flat; any failed item skips the reduce (see reduceSkipped).",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description:
            "The corpus to judge. Strings or arbitrary JSON objects — every item gets the same questions.",
          items: { type: ["string", "object", "number", "boolean", "array", "null"] },
        },
        questions: {
          type: "object",
          description:
            "Map of id -> question, asked of EVERY item. Each question: {type: 'noul'|'choice'|'score', instructions: string, criteria?: object|array}. Choice needs >=2 criteria entries; score needs >=2 ordered levels.",
          additionalProperties: { type: "object" },
        },
        reduce: {
          type: "object",
          description:
            "Optional final question judged over the per-item verdicts instead of the corpus: {instructions, criteria (object of options or ordered array of levels), type? (noul|choice|score)}.",
        },
        concurrency: {
          type: "number",
          description: "Item judgments in flight at once (default 4).",
        },
      },
      required: ["items", "questions"],
    },
  },
  {
    name: "jev_escalate",
    description:
      "Ask the same questions ONCE, then re-ask them exactly once when Jev's own gate question says the first answers are too uncertain to act on. The gate question must be one of `questions`. Returns {outcome: 'accepted'|'escalated'|'unresolved', answers, first, second?, gateScore, threshold, target, escalated, error?} — `answers` is what to act on (`second` when escalated, otherwise the preserved first pass). Defaults: choice/score gates escalate when confidence < 0.6 (PROVISIONAL — vendor-cited, tune against your own outcomes); noul gates escalate when p is inside [0.3, 0.7] (PROVISIONAL, same provenance). An uncertain gate with no resolvable secondModel returns outcome 'unresolved' with error 'no-escalation-target'; an unreadable gate returns 'unresolved' with error 'gate-question-missing'. A first-pass outage surfaces as an isError result (fail-open), never a crash.",
    inputSchema: {
      type: "object",
      properties: {
        state: {
          description: "Arbitrary JSON state the questions are judged against.",
        },
        questions: {
          type: "object",
          description:
            "Map of id -> question, including the gate question. Each question: {type: 'noul'|'choice'|'score', instructions: string, criteria?: object|array}. Choice needs >=2 criteria entries; score needs >=2 ordered levels.",
          additionalProperties: { type: "object" },
        },
        gateQuestionId: {
          type: "string",
          description: "Which id of `questions` reads as the confidence gate.",
        },
        threshold: {
          type: "number",
          description:
            "Choice/score gate: escalate when confidence is below this (default 0.6, PROVISIONAL).",
        },
        band: {
          type: "array",
          items: { type: "number" },
          description:
            "Noul gate: escalate when p is inside this inclusive [low, high] band (default [0.3, 0.7], PROVISIONAL).",
        },
        secondModel: {
          type: "string",
          description:
            "Model for the single escalation pass, resolved with the same key/config as the first pass. If it cannot be resolved, no second pass is attempted and outcome/target/error report that honestly.",
        },
      },
      required: ["state", "questions", "gateQuestionId"],
    },
  },
  {
    name: "jev_prune",
    description:
      "Decide which context items are still needed — NON-DESTRUCTIVE BY CONTRACT: the input is never edited, and every drop decision carries a `replacement` string (verbatim headChars + provenance note) while the CALLER keeps the original text. Returns {decisions (index-aligned: {id, keep, score, chars, replacement?, omittedChars?}), deferred, reason?}. Defaults: keep bar 0.5, drop bar 0.25 (MEASURED cross-repo), error/diagnostic drop bar 0.1 (MEASURED), headChars 300, minChars 2000 (shorter items keep without spending a question), maxItemsPerRequest 64, maxStateTokens 25000. State over the token budget returns {deferred: true, reason: 'state-too-large'} with ZERO requests. Missing/malformed answers keep — unjudged is never read as droppable.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description:
            "Candidates with unique ids: {id, text, kind?}. kind is one of 'output' | 'error' | 'diagnostic'; error/diagnostic use the stricter drop bar.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique id — also the question id." },
              text: {
                type: "string",
                description: "The item's full text. Never mutated; the caller keeps it.",
              },
              kind: {
                type: "string",
                description:
                  "Content kind: 'output' (default bars), 'error' or 'diagnostic' (stricter drop bar).",
              },
            },
            required: ["id", "text"],
          },
        },
        keepThreshold: {
          type: "number",
          description: "At/above this a keep; below it an item may drop (default 0.5).",
        },
        dropThreshold: {
          type: "number",
          description: "Drop bar for 'output' items (default 0.25).",
        },
        errorDropThreshold: {
          type: "number",
          description: "Drop bar for 'error'/'diagnostic' items (default 0.1).",
        },
        headChars: {
          type: "number",
          description: "Verbatim head kept in every drop replacement (default 300).",
        },
        minChars: {
          type: "number",
          description: "Items shorter than this keep without a question (default 2000).",
        },
        maxItemsPerRequest: {
          type: "number",
          description: "Questions packed into one request (default 64).",
        },
        maxStateTokens: {
          type: "number",
          description:
            "Approximate token budget for the whole state; oversized state defers with zero requests (default 25000).",
        },
      },
      required: ["items"],
    },
  },
  {
    name: "jev_finding_realness",
    description:
      "Is this review finding real enough for a reviewer to see? ONE request, two questions (noul 'realness' + choice 'severity'). Returns {realness, report, severity, severityProvided}. Default report bar: realness >= 0.5 (PROVISIONAL — upstream has no threshold at all; calibrate on your own findings). Unreadable realness comes back as realness: -1, report: false (an unjudged marker, never a probability) with severity untouched. The model's severity label passes through verbatim — never coerced to 'low'. Caller severity/category are metadata only and are never sent (no anchoring).",
    inputSchema: {
      type: "object",
      properties: {
        finding: {
          type: "object",
          description:
            "The finding under review: {path, content, existingCode?, suggestionCode?, severity?, category?, diff?, context?}. severity/category are reported back when unjudged but never sent to the model.",
          properties: {
            path: { type: "string", description: "File path the finding points at." },
            content: { type: "string", description: "The finding text itself." },
            existingCode: { type: "string", description: "Referenced existing code (optional)." },
            suggestionCode: {
              type: "string",
              description: "Suggested replacement code (optional).",
            },
            severity: {
              type: "string",
              description: "Caller's severity, if any (kept as fallback; not sent).",
            },
            category: { type: "string", description: "Caller's category, if any (not sent)." },
            diff: { type: "string", description: "Referenced diff (optional)." },
            context: { type: "string", description: "Surrounding context (optional)." },
          },
          required: ["path", "content"],
        },
        threshold: {
          type: "number",
          description: "Report at/above this realness (default 0.5, PROVISIONAL).",
        },
      },
      required: ["finding"],
    },
  },
  {
    name: "jev_refute",
    description:
      "Drop refuted review findings — conservatively, with deliberate ASYMMETRY: a finding is dropped ONLY when its refute score is >= refutedThreshold AND its class is proven non-protected. Everything else keeps — including missing/malformed refute or class answers (unjudged is not a verdict) and any finding classed memory-safety, concurrency, linkage, behavioural-change, or unused-param. Returns {refuted: [{index, score, reason}], kept: [{index, score, protectedSubject}], scores: [{index, probability, cls, protectedSubject}]}. Default refutedThreshold 0.75 (PROVISIONAL, deliberately high: a false removal costs far more than a false keep — calibrate before lowering). Findings batch at 32 per request; optional evidence rides once at the top of the shared state.",
    inputSchema: {
      type: "object",
      properties: {
        findings: {
          type: "array",
          description:
            "Findings to filter: [{path, content, existingCode?, suggestionCode?, severity?, category?, diff?, context?}].",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path the finding points at." },
              content: { type: "string", description: "The finding text itself." },
              existingCode: { type: "string", description: "Referenced existing code (optional)." },
              suggestionCode: {
                type: "string",
                description: "Suggested replacement code (optional).",
              },
              severity: { type: "string", description: "Caller's severity metadata (optional)." },
              category: { type: "string", description: "Caller's category metadata (optional)." },
              diff: { type: "string", description: "Referenced diff (optional)." },
              context: { type: "string", description: "Surrounding context (optional)." },
            },
            required: ["path", "content"],
          },
        },
        evidence: {
          type: "string",
          description: "Optional evidence/diff shared by the whole batch — sent once.",
        },
        refutedThreshold: {
          type: "number",
          description:
            "Drop at/above this refute probability, when classed non-protected (default 0.75, PROVISIONAL).",
        },
      },
      required: ["findings"],
    },
  },
];

/** Exported so tool behaviour can be asserted without starting a server. */
export async function handleTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "jev_ask": {
      const questions = asRecord(args.questions, "questions");
      const model =
        typeof args.model === "string" && args.model.length > 0 ? { model: args.model } : {};
      return askJev(resolveJevConfig(model), args.state, questions as unknown as Questions);
    }
    case "jev_models": {
      const models = await listJevModels(resolveJevConfig());
      return { models };
    }
    case "jev_route_skills": {
      const task = reqString(args, "task");
      const skills = reqArray(args, "skills").map((s, i) => {
        const rec = asRecord(s, "skills[" + i + "]");
        if (typeof rec.name !== "string" || rec.name.length === 0) {
          throw new Error('"skills[' + i + '].name" must be a non-empty string');
        }
        return {
          name: rec.name,
          description: typeof rec.description === "string" ? rec.description : undefined,
        };
      });
      const minConfidence = optNumber(args, "minConfidence");
      return routeSkill(
        resolveJevConfig(),
        task,
        skills,
        minConfidence === undefined ? {} : { minConfidence },
      );
    }
    case "jev_pick_tool": {
      const task = reqString(args, "task");
      const tools = reqArray(args, "tools").map((t, i) => {
        const rec = asRecord(t, "tools[" + i + "]");
        if (typeof rec.name !== "string" || rec.name.length === 0) {
          throw new Error('"tools[' + i + '].name" must be a non-empty string');
        }
        return {
          name: rec.name,
          description: typeof rec.description === "string" ? rec.description : "",
        };
      });
      const context = typeof args.context === "string" ? args.context : undefined;
      return pickTool(resolveJevConfig(), { task, tools, context });
    }
    case "jev_judge_destructive": {
      const tool = reqString(args, "tool");
      if (!("input" in args)) throw new Error('"input" is required');
      const cwd = typeof args.cwd === "string" ? args.cwd : undefined;
      return judgeDestructive(resolveJevConfig(), { tool, input: args.input, cwd });
    }
    case "jev_browse_action": {
      const goal = reqString(args, "goal");
      const pageRec = asRecord(args.page, "page");
      const url = pageRec.url;
      if (typeof url !== "string" || url.length === 0) {
        throw new Error('"page.url" must be a non-empty string');
      }
      const elements = reqArray(args, "elements").map((e, i) => {
        const rec = asRecord(e, "elements[" + i + "]");
        if (typeof rec.index !== "string" || typeof rec.label !== "string") {
          throw new Error('"elements[' + i + ']" needs string "index" and "label"');
        }
        if (!Array.isArray(rec.operations)) {
          throw new Error('"elements[' + i + '].operations" must be an array');
        }
        return {
          index: rec.index,
          label: rec.label,
          role: typeof rec.role === "string" ? rec.role : undefined,
          value: typeof rec.value === "string" ? rec.value : undefined,
          operations: rec.operations.map((o) => String(o)),
        };
      });
      const recentActions = Array.isArray(args.recentActions)
        ? (args.recentActions as Array<{ action: string; kind?: string; pageChanged?: boolean }>)
        : undefined;
      return chooseBrowserAction(resolveJevConfig(), {
        goal,
        page: {
          url,
          title: typeof pageRec.title === "string" ? pageRec.title : undefined,
          text: typeof pageRec.text === "string" ? pageRec.text : undefined,
        },
        elements,
        recentActions,
      });
    }
    case "jev_rank": {
      const task = reqString(args, "task");
      const candidates = reqArray(args, "candidates").map((c, i) => {
        if (typeof c !== "string") throw new Error('"candidates[' + i + ']" must be a string');
        return c;
      });
      return rankCandidates(resolveJevConfig(), task, candidates);
    }
    case "jev_classify": {
      const items = reqArray(args, "items");
      if (items.length === 0) throw new Error('"items" must not be empty');
      const questions = asRecord(args.questions, "questions") as unknown as Questions;
      const reduce = args.reduce === undefined ? undefined : asReduceQuestion(args.reduce);
      const concurrency = optNumber(args, "concurrency");
      return classifyCorpus(resolveJevConfig(), items, questions, {
        reduce,
        concurrency,
      });
    }
    case "jev_escalate": {
      if (!("state" in args)) throw new Error('"state" is required');
      const questions = asRecord(args.questions, "questions") as unknown as Questions;
      const secondModel =
        typeof args.secondModel === "string" && args.secondModel.length > 0
          ? args.secondModel
          : undefined;
      let secondConfig: JevConfig | undefined;
      if (secondModel !== undefined) {
        try {
          secondConfig = resolveJevConfig({ model: secondModel });
        } catch {
          // Unresolvable second config → call with NO second pass; core's
          // target/error report it honestly. No second API-key path is invented.
        }
      }
      return escalateOnLowConfidence(resolveJevConfig(), args.state, questions, {
        gateQuestionId: reqString(args, "gateQuestionId"),
        threshold: optNumber(args, "threshold"),
        band: asBand(args.band),
        secondConfig,
      });
    }
    case "jev_prune": {
      const items = reqArray(args, "items").map((raw, i) => {
        const rec = asRecord(raw, "items[" + i + "]");
        if (typeof rec.id !== "string" || rec.id.length === 0) {
          throw new Error('"items[' + i + '].id" must be a non-empty string');
        }
        if (typeof rec.text !== "string") {
          throw new Error('"items[' + i + '].text" must be a string');
        }
        return { id: rec.id, text: rec.text, kind: asPruneKind(rec.kind) };
      });
      return pruneContext(resolveJevConfig(), items, {
        keepThreshold: optNumber(args, "keepThreshold"),
        dropThreshold: optNumber(args, "dropThreshold"),
        errorDropThreshold: optNumber(args, "errorDropThreshold"),
        headChars: optNumber(args, "headChars"),
        minChars: optNumber(args, "minChars"),
        maxItemsPerRequest: optNumber(args, "maxItemsPerRequest"),
        maxStateTokens: optNumber(args, "maxStateTokens"),
      });
    }
    case "jev_finding_realness": {
      const finding = asFinding(args.finding, "finding");
      const threshold = optNumber(args, "threshold");
      return findingRealness(resolveJevConfig(), finding, { threshold });
    }
    case "jev_refute": {
      const findings = reqArray(args, "findings").map((f, i) =>
        asFinding(f, "findings[" + i + "]"),
      );
      const evidence = typeof args.evidence === "string" ? args.evidence : undefined;
      const refutedThreshold = optNumber(args, "refutedThreshold");
      return refutationFilter(resolveJevConfig(), findings, { refutedThreshold, evidence });
    }
    default:
      throw new Error("Unknown tool: " + name);
  }
}

/**
 * One tool call behind the fail-open envelope: success stringifies the result,
 * any thrown error (bad input, missing key, Jev outage) becomes an isError
 * result carrying the message — a handler never crashes the server.
 * Exported so the fail-open contract can be asserted without starting a server.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ReturnType<typeof ok> | ReturnType<typeof fail>> {
  try {
    return ok(await handleTool(name, args));
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Build the MCP server with all Jev tools registered. */
export function createServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    return callTool(request.params.name, args);
  });
  return server;
}

/** Start the server on stdio. Logs go to stderr (stdout is the protocol). */
export async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error(SERVER_NAME + " v" + SERVER_VERSION + " listening on stdio");
}
