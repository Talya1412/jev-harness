// Bundled by @jev-harness/omp — @jev-harness/core is inlined. Do not edit.

// dist/extension.js
import { homedir as homedir2 } from "node:os";
import { join as join3 } from "node:path";

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

// ../core/dist/redact.js
var PLACEHOLDER = "[REDACTED";
var BUILTIN_REDACT_PATTERNS = [
  { label: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    label: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
  },
  {
    label: "private-key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
  },
  {
    label: "github-token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g
  },
  { label: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: "api-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { label: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  {
    label: "auth-header",
    pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]{16,}={0,2}/gi,
    replace: "$1 [REDACTED]"
  },
  {
    label: "secret-assignment",
    pattern: /\b([A-Z][A-Z0-9_]{2,}(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_PASSWD|_CREDENTIALS?|APIKEY|API_KEY))\s*[:=]\s*("[^"\n]*"|'[^'\n]*'|[^\s,;)"']+)/g,
    replace: "$1=[REDACTED]"
  },
  {
    label: "url-credential",
    pattern: /\b((?:password|passwd|pwd|pass|token|api_?key)=)([^&;\s"']+)/gi,
    replace: "$1[REDACTED]"
  },
  {
    label: "connection-string",
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|mssql):\/\/[^\s"'@/:]+:[^\s"'@]*@/g,
    replace: "[REDACTED-connstring]@"
  },
  {
    label: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
  }
];
function redactText(text, opts = {}) {
  let out = text;
  const patterns = opts.extra?.length ? [
    ...BUILTIN_REDACT_PATTERNS,
    ...opts.extra.map((p) => ({ label: "custom", pattern: p }))
  ] : BUILTIN_REDACT_PATTERNS;
  for (const { label, pattern, replace } of patterns) {
    out = out.replace(pattern, replace ?? `${PLACEHOLDER}:${label}]`);
  }
  return out;
}
function redactState(state, opts = {}) {
  return walk(state, 0, opts);
}
function isPlainObject(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function walk(value, depth, opts) {
  if (typeof value === "string")
    return redactText(value, opts);
  if (value === null || typeof value !== "object")
    return value;
  if (depth >= (opts.maxDepth ?? 12))
    return value;
  if (Array.isArray(value))
    return value.map((v) => walk(v, depth + 1, opts));
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime()))
      return null;
    return redactText(value.toISOString(), opts);
  }
  if (value instanceof Map) {
    return Array.from(value.entries(), ([k, v]) => [
      walk(k, depth + 1, opts),
      walk(v, depth + 1, opts)
    ]);
  }
  if (value instanceof Set) {
    return Array.from(value, (v) => walk(v, depth + 1, opts));
  }
  if (!isPlainObject(value)) {
    try {
      return redactText(String(value), opts);
    } catch {
      return PLACEHOLDER + ":opaque]";
    }
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = walk(v, depth + 1, opts);
  }
  return out;
}

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
    onRetry: config.onRetry,
    redact: config.redact
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
      throw new JevError(`question "${key}" needs a non-empty instructions string`, {
        retryable: false
      });
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
      throw new JevError(`question "${key}" has unknown type "${q.type}"`, {
        retryable: false
      });
    }
  }
}
async function askJev(config, state, questions, signal) {
  const cfg = resolveConfig(config);
  validateQuestions(questions);
  if (state === void 0 || state === null) {
    throw new JevError("state is required", { retryable: false });
  }
  let effectiveState = state;
  if (cfg.redact) {
    const opts = cfg.redact === true ? {} : cfg.redact;
    try {
      effectiveState = redactState(state, opts);
    } catch {
      effectiveState = state;
    }
  }
  const body = JSON.stringify({ model: cfg.model, state: effectiveState, questions });
  let lastError = null;
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    if (signal?.aborted) {
      const abortErr = new Error("Jev call aborted");
      abortErr.name = "AbortError";
      throw abortErr;
    }
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
        lastError = new JevError(`Jev HTTP ${res.status}: ${text.slice(0, 300)}`, {
          status: res.status,
          retryable: true
        });
        if (attempt < cfg.maxAttempts) {
          cfg.onRetry?.(attempt, lastError);
          await sleep(250 * attempt * attempt);
          continue;
        }
        throw lastError;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new JevError(`Jev HTTP ${res.status}: ${text.slice(0, 500)}`, {
          status: res.status,
          retryable: false
        });
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
var MAX_BROWSER_ELEMENTS = 30;
var MAX_ELEMENT_CHARS = 500;
var MAX_PAGE_TEXT_CHARS = 8e3;
var THRESHOLDS = Object.freeze({
  /**
   * Destructive tool_call gate. Measured on `golden/destructive-gate-dual.json`
   * (104 cases, live recording 2026-09-24): AUC 1.000, Brier 0.0165, and a
   * noiseless plateau of [0.40, 0.56] — the noisiest negative at 0.40 and the
   * quietest positive at 0.56. 0.5 sits inside it with margin on both sides.
   * Raising this to 0.6 would cost one false negative, so 0.5 is the value to
   * keep. Re-measure with:
   * `node packages/eval/scripts/record-baseline.mjs packages/eval/golden/destructive-gate-dual.json destructive packages/eval/golden/destructive-gate-dual.baseline.json`
   */
  destructiveGate: 0.5,
  /** Minimum confidence before a skill suggestion is worth injecting. */
  skillRouting: 0.5,
  /**
   * Prompt-injection screen, ENTRY POINT A — `gateInjection`.
   *
   * `gateInjection` and `detectPromptInjection` are two entry points to ONE
   * decision ("does this content try to manipulate the agent?"), now sharing
   * one transport helper (in ./gate-core.js) and one question id. They stay
   * separate because they screen at different moments and read different
   * state:
   *
   * - `gateInjection` (this key, 0.7) runs on tool results and fetched pages
   *   BEFORE they enter model context. It sees raw material the model has not
   *   seen, and a false positive silently drops a legitimate result, so it
   *   holds the stricter bar.
   * - `detectPromptInjection` (0.6) runs on content about to be APPENDED to
   *   an already-trusted conversation, where the blast radius of a miss is the
   *   whole assembled context, so it screens lower — and its prompt also names
   *   encoded payloads and role hijacking, which the pre-context screen's
   *   wording does not.
   *
   * HONEST CAVEAT: the 0.1 GAP ITSELF IS NOT MEASURED. Unlike
   * `destructiveGate` above, there is no injection golden dataset or recorded
   * baseline in @jev-harness/eval — no sweep ever justified 0.7 over 0.6 or
   * the reverse. The difference is justified by the entry points' differing
   * jobs, not by a calibration run. Treat the gap as a deliberate, reversible
   * choice, not a tuned constant: do not "tidy" the two keys into one without
   * first recording an injection dataset and measuring the change. Each
   * function reads its OWN key, and patterns-extra.test.ts pins that.
   */
  gateInjection: 0.7,
  /**
   * Prompt-injection screen, ENTRY POINT B — `detectPromptInjection`.
   *
   * The counterpart to `gateInjection`; read that key's comment first. Same
   * one decision, screened at a different point in the pipeline (content being
   * appended to an already-trusted conversation) with wording that also names
   * encoded payloads and role hijacking, hence the lower 0.6 bar.
   *
   * The 0.7-vs-0.6 gap is likewise UNMEASURED — see the caveat on
   * `gateInjection`. Each function reads its own key on purpose.
   */
  detectPromptInjection: 0.6,
  /** Dedup / same-underlying-fact cutoff. */
  duplicate: 0.5,
  /**
   * Escalate when a choice/score gate falls BELOW this. PROVISIONAL: vendor
   * confidence-routing maps "<0.6 confidence -> human"; coco-research's
   * jev-use treats sub-0.70 decisions as guesses. No local labeled data —
   * tune on your own outcomes before relying on it.
   */
  escalateBelow: 0.6,
  /**
   * Noul uncertainty band: a p inside [low, high] is uncertain, outside is
   * determined. PROVISIONAL but vendor-cited: the consistency-noul cookbook
   * maps [0.30, 0.70] to uncertain. Noul answers carry no confidence field,
   * so distance from 0.5 is the only uncertainty signal they give.
   */
  uncertainBandLow: 0.3,
  uncertainBandHigh: 0.7,
  /**
   * Prune keep bar: at or above this a context item stays. MEASURED as a
   * cross-repo consensus (codex-context-diet keepThreshold 0.5, jev-pruner
   * keepThreshold 0.5) — not a locally measured plateau; re-tune against your
   * own read-backs.
   */
  pruneKeep: 0.5,
  /** Prune drop bar: at or below this the item may be dropped. MEASURED cross-repo (codex-context-diet dropThreshold 0.25; the band between drop and keep always keeps). */
  pruneDrop: 0.25,
  /** Drop bar for error/diagnostic output — far stricter, because a dropped error is how bugs hide. MEASURED cross-repo (codex-context-diet needs <=0.1 on failure-looking output; jev-pruner requires <=0.1 in every segment). */
  pruneErrorDrop: 0.1,
  /**
   * Refute (delete) a review finding only at or above this. PROVISIONAL and
   * deliberately high: no published measurement exists and the loss is
   * asymmetric — a false removal is far more expensive than a false keep
   * (open-code-review's filter states this in prose). Calibrate before lowering.
   */
  refute: 0.75,
  /** Report a finding as a real defect at or above this. PROVISIONAL: upstream has no threshold at all (bare severity enum, unknown values silently coerced to "low"); 0.5 is the coin-flip boundary until calibrated on your own findings. */
  findingReal: 0.5,
  /**
   * Minimum confidence in the dual gate's category choice. Below this the
   * category is treated as unproven and the verdict becomes `confirm` rather
   * than a hard block, so a genuine-but-uncertain case always has a way
   * forward.
   */
  categoryConfidence: 0.5,
  // --- the remaining public defaults, same values every pattern already used ---
  /** Post-hoc verification that a finished step actually satisfied the task. */
  verifyStep: 0.6,
  /** Genuine ambiguity fork worth one clarifying question. */
  clarification: 0.5,
  /** Cheap-vs-expensive model routing for a task. */
  effortRouting: 0.5,
  /** Browser-action selection confidence floor. */
  browserAction: 0.4,
  /** Tool selection confidence floor. */
  toolPick: 0.4,
  /** Tool side-effect risk floor that demands explicit confirmation. */
  toolRisk: 0.5,
  /** RAG claim-support floor before a generated statement is trusted. */
  claimSupport: 0.5,
  /** Context-sufficiency floor before asking the user for more. */
  contextSufficiency: 0.5,
  /** Regression-detection floor. */
  regression: 0.5,
  /** Subagent selection confidence floor. */
  subagentPick: 0.4,
  /** Subagent delegation floor. */
  delegation: 0.5,
  /** Commit-safety floor for `commitGate`. */
  commitSafe: 0.8,
  /** Secret-leak flag floor. */
  secretLeak: 0.6,
  /**
   * Token-overlap floor for `infra.localRouteSkill`. Not a Jev probability —
   * it is a different scale, so it is tuned separately from the rest.
   */
  localRouterFloor: 0.05
});
async function routeSkill(config, message, skills, options = {}) {
  const minConfidence = options.minConfidence ?? THRESHOLDS.skillRouting;
  const shortlist2 = skills.slice(0, options.maxCandidates ?? 12);
  if (shortlist2.length === 0)
    return { skill: null, confidence: 0, probabilities: {} };
  if (shortlist2.some((s) => s.name === "none")) {
    throw new JevError('routeSkill: "none" is reserved for the abstain option; rename the skill candidate', { retryable: false });
  }
  const criteria = { none: "No listed skill is relevant to this request" };
  const state = {};
  for (const s of shortlist2) {
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
var DESTRUCTIVE_CATEGORIES = [
  "destructive",
  "reversible-mutation",
  "read-only",
  "unknown"
];
async function judgeDestructiveDual(config, call, options) {
  const threshold = options?.threshold ?? THRESHOLDS.destructiveGate;
  const response = await askJev(config, {
    tool: call.tool,
    input: JSON.stringify(call.input ?? {}).slice(0, 4e3),
    cwd: call.cwd
  }, {
    destructive: {
      type: "noul",
      instructions: "Running this exact tool call would destroy or irreversibly change data, history, or system state. That includes: recursive or bulk deletion; overwriting or truncating existing files without backup; git history rewrite, force-push, or discarding uncommitted work; dropping tables or deleting namespaces/volumes; formatting, wiping, or overwriting a disk or device; changing permissions or ownership across a broad path; exhausting, killing, or shutting down the machine (fork bombs, mass process kill, shutdown/reboot); publishing a package or spending money; or sending secrets to an external endpoint. Reading, searching, listing, creating a brand-new file, building, running tests, or editing a file in place with a normal edit tool is NOT destructive."
    },
    category: {
      type: "choice",
      instructions: "What would this tool call actually do? Judge the call itself, not the tool's general reputation.",
      criteria: {
        destructive: "Deletes or overwrites existing data, rewrites or force-pushes history, spends money, or publishes irreversibly.",
        "reversible-mutation": "Changes state that can be restored \u2014 a normal file edit, an append, a committed change on a branch.",
        "read-only": "Only reads, lists, searches, builds, or tests; nothing on disk or remote changes.",
        unknown: "Cannot tell from the call alone."
      }
    }
  }, options?.signal);
  const readDestructive = () => {
    try {
      return noul(response, "destructive");
    } catch {
      return 0;
    }
  };
  const readCategory = () => {
    try {
      const picked = choice(response, "category");
      const label = String(picked.choice ?? "").trim().toLowerCase();
      return {
        category: DESTRUCTIVE_CATEGORIES.includes(label) ? label : "unknown",
        confidence: picked.confidence ?? 0
      };
    } catch {
      return { category: "unknown", confidence: 0 };
    }
  };
  const destructive = readDestructive();
  const { category, confidence } = readCategory();
  if (!(destructive >= threshold))
    return { destructive, category, confidence, decision: "allow" };
  const proven = category === "destructive" && confidence >= THRESHOLDS.categoryConfidence;
  return { destructive, category, confidence, decision: proven ? "block" : "confirm" };
}
async function chooseBrowserAction(config, input, options = {}) {
  const minConfidence = options.minConfidence ?? THRESHOLDS.browserAction;
  const selected = input.elements.slice(0, MAX_BROWSER_ELEMENTS);
  let truncated = input.elements.length > selected.length;
  const capField = (s) => {
    if (s === void 0)
      return void 0;
    if (s.length > MAX_ELEMENT_CHARS)
      truncated = true;
    return s.slice(0, MAX_ELEMENT_CHARS);
  };
  const cappedElements = selected.map((e) => ({
    ...e,
    label: capField(e.label) ?? "",
    role: capField(e.role),
    value: capField(e.value)
  }));
  const pageText = input.page.text ?? "";
  if (pageText.length > MAX_PAGE_TEXT_CHARS)
    truncated = true;
  const cappedPage = { ...input.page, text: pageText.slice(0, MAX_PAGE_TEXT_CHARS) };
  const operations = /* @__PURE__ */ new Set();
  for (const el of cappedElements)
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
    const eligible = cappedElements.filter((e) => e.operations.map((o) => String(o).toUpperCase()).includes(op2));
    if (eligible.length === 0)
      continue;
    if (eligible.some((e) => e.index === "none")) {
      throw new JevError('chooseBrowserAction: "none" is reserved for the no-target escape; rename the element index', { retryable: false });
    }
    const targetCriteria = {
      none: "Do not target any element for this operation."
    };
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
    page: cappedPage,
    elements: cappedElements,
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
  return { operation: op.choice ?? null, target, confidence: op.confidence, act, truncated };
}
async function pickTool(config, input, options = {}) {
  const minConfidence = options.minConfidence ?? THRESHOLDS.toolPick;
  const riskThreshold = options.riskThreshold ?? THRESHOLDS.toolRisk;
  if (input.tools.length === 0)
    return { tool: null, confidence: 0, risky: 0, confirmRequired: false, act: false };
  if (input.tools.some((t) => t.name === "none")) {
    throw new JevError('pickTool: "none" is reserved for the abstain option; rename the tool', {
      retryable: false
    });
  }
  const criteria = {
    none: "No listed tool is appropriate; answer or ask the user instead."
  };
  for (const t of input.tools)
    criteria[t.name] = t.description;
  const response = await askJev(config, { task: input.task, context: input.context ?? "", tools: input.tools }, {
    tool: {
      type: "choice",
      instructions: "Which single tool best accomplishes the task?",
      criteria
    },
    risky: {
      type: "noul",
      instructions: "Does invoking the chosen tool carry side effects that warrant explicit user confirmation (writes, deletes, network mutations, spending)?"
    }
  }, options.signal);
  const picked = choice(response, "tool");
  const risky = noul(response, "risky");
  const act = !!picked.choice && picked.choice !== "none" && picked.confidence >= minConfidence;
  return {
    tool: picked.choice ?? null,
    confidence: picked.confidence,
    risky,
    confirmRequired: risky >= riskThreshold,
    act
  };
}

// ../core/dist/infra.js
var DEFAULT_REFUSAL_MAX = 200;
function createRefusalLedger(options = {}) {
  const now = options.now ?? Date.now;
  const max = Math.max(1, options.max ?? DEFAULT_REFUSAL_MAX);
  const entries = [];
  const byKey = /* @__PURE__ */ new Map();
  return {
    record(key, reason, at) {
      const when = at ?? now();
      const folded = byKey.get(`${key}\0${reason}`);
      if (folded) {
        folded.count++;
        folded.at = when;
        return;
      }
      const entry = { key, reason, at: when, count: 1 };
      byKey.set(`${key}\0${reason}`, entry);
      entries.push(entry);
      while (entries.length > max) {
        const dropped = entries.shift();
        if (dropped)
          byKey.delete(`${dropped.key}\0${dropped.reason}`);
      }
    },
    entries() {
      return entries.map((e) => Object.freeze({ ...e }));
    }
  };
}
var TOKEN_RE = /[a-z0-9]+/g;
function tokenize(s) {
  return new Set(s.toLowerCase().match(TOKEN_RE) ?? []);
}
function overlap(a, b) {
  if (a.size === 0 || b.size === 0)
    return 0;
  let hit = 0;
  for (const t of a)
    if (b.has(t))
      hit++;
  return hit / Math.sqrt(a.size * b.size);
}
function localRouteSkill(message, skills) {
  const m = tokenize(message);
  let best = null;
  for (const s of skills.slice(0, 50)) {
    const desc = tokenize((s.name + " " + (s.description ?? "")).trim());
    const sc = overlap(m, desc);
    if (!best || sc > best.score)
      best = { name: s.name, score: sc };
  }
  if (!best || best.score < THRESHOLDS.localRouterFloor)
    return { skill: null, score: best?.score ?? 0 };
  return { skill: best.name, score: best.score };
}

// ../core/dist/budget.js
function createBudgetGuard(opts = {}) {
  const maxPerWindow = Math.max(1, opts.maxPerWindow ?? 120);
  const windowMs = Math.max(1, opts.windowMs ?? 6e4);
  const maxTotal = Math.max(1, opts.maxTotal ?? Number.POSITIVE_INFINITY);
  let timestamps = [];
  let totalCalls = 0;
  let rejected = 0;
  function pruneWindow(now) {
    const cutoff = now - windowMs;
    while (timestamps.length > 0 && timestamps[0] < cutoff)
      timestamps.shift();
    return timestamps;
  }
  return {
    wrap(config) {
      const parent = config.fetchImpl ?? fetch;
      const wrapped = async (url, init) => {
        const now = Date.now();
        const window = pruneWindow(now);
        if (window.length >= maxPerWindow) {
          rejected++;
          opts.onLimit?.({ reason: "window", used: window.length, limit: maxPerWindow });
          throw new JevError(`Jev budget exhausted: ${window.length} requests in the last ${windowMs}ms (limit ${maxPerWindow}). Raise maxPerWindow or wait for the window to slide.`, { retryable: false });
        }
        if (totalCalls >= maxTotal) {
          rejected++;
          opts.onLimit?.({ reason: "total", used: totalCalls, limit: maxTotal });
          throw new JevError(`Jev budget exhausted: ${totalCalls} lifetime requests (limit ${maxTotal}). Create a new guard or raise maxTotal.`, { retryable: false });
        }
        window.push(now);
        totalCalls++;
        return parent(url, init);
      };
      return { ...config, fetchImpl: wrapped };
    },
    stats() {
      const window = pruneWindow(Date.now());
      return { windowCalls: window.length, totalCalls, rejected };
    },
    reset() {
      timestamps = [];
      totalCalls = 0;
      rejected = 0;
    }
  };
}

// ../core/dist/decision-log.js
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ../core/dist/cache.js
function stableStringify(value) {
  const walk2 = (v) => {
    if (Array.isArray(v))
      return v.map(walk2);
    if (v && typeof v === "object") {
      const obj = v;
      const out = {};
      for (const k of Object.keys(obj).sort())
        out[k] = walk2(obj[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk2(value));
}
function fnv1a(input) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ../core/dist/decision-log.js
function createDecisionLog(opts = {}) {
  const maxEntries = Math.max(1, opts.maxEntries ?? 1e3);
  const entries = [];
  return {
    record(decision) {
      entries.push(decision);
      if (entries.length > maxEntries)
        entries.shift();
      try {
        opts.sink?.(decision);
      } catch {
      }
    },
    entries() {
      return entries;
    },
    get size() {
      return entries.length;
    },
    compare(other) {
      const rows = other instanceof Array ? other : other.entries();
      const byDigest = /* @__PURE__ */ new Map();
      for (const r of rows) {
        if (!byDigest.has(r.digest))
          byDigest.set(r.digest, r);
      }
      const disagreements = [];
      let matched = 0;
      let agreed = 0;
      for (const mine of entries) {
        const theirs = byDigest.get(mine.digest);
        if (!theirs)
          continue;
        matched++;
        let same = true;
        for (const [id, value] of Object.entries(mine.answers)) {
          const otherValue = theirs.answers[id];
          if (otherValue === void 0 || otherValue !== value) {
            same = false;
            break;
          }
        }
        if (same)
          agreed++;
        else
          disagreements.push({ digest: mine.digest, kind: mine.kind, a: mine, b: theirs });
      }
      return {
        matched,
        agreed,
        flipRate: matched === 0 ? 0 : disagreements.length / matched,
        disagreements
      };
    }
  };
}
function decisionDigest(kind, state, questionIds) {
  let canon;
  try {
    canon = stableStringify(state);
  } catch {
    canon = '{"circular":true}';
  }
  return fnv1a(kind + "\n" + canon + "\n" + [...questionIds].sort().join(","));
}
function jsonlSink(path) {
  return (record) => {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
  };
}

// ../core/dist/persist-cache.js
import { existsSync, mkdirSync as mkdirSync2, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname as dirname2, join } from "node:path";
function createPersistentCache(opts) {
  const ttlMs = Math.max(0, opts.ttlMs ?? 24 * 60 * 60 * 1e3);
  const maxEntries = Math.max(1, opts.maxEntries ?? 512);
  const path = join(opts.dir, opts.file ?? "jev-cache.json");
  let entries = /* @__PURE__ */ new Map();
  let nextSeq = 1;
  let loaded = false;
  const hits = { hits: 0, misses: 0 };
  function load() {
    if (loaded)
      return;
    loaded = true;
    if (!existsSync(path))
      return;
    try {
      const doc = JSON.parse(readFileSync(path, "utf8"));
      if (!doc || doc.version !== 1 || typeof doc.entries !== "object")
        return;
      const now = Date.now();
      const rows = Object.entries(doc.entries);
      rows.sort((a, b) => a[1].seq - b[1].seq);
      for (const [key, entry] of rows) {
        if (typeof entry?.expiresAt === "number" && entry.expiresAt > now && entry.response) {
          entries.set(key, {
            response: entry.response,
            expiresAt: entry.expiresAt,
            seq: entry.seq
          });
          nextSeq = Math.max(nextSeq, entry.seq + 1);
        }
      }
    } catch {
      entries = /* @__PURE__ */ new Map();
    }
  }
  function flush() {
    try {
      mkdirSync2(dirname2(path), { recursive: true });
      const doc = { version: 1, nextSeq, entries: Object.fromEntries(entries) };
      const tmp = path + ".tmp";
      writeFileSync(tmp, JSON.stringify(doc), "utf8");
      renameSync(tmp, path);
    } catch {
    }
  }
  function evictIfNeeded() {
    while (entries.size >= maxEntries) {
      let oldestKey = null;
      let oldestSeq = Number.POSITIVE_INFINITY;
      for (const [key, entry] of entries) {
        if (entry.seq < oldestSeq) {
          oldestSeq = entry.seq;
          oldestKey = key;
        }
      }
      if (oldestKey === null)
        break;
      entries.delete(oldestKey);
    }
  }
  return {
    get(key) {
      load();
      const entry = entries.get(key);
      if (!entry) {
        hits.misses++;
        return void 0;
      }
      if (Date.now() >= entry.expiresAt) {
        entries.delete(key);
        hits.misses++;
        return void 0;
      }
      hits.hits++;
      return entry.response;
    },
    set(key, response) {
      load();
      evictIfNeeded();
      entries.set(key, { response, expiresAt: Date.now() + ttlMs, seq: nextSeq++ });
      flush();
    },
    delete(key) {
      load();
      entries.delete(key);
      flush();
    },
    clear() {
      load();
      entries = /* @__PURE__ */ new Map();
      nextSeq = 1;
      flush();
    },
    get size() {
      load();
      return entries.size;
    },
    stats() {
      const total = hits.hits + hits.misses;
      return { ...hits, hitRate: total === 0 ? 0 : hits.hits / total };
    },
    flush
  };
}
function withPersistentCache(config, cache) {
  const parent = config.fetchImpl ?? fetch;
  const wrapped = async (url, init) => {
    const target = String(url);
    if (!target.endsWith("/v1/systemone") || init?.method?.toUpperCase() !== "POST") {
      return parent(url, init);
    }
    if (init?.body !== void 0 && typeof init.body !== "string") {
      return parent(url, init);
    }
    const key = target + "\n" + String(init.body ?? "");
    try {
      const hit = cache.get(key);
      if (hit) {
        return new Response(JSON.stringify(hit), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    } catch {
      return parent(url, init);
    }
    const res = await parent(url, init);
    if (res.ok) {
      try {
        cache.set(key, await res.clone().json());
      } catch {
      }
    }
    return res;
  };
  return { ...config, fetchImpl: wrapped };
}

// ../core/dist/taxonomy.js
var DEFAULT_RATE_LIMIT_BACKOFF_MS = 3e4;
var MAX_RATE_LIMIT_BACKOFF_MS = 3e5;
var freeze = (p) => Object.freeze(p);
var POLICIES = Object.freeze({
  /** The key is missing, rejected, or lacks access: every later call fails too. */
  auth: freeze({
    kind: "auth",
    retryable: false,
    backoffMs: 0,
    disableSession: true,
    silent: false
  }),
  /** The model name is withdrawn or unavailable to this key: retrying re-fails. */
  model: freeze({
    kind: "model",
    retryable: false,
    backoffMs: 0,
    disableSession: true,
    silent: false
  }),
  /** Throttled. Retryable, but only after the advertised window. */
  rate_limit: freeze({
    kind: "rate_limit",
    retryable: true,
    backoffMs: DEFAULT_RATE_LIMIT_BACKOFF_MS,
    disableSession: false,
    silent: false
  }),
  /** DNS/TLS/socket/abort failures. Retryable and deliberately quiet. */
  network: freeze({
    kind: "network",
    retryable: true,
    backoffMs: 1e3,
    disableSession: false,
    silent: true
  }),
  /** Upstream 5xx. Retryable, worth logging. */
  server: freeze({
    kind: "server",
    retryable: true,
    backoffMs: 2e3,
    disableSession: false,
    silent: false
  }),
  /** Anything unrecognised: do not retry, do not disable, do not hide it. */
  unknown: freeze({
    kind: "unknown",
    retryable: false,
    backoffMs: 0,
    disableSession: false,
    silent: false
  })
});
var MODEL_MENTION_RE = /\bmodel\b/i;
var MODEL_MESSAGE_RE = /unknown model|no such model|invalid model|unsupported model|model[^.]{0,40}(?:not found|not supported|unavailable|does not exist)/i;
var NETWORK_MESSAGE_RE = /fetch failed|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ETIMEDOUT|EPIPE|socket hang up|network|timed? ?out|abort/i;
function readMessage(error) {
  if (error instanceof Error)
    return error.message;
  if (typeof error === "string")
    return error;
  if (error && typeof error === "object") {
    const m = error.message;
    if (typeof m === "string")
      return m;
  }
  return "";
}
function readName(error) {
  if (error instanceof Error)
    return error.name;
  if (error && typeof error === "object") {
    const n = error.name;
    if (typeof n === "string")
      return n;
  }
  return "";
}
function readStatus(error) {
  if (error instanceof JevError)
    return error.status;
  if (!error || typeof error !== "object")
    return void 0;
  const direct = error.status;
  if (typeof direct === "number")
    return direct;
  const nested = error.response?.status;
  return typeof nested === "number" ? nested : void 0;
}
function readHeader(error, name) {
  if (!error || typeof error !== "object")
    return void 0;
  const nested = error.headers;
  const container = nested ?? error;
  if (!container || typeof container !== "object")
    return void 0;
  const get = container.get;
  if (typeof get === "function") {
    const value = container.get(name);
    return value === null || value === void 0 ? void 0 : String(value);
  }
  if (container instanceof Map) {
    const found = container.get(name);
    return found === void 0 || found === null ? void 0 : String(found);
  }
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(container)) {
    if (k.toLowerCase() === wanted && v !== void 0 && v !== null)
      return String(v);
  }
  return void 0;
}
var clampBackoff = (ms) => Math.min(Math.max(0, ms), MAX_RATE_LIMIT_BACKOFF_MS);
function retryAfterMs(error) {
  const raw = readHeader(error, "retry-after");
  if (raw === void 0)
    return void 0;
  const trimmed = raw.trim();
  if (trimmed.length === 0)
    return void 0;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? clampBackoff(seconds * 1e3) : void 0;
  }
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? void 0 : clampBackoff(at - Date.now());
}
function classifyJevFailure(error) {
  const status = readStatus(error);
  const message = readMessage(error);
  if (status !== void 0) {
    if (status === 401 || status === 403)
      return "auth";
    if (status === 404 && MODEL_MENTION_RE.test(message))
      return "model";
    if (status === 429)
      return "rate_limit";
    if (status >= 500)
      return "server";
    return "unknown";
  }
  if (MODEL_MESSAGE_RE.test(message))
    return "model";
  if (error instanceof TypeError || readName(error) === "AbortError")
    return "network";
  if (NETWORK_MESSAGE_RE.test(message))
    return "network";
  return "unknown";
}
function policyForFailure(kind, error) {
  const base = POLICIES[kind] ?? POLICIES.unknown;
  if (error instanceof JevError && error.retryable === false && base.retryable) {
    return freeze({ ...base, retryable: false, backoffMs: 0 });
  }
  if (base.kind === "rate_limit" && base.retryable) {
    const honoured = retryAfterMs(error);
    if (honoured !== void 0 && honoured !== base.backoffMs) {
      return freeze({ ...base, backoffMs: honoured });
    }
  }
  return base;
}

// ../core/dist/patterns-prune.js
var DEFAULT_HEAD_CHARS = 300;
var DEFAULT_MIN_CHARS = 2e3;
var DEFAULT_MAX_ITEMS_PER_REQUEST = 64;
var DEFAULT_MAX_STATE_TOKENS = 25e3;
var CHARS_PER_TOKEN = 4;
var UNJUDGED_KEEP_SCORE = 1;
function needQuestion(kind) {
  const base = "Judge only by this item in the state: does the conversation still need this item's full CONTENTS to continue, or can the turn proceed with a bounded preview (its id plus a short head)? Answer high (toward 1) only if the full contents are still required to continue; answer low (toward 0) if a bounded preview suffices.";
  if (kind === "error" || kind === "diagnostic") {
    return base + " This is error/diagnostic output: dropping live error output is how bugs hide, so hold it to a stricter standard \u2014 score low ONLY if this output is fully superseded, already acted upon, or redundant.";
  }
  return base;
}
function readNeed(response, id) {
  const answer = response.answers[id];
  if (!answer || answer.type !== "noul")
    return null;
  const n = answer.noul;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1)
    return null;
  return n;
}
function shouldDrop(score, kind, keepThreshold, dropThreshold, errorDropThreshold) {
  const errorLike = kind === "error" || kind === "diagnostic";
  const bar = errorLike ? errorDropThreshold : dropThreshold;
  return score < keepThreshold && score <= bar;
}
function unjudgedKeep(item) {
  return { id: item.id, keep: true, score: UNJUDGED_KEEP_SCORE, chars: item.text.length };
}
async function pruneContext(config, items, options) {
  const keepThreshold = options?.keepThreshold ?? THRESHOLDS.pruneKeep;
  const dropThreshold = options?.dropThreshold ?? THRESHOLDS.pruneDrop;
  const errorDropThreshold = options?.errorDropThreshold ?? THRESHOLDS.pruneErrorDrop;
  const headChars = options?.headChars ?? DEFAULT_HEAD_CHARS;
  const minChars = options?.minChars ?? DEFAULT_MIN_CHARS;
  const protect = options?.protect;
  const maxItemsPerRequest = Math.max(1, options?.maxItemsPerRequest ?? DEFAULT_MAX_ITEMS_PER_REQUEST);
  const maxStateTokens = options?.maxStateTokens ?? DEFAULT_MAX_STATE_TOKENS;
  if (JSON.stringify(items).length / CHARS_PER_TOKEN > maxStateTokens) {
    return { decisions: items.map(unjudgedKeep), deferred: true, reason: "state-too-large" };
  }
  const decisions = new Array(items.length);
  const judged = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (protect?.(item) || item.text.length < minChars) {
      decisions[index] = unjudgedKeep(item);
    } else {
      judged.push({ index, item });
    }
  }
  for (let offset = 0; offset < judged.length; offset += maxItemsPerRequest) {
    const batch = judged.slice(offset, offset + maxItemsPerRequest);
    const questions = {};
    for (const { item } of batch) {
      questions[item.id] = { type: "noul", instructions: needQuestion(item.kind) };
    }
    const response = await askJev(config, { items: batch.map(({ item }) => item) }, questions, options?.signal);
    for (const { index, item } of batch) {
      const score = readNeed(response, item.id);
      if (score === null) {
        decisions[index] = unjudgedKeep(item);
        continue;
      }
      if (shouldDrop(score, item.kind, keepThreshold, dropThreshold, errorDropThreshold)) {
        const omittedChars = Math.max(0, item.text.length - headChars);
        decisions[index] = {
          id: item.id,
          keep: false,
          score,
          chars: item.text.length,
          replacement: item.text.slice(0, headChars) + `
[... ${omittedChars} chars omitted by jev prune; id=${item.id} \u2014 original retained by caller]`,
          omittedChars
        };
      } else {
        decisions[index] = { id: item.id, keep: true, score, chars: item.text.length };
      }
    }
  }
  return { decisions, deferred: false };
}

// ../kit/dist/config.js
var MAX_TIMEOUT_MS = 2147483647;
function parseTimeoutMs(raw) {
  if (raw === void 0 || raw.trim() === "")
    return void 0;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0)
    return void 0;
  return Math.min(Math.floor(n), MAX_TIMEOUT_MS);
}
function resolveEnvConfig(opts = {}) {
  const env = opts.env ?? process.env;
  const overrides = opts.overrides ?? {};
  const apiKey = (overrides.apiKey ?? env.TYPESAFE_API_KEY ?? "").trim();
  if (opts.requireKey && !apiKey) {
    throw new Error("TYPESAFE_API_KEY is not set. Export it in your shell or add it to your harness env file.");
  }
  const config = {
    apiKey,
    baseUrl: ((overrides.baseUrl ?? env.TYPESAFE_BASE_URL ?? "").trim() || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: (overrides.model ?? opts.modelOverride ?? "").trim() || (env.TYPESAFE_DEFAULT_MODEL ?? "").trim() || DEFAULT_MODEL,
    // Adapters built on the kit send tool input and history as state; redaction
    // is on unless JEV_REDACT=0 or the caller passes its own decision.
    redact: opts.redact ?? overrides.redact ?? (env.JEV_REDACT ?? "").trim() !== "0"
  };
  const timeoutMs = overrides.timeoutMs ?? parseTimeoutMs(env.JEV_TIMEOUT_MS);
  if (timeoutMs !== void 0)
    config.timeoutMs = timeoutMs;
  return config;
}

// ../kit/dist/router.js
function lexicalShortlist(text, roster, opts = {}) {
  const limit = Math.max(1, opts.limit ?? 12);
  const lower = text.toLowerCase();
  const scored = roster.filter((s) => s.name !== "").map((s) => {
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
  return (lexical.length > 0 ? lexical : roster.map((s) => s.name).filter((n) => n !== "")).slice(0, limit);
}

// dist/config.js
var DEFAULT_TIMEOUT_MS2 = 15e3;
var GATE_THRESHOLD = THRESHOLDS.destructiveGate;
var SKILL_MIN_CONFIDENCE = THRESHOLDS.skillRouting;
var GATE_DEADLINE_MS = 8e3;
function withDeadline(host, ms) {
  const timer = AbortSignal.timeout(ms);
  if (!host)
    return timer;
  if (typeof AbortSignal.any === "function")
    return AbortSignal.any([host, timer]);
  const ctl = new AbortController();
  const abort = () => ctl.abort();
  if (host.aborted)
    abort();
  else
    host.addEventListener("abort", abort, { once: true });
  timer.addEventListener("abort", abort, { once: true });
  return ctl.signal;
}
function readConfig(env, modelOverride, redact) {
  const cfg = resolveEnvConfig({
    env,
    modelOverride,
    requireKey: true,
    // parseTimeoutMs also caps at MAX_TIMEOUT_MS, which the previous inline
    // Number() did not: a huge value would overflow setTimeout into ~1ms.
    overrides: { timeoutMs: parseTimeoutMs(env.JEV_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS2 }
  });
  if (redact === void 0)
    delete cfg.redact;
  else
    cfg.redact = redact;
  return cfg;
}
function redactOn(env, context) {
  const raw = (env.OMP_JEV_REDACT ?? "").trim();
  if (raw === "0")
    return false;
  if (raw === "1")
    return true;
  return context === "hook";
}
function autoOn(env, name) {
  return (env.OMP_JEV_AUTO ?? "").trim() === "1" && (env[name] ?? "1").trim() !== "0";
}
function envNum(env, name, fallback) {
  const raw = (env[name] ?? "").trim();
  if (!raw)
    return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// dist/compact.js
var COMPACT_DEFAULTS = {
  keepThreshold: 0.2,
  maxStateTokens: 25e3,
  maxRequestTokens: 3e4,
  truncateHeadChars: 300,
  minReductionRatio: 0.25
};
function contentText(content) {
  if (typeof content === "string")
    return content;
  if (Array.isArray(content)) {
    return content.map((x) => typeof x === "string" ? x : typeof x?.text === "string" ? x.text : "").filter((s) => s !== "").join("\n");
  }
  if (content == null)
    return "";
  return JSON.stringify(content);
}
function flatten(messages) {
  const out = [];
  for (const raw of messages) {
    const m = raw ?? {};
    const role = String(m.role ?? "unknown");
    const blocks = Array.isArray(m.content) ? m.content : [];
    const texts = [];
    if (typeof m.content === "string" && m.content !== "")
      texts.push(m.content);
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
      else if (b.type === "tool_use" || b.type === "tool_call" || b.type === "toolCall") {
        toolUses.push({
          id: String(b.id ?? b.toolCallId ?? ""),
          tool: String(b.name ?? b.toolName ?? "tool"),
          input: b.input ?? b.arguments ?? b.args ?? {}
        });
      } else if (b.type === "tool_result" || b.type === "toolResult") {
        toolResults.push({
          id: String(b.tool_use_id ?? b.toolUseId ?? b.toolCallId ?? ""),
          text: contentText(b.content)
        });
      }
    }
    if (role === "toolResult") {
      const id = String(m.toolCallId ?? "");
      if (id !== "") {
        toolResults.push({
          id,
          text: blocks.length > 0 ? contentText(m.content) : texts.join("\n")
        });
        texts.length = 0;
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
        byId.set(u.id, {
          id: u.id,
          tool: u.tool,
          input: u.input,
          resultChars: 0,
          resultText: null
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
function buildCompactState(msgs) {
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
async function planCompaction(prep) {
  const region = [...prep.region];
  if (region.length === 0)
    return { kind: "defer", reason: "no-messages" };
  const flat = flatten(region);
  const calls = collectCalls(flat);
  if (calls.length === 0)
    return { kind: "defer", reason: "no-calls" };
  const state = buildCompactState(flat);
  const stateTokens = estimateTokens(JSON.stringify(state));
  if (stateTokens > prep.effective.maxStateTokens) {
    return {
      kind: "defer",
      reason: "state-too-large",
      detail: { stateTokens, maxStateTokens: prep.effective.maxStateTokens }
    };
  }
  const batches = batchCompactCalls(calls, stateTokens, prep.effective.maxRequestTokens);
  const answers = /* @__PURE__ */ new Map();
  for (const batch of batches) {
    const partial = await prep.ask(state, reduceCallQuestions(batch));
    for (const [id, p] of Object.entries(partial))
      answers.set(id, p);
  }
  const keepProb = (id) => answers.get(id) ?? 1;
  const decisions = calls.map((c) => {
    const keepCall = keepProb("call_" + c.id);
    const keepResult = keepProb("result_" + c.id);
    const action = keepResult >= prep.effective.keepThreshold ? "keep" : "drop_result";
    return { call: c, action, keepCall, keepResult };
  });
  const dropped = decisions.filter((d) => d.action === "drop_result" && d.call.resultChars > prep.effective.truncateHeadChars);
  const savedChars = dropped.reduce((n, d) => n + (d.call.resultChars - prep.effective.truncateHeadChars), 0);
  const totalChars = calls.reduce((n, c) => n + c.resultChars, 0);
  if (totalChars === 0 || savedChars / totalChars < prep.effective.minReductionRatio) {
    return { kind: "defer", reason: "insufficient-reduction", detail: { savedChars, totalChars } };
  }
  const truncById = new Map(dropped.map((d) => [d.call.id, d.call]));
  const renderResult = (id, fallback) => {
    const t = truncById.get(id);
    if (!t)
      return "[tool_result id=" + id + "] " + fallback;
    const head = prep.effective.truncateHeadChars;
    const body = t.resultText ?? fallback;
    const omitted = Math.max(0, body.length - head);
    return "[tool_result id=" + id + "] " + body.slice(0, head) + (omitted > 0 ? "\n[..." + omitted + " chars omitted by jev_compact; re-run the tool to recover]" : "");
  };
  const carried = /* @__PURE__ */ new Set();
  for (const m of flat)
    for (const r of m.toolResults)
      carried.add(r.id);
  const render = (msgs) => msgs.map((m) => {
    const parts = [];
    for (const r of m.toolResults)
      parts.push(renderResult(r.id, r.text));
    for (const u of m.toolUses) {
      parts.push("[tool_use id=" + u.id + " name=" + u.tool + " input=" + JSON.stringify(u.input) + "]");
      if (!carried.has(u.id) && truncById.has(u.id))
        parts.push(renderResult(u.id, ""));
    }
    if (m.text)
      parts.unshift(m.text);
    return parts.filter(Boolean).join("\n");
  }).filter(Boolean).join("\n\n");
  const summary = "Verbatim history retained; " + dropped.length + " tool output(s) truncated by Jev decisions.\n\n" + render(flat);
  return { kind: "compacted", plan: { decisions, dropped, savedChars, totalChars, summary } };
}
function jevAsker(cfg) {
  return async (state, questions) => {
    const response = await askJev(cfg, state, questions);
    const out = {};
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

// dist/failure.js
import { appendFileSync as appendFileSync2, mkdirSync as mkdirSync3 } from "node:fs";
import { dirname as dirname3 } from "node:path";
function createTracedLedger(path, max = 200) {
  const ledger = createRefusalLedger({ max });
  const sink = (path ?? "").trim();
  const seen = /* @__PURE__ */ new Set();
  return {
    record(key, reason, at) {
      ledger.record(key, reason, at);
      if (sink === "")
        return;
      const id = key + "\0" + reason;
      if (seen.has(id))
        return;
      seen.add(id);
      try {
        mkdirSync3(dirname3(sink), { recursive: true });
        appendFileSync2(sink, JSON.stringify({
          ts: new Date(at ?? Date.now()).toISOString(),
          kind: "omp_refusal",
          key,
          reason
        }) + "\n", "utf8");
      } catch {
      }
    },
    entries() {
      return ledger.entries();
    }
  };
}
function decideOnFailure(error, where) {
  const kind = classifyJevFailure(error);
  const policy = policyForFailure(kind, error);
  return {
    kind,
    disableSession: policy.disableSession,
    silent: policy.silent,
    backoffMs: policy.retryable ? policy.backoffMs : 0,
    message: "jev " + where + ": " + kind + " failure" + (policy.disableSession ? " \u2014 disabling Jev for this session" : "") + ": " + describe(error)
  };
}
function describe(error) {
  if (error instanceof Error)
    return (error.message || error.name).slice(0, 300);
  if (typeof error === "string")
    return error.slice(0, 300);
  try {
    return JSON.stringify(error).slice(0, 300);
  } catch {
    return String(error).slice(0, 300);
  }
}
function reportFailure(logger, decision) {
  try {
    if (decision.silent)
      logger.debug(decision.message);
    else
      logger.warn(decision.message);
  } catch {
  }
  return { disabled: decision.disableSession };
}

// dist/router.js
import { existsSync as existsSync2, readFileSync as readFileSync2, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";
var MAX_CANDIDATES = 12;
var MIN_PROMPT_CHARS = 12;
var ROUTE_DEBOUNCE_MS = 250;
var ROUTE_CACHE_TTL_MS = 10 * 60 * 1e3;
function parseSkillFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match)
    return null;
  const out = {};
  let key = null;
  for (const raw of match[1].split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    const head = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (head) {
      key = head[1].toLowerCase();
      out[key] = head[2].replace(/^[>|][-+]?\s*/, "").trim();
      continue;
    }
    if (key && /^\s+\S/.test(line)) {
      const part = line.trim();
      out[key] = out[key] ? out[key] + " " + part : part;
    }
  }
  const name = (out.name ?? "").trim();
  if (!name)
    return null;
  return { name, description: (out.description ?? "").replace(/\s+/g, " ").trim() };
}
function readSkillDir(root) {
  const out = [];
  try {
    if (!existsSync2(root))
      return out;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory())
        continue;
      try {
        const text = readFileSync2(join2(root, entry.name, "SKILL.md"), "utf8");
        const parsed = parseSkillFrontmatter(text);
        if (parsed)
          out.push({ ...parsed, description: parsed.description.slice(0, 400) });
      } catch {
      }
    }
  } catch {
  }
  return out;
}
function defaultSkillDirs(cwd, home) {
  const resolved = home ?? process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  return [
    join2(cwd, ".omp", "skills"),
    join2(resolved, ".omp", "agent", "skills"),
    join2(resolved, ".agents", "skills")
  ];
}
function loadSkillRoster(dirs) {
  const byName = /* @__PURE__ */ new Map();
  for (const dir of dirs) {
    for (const skill of readSkillDir(dir)) {
      if (!byName.has(skill.name))
        byName.set(skill.name, skill);
    }
  }
  return [...byName.values()];
}
function userAlreadyChose(text, roster) {
  const lower = text.toLowerCase();
  if (/\/skill:[a-z0-9_-]+/i.test(text))
    return true;
  return roster.some((s) => s.name.length > 3 && lower.includes(s.name.toLowerCase()));
}
function createSkillRouter(options) {
  const now = options.now ?? Date.now;
  const debounceMs = options.debounceMs ?? ROUTE_DEBOUNCE_MS;
  const ttl = options.cacheTtlMs ?? ROUTE_CACHE_TTL_MS;
  const cache = /* @__PURE__ */ new Map();
  const counters = { cached: 0, superseded: 0, judged: 0 };
  let seq = 0;
  let inFlight = null;
  const key = (text) => text.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 2e3);
  let lastArrival = null;
  return {
    async route(text, roster) {
      const cacheKey = key(text);
      const hit = cache.get(cacheKey);
      if (hit && now() - hit.at < ttl) {
        counters.cached++;
        return hit.answer;
      }
      if (hit)
        cache.delete(cacheKey);
      const mine = ++seq;
      const arrivedAt = now();
      const inBurst = debounceMs > 0 && lastArrival !== null && arrivedAt - lastArrival < debounceMs;
      lastArrival = arrivedAt;
      if (inBurst) {
        await new Promise((r) => setTimeout(r, debounceMs));
        if (mine !== seq) {
          counters.superseded++;
          return null;
        }
      }
      while (inFlight) {
        await inFlight.catch(() => void 0);
        if (mine !== seq) {
          counters.superseded++;
          return null;
        }
      }
      const candidates = shortlist(text, roster);
      if (candidates.length === 0)
        return null;
      const mineStill = () => mine === seq;
      const pending = options.judge(text, candidates);
      inFlight = pending;
      let answer;
      try {
        answer = await pending;
      } finally {
        if (inFlight === pending)
          inFlight = null;
      }
      counters.judged++;
      if (!mineStill()) {
        counters.superseded++;
        return null;
      }
      cache.set(cacheKey, { answer, at: now() });
      return answer;
    },
    stats: () => ({ ...counters })
  };
}
function shortlist(text, roster) {
  const picked = lexicalShortlist(text, [...roster], { limit: MAX_CANDIDATES });
  const byName = new Map(roster.map((s) => [s.name, s]));
  const out = [];
  for (const entry of picked) {
    const name = typeof entry === "string" ? entry : entry.name;
    const found = byName.get(name);
    if (found)
      out.push(found);
  }
  if (out.length > 0)
    return out;
  return roster.slice(0, MAX_CANDIDATES);
}
var LOCAL_ROUTE_MIN_SCORE = 0.2;
function localRoute(text, roster) {
  const best = localRouteSkill(text, [...roster]);
  if (best.skill === null || best.score < LOCAL_ROUTE_MIN_SCORE)
    return null;
  return { skill: best.skill, score: best.score };
}
function localRouteHint(route) {
  return "[jev] Consider loading skill: " + route.skill + " (" + Math.round(route.score * 100) + "% local keyword match; Jev was unreachable)";
}
function skillHint(answer) {
  if (!answer.skill)
    return null;
  return "[jev] Consider loading skill: " + answer.skill + " (" + Math.round(answer.confidence * 100) + "% from the installed roster)";
}

// dist/prune.js
var PRUNE_MARKER = "omitted by jev prune";
var PRUNE_HARD_CAP_CHARS = 2e5;
var PRUNE_MIN_CHARS = 2e3;
var LOCAL_CAP_HEAD_CHARS = 15e4;
var LOCAL_CAP_TAIL_CHARS = 4e4;
var isText = (block) => block.type === "text";
function replacement(text, original) {
  return [{ type: "text", text }, ...original.filter((block) => block.type !== "text")];
}
function localCap(text, id) {
  const omitted = text.length - LOCAL_CAP_HEAD_CHARS - LOCAL_CAP_TAIL_CHARS;
  return text.slice(0, LOCAL_CAP_HEAD_CHARS) + `
[locally capped: ${omitted} of ${text.length} chars ${PRUNE_MARKER} (oversize; no Jev call); id=${id} \u2014 original retained by host]` + text.slice(text.length - LOCAL_CAP_TAIL_CHARS);
}
async function pruneToolResult(event, ctx, deps) {
  const kind = event?.isError ? "error" : "output";
  try {
    if ((deps.env.OMP_JEV_PRUNE ?? "").trim() !== "1")
      return;
    const text = (event.content ?? []).filter(isText).map((block) => block.text).join("\n");
    if (text.includes(PRUNE_MARKER))
      return;
    if (text.length > PRUNE_HARD_CAP_CHARS) {
      return {
        content: replacement(localCap(text, String(event.toolCallId)), event.content)
      };
    }
    if (text.length < PRUNE_MIN_CHARS)
      return;
    const outcome = await pruneContext(deps.config(), [{ id: String(event.toolCallId), text, kind }], {
      minChars: PRUNE_MIN_CHARS,
      signal: withDeadline(ctx?.signal, GATE_DEADLINE_MS)
    });
    if (outcome.deferred)
      return;
    const decision = outcome.decisions[0];
    if (!decision || decision.keep || !decision.replacement)
      return;
    return { content: replacement(decision.replacement, event.content) };
  } catch (err) {
    deps.refusals.record("prune:" + kind, decideOnFailure(err, "prune").kind);
    return;
  }
}

// dist/extension.js
var ENV = process.env;
var DAY_MS = 24 * 60 * 60 * 1e3;
var maxPerMin = envNum(ENV, "OMP_JEV_MAX_CALLS_PER_MIN", 120);
var guard = maxPerMin > 0 ? createBudgetGuard({ maxPerWindow: maxPerMin, windowMs: 6e4 }) : null;
var persistentCache = createPersistentCache({
  dir: (ENV.OMP_JEV_CACHE_DIR ?? "").trim() || join3(homedir2(), ".omp", "cache", "jev-harness"),
  ttlMs: envNum(ENV, "OMP_JEV_CACHE_TTL_MS", DAY_MS)
});
function jevConfig(modelOverride, redact) {
  let cfg = readConfig(ENV, modelOverride, redact);
  if (guard)
    cfg = guard.wrap(cfg);
  return withPersistentCache(cfg, persistentCache);
}
var gateLog = createDecisionLog((ENV.OMP_JEV_DECISION_LOG ?? "").trim() ? { sink: jsonlSink((ENV.OMP_JEV_DECISION_LOG ?? "").trim()) } : {});
var refusals = createTracedLedger(ENV.OMP_JEV_DECISION_LOG);
var sessionDisabled = false;
var skillRouter = createSkillRouter({
  judge: async (text, candidates) => {
    const cfg = jevConfig(void 0, redactOn(ENV, "hook"));
    const result = await routeSkill(cfg, text, candidates, {
      minConfidence: SKILL_MIN_CONFIDENCE,
      maxCandidates: candidates.length
    });
    return { skill: result.skill, confidence: result.confidence };
  }
});
function jevExtension(pi) {
  const z = pi.zod;
  pi.registerTool({
    name: "jev",
    label: "Jev",
    description: "Ask TypeSafe's Jev (System One) for one narrow, calibrated judgment over a state, then act on the probability in code. Pick mode: 'route_skills' ranks skill names against a task (returns the best name, or null to abstain); 'browse_action' picks the next browser operation from a page snapshot; 'pick_tool' picks one tool for a task and flags whether it needs confirmation. Every mode is ADVISORY \u2014 it returns a decision, it never executes anything, and you must validate the choice before acting (an element index against the live snapshot, a tool name against the real roster). For typed questions you want to ask yourself (noul/choice/score over arbitrary state), use the native judge() prelude inside eval \u2014 it is the same model and needs no tool call.",
    loadMode: "discoverable",
    approval: "read",
    parameters: z.object({
      mode: z.enum(["route_skills", "browse_action", "pick_tool"]).describe("Which judgment to make."),
      task: z.string().optional().describe("route_skills / pick_tool: the task, request, or question to judge."),
      skills: z.array(z.object({ name: z.string(), description: z.string().optional() })).optional().describe("route_skills: candidate skills to rank. Descriptions matter \u2014 without them a browser task routes to a desktop-automation skill."),
      tools: z.array(z.object({
        name: z.string(),
        description: z.string(),
        args: z.record(z.string(), z.string()).optional().describe("Map of arg name -> type/description, for closed-set args.")
      })).optional().describe("pick_tool: candidate tools to choose from."),
      context: z.string().optional().describe("pick_tool: extra context, e.g. a recent error or the file being worked on."),
      goal: z.string().optional().describe("browse_action: what the user wants on the page."),
      elements: z.array(z.object({
        index: z.string().describe("Stable element index from the snapshot, e.g. '3' or '5:2' for a select option."),
        label: z.string().describe("Human-visible label."),
        role: z.string().optional().describe("ARIA role, e.g. combobox / button / link."),
        value: z.string().optional().describe("Current value, if any."),
        operations: z.array(z.string()).describe("Operations this element supports, e.g. ['CLICK','TYPE_TEXT'].")
      })).optional().describe("browse_action: numbered interactive elements from the current snapshot."),
      page: z.object({ url: z.string(), title: z.string().optional(), text: z.string().optional() }).optional().describe("browse_action: current page context."),
      recent_actions: z.array(z.object({
        action: z.string(),
        kind: z.string().optional(),
        page_changed: z.boolean().optional()
      })).optional().describe("browse_action: last few actions taken.")
    }),
    async execute(_id, params, signal) {
      const abort = signal ?? void 0;
      const cfg = jevConfig(void 0, redactOn(ENV, "tool"));
      const text = (value) => JSON.stringify(value, null, 2);
      if (params.mode === "route_skills") {
        const candidates = params.skills ?? [];
        const result2 = await routeSkill(cfg, String(params.task ?? ""), candidates, {
          signal: abort
        });
        const out2 = {
          skill: result2.skill,
          confidence: result2.confidence,
          probabilities: result2.probabilities,
          hint: result2.skill === null ? "No listed skill is relevant." : "Consider loading skill: " + result2.skill
        };
        return { content: [{ type: "text", text: text(out2) }], details: out2 };
      }
      if (params.mode === "browse_action") {
        const result2 = await chooseBrowserAction(cfg, {
          goal: String(params.goal ?? ""),
          page: params.page ?? { url: "" },
          elements: params.elements ?? [],
          recentActions: (params.recent_actions ?? []).map((r) => ({
            action: String(r?.action ?? ""),
            kind: r?.kind,
            pageChanged: r?.page_changed
          }))
        }, { signal: abort });
        return { content: [{ type: "text", text: text(result2) }], details: result2 };
      }
      const result = await pickTool(cfg, { task: String(params.task ?? ""), tools: params.tools ?? [], context: params.context }, { signal: abort });
      const out = {
        tool: result.tool,
        confidence: result.confidence,
        risky_probability: result.risky,
        confirm_required: result.confirmRequired,
        act: result.act
      };
      return { content: [{ type: "text", text: text(out) }], details: out };
    }
  });
  pi.on("tool_call", async (event, ctx) => {
    if (!autoOn(ENV, "OMP_JEV_GATE") || sessionDisabled)
      return;
    try {
      const name = String(event?.toolName ?? "");
      if (!/^(bash|write|edit|delete|move|rm|mcp__)/i.test(name))
        return;
      const cfg = jevConfig(void 0, redactOn(ENV, "hook"));
      const startedAt = Date.now();
      const verdict = await judgeDestructiveDual(cfg, { tool: name, input: event?.input ?? {}, cwd: process.cwd() }, { threshold: GATE_THRESHOLD, signal: withDeadline(ctx?.signal, GATE_DEADLINE_MS) });
      gateLog.record({
        ts: (/* @__PURE__ */ new Date()).toISOString(),
        kind: "omp_gate",
        model: cfg.model ?? "unknown",
        digest: decisionDigest("omp_gate", { tool: name, input: event?.input ?? {} }, [
          "destructive",
          "category"
        ]),
        answers: { destructive: verdict.destructive, category: verdict.category },
        threshold: GATE_THRESHOLD,
        action: verdict.decision,
        latencyMs: Date.now() - startedAt
      });
      if (verdict.decision === "allow")
        return;
      refusals.record("gate:" + name, verdict.decision + ":" + verdict.category);
      if (verdict.decision === "block") {
        return {
          block: true,
          reason: "jev gate: destructive (" + verdict.destructive.toFixed(2) + ", category=" + verdict.category + "). The tool alone cannot undo this. If the user has explicitly asked for it, re-issue the same call with that confirmation stated in the task; otherwise use a safer equivalent (delete the specific path, not a glob) or ask the user first."
        };
      }
      return {
        block: true,
        reason: "jev gate: possibly destructive but UNPROVEN (" + verdict.destructive.toFixed(2) + ", category=" + verdict.category + ", confidence=" + verdict.confidence.toFixed(2) + "). Ask the user to confirm this exact call; if they confirm, state that confirmation and re-issue it unchanged."
      };
    } catch (err) {
      const decision = decideOnFailure(err, "gate");
      const { disabled } = reportFailure(pi.logger, decision);
      if (disabled)
        sessionDisabled = true;
      refusals.record("gate:error", decision.kind);
      return;
    }
  });
  let pendingHint = null;
  pi.on("input", async (event, ctx) => {
    if (!autoOn(ENV, "OMP_JEV_SKILL_ROUTER") || sessionDisabled)
      return;
    let text = "";
    let roster = [];
    try {
      text = String(event?.text ?? event?.prompt ?? "");
      if (text.length < MIN_PROMPT_CHARS)
        return;
      roster = loadSkillRoster(defaultSkillDirs(ctx?.cwd ?? process.cwd()));
      if (roster.length === 0) {
        refusals.record("router:roster", "empty-roster");
        return;
      }
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
      if (hint !== null)
        pendingHint = hint;
    } catch (err) {
      const decision = decideOnFailure(err, "skill router");
      const { disabled } = reportFailure(pi.logger, decision);
      if (disabled)
        sessionDisabled = true;
      refusals.record("router:error", decision.kind);
      const fallback = localRoute(text, roster);
      refusals.record("router:local-fallback", fallback === null ? decision.kind + ":no-match" : decision.kind + ":" + fallback.skill);
      if (fallback !== null) {
        pi.logger.debug("jev_router: local fallback", {
          skill: fallback.skill,
          score: fallback.score,
          failure: decision.kind
        });
        pendingHint = localRouteHint(fallback);
      }
    }
  });
  pi.on("before_agent_start", async () => {
    if (pendingHint === null)
      return;
    const hint = pendingHint;
    pendingHint = null;
    return {
      message: {
        customType: "jev-skill-hint",
        content: hint,
        display: false,
        attribution: "agent"
      }
    };
  });
  pi.on("session_before_compact", async (event) => {
    if (!autoOn(ENV, "OMP_JEV_CONTEXT"))
      return;
    try {
      const prep = event?.preparation;
      if (!prep || !Array.isArray(prep.messagesToSummarize))
        return;
      const effective = {
        keepThreshold: envNum(ENV, "OMP_JEV_KEEP_THRESHOLD", COMPACT_DEFAULTS.keepThreshold),
        maxStateTokens: envNum(ENV, "OMP_JEV_MAX_STATE_TOKENS", COMPACT_DEFAULTS.maxStateTokens),
        maxRequestTokens: envNum(ENV, "OMP_JEV_MAX_REQUEST_TOKENS", COMPACT_DEFAULTS.maxRequestTokens),
        truncateHeadChars: envNum(ENV, "OMP_JEV_TRUNCATE_HEAD", COMPACT_DEFAULTS.truncateHeadChars),
        minReductionRatio: envNum(ENV, "OMP_JEV_MIN_REDUCTION", COMPACT_DEFAULTS.minReductionRatio)
      };
      const cfg = jevConfig(void 0, redactOn(ENV, "hook"));
      const outcome = await planCompaction({
        region: [...prep.messagesToSummarize ?? [], ...prep.turnPrefixMessages ?? []],
        ask: jevAsker(cfg),
        effective
      });
      if (outcome.kind === "defer") {
        pi.logger.debug("jev_compact: deferring to native compaction", {
          reason: outcome.reason,
          ...outcome.detail ?? {}
        });
        return;
      }
      const { plan } = outcome;
      pi.logger.debug("jev_compact: reduced", {
        calls: plan.decisions.length,
        dropped: plan.dropped.length,
        savedChars: plan.savedChars
      });
      return {
        compaction: {
          summary: plan.summary,
          shortSummary: "Jev verbatim compaction: " + plan.dropped.length + "/" + plan.decisions.length + " tool outputs truncated",
          firstKeptEntryId: prep.firstKeptEntryId,
          tokensBefore: prep.tokensBefore,
          details: {
            jev: {
              calls: plan.decisions.length,
              dropped: plan.dropped.length,
              savedChars: plan.savedChars,
              keepThreshold: effective.keepThreshold
            }
          }
        }
      };
    } catch (err) {
      const decision = decideOnFailure(err, "compact");
      const { disabled } = reportFailure(pi.logger, decision);
      if (disabled)
        sessionDisabled = true;
      refusals.record("compact:error", decision.kind);
      return;
    }
  });
  pi.on("tool_result", async (event, ctx) => pruneToolResult(event, ctx, {
    env: ENV,
    // The shared ledger — injected, never duplicated (a second ledger would
    // split the refusal trail this file's comment documents).
    refusals,
    config: () => jevConfig(void 0, redactOn(ENV, "hook"))
  }));
}
export {
  jevExtension as default,
  refusals
};
