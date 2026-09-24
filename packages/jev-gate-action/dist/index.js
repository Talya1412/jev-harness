// Bundled by @jev-harness/jev-gate-action — @jev-harness/core is inlined. Do not edit.

// dist/main.js
import { appendFileSync, readFileSync } from "node:fs";

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

// dist/main.js
function env(name) {
  return process.env[name] ?? "";
}
function boolInput(name, fallback) {
  const raw = env(`INPUT_${name.toUpperCase()}`);
  if (raw === "")
    return fallback;
  return raw === "true" || raw === "1";
}
function numInput(name, fallback) {
  const n = Number(env(`INPUT_${name.toUpperCase()}`));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function notice(message) {
  console.log(`::notice::${message}`);
}
function warning(message) {
  console.log(`::warning::${message}`);
}
function setOutput(name, value) {
  const file = env("GITHUB_OUTPUT");
  if (file)
    appendFileSync(file, `${name}=${value}
`);
}
function appendSummary(text) {
  const file = env("GITHUB_STEP_SUMMARY");
  if (file)
    appendFileSync(file, text + "\n");
}
async function githubFetch(path, init = {}, accept) {
  const base = env("GITHUB_API_URL") || "https://api.github.com";
  const headers = {
    Authorization: `Bearer ${env("INPUT_GITHUB_TOKEN") || env("GITHUB_TOKEN")}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "jev-harness-gate",
    "Content-Type": "application/json"
  };
  if (accept)
    headers.Accept = accept;
  return fetch(`${base}${path}`, { ...init, headers });
}
function readPullRequest() {
  const eventPath = env("GITHUB_EVENT_PATH");
  if (!eventPath)
    return null;
  const repo = env("GITHUB_REPOSITORY");
  if (!repo)
    return null;
  const payload = JSON.parse(readFileSync(eventPath, "utf8"));
  const pr = payload.pull_request;
  if (!pr || typeof pr.number !== "number")
    return null;
  return { repo, number: pr.number };
}
async function run() {
  const apiKey = env("TYPESAFE_API_KEY").trim();
  if (!apiKey) {
    notice("TYPESAFE_API_KEY is not set \u2014 Jev gate skipped (fail-open).");
    return;
  }
  const pr = readPullRequest();
  if (!pr) {
    notice("No pull_request event context \u2014 gate skipped.");
    return;
  }
  const diffRes = await githubFetch(`/repos/${pr.repo}/pulls/${pr.number}`, {}, "application/vnd.github.diff");
  if (!diffRes.ok)
    throw new Error(`fetching the PR diff failed: HTTP ${diffRes.status}`);
  const diff = (await diffRes.text()).slice(0, numInput("max_diff_chars", 6e4));
  const response = await askJev({
    apiKey,
    baseUrl: env("TYPESAFE_BASE_URL") || void 0,
    model: env("TYPESAFE_DEFAULT_MODEL") || void 0,
    timeoutMs: env("JEV_TIMEOUT_MS") ? Number(env("JEV_TIMEOUT_MS")) : void 0,
    redact: true
  }, { diff }, {
    destructive: {
      type: "noul",
      instructions: "Merging this diff would destroy or irreversibly change data, history, or system state (recursive/bulk deletion, dropped tables or columns, force-push or history rewrite, disabled safety checks, or infrastructure teardown)."
    },
    secret_leak: {
      type: "noul",
      instructions: "The diff embeds a REAL credential or secret: an API key, token, password, private key, or a connection string with credentials. Placeholder or example values do not count."
    },
    risk: {
      type: "score",
      instructions: "Severity of harm if this change turns out to be wrong after merge.",
      criteria: ["None", "Low", "Moderate", "High", "Critical"]
    }
  });
  const destructive = noul(response, "destructive");
  const secretLeakP = noul(response, "secret_leak");
  const risk = score(response, "risk").score;
  const destructiveThreshold = numInput("destructive_threshold", 0.12);
  const secretThreshold = numInput("secret_threshold", 0.07);
  const verdict = destructive >= destructiveThreshold || secretLeakP >= secretThreshold ? "block" : "pass";
  setOutput("destructive", destructive.toFixed(3));
  setOutput("secret_leak", secretLeakP.toFixed(3));
  setOutput("risk", risk.toFixed(2));
  setOutput("verdict", verdict);
  appendSummary([
    "### Jev gate",
    "",
    "| signal | value |",
    "|---|---|",
    `| destructive | ${destructive.toFixed(2)} (threshold ${destructiveThreshold}) |`,
    `| secret leak | ${secretLeakP.toFixed(2)} (threshold ${secretThreshold}) |`,
    `| risk | ${risk.toFixed(2)} |`,
    `| verdict | **${verdict}** |`,
    "",
    "_Jev returns calibrated probabilities, not truth. Tune thresholds on your own labeled data \u2014 see `@jev-harness/eval`._"
  ].join("\n"));
  if (verdict === "block") {
    if (boolInput("fail_on_block", false)) {
      console.log(`::error::Jev gate blocks this PR: destructive=${destructive.toFixed(2)}, secret_leak=${secretLeakP.toFixed(2)}`);
      process.exit(1);
    }
    warning(`Jev gate verdict: block (destructive=${destructive.toFixed(2)}, secret_leak=${secretLeakP.toFixed(2)}) \u2014 advisory only.`);
  }
}
if (process.env.VITEST_WORKER_ID === void 0) {
  run().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    if (boolInput("strict", false)) {
      console.log(`::error::Jev gate failed: ${message}`);
      process.exit(1);
    }
    warning(`Jev gate failed (fail-open): ${message}`);
  });
}
export {
  githubFetch
};
