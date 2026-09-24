#!/usr/bin/env node
// Bundled by @jev-harness/github — @jev-harness/core is inlined. Do not edit.

// src/action.ts
import { execFileSync, execSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
function score(response, id) {
  const a = response.answers[id];
  if (!a || a.type !== "score")
    throw new JevError(`answer "${id}" is not a valid score`, { retryable: false });
  const s = a;
  return { score: s.score, confidence: s.confidence ?? 0, legend: s.legend };
}

// ../core/dist/patterns.js
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
  const shortlist = skills.slice(0, options.maxCandidates ?? 12);
  if (shortlist.length === 0)
    return { skill: null, confidence: 0, probabilities: {} };
  if (shortlist.some((s) => s.name === "none")) {
    throw new JevError('routeSkill: "none" is reserved for the abstain option; rename the skill candidate', { retryable: false });
  }
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
  const threshold = options.threshold ?? THRESHOLDS.destructiveGate;
  const response = await askJev(config, {
    tool: call.tool,
    input: JSON.stringify(call.input ?? {}).slice(0, 4e3),
    cwd: call.cwd
  }, {
    destructive: {
      type: "noul",
      instructions: "Running this exact tool call would destroy or irreversibly change data, history, or system state. That includes: recursive or bulk deletion; overwriting or truncating existing files without backup; git history rewrite, force-push, or discarding uncommitted work; dropping tables or deleting namespaces/volumes; formatting, wiping, or overwriting a disk or device; changing permissions or ownership across a broad path; exhausting, killing, or shutting down the machine (fork bombs, mass process kill, shutdown/reboot); publishing a package or spending money; or sending secrets to an external endpoint. Reading, searching, listing, creating a brand-new file, building, running tests, or editing a file in place with a normal edit tool is NOT destructive."
    }
  }, options.signal);
  const p = noul(response, "destructive");
  return { destructive: p, blocked: p >= threshold };
}

// ../core/dist/patterns-extra.js
async function triageUrgency(config, input, options = {}) {
  const levels = ["Low", "Medium", "High", "Critical"];
  const response = await askJev(config, {
    title: input.title.slice(0, 500),
    body: (input.body ?? "").slice(0, 4e3),
    context: (input.context ?? "").slice(0, 2e3)
  }, {
    urgency: {
      type: "score",
      instructions: "How urgent is this item? Critical = active outage, data loss, or security breach. High = broken core flow or many users blocked. Medium = workaround exists or narrow impact. Low = cosmetic or backlog.",
      criteria: levels
    }
  }, options.signal);
  const r = score(response, "urgency");
  const idx = Math.max(0, Math.min(levels.length - 1, Math.round(r.score)));
  return { urgency: r.score, level: levels[idx], confidence: r.confidence };
}

// src/review.ts
var DEFAULT_REVIEWERS = [
  { name: "auto", description: "No human review needed; trivial or well-tested change." },
  { name: "peer", description: "Normal code review by a teammate." },
  {
    name: "security",
    description: "Security review: touches auth, crypto, secrets, or untrusted input."
  },
  {
    name: "perf",
    description: "Performance review: hot path, allocation, or scaling-sensitive change."
  }
];
async function runReview(config, input, signal) {
  const reviewers = input.reviewers && input.reviewers.length > 0 ? input.reviewers : DEFAULT_REVIEWERS;
  const message = (input.title + "\n\n" + input.body).slice(0, 3e3);
  const [destructive, urgency, reviewer] = await Promise.allSettled([
    judgeDestructive(
      config,
      { tool: "git-diff", input: { diff: input.diff }, cwd: input.cwd },
      {
        threshold: input.destructiveThreshold,
        signal
      }
    ),
    triageUrgency(config, { title: input.title, body: input.body }, { signal }),
    routeSkill(config, message, reviewers, { minConfidence: 0.4, signal })
  ]);
  const decisions = {
    destructive: destructive.status === "fulfilled" ? { probability: destructive.value.destructive, blocked: destructive.value.blocked } : null,
    urgency: urgency.status === "fulfilled" ? { level: urgency.value.level, score: urgency.value.urgency } : null,
    reviewer: reviewer.status === "fulfilled" ? { reviewer: reviewer.value.skill, confidence: reviewer.value.confidence } : null
  };
  const failures = [destructive, urgency, reviewer].filter((r) => r.status === "rejected");
  const degraded = failures.length > 0;
  const error = failures.length > 0 ? failures.map(
    (r, i) => "decision " + i + ": " + (r.reason instanceof Error ? r.reason.message : String(r.reason))
  ).join("; ") : void 0;
  return {
    decisions,
    comment: buildReviewComment({ decisions, title: input.title, degraded, error }),
    degraded,
    error
  };
}
function buildReviewComment(input) {
  const { decisions, title, degraded, error } = input;
  const lines = [
    "## Jev review" + (degraded ? " (degraded)" : ""),
    "",
    "> Advisory only. Jev emits calibrated probabilities; thresholds and side effects stay in your workflow.",
    "",
    "| decision | result |",
    "| --- | --- |"
  ];
  if (decisions.destructive) {
    const flag = decisions.destructive.blocked ? "BLOCKED" : "ok";
    lines.push(`| destructive | ${flag} (p=${decisions.destructive.probability.toFixed(2)}) |`);
  } else {
    lines.push("| destructive | _unavailable_ |");
  }
  if (decisions.urgency) {
    lines.push(`| urgency | ${decisions.urgency.level} (${decisions.urgency.score.toFixed(2)}) |`);
  } else {
    lines.push("| urgency | _unavailable_ |");
  }
  if (decisions.reviewer) {
    const who = decisions.reviewer.reviewer ?? "none (low confidence)";
    lines.push(`| reviewer | ${who} (conf=${decisions.reviewer.confidence.toFixed(2)}) |`);
  } else {
    lines.push("| reviewer | _unavailable_ |");
  }
  lines.push("");
  lines.push("**PR:** " + title);
  if (degraded && error) {
    lines.push("");
    lines.push("<details><summary>errors</summary>");
    lines.push("");
    lines.push("```");
    lines.push(error);
    lines.push("```");
    lines.push("</details>");
  }
  return lines.join("\n");
}

// src/action.ts
function gitDiff(workspace) {
  try {
    const cwd = workspace ?? process.cwd();
    const diff = execSync("git diff origin/HEAD... 2>/dev/null || git diff HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      cwd
    });
    return diff.trim();
  } catch {
    return "";
  }
}
function parseReviewers(raw) {
  if (!raw || raw.trim() === "") return DEFAULT_REVIEWERS;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_REVIEWERS;
    return parsed.filter(
      (x) => typeof x === "object" && x !== null && typeof x.name === "string"
    );
  } catch {
    return DEFAULT_REVIEWERS;
  }
}
function readEnv(env = process.env) {
  return {
    apiKey: (env.TYPESAFE_API_KEY ?? "").trim(),
    baseUrl: (env.TYPESAFE_BASE_URL ?? "").trim() || void 0,
    model: (env.TYPESAFE_DEFAULT_MODEL ?? "").trim() || void 0,
    prNumber: env.PR_NUMBER ?? env.INPUT_PR_NUMBER,
    title: env.PR_TITLE ?? env.INPUT_PR_TITLE ?? "(no title)",
    body: env.PR_BODY ?? env.INPUT_PR_BODY ?? "",
    diff: (env.PR_DIFF ?? env.INPUT_PR_DIFF ?? "").trim() || gitDiff(env.GITHUB_WORKSPACE),
    workspace: env.GITHUB_WORKSPACE,
    reviewers: parseReviewers(env.REVIEWERS ?? env.INPUT_REVIEWERS),
    post: (env.INPUT_POST ?? "true") !== "false"
  };
}
function postComment(prNumber, body) {
  try {
    const dir = mkdtempSync(join(tmpdir(), "jev-review-"));
    const file = join(dir, "comment.md");
    writeFileSync(file, body, "utf8");
    execFileSync("gh", ["pr", "comment", prNumber, "--body-file", file], {
      stdio: "inherit"
    });
    return true;
  } catch (err) {
    process.stderr.write(
      "could not post comment via gh: " + (err instanceof Error ? err.message : String(err)) + "\n"
    );
    return false;
  }
}
async function main() {
  const env = readEnv();
  const config = env.apiKey ? { apiKey: env.apiKey, baseUrl: env.baseUrl, model: env.model } : null;
  if (!config) {
    process.stderr.write("TYPESAFE_API_KEY not set; posting a fail-open comment.\n");
  }
  const review = config ? await runReview(config, {
    title: env.title,
    body: env.body,
    diff: env.diff,
    cwd: env.workspace,
    reviewers: env.reviewers
  }) : {
    decisions: { destructive: null, urgency: null, reviewer: null },
    comment: "## Jev review (degraded)\n\n> TYPESAFE_API_KEY is not set, so no Jev call was made. Nothing was blocked.\n\n**PR:** " + env.title,
    degraded: true,
    error: "TYPESAFE_API_KEY is not set"
  };
  process.stdout.write(review.comment + "\n");
  if (env.post && env.prNumber) {
    postComment(env.prNumber, review.comment);
  }
  return 0;
}
main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(
    "jev-review failed: " + (err instanceof Error ? err.message : String(err)) + "\n"
  );
  process.exit(0);
});
