// Bundled by @jev-harness/omp — @jev-harness/core is inlined. Do not edit.

// ../core/dist/types.js
var DEFAULT_BASE_URL = "https://api.typesafe.ai";
var DEFAULT_MODEL = "jev-latest";
var JevError = class extends Error {
  status;
  retryable;
  constructor(message, options = {}) {
    super(message);
    this.name = "JevError";
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    if (options.cause !== void 0)
      this.cause = options.cause;
  }
};

// ../core/dist/client.js
var DEFAULT_TIMEOUT_MS = 15e3;
var DEFAULT_MAX_ATTEMPTS = 3;
function resolveConfig(config) {
  const apiKey = (config.apiKey ?? "").trim();
  if (!apiKey) {
    throw new JevError("TYPESAFE_API_KEY is not set. Add it to your environment or pass { apiKey }.", { retryable: false });
  }
  return {
    apiKey,
    baseUrl: (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: config.model ?? DEFAULT_MODEL,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxAttempts: Math.max(1, config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
    fetchImpl: config.fetchImpl ?? fetch,
    onRetry: config.onRetry
  };
}
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function validateQuestions(questions) {
  const keys = Object.keys(questions ?? {});
  if (keys.length === 0)
    throw new JevError("questions must be a non-empty object", { retryable: false });
  for (const key of keys) {
    const q = questions[key];
    if (!q || typeof q !== "object")
      throw new JevError(`question "${key}" must be an object`, { retryable: false });
    if (!q.instructions || typeof q.instructions !== "string") {
      throw new JevError(`question "${key}" needs a non-empty instructions string`, { retryable: false });
    }
    if (q.type === "choice") {
      const n = Object.keys(q.criteria ?? {}).length;
      if (n < 2)
        throw new JevError(`choice "${key}" needs at least 2 criteria`, { retryable: false });
    } else if (q.type === "score") {
      const n = Array.isArray(q.criteria) ? q.criteria.length : 0;
      if (n < 2)
        throw new JevError(`score "${key}" needs at least 2 ordered levels`, { retryable: false });
    } else if (q.type !== "noul") {
      throw new JevError(`question "${key}" has unknown type "${q.type}"`, { retryable: false });
    }
  }
}
async function askJev(config, state, questions, signal) {
  const cfg = resolveConfig(config);
  validateQuestions(questions);
  if (state === void 0 || state === null) {
    throw new JevError("state is required", { retryable: false });
  }
  const body = JSON.stringify({ model: cfg.model, state, questions });
  let lastError = null;
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await cfg.fetchImpl(cfg.baseUrl + "/v1/systemone", {
        method: "POST",
        headers: { Authorization: "Bearer " + cfg.apiKey, "Content-Type": "application/json" },
        body,
        signal: controller.signal
      });
      if (res.status === 429 || res.status >= 500) {
        const text = await res.text().catch(() => "");
        lastError = new JevError(`Jev HTTP ${res.status}: ${text.slice(0, 300)}`, { status: res.status, retryable: true });
        if (attempt < cfg.maxAttempts) {
          cfg.onRetry?.(attempt, lastError);
          await sleep(250 * attempt * attempt);
          continue;
        }
        throw lastError;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new JevError(`Jev HTTP ${res.status}: ${text.slice(0, 500)}`, { status: res.status, retryable: false });
      }
      let parsed;
      const raw = await res.text();
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new JevError("Jev returned malformed JSON", { retryable: false });
      }
      const obj = parsed;
      if (!obj || typeof obj !== "object" || !obj.answers || typeof obj.answers !== "object") {
        throw new JevError("Jev response is missing `answers`", { retryable: false });
      }
      return obj;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (e instanceof JevError && !e.retryable)
        throw e;
      lastError = e;
      const transient = e.name === "AbortError" || /fetch failed|ECONN|network|timeout|aborted/i.test(e.message);
      if (!transient || attempt === cfg.maxAttempts)
        throw e;
      cfg.onRetry?.(attempt, e);
      await sleep(250 * attempt * attempt);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  throw lastError ?? new JevError("Jev call failed", { retryable: false });
}
async function listJevModels(config) {
  const cfg = resolveConfig(config);
  const res = await cfg.fetchImpl(cfg.baseUrl + "/v1/models", {
    headers: { Authorization: "Bearer " + cfg.apiKey }
  });
  if (!res.ok)
    throw new JevError(`Jev models HTTP ${res.status}`, { status: res.status });
  const body = await res.json();
  return body.models ?? [];
}
function noul(response, id) {
  const a = response.answers[id];
  if (!a || a.type !== "noul" || typeof a.noul !== "number") {
    throw new JevError(`answer "${id}" is not a valid noul`, { retryable: false });
  }
  return a.noul;
}
function choice(response, id) {
  const a = response.answers[id];
  if (!a || a.type !== "choice")
    throw new JevError(`answer "${id}" is not a valid choice`, { retryable: false });
  const c = a;
  return { choice: c.choice, confidence: c.confidence ?? 0, probabilities: c.probabilities ?? {} };
}

// ../core/dist/patterns.js
async function routeSkill(config, message, skills, options = {}) {
  const minConfidence = options.minConfidence ?? 0.5;
  const shortlist = skills.slice(0, options.maxCandidates ?? 12);
  if (shortlist.length === 0)
    return { skill: null, confidence: 0, probabilities: {} };
  const criteria = { none: "No listed skill is relevant to this request" };
  const state = {};
  for (const s of shortlist) {
    const desc = (s.description ?? "").replace(/\s+/g, " ").slice(0, 180);
    criteria[s.name] = desc ? `${s.name}: ${desc}` : `Skill named ${s.name}`;
    state[s.name] = desc;
  }
  const response = await askJev(config, { message: message.slice(0, 3e3), skills: state }, {
    best: {
      type: "choice",
      instructions: "Which listed skill, if any, is the right tool for this request? Judge by what the skill actually does, not by surface word overlap.",
      criteria
    }
  }, options.signal);
  const result = choice(response, "best");
  const picked = result.choice && result.choice !== "none" && result.confidence >= minConfidence ? result.choice : null;
  return { skill: picked, confidence: result.confidence, probabilities: result.probabilities };
}
async function judgeDestructive(config, call, options = {}) {
  const threshold = options.threshold ?? 0.75;
  const response = await askJev(config, {
    tool: call.tool,
    input: JSON.stringify(call.input ?? {}).slice(0, 4e3),
    cwd: call.cwd
  }, {
    destructive: {
      type: "noul",
      instructions: "Running this exact tool call would destroy or irreversibly change data, history, or system state (recursive/bulk deletion, overwriting existing files without backup, force-push or history rewrite, dropping tables, killing processes, spending money, or sending secrets to an external endpoint). Reading, searching, listing, creating a brand-new file, or editing a file in place with a normal edit tool is NOT destructive."
    }
  }, options.signal);
  const p = noul(response, "destructive");
  return { destructive: p, blocked: p >= threshold };
}
async function chooseBrowserAction(config, input, options = {}) {
  const minConfidence = options.minConfidence ?? 0.4;
  const operations = /* @__PURE__ */ new Set();
  for (const el of input.elements)
    for (const op2 of el.operations)
      operations.add(String(op2).toUpperCase());
  const criteria = {
    CLICK: "Click an element, button, menu option, autocomplete suggestion, or calendar day.",
    TYPE_TEXT: "Enter or replace text in an editable field. The value is supplied by code, not by you.",
    SELECT: "Select an observed dropdown value.",
    SCROLL_DOWN: "Scroll down to reveal more content.",
    SCROLL_UP: "Scroll up.",
    WAIT: "Wait for the page to update.",
    DONE: "Every requirement is visibly satisfied.",
    BLOCKED: "No supported operation can progress."
  };
  const questions = {
    operation: {
      type: "choice",
      instructions: `Pick the single next browser operation that best advances the goal.

GOAL: ${input.goal.slice(0, 1e3)}`,
      criteria
    }
  };
  for (const op2 of operations) {
    if (!["CLICK", "TYPE_TEXT", "SELECT"].includes(op2))
      continue;
    const eligible = input.elements.filter((e) => e.operations.map((o) => String(o).toUpperCase()).includes(op2));
    if (eligible.length === 0)
      continue;
    const targetCriteria = { none: "Do not target any element for this operation." };
    for (const e of eligible)
      targetCriteria[e.index] = [e.label, e.role, e.value].filter(Boolean).join(" | ");
    questions[op2.toLowerCase() + "_target"] = {
      type: "choice",
      instructions: `Which element should receive the ${op2} operation to advance the goal?`,
      criteria: targetCriteria
    };
  }
  const response = await askJev(config, {
    goal: input.goal,
    page: input.page,
    elements: input.elements,
    recent_actions: input.recentActions ?? []
  }, questions, options.signal);
  const op = choice(response, "operation");
  const targetKey = op.choice ? op.choice.toLowerCase() + "_target" : null;
  let target = null;
  if (targetKey && response.answers[targetKey]) {
    try {
      const t = choice(response, targetKey).choice;
      target = t === "none" ? null : t;
    } catch {
      target = null;
    }
  }
  const act = !!op.choice && op.choice !== "BLOCKED" && op.confidence >= minConfidence;
  return { operation: op.choice ?? null, target, confidence: op.confidence, act };
}
async function pickTool(config, input, options = {}) {
  const minConfidence = options.minConfidence ?? 0.4;
  const riskThreshold = options.riskThreshold ?? 0.5;
  if (input.tools.length === 0)
    return { tool: null, confidence: 0, risky: 0, confirmRequired: false, act: false };
  const criteria = { none: "No listed tool is appropriate; answer or ask the user instead." };
  for (const t of input.tools)
    criteria[t.name] = t.description;
  const response = await askJev(config, { task: input.task, context: input.context ?? "", tools: input.tools }, {
    tool: { type: "choice", instructions: "Which single tool best accomplishes the task?", criteria },
    risky: {
      type: "noul",
      instructions: "Does invoking the chosen tool carry side effects that warrant explicit user confirmation (writes, deletes, network mutations, spending)?"
    }
  }, options.signal);
  const picked = choice(response, "tool");
  const risky = noul(response, "risky");
  const act = !!picked.choice && picked.choice !== "none" && picked.confidence >= minConfidence;
  return { tool: picked.choice ?? null, confidence: picked.confidence, risky, confirmRequired: risky >= riskThreshold, act };
}

// dist/extension.js
var DEFAULT_TIMEOUT_MS2 = 15e3;
var GATE_THRESHOLD = 0.75;
var SKILL_MIN_CONFIDENCE = 0.5;
function readConfig(modelOverride) {
  const apiKey = (process.env.TYPESAFE_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error("TYPESAFE_API_KEY is not set. Add it to ~/.omp/agent/.env or export it before launching omp.");
  }
  const timeoutRaw = (process.env.JEV_TIMEOUT_MS ?? "").trim();
  const timeoutMs = timeoutRaw !== "" && Number.isFinite(Number(timeoutRaw)) ? Number(timeoutRaw) : DEFAULT_TIMEOUT_MS2;
  return {
    apiKey,
    baseUrl: (process.env.TYPESAFE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: (modelOverride ?? "").trim() || process.env.TYPESAFE_DEFAULT_MODEL || DEFAULT_MODEL,
    timeoutMs
  };
}
function autoOn(env) {
  return (process.env.OMP_JEV_AUTO ?? "").trim() === "1" && (process.env[env] ?? "1").trim() !== "0";
}
function envNum(name, fallback) {
  const raw = (process.env[name] ?? "").trim();
  if (!raw)
    return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
function jevExtension(pi) {
  const z = pi.zod;
  const questionSchema = z.object({
    type: z.enum(["noul", "choice", "score"]).describe("Question primitive"),
    instructions: z.string().describe("The single narrow judgment to make"),
    criteria: z.union([z.array(z.string()), z.record(z.string(), z.string())]).optional().describe("For choice: {key: description}. For score: ordered [low..high] levels.")
  }).passthrough();
  pi.registerTool({
    name: "jev_ask",
    label: "Jev Ask",
    description: "Ask TypeSafe's Jev (System One) typed questions about a state and get calibrated probabilities. questions is a map of id -> {type: 'noul'|'choice'|'score', instructions, criteria?}. noul returns P(yes); choice returns the winning key + probabilities + confidence; score returns a probability-weighted level. Use for routing, ranking, extraction, verification, and confidence-gated decisions where code needs semantic judgment rather than generated text.",
    parameters: z.object({
      state: z.union([z.string(), z.record(z.string(), z.any()), z.array(z.any())]).describe("The content to judge \u2014 text, or a JSON object with named fields referenced by backticked paths."),
      questions: z.record(z.string(), questionSchema).describe("Map of question id -> question definition."),
      model: z.string().optional().describe("Override model (default jev-latest).")
    }),
    loadMode: "essential",
    approval: "read",
    async execute(_id, params, signal) {
      const cfg = readConfig(params.model);
      const result = await askJev(cfg, params.state, params.questions, signal ?? void 0);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result
      };
    }
  });
  pi.registerTool({
    name: "jev_models",
    label: "Jev Models",
    description: "List the TypeSafe System One models available to the configured API key.",
    parameters: z.object({}),
    loadMode: "essential",
    approval: "read",
    async execute(_id, _params, _signal) {
      const cfg = readConfig();
      const models = await listJevModels(cfg);
      const text = JSON.stringify(models, null, 2);
      return { content: [{ type: "text", text }], details: { models } };
    }
  });
  pi.registerTool({
    name: "jev_route_skills",
    label: "Jev Route Skills",
    description: "Rank the installed skill roster against a task description using one Jev call. Pass the task text and the candidate skill names; returns a relevance ranking plus a no-skill-needed probability. Advisory: decide from the result, do not blindly load the top hit.",
    loadMode: "discoverable",
    parameters: z.object({
      task: z.string().describe("The user's task or first message to route."),
      skills: z.array(z.string()).describe("Candidate skill names to rank.")
    }),
    approval: "read",
    async execute(_id, params, signal) {
      const cfg = readConfig();
      const result = await routeSkill(cfg, params.task, params.skills.map((name) => ({ name })), { signal: signal ?? void 0 });
      const hint = result.skill !== null ? "Consider loading skill: " + result.skill : "No listed skill is relevant.";
      return {
        content: [{ type: "text", text: hint + "\n\n" + JSON.stringify(result, null, 2) }],
        details: result
      };
    }
  });
  pi.registerTool({
    name: "jev_browse_goal",
    label: "Jev Browse Goal",
    description: "Given a goal and a numbered element table from a page snapshot, ask Jev to pick the single next browser action. Returns the operation plus the chosen target. ADVISORY: this tool does not execute anything \u2014 validate the returned index against the live snapshot and act in code.",
    parameters: z.object({
      goal: z.string().describe("What the user wants to achieve on the page."),
      elements: z.array(z.object({
        index: z.string().describe("Stable element index from the snapshot, e.g. '3' or '5:2' for a select option."),
        label: z.string().describe("Human-visible label."),
        role: z.string().optional().describe("ARIA role, e.g. combobox / button / link."),
        value: z.string().optional().describe("Current value, if any."),
        operations: z.array(z.string()).describe("Operations this element supports, e.g. ['CLICK','TYPE_TEXT'].")
      })).describe("Numbered interactive elements from the current snapshot."),
      page: z.object({ url: z.string(), title: z.string().optional(), text: z.string().optional() }).describe("Current page context."),
      recent_actions: z.array(z.object({ action: z.string(), kind: z.string().optional(), page_changed: z.boolean().optional() })).optional().describe("Last few actions taken.")
    }),
    loadMode: "discoverable",
    approval: "read",
    async execute(_id, params, signal) {
      const cfg = readConfig();
      const result = await chooseBrowserAction(cfg, {
        goal: params.goal,
        page: params.page,
        elements: params.elements,
        recentActions: (params.recent_actions ?? []).map((r) => ({
          action: String(r?.action ?? ""),
          kind: r?.kind,
          pageChanged: r?.page_changed
        }))
      }, { signal: signal ?? void 0 });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result
      };
    }
  });
  pi.registerTool({
    name: "jev_pick_tool",
    label: "Jev Pick Tool",
    description: "Given a task and a list of candidate tools with their schemas, ask Jev which single tool to use and whether it needs confirmation. Best when the candidate set is enumerable (few tools, closed-set args). ADVISORY: this does not execute the tool.",
    parameters: z.object({
      task: z.string().describe("What the user is asking for."),
      tools: z.array(z.object({
        name: z.string(),
        description: z.string(),
        args: z.record(z.string(), z.string()).optional().describe("Map of arg name -> type/description, for closed-set args.")
      })).describe("Candidate tools to choose from."),
      context: z.string().optional().describe("Extra context, e.g. recent error or file being worked on.")
    }),
    loadMode: "discoverable",
    approval: "read",
    async execute(_id, params, signal) {
      const cfg = readConfig();
      const result = await pickTool(cfg, { task: params.task, tools: params.tools, context: params.context }, { signal: signal ?? void 0 });
      const out = {
        tool: result.tool,
        confidence: result.confidence,
        risky_probability: result.risky,
        confirm_required: result.confirmRequired,
        act: result.act
      };
      return {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        details: out
      };
    }
  });
  pi.on("tool_call", async (event) => {
    if (!autoOn("OMP_JEV_GATE"))
      return;
    try {
      const name = String(event?.toolName ?? "");
      if (!/^(bash|write|edit|delete|move|rm|mcp__)/i.test(name))
        return;
      const cfg = readConfig();
      const verdict = await judgeDestructive(cfg, { tool: name, input: event?.input ?? {}, cwd: process.cwd() }, { threshold: GATE_THRESHOLD });
      if (verdict.blocked) {
        return {
          block: true,
          reason: "jev gate: destructive effect likely (" + verdict.destructive.toFixed(2) + "). Re-issue with explicit confirmation or adjust the command."
        };
      }
    } catch (err) {
      try {
        pi.logger.warn("jev gate: allowed on error (fail-open)", { error: String(err) });
      } catch {
      }
      return;
    }
  });
  pi.on("input", async (event, ctx) => {
    if (!autoOn("OMP_JEV_SKILL_ROUTER"))
      return;
    try {
      const text = String(event?.text ?? event?.prompt ?? "");
      if (text.length < 12)
        return;
      let roster = [];
      try {
        roster = (ctx?.skills ?? []).map((s) => ({ name: String(s?.name ?? ""), description: String(s?.description ?? "") })).filter((s) => s.name !== "");
      } catch {
        roster = [];
      }
      if (roster.length === 0)
        return;
      const lower = text.toLowerCase();
      const scored = roster.map((s) => {
        const parts = s.name.toLowerCase().split(/[-_]/);
        let score = 0;
        for (const part of parts) {
          if (part.length > 3 && lower.includes(part))
            score += 2;
          if (part.length <= 4 && lower.includes(part))
            score += 1;
        }
        return { name: s.name, score };
      });
      const lexical = scored.filter((x) => x.score > 0).map((x) => x.name);
      const shortlist = (lexical.length > 0 ? lexical : roster.map((s) => s.name)).slice(0, 12);
      if (shortlist.length === 0)
        return;
      const byName = /* @__PURE__ */ new Map();
      for (const s of roster) {
        byName.set(s.name, s.description.replace(/\s+/g, " ").slice(0, 180));
      }
      const cfg = readConfig();
      const result = await routeSkill(cfg, text, shortlist.map((name) => ({ name, description: byName.get(name) ?? "" })), { minConfidence: SKILL_MIN_CONFIDENCE, maxCandidates: 12 });
      if (result.skill !== null) {
        return { additionalContext: "[jev] Consider loading skill: " + result.skill };
      }
    } catch (err) {
      try {
        pi.logger.debug("jev skill router skipped", { error: String(err) });
      } catch {
      }
      return;
    }
  });
  const COMPACT_DEFAULTS = {
    keepThreshold: 0.2,
    // measured: real scores sit 0.2-0.4, so 0.5 keeps nearly everything
    maxStateTokens: 25e3,
    maxRequestTokens: 3e4,
    truncateHeadChars: 300,
    minReductionRatio: 0.25
  };
  function flatten(messages) {
    const out = [];
    for (const raw of messages) {
      const m = raw;
      const role = String(m.role ?? "unknown");
      const blocks = Array.isArray(m.content) ? m.content : [];
      const texts = [];
      const toolUses = [];
      const toolResults = [];
      for (const b of blocks) {
        if (!b || typeof b !== "object") {
          if (typeof b === "string")
            texts.push(b);
          continue;
        }
        if (b.type === "text" && typeof b.text === "string")
          texts.push(b.text);
        else if (b.type === "tool_use" || b.type === "tool_call") {
          toolUses.push({
            id: String(b.id ?? b.toolCallId ?? ""),
            tool: String(b.name ?? b.toolName ?? "tool"),
            input: b.input ?? b.args ?? {}
          });
        } else if (b.type === "tool_result") {
          const c = b.content;
          let tr = "";
          if (typeof c === "string")
            tr = c;
          else if (Array.isArray(c))
            tr = c.map((x) => typeof x === "string" ? x : x?.text ?? "").join("\n");
          else if (c != null)
            tr = JSON.stringify(c);
          toolResults.push({ id: String(b.tool_use_id ?? b.toolUseId ?? ""), text: tr });
        }
      }
      out.push({ role, text: texts.join("\n"), toolUses, toolResults });
    }
    return out;
  }
  function collectCalls(msgs) {
    const byId = /* @__PURE__ */ new Map();
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
  function estimateTokens(s) {
    let tok = 0;
    for (const ch of s) {
      if (/[A-Za-z]/.test(ch))
        tok += 1 / 6;
      else if (/[0-9]/.test(ch))
        tok += 0.5;
      else
        tok += 1;
    }
    return Math.ceil(tok) + 8;
  }
  function buildCompactState(msgs, calls) {
    const callById = new Map(calls.map((c) => [c.id, c]));
    return {
      conversation: msgs.map((m) => ({
        role: m.role,
        text: m.text.length > 4e3 ? m.text.slice(0, 3e3) + "\n...[truncated]...\n" + m.text.slice(-900) : m.text,
        tool_calls: m.toolUses.map((u) => ({ id: u.id, tool: u.tool, input: u.input })),
        tool_results: m.toolResults.map((r) => ({
          id: r.id,
          note: "ok, " + r.text.length + " chars (omitted)",
          isError: /^\s*(error|Error|ERROR)/.test(r.text)
        }))
      }))
    };
  }
  function questionsForCall(c) {
    const q = {};
    Object.assign(q, {
      ["call_" + c.id]: {
        type: "noul",
        instructions: "Tool call " + c.id + " (" + c.tool + ") should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next"
      }
    });
    Object.assign(q, {
      ["result_" + c.id]: {
        type: "noul",
        instructions: "The full output of tool call " + c.id + " (" + c.tool + ", " + c.resultChars + " chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do"
      }
    });
    return q;
  }
  function reduceCallQuestions(calls) {
    const q = {};
    for (const c of calls)
      Object.assign(q, questionsForCall(c));
    return q;
  }
  function batchCompactCalls(calls, stateTokens, budget) {
    const perCall = estimateTokens(JSON.stringify(reduceCallQuestions(calls.slice(0, 1))));
    const maxPerBatch = Math.max(1, Math.floor((budget - stateTokens - 20) / Math.max(1, perCall)));
    const out = [];
    for (let i = 0; i < calls.length; i += maxPerBatch)
      out.push(calls.slice(i, i + maxPerBatch));
    return out;
  }
  pi.on("session_before_compact", async (event) => {
    if (!autoOn("OMP_JEV_CONTEXT"))
      return;
    try {
      const prep = event?.preparation;
      if (!prep || !Array.isArray(prep.messagesToSummarize))
        return;
      const region = [...prep.messagesToSummarize ?? [], ...prep.turnPrefixMessages ?? []];
      if (region.length === 0)
        return;
      const flat = flatten(region);
      const calls = collectCalls(flat);
      if (calls.length === 0)
        return;
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
      const results = await Promise.all(batches.map((b) => askJev(cfg, state, reduceCallQuestions(b))));
      const probs = /* @__PURE__ */ new Map();
      for (const r of results) {
        for (const id of Object.keys(r.answers)) {
          try {
            probs.set(id, noul(r, id));
          } catch {
            probs.set(id, 1);
          }
        }
      }
      const keepProb = (id) => probs.get(id) ?? 1;
      const decisions = calls.map((c) => {
        const keepCall = keepProb("call_" + c.id);
        const keepResult = keepProb("result_" + c.id);
        const action = keepResult >= keepThreshold ? "keep" : "drop_result";
        return { call: c, action, keepCall, keepResult };
      });
      const dropped = decisions.filter((d) => d.action === "drop_result" && d.call.resultChars > truncateHead);
      const savedChars = dropped.reduce((n, d) => n + (d.call.resultChars - truncateHead), 0);
      const totalChars = calls.reduce((n, c) => n + c.resultChars, 0);
      if (totalChars === 0 || savedChars / totalChars < minReduction) {
        pi.logger.debug("jev_compact: insufficient reduction, deferring", { savedChars, totalChars });
        return;
      }
      const truncById = new Map(dropped.map((d) => [d.call.id, d.call]));
      const render = (msgs) => msgs.map((m) => {
        const parts = [];
        if (m.text)
          parts.push(m.text);
        for (const u of m.toolUses) {
          const t = truncById.get(u.id);
          parts.push("[tool_use id=" + u.id + " name=" + u.tool + " input=" + JSON.stringify(u.input) + "]");
          if (t && t.resultText != null) {
            const full = t.resultText;
            parts.push("[tool_result id=" + u.id + "] " + full.slice(0, truncateHead) + "\n[..." + (t.resultChars - truncateHead) + " chars omitted by jev_compact; re-run the tool to recover]");
          }
        }
        for (const r of m.toolResults) {
          if (m.toolUses.some((w) => w.id === r.id))
            continue;
          const t = truncById.get(r.id);
          if (t && t.resultText != null) {
            const full = t.resultText;
            parts.push("[tool_result id=" + r.id + "] " + full.slice(0, truncateHead) + "\n[..." + (t.resultChars - truncateHead) + " chars omitted by jev_compact]");
          } else {
            parts.push("[tool_result id=" + r.id + "] " + r.text);
          }
        }
        return parts.filter(Boolean).join("\n");
      }).filter(Boolean).join("\n\n");
      const summary = "Verbatim history retained; " + dropped.length + " tool output(s) truncated by Jev decisions.\n\n" + render(flat);
      pi.logger.debug("jev_compact: reduced", {
        calls: calls.length,
        dropped: dropped.length,
        batches: batches.length,
        savedChars
      });
      return {
        compaction: {
          summary,
          shortSummary: "Jev verbatim compaction: " + dropped.length + "/" + calls.length + " tool outputs truncated",
          firstKeptEntryId: prep.firstKeptEntryId,
          tokensBefore: prep.tokensBefore,
          details: { jev: { calls: calls.length, dropped: dropped.length, savedChars, keepThreshold } }
        }
      };
    } catch (err) {
      try {
        pi.logger.warn("jev_compact failed, falling back to native compaction", { error: String(err) });
      } catch {
      }
      return;
    }
  });
}
export {
  jevExtension as default
};
