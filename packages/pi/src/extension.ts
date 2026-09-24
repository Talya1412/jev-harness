/**
 * @jev-harness/pi - TypeSafe Jev (System One) judgments as a Pi extension.
 *
 * Registers six fail-open tools (jev_ask, jev_models, jev_route_skills,
 * jev_pick_tool, jev_browse_action, jev_classify) plus two hooks:
 * - session_before_compact: verbatim compaction driven by two noul
 *   judgments per tool call/result pair.
 * - input: append-only skill-router advisory (never blocks or rewrites).
 *
 * Every Jev call fails OPEN: errors resolve to advisory text (tools) or
 * undefined (hooks), so the host agent never stalls because Jev is down.
 * The API key is read from the environment on each call and never logged.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { noul, withFailMode, type Questions } from "@jev-harness/core";
import { lexicalShortlist, type JevToolkit } from "@jev-harness/kit";
import { Type } from "typebox";

import { classifyItems, type ClassifyResult } from "./classify.js";
import { collectToolPairs, keepThreshold } from "./compact.js";
import { createPiToolkit } from "./config.js";

/** Bound once; the pure helpers take it as a parameter so tests need no globals. */
const ENV = process.env;

/** Tool-result envelope. Presentation only — not worth extracting. */
function ok(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

/** Fail-open error surface: the host agent must never stall on a Jev outage. */
function errorText(tool: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return tool + " failed (fail-open, host unaffected): " + msg.slice(0, 500);
}

/** A reduce question in the parts core takes (MapReduceOptions.reduce). */
function asReduce(value: unknown) {
  const rec = value as {
    instructions?: unknown;
    criteria?: Record<string, string> | string[];
    type?: "noul" | "choice" | "score";
  };
  if (typeof rec?.instructions !== "string" || rec.instructions.length === 0) {
    throw new Error("reduce.instructions must be a non-empty string");
  }
  if (rec.criteria === undefined) {
    throw new Error("reduce.criteria is required: an object of options, or an ordered array");
  }
  return { instructions: rec.instructions, criteria: rec.criteria, type: rec.type };
}

/** One line per item, then the reduce — the model reads text, details carry the JSON. */
function classifyText(result: ClassifyResult): string {
  const lines = result.perItem.map((answers, index) => {
    const failure = result.failures.find((f) => f.index === index);
    if (failure) return "[" + index + "] failed: " + failure.error;
    return "[" + index + "] " + JSON.stringify(answers);
  });
  if (result.reduced !== null) lines.push("reduced: " + JSON.stringify(result.reduced));
  else if (result.reduceSkipped !== undefined)
    lines.push("reduce skipped: " + result.reduceSkipped);
  return lines.join("\n");
}
export default function jevPi(pi: ExtensionAPI): void {
  // Fresh config per call (the kit re-reads the environment each time), fail
  // open: the key is only required once a call is actually made.
  const kit: JevToolkit = createPiToolkit();
  pi.registerTool({
    name: "jev_ask",
    label: "Jev ask",
    description:
      "Ask TypeSafe Jev (System One) for calibrated judgments over an arbitrary JSON state. " +
      "Pass questions as a map of id to {type: noul|choice|score, instructions, criteria}. " +
      "Fail-open: Jev errors return advisory text, never throw.",
    parameters: Type.Object({
      state: Type.Unknown({
        description: "Arbitrary JSON state the questions are judged against.",
      }),
      questions: Type.Unknown({
        description:
          "Map of question id to question. noul needs instructions; " +
          "choice needs criteria as an object with at least 2 options; " +
          "score needs criteria as an ordered array with at least 2 levels.",
      }),
    }),
    execute: async (_id, params, signal) => {
      try {
        const response = await kit.ask(params.state, params.questions as Questions, {
          signal: signal ?? undefined,
        });
        return ok(JSON.stringify(response.answers, null, 2), {
          model: response.model,
          usage: response.usage,
        });
      } catch (err) {
        return ok(errorText("jev_ask", err));
      }
    },
  });

  pi.registerTool({
    name: "jev_models",
    label: "Jev models",
    description:
      "List the TypeSafe Jev models available to the configured key. " +
      "Fail-open: errors return advisory text, never throw.",
    parameters: Type.Object({}),
    execute: async () => {
      try {
        const models = await kit.models();
        const lines = models.map((m) => (m.description ? m.name + " - " + m.description : m.name));
        return ok(lines.length > 0 ? lines.join("\n") : "No Jev models returned.", {
          count: models.length,
        });
      } catch (err) {
        return ok(errorText("jev_models", err));
      }
    },
  });

  pi.registerTool({
    name: "jev_route_skills",
    label: "Jev route skills",
    description:
      "Route a request to one skill (or none) using Jev. " +
      "Send skill DESCRIPTIONS, not bare names. " +
      "Fail-open: errors return advisory text, never throw.",
    parameters: Type.Object({
      message: Type.String({ description: "The user request to route." }),
      skills: Type.Array(
        Type.Object({
          name: Type.String(),
          description: Type.Optional(Type.String()),
        }),
        {
          description: "Candidate skills. Descriptions matter far more than names.",
        },
      ),
      minConfidence: Type.Optional(
        Type.Number({
          description: "Minimum confidence to select a skill. Default 0.5.",
        }),
      ),
    }),
    execute: async (_id, params, signal) => {
      try {
        const result = await kit.routeSkills(
          params.message,
          params.skills.map((s) => ({
            name: s.name,
            description: s.description ?? "",
          })),
          { minConfidence: params.minConfidence, signal: signal ?? undefined },
        );
        return ok(JSON.stringify(result, null, 2), result);
      } catch (err) {
        return ok(errorText("jev_route_skills", err));
      }
    },
  });

  pi.registerTool({
    name: "jev_pick_tool",
    label: "Jev pick tool",
    description:
      "Select one tool (or none) for a task using Jev, with a confirmation " +
      "flag for side-effecting choices. Does not execute anything. " +
      "Fail-open: errors return advisory text, never throw.",
    parameters: Type.Object({
      task: Type.String({ description: "The task to accomplish." }),
      tools: Type.Array(
        Type.Object({
          name: Type.String(),
          description: Type.String(),
        }),
        { description: "Candidate tools with descriptions." },
      ),
      context: Type.Optional(Type.String()),
    }),
    execute: async (_id, params, signal) => {
      try {
        const result = await kit.pickTool(
          {
            task: params.task,
            tools: params.tools.map((t) => ({
              name: t.name,
              description: t.description,
            })),
            context: params.context,
          },
          { signal: signal ?? undefined },
        );
        return ok(JSON.stringify(result, null, 2), result);
      } catch (err) {
        return ok(errorText("jev_pick_tool", err));
      }
    },
  });

  pi.registerTool({
    name: "jev_browse_action",
    label: "Jev browse goal",
    description:
      "Pick the single next browser operation that best advances a goal, " +
      "using Jev over a page snapshot. Does not execute anything. " +
      "Fail-open: errors return advisory text, never throw.",
    parameters: Type.Object({
      goal: Type.String({ description: "What the browsing task must achieve." }),
      page: Type.Object({
        url: Type.String(),
        title: Type.Optional(Type.String()),
        text: Type.Optional(Type.String()),
      }),
      elements: Type.Array(
        Type.Object({
          index: Type.String(),
          label: Type.String(),
          role: Type.Optional(Type.String()),
          value: Type.Optional(Type.String()),
          operations: Type.Array(Type.String()),
        }),
      ),
      recentActions: Type.Optional(
        Type.Array(
          Type.Object({
            action: Type.String(),
            kind: Type.Optional(Type.String()),
            pageChanged: Type.Optional(Type.Boolean()),
          }),
        ),
      ),
    }),
    execute: async (_id, params, signal) => {
      try {
        const result = await kit.browseAction(
          {
            goal: params.goal,
            page: {
              url: params.page.url,
              title: params.page.title,
              text: params.page.text,
            },
            elements: params.elements.map((e) => ({
              index: e.index,
              label: e.label,
              role: e.role,
              value: e.value,
              operations: e.operations,
            })),
            recentActions: params.recentActions?.map((a) => ({
              action: a.action,
              kind: a.kind,
              pageChanged: a.pageChanged,
            })),
          },
          { signal: signal ?? undefined },
        );
        return ok(JSON.stringify(result, null, 2), result);
      } catch (err) {
        return ok(errorText("jev_browse_action", err));
      }
    },
  });

  pi.registerTool({
    name: "jev_classify",
    label: "Jev classify",
    description:
      "Run the SAME typed questions over a large corpus (strings or JSON items): one request per item, " +
      "so the cost is items x questions. An optional reduce asks one final question over the per-item " +
      "verdicts - a digest capped at 200 items / 4000 chars, never the corpus. Results are index-aligned; " +
      "a failing item is reported by index and the other answers still come back. " +
      "Fail-open: Jev errors return advisory text, never throw.",
    parameters: Type.Object({
      items: Type.Array(Type.Unknown(), {
        description: "The corpus to judge. Every item gets the same questions.",
      }),
      questions: Type.Unknown({
        description:
          "Map of question id to question, asked of EVERY item. noul needs instructions; " +
          "choice needs criteria as an object with at least 2 options; " +
          "score needs criteria as an ordered array with at least 2 levels.",
      }),
      reduce: Type.Optional(
        Type.Unknown({
          description:
            "Optional final question over the per-item verdicts: " +
            "{type: noul|choice|score, instructions, criteria}.",
        }),
      ),
      concurrency: Type.Optional(
        Type.Number({ description: "Item judgments in flight at once. Default 4." }),
      ),
    }),
    execute: async (_id, params, signal) => {
      try {
        const result = await classifyItems(
          kit.config(),
          params.items,
          params.questions as Questions,
          {
            reduce: params.reduce === undefined ? undefined : asReduce(params.reduce),
            concurrency: params.concurrency,
            signal: signal ?? undefined,
          },
        );
        return ok(classifyText(result), {
          perItem: result.perItem,
          reduced: result.reduced,
          failures: result.failures,
          reduceSkipped: result.reduceSkipped,
          usage: result.usage,
        });
      } catch (err) {
        return ok(errorText("jev_classify", err));
      }
    },
  });

  pi.on("session_before_compact", async (event) => {
    // Fail-open, stated once instead of a hand-rolled catch. The callback is
    // the whole hook body, so exactly the paths the catch covered (no key, a
    // Jev outage, an unreadable answer) still resolve to `undefined` and OMP
    // runs its own compaction.
    return await withFailMode(
      "open",
      async () => {
        if (!(process.env.TYPESAFE_API_KEY ?? "").trim()) return undefined;
        const pairs = collectToolPairs(event.branchEntries);
        if (pairs.length === 0) return undefined;
        const threshold = keepThreshold(ENV.OMP_JEV_KEEP_THRESHOLD);
        const questions: Questions = {};
        for (const p of pairs) {
          questions["keep_call_" + p.key] = {
            type: "noul",
            instructions:
              "This tool call is still load-bearing for the ongoing task; " +
              "dropping it from context would lose information the agent still needs. " +
              "Tool: " +
              p.tool +
              ". Arguments: " +
              p.argsText,
          };
          questions["keep_result_" + p.key] = {
            type: "noul",
            instructions:
              "The result of this tool call is still needed for the ongoing task; " +
              "dropping it would lose information the agent still needs. " +
              "Tool: " +
              p.tool +
              ". Result (head): " +
              p.resultText,
          };
        }
        const response = await kit.ask(
          {
            pairs: pairs.map((p) => ({
              tool: p.tool,
              argsText: p.argsText,
              resultText: p.resultText,
            })),
          },
          questions,
          { signal: event.signal },
        );
        const decisions = pairs.map((p) => {
          let keepCall = 1;
          let keepResult = 1;
          try {
            keepCall = noul(response, "keep_call_" + p.key);
          } catch {
            /* keep the default */
          }
          try {
            keepResult = noul(response, "keep_result_" + p.key);
          } catch {
            /* keep the default */
          }
          return {
            key: p.key,
            tool: p.tool,
            keepCall,
            keepResult,
            stale: keepCall < threshold && keepResult < threshold,
          };
        });
        const stale = decisions.filter((d) => d.stale);
        if (stale.length === 0) return undefined;
        const firstEntryId = event.branchEntries[0]?.id;
        if (!firstEntryId) return undefined;
        const staleNames = stale.map((d) => d.tool).join(", ");
        const summary =
          "jev-compaction: judged " +
          String(pairs.length) +
          " tool pair(s); " +
          String(stale.length) +
          " stale (" +
          staleNames +
          "). History kept verbatim; per-pair scores in details.";
        return {
          compaction: {
            summary,
            firstKeptEntryId: firstEntryId,
            tokensBefore: event.preparation.tokensBefore,
            details: {
              shortSummary:
                "jev: " + String(stale.length) + "/" + String(pairs.length) + " tool pairs stale",
              threshold,
              decisions,
            },
          },
        };
      },
      { open: undefined, closed: undefined },
    );
  });

  pi.on("input", (event, ctx) => {
    try {
      const text = event.text ?? "";
      if (!text.trim()) return undefined;
      if (!(process.env.TYPESAFE_API_KEY ?? "").trim()) return undefined;
      const tools = pi.getAllTools();
      if (tools.length === 0) return undefined;
      // Cheap lexical prefilter before spending a call: first-message match in
      // core slices to maxCandidates (12), so a big tool roster would otherwise
      // crowd out the relevant names.
      const roster = tools.map((t) => ({ name: t.name, description: t.description ?? "" }));
      const shortlist = lexicalShortlist(text.slice(0, 2000), roster);
      const byName = new Map(roster.map((s) => [s.name, s.description]));
      void kit
        .routeSkills(
          text.slice(0, 2000),
          shortlist.map((name) => ({ name, description: byName.get(name) ?? "" })),
          { minConfidence: 0.5 },
        )
        .then((r) => {
          if (r.skill) {
            ctx.ui.notify(
              "jev: " +
                r.skill +
                " looks relevant (" +
                String(Math.round(r.confidence * 100)) +
                "%)",
              "info",
            );
          }
        })
        .catch(() => {});
    } catch {
      // Fail open: input is never blocked or rewritten by this hook.
    }
    return undefined;
  });
}
