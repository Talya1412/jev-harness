/**
 * Reusable Jev patterns. Each one is a pure function over an already-built
 * client call, so the same logic backs every harness adapter.
 */
import { askJev, choice, noul, type JevConfig, type JevResponse } from "./client.js";

export interface SkillCandidate {
  name: string;
  description?: string;
}

/**
 * Route a request to one skill (or none). Sending DESCRIPTIONS matters:
 * with names alone, "test the login page in a browser" routes to a
 * desktop-automation skill instead of the browser-testing one.
 */
export async function routeSkill(
  config: JevConfig,
  message: string,
  skills: SkillCandidate[],
  options: { minConfidence?: number; maxCandidates?: number; signal?: AbortSignal } = {},
): Promise<{ skill: string | null; confidence: number; probabilities: Record<string, number> }> {
  const minConfidence = options.minConfidence ?? 0.5;
  const shortlist = skills.slice(0, options.maxCandidates ?? 12);
  if (shortlist.length === 0) return { skill: null, confidence: 0, probabilities: {} };

  const criteria: Record<string, string> = { none: "No listed skill is relevant to this request" };
  const state: Record<string, string> = {};
  for (const s of shortlist) {
    const desc = (s.description ?? "").replace(/\s+/g, " ").slice(0, 180);
    criteria[s.name] = desc ? `${s.name}: ${desc}` : `Skill named ${s.name}`;
    state[s.name] = desc;
  }

  const response = await askJev(config, { message: message.slice(0, 3000), skills: state }, {
    best: {
      type: "choice",
      instructions: "Which listed skill, if any, is the right tool for this request? Judge by what the skill actually does, not by surface word overlap.",
      criteria,
    },
  }, options.signal);

  const result = choice(response, "best");
  const picked = result.choice && result.choice !== "none" && result.confidence >= minConfidence ? result.choice : null;
  return { skill: picked, confidence: result.confidence, probabilities: result.probabilities };
}

/** Decide whether a tool call is destructive enough to warrant confirmation. */
export async function judgeDestructive(
  config: JevConfig,
  call: { tool: string; input: unknown; cwd?: string },
  options: { threshold?: number; signal?: AbortSignal } = {},
): Promise<{ destructive: number; blocked: boolean }> {
  const threshold = options.threshold ?? 0.75;
  const response = await askJev(config, {
    tool: call.tool,
    input: JSON.stringify(call.input ?? {}).slice(0, 4000),
    cwd: call.cwd,
  }, {
    destructive: {
      type: "noul",
      instructions:
        "Running this exact tool call would destroy or irreversibly change data, history, or system state (recursive/bulk deletion, overwriting existing files without backup, force-push or history rewrite, dropping tables, killing processes, spending money, or sending secrets to an external endpoint). Reading, searching, listing, creating a brand-new file, or editing a file in place with a normal edit tool is NOT destructive.",
    },
  }, options.signal);
  const p = noul(response, "destructive");
  return { destructive: p, blocked: p >= threshold };
}

/** Pick one browser action from a snapshot. Does not execute anything. */
export async function chooseBrowserAction(
  config: JevConfig,
  input: {
    goal: string;
    page: { url: string; title?: string; text?: string };
    elements: Array<{ index: string; label: string; role?: string; value?: string; operations: string[] }>;
    recentActions?: Array<{ action: string; kind?: string; pageChanged?: boolean }>;
  },
  options: { minConfidence?: number; signal?: AbortSignal } = {},
): Promise<{ operation: string | null; target: string | null; confidence: number; act: boolean }> {
  const minConfidence = options.minConfidence ?? 0.4;
  const operations = new Set<string>();
  for (const el of input.elements) for (const op of el.operations) operations.add(String(op).toUpperCase());

  const criteria: Record<string, string> = {
    CLICK: "Click an element, button, menu option, autocomplete suggestion, or calendar day.",
    TYPE_TEXT: "Enter or replace text in an editable field. The value is supplied by code, not by you.",
    SELECT: "Select an observed dropdown value.",
    SCROLL_DOWN: "Scroll down to reveal more content.",
    SCROLL_UP: "Scroll up.",
    WAIT: "Wait for the page to update.",
    DONE: "Every requirement is visibly satisfied.",
    BLOCKED: "No supported operation can progress.",
  };

  const questions: Record<string, unknown> = {
    operation: {
      type: "choice",
      instructions: `Pick the single next browser operation that best advances the goal.\n\nGOAL: ${input.goal.slice(0, 1000)}`,
      criteria,
    },
  };
  for (const op of operations) {
    if (!["CLICK", "TYPE_TEXT", "SELECT"].includes(op)) continue;
    const eligible = input.elements.filter((e) => e.operations.map((o) => String(o).toUpperCase()).includes(op));
    if (eligible.length === 0) continue;
    // A choice needs at least two options. Add an explicit "none" escape so a
    // single eligible element still yields a valid question rather than a 400.
    const targetCriteria: Record<string, string> = { none: "Do not target any element for this operation." };
    for (const e of eligible) targetCriteria[e.index] = [e.label, e.role, e.value].filter(Boolean).join(" | ");
    questions[op.toLowerCase() + "_target"] = {
      type: "choice",
      instructions: `Which element should receive the ${op} operation to advance the goal?`,
      criteria: targetCriteria,
    };
  }

  const response = await askJev(config, {
    goal: input.goal,
    page: input.page,
    elements: input.elements,
    recent_actions: input.recentActions ?? [],
  }, questions as never, options.signal);

  const op = choice(response, "operation");
  const targetKey = op.choice ? op.choice.toLowerCase() + "_target" : null;
  let target: string | null = null;
  if (targetKey && response.answers[targetKey]) {
    try {
      const t = choice(response, targetKey).choice;
      target = t === "none" ? null : t;
    } catch { target = null; }
  }
  const act = !!op.choice && op.choice !== "BLOCKED" && op.confidence >= minConfidence;
  return { operation: op.choice ?? null, target, confidence: op.confidence, act };
}

/** Select one tool (or none) and flag whether it needs confirmation. */
export async function pickTool(
  config: JevConfig,
  input: { task: string; tools: Array<{ name: string; description: string }>; context?: string },
  options: { minConfidence?: number; riskThreshold?: number; signal?: AbortSignal } = {},
): Promise<{ tool: string | null; confidence: number; risky: number; confirmRequired: boolean; act: boolean }> {
  const minConfidence = options.minConfidence ?? 0.4;
  const riskThreshold = options.riskThreshold ?? 0.5;
  if (input.tools.length === 0) return { tool: null, confidence: 0, risky: 0, confirmRequired: false, act: false };

  const criteria: Record<string, string> = { none: "No listed tool is appropriate; answer or ask the user instead." };
  for (const t of input.tools) criteria[t.name] = t.description;

  const response = await askJev(config, { task: input.task, context: input.context ?? "", tools: input.tools }, {
    tool: { type: "choice", instructions: "Which single tool best accomplishes the task?", criteria },
    risky: {
      type: "noul",
      instructions:
        "Does invoking the chosen tool carry side effects that warrant explicit user confirmation (writes, deletes, network mutations, spending)?",
    },
  }, options.signal);

  const picked = choice(response, "tool");
  const risky = noul(response, "risky");
  const act = !!picked.choice && picked.choice !== "none" && picked.confidence >= minConfidence;
  return { tool: picked.choice ?? null, confidence: picked.confidence, risky, confirmRequired: risky >= riskThreshold, act };
}

/** Rank a list of strings against a task; returns best-first with scores. */
export async function rankCandidates(
  config: JevConfig,
  task: string,
  candidates: string[],
  options: { signal?: AbortSignal } = {},
): Promise<Array<{ candidate: string; fitness: number }>> {
  if (candidates.length === 0) return [];
  const questions: Record<string, unknown> = {};
  const criteria = ["Irrelevant", "Weakly related", "Relevant", "Directly on point"];
  for (let i = 0; i < candidates.length; i++) {
    questions[`fit_${i}`] = {
      type: "score",
      instructions: `How well does this candidate serve the task?\n\nTASK: ${task.slice(0, 1000)}\n\nCANDIDATE: ${candidates[i].slice(0, 1000)}`,
      criteria,
    };
  }
  const response = await askJev(config, { task: task.slice(0, 2000) }, questions as never, options.signal);
  const scored = candidates.map((c, i) => {
    let fitness = 0;
    try {
      const a = response.answers[`fit_${i}`];
      fitness = a && a.type === "score" ? a.score : 0;
    } catch { fitness = 0; }
    return { candidate: c, fitness };
  });
  return scored.sort((a, b) => b.fitness - a.fitness);
}

export type { JevConfig, JevResponse };
export { askJev, listJevModels } from "./client.js";
export * from "./types.js";
