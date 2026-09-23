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
  judgeDestructive,
  listJevModels,
  pickTool,
  rankCandidates,
  routeSkill,
  type Questions,
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
];

async function handleTool(name: string, args: Record<string, unknown>): Promise<unknown> {
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
    default:
      throw new Error("Unknown tool: " + name);
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
    try {
      return ok(await handleTool(request.params.name, args));
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });
  return server;
}

/** Start the server on stdio. Logs go to stderr (stdout is the protocol). */
export async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error(SERVER_NAME + " v" + SERVER_VERSION + " listening on stdio");
}
