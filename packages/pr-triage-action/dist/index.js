// Bundled by @jev-harness/pr-triage-action — @jev-harness/core is inlined. Do not edit.

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
  const patterns = opts.extra?.length ? [...BUILTIN_REDACT_PATTERNS, ...opts.extra.map((p) => ({ label: "custom", pattern: p }))] : BUILTIN_REDACT_PATTERNS;
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
    return Array.from(value.entries(), ([k, v]) => [walk(k, depth + 1, opts), walk(v, depth + 1, opts)]);
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

// dist/main.js
var MARKER = "<!-- jev-pr-triage -->";
var ALLOWED_ROUTES = /* @__PURE__ */ new Set(["auto", "peer", "security"]);
function normalizeRoute(route) {
  return ALLOWED_ROUTES.has(route) ? route : "peer";
}
var RISK_LEVELS = ["None", "Low", "Moderate", "High", "Critical"];
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
    "User-Agent": "jev-harness-pr-triage",
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
  return {
    repo,
    number: pr.number,
    labels: (pr.labels ?? []).map((l) => l.name),
    title: pr.title ?? "",
    body: pr.body ?? ""
  };
}
function riskLabel(risk) {
  const index = Math.min(RISK_LEVELS.length - 1, Math.max(0, Math.round(risk)));
  return RISK_LEVELS[index];
}
function renderBody(j) {
  return [
    MARKER,
    "### Jev triage",
    "",
    "| signal | value |",
    "|---|---|",
    `| touches auth | ${j.touches.toFixed(2)} |`,
    `| risk | ${riskLabel(j.risk)} (${j.risk.toFixed(2)}) |`,
    `| route | \`${j.route}\` (confidence ${j.routeConfidence.toFixed(2)}) |`,
    "",
    "_Jev returns calibrated probabilities, not truth. Tune thresholds on your own labeled data \u2014 see `@jev-harness/eval`._"
  ].join("\n");
}
async function upsertComment(repo, prNumber, body) {
  const listRes = await githubFetch(`/repos/${repo}/issues/${prNumber}/comments?per_page=100`);
  if (!listRes.ok)
    throw new Error(`listing PR comments failed: HTTP ${listRes.status}`);
  const comments = await listRes.json();
  const existing = comments.find((c) => typeof c.body === "string" && c.body.includes(MARKER));
  const method = existing ? "PATCH" : "POST";
  const path = existing ? `/repos/${repo}/issues/comments/${existing.id}` : `/repos/${repo}/issues/${prNumber}/comments`;
  const res = await githubFetch(path, { method, body: JSON.stringify({ body }) });
  if (!res.ok)
    throw new Error(`upserting the triage comment failed: HTTP ${res.status}`);
  const out = await res.json();
  return out.html_url ?? null;
}
async function applyLabels(pr, additions) {
  const toAdd = additions.filter((label) => label && !pr.labels.includes(label));
  if (toAdd.length === 0)
    return;
  const res = await githubFetch(`/repos/${pr.repo}/issues/${pr.number}/labels`, {
    method: "POST",
    body: JSON.stringify({ labels: toAdd })
  });
  if (!res.ok)
    throw new Error(`adding labels failed: HTTP ${res.status}`);
}
async function run() {
  const apiKey = env("TYPESAFE_API_KEY").trim();
  if (!apiKey) {
    notice("TYPESAFE_API_KEY is not set \u2014 Jev triage skipped (fail-open).");
    return;
  }
  const pr = readPullRequest();
  if (!pr) {
    notice("No pull_request event context \u2014 skipped.");
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
    timeoutMs: env("JEV_TIMEOUT_MS") ? Number(env("JEV_TIMEOUT_MS")) : void 0
  }, {
    pr_title: (env("PR_TITLE") || pr.title).slice(0, 500),
    pr_body: (env("PR_BODY") || pr.body).slice(0, 4e3),
    diff
  }, {
    touches_auth: {
      type: "noul",
      instructions: "Does this change affect authentication or session security?"
    },
    risk: {
      type: "score",
      instructions: "Security and correctness risk level of merging this change as-is.",
      criteria: ["None", "Low", "Moderate", "High", "Critical"]
    },
    route: {
      type: "choice",
      instructions: "Who should review this?",
      criteria: {
        auto: "No human needed",
        peer: "Normal peer review",
        security: "Needs a security reviewer"
      }
    }
  });
  const routeAnswer = choice(response, "route");
  const judgment = {
    touches: noul(response, "touches_auth"),
    risk: score(response, "risk").score,
    route: normalizeRoute(routeAnswer.choice),
    routeConfidence: routeAnswer.confidence
  };
  setOutput("touches_auth", judgment.touches.toFixed(3));
  setOutput("risk", judgment.risk.toFixed(2));
  setOutput("route", judgment.route);
  setOutput("route_confidence", judgment.routeConfidence.toFixed(3));
  const body = renderBody(judgment);
  appendSummary(body.replace(MARKER, "").trim());
  if (boolInput("comment", true)) {
    const url = await upsertComment(pr.repo, pr.number, body);
    if (url)
      setOutput("comment_url", url);
  }
  if (boolInput("labels", true)) {
    const additions = [];
    if (judgment.route === "security")
      additions.push("jev:security");
    if (judgment.risk >= numInput("risk_label_threshold", 4))
      additions.push("jev:risk-high");
    if (judgment.touches >= numInput("auth_label_threshold", 0.7))
      additions.push("jev:auth");
    await applyLabels(pr, additions);
  }
}
if (process.env.VITEST_WORKER_ID === void 0) {
  run().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    if (boolInput("strict", false)) {
      console.log(`::error::Jev triage failed: ${message}`);
      process.exit(1);
    }
    warning(`Jev triage failed (fail-open): ${message}`);
  });
}
export {
  githubFetch,
  normalizeRoute
};
