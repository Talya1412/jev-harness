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
  const patterns = opts.extra?.length ? [...BUILTIN_REDACT_PATTERNS, ...opts.extra.map((p) => ({ label: "custom", pattern: p }))] : BUILTIN_REDACT_PATTERNS;
  for (const { label, pattern, replace } of patterns) {
    out = out.replace(pattern, replace ?? `${PLACEHOLDER}:${label}]`);
  }
  return out;
}
function redactState(state, opts = {}) {
  return walk(state, 0, opts);
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
    Authorization: `Bearer ${env("GITHUB_TOKEN")}`,
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
  const destructiveThreshold = numInput("destructive_threshold", 0.75);
  const secretThreshold = numInput("secret_threshold", 0.6);
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
run().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  if (boolInput("strict", false)) {
    console.log(`::error::Jev gate failed: ${message}`);
    process.exit(1);
  }
  warning(`Jev gate failed (fail-open): ${message}`);
});
