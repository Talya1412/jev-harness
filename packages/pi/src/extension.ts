/**
 * @jev-harness/pi - TypeSafe Jev (System One) judgments as a Pi extension.
 *
 * Registers five fail-open tools (jev_ask, jev_models, jev_route_skills,
 * jev_pick_tool, jev_browse_action) plus two hooks:
 * - session_before_compact: verbatim compaction driven by two noul
 *   judgments per tool call/result pair.
 * - input: append-only skill-router advisory (never blocks or rewrites).
 *
 * Every Jev call fails OPEN: errors resolve to advisory text (tools) or
 * undefined (hooks), so the host agent never stalls because Jev is down.
 * The API key is read from the environment on each call and never logged.
 */
import {
  askJev,
  chooseBrowserAction,
  listJevModels,
  noul,
  pickTool,
  routeSkill,
  type JevConfig,
  type Questions,
} from "@jev-harness/core";
import type {
  ExtensionAPI,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  blockText,
  collectToolPairs,
  keepThreshold,
  resolveJevConfig,
  truncate,
  DEFAULT_KEEP_THRESHOLD,
  MAX_COMPACTION_PAIRS,
  type ToolPair,
} from "./compact.js";

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

export default function jevPi(pi: ExtensionAPI): void {
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
        const response = await askJev(
          resolveJevConfig(ENV),
          params.state,
          params.questions as Questions,
          signal ?? undefined,
        );
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
        const models = await listJevModels(resolveJevConfig(ENV));
        const lines = models.map((m) =>
          m.description ? m.name + " - " + m.description : m.name,
        );
        return ok(
          lines.length > 0 ? lines.join("\n") : "No Jev models returned.",
          { count: models.length },
        );
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
          description:
            "Candidate skills. Descriptions matter far more than names.",
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
        const result = await routeSkill(
          resolveJevConfig(ENV),
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
        const result = await pickTool(
          resolveJevConfig(ENV),
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
        const result = await chooseBrowserAction(
          resolveJevConfig(ENV),
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

  pi.on("session_before_compact", async (event) => {
    try {
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
            "Tool: " + p.tool + ". Arguments: " + p.argsText,
        };
        questions["keep_result_" + p.key] = {
          type: "noul",
          instructions:
            "The result of this tool call is still needed for the ongoing task; " +
            "dropping it would lose information the agent still needs. " +
            "Tool: " + p.tool + ". Result (head): " + p.resultText,
        };
      }
      const response = await askJev(
        resolveJevConfig(ENV),
        {
          pairs: pairs.map((p) => ({
            tool: p.tool,
            argsText: p.argsText,
            resultText: p.resultText,
          })),
        },
        questions,
        event.signal,
      );
      const decisions = pairs.map((p) => {
        let keepCall = 1;
        let keepResult = 1;
        try {
          keepCall = noul(response, "keep_call_" + p.key);
        } catch {
          keepCall = 1;
        }
        try {
          keepResult = noul(response, "keep_result_" + p.key);
        } catch {
          keepResult = 1;
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
    } catch {
      return undefined;
    }
  });

  pi.on("input", (event, ctx) => {
    try {
      const text = event.text ?? "";
      if (!text.trim()) return undefined;
      if (!(process.env.TYPESAFE_API_KEY ?? "").trim()) return undefined;
      const tools = pi.getAllTools();
      if (tools.length === 0) return undefined;
      void routeSkill(
        resolveJevConfig(ENV),
        text.slice(0, 2000),
        tools.map((t) => ({ name: t.name, description: t.description ?? "" })),
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
