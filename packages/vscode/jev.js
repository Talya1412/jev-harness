/**
 * Minimal CJS port of @jev-harness/core for the VS Code extension. Same
 * question instructions as packages/core, so the extension's decisions are
 * behaviorally identical to the TS/Python adapters. Dependency-free: uses
 * Node's `https` by default, with an injectable transport for tests.
 */
"use strict";

const https = require("node:https");
const http = require("node:http");

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-latest";

class JevError extends Error {
  constructor(message, { status, retryable } = {}) {
    super(message);
    this.name = "JevError";
    this.status = status;
    this.retryable = !!retryable;
  }
}

/** Default transport using node https/http. */
function defaultTransport(url, { method, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    if (body) req.write(body);
    req.end();
  });
}

function validateQuestions(questions) {
  const keys = Object.keys(questions || {});
  if (!keys.length) throw new JevError("questions must be a non-empty object", { retryable: false });
  for (const key of keys) {
    const q = questions[key];
    if (!q || !q.instructions) throw new JevError(`question "${key}" needs instructions`, { retryable: false });
    if (q.type === "choice") {
      if (Object.keys(q.criteria || {}).length < 2) throw new JevError(`choice "${key}" needs ≥ 2 criteria`, { retryable: false });
    } else if (q.type === "score") {
      if ((q.criteria || []).length < 2) throw new JevError(`score "${key}" needs ≥ 2 levels`, { retryable: false });
    } else if (q.type !== "noul") {
      throw new JevError(`question "${key}" has unknown type "${q.type}"`, { retryable: false });
    }
  }
}

async function askJev(config, state, questions) {
  const apiKey = (config.apiKey || "").trim();
  if (!apiKey) throw new JevError("API key not set (configure jev-harness.apiKey).", { retryable: false });
  validateQuestions(questions);
  if (state == null) throw new JevError("state is required", { retryable: false });
  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = config.model || DEFAULT_MODEL;
  const body = JSON.stringify({ model, state, questions });
  const transport = config.transport || defaultTransport;
  const { status, body: raw } = await transport(baseUrl + "/v1/systemone", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body,
    timeoutMs: config.timeoutMs || 15000,
  });
  if (status === 429 || status >= 500) throw new JevError(`Jev HTTP ${status}`, { status, retryable: true });
  if (!(status >= 200 && status < 300)) throw new JevError(`Jev HTTP ${status}: ${raw.toString().slice(0, 500)}`, { status, retryable: false });
  let parsed;
  try { parsed = JSON.parse(raw.toString()); } catch { throw new JevError("malformed JSON", { retryable: false }); }
  if (!parsed || !parsed.answers) throw new JevError("response missing answers", { retryable: false });
  return parsed;
}

const noul = (r, id) => { const a = r.answers[id]; if (!a || a.type !== "noul" || typeof a.noul !== "number") throw new JevError(`"${id}" is not a valid noul`, { retryable: false }); return a.noul; };
const choice = (r, id) => { const a = r.answers[id]; if (!a || a.type !== "choice") throw new JevError(`"${id}" is not a valid choice`, { retryable: false }); return { choice: a.choice, confidence: a.confidence || 0, probabilities: a.probabilities || {} }; };
const score = (r, id) => { const a = r.answers[id]; if (!a || a.type !== "score") throw new JevError(`"${id}" is not a valid score`, { retryable: false }); return { score: a.score, confidence: a.confidence || 0 }; };

// --- patterns (same instructions as packages/core) ---

async function judgeDestructive(config, call, { threshold = 0.75 } = {}) {
  const r = await askJev(config, { tool: call.tool, input: JSON.stringify(call.input || {}).slice(0, 4000), cwd: call.cwd }, {
    destructive: { type: "noul", instructions: "Running this exact tool call would destroy or irreversibly change data, history, or system state (recursive/bulk deletion, overwriting existing files without backup, force-push or history rewrite, dropping tables, killing processes, spending money, or sending secrets to an external endpoint). Reading, searching, listing, creating a brand-new file, or editing a file in place with a normal edit tool is NOT destructive." },
  });
  const p = noul(r, "destructive");
  return { destructive: p, blocked: p >= threshold };
}

async function verifyClaim(config, { claim, source, context = "" }, { threshold = 0.5 } = {}) {
  const r = await askJev(config, { claim: claim.slice(0, 4000), source: source.slice(0, 8000), context: context.slice(0, 2000) }, {
    supported: { type: "noul", instructions: "Does the source text specifically support the claim — i.e. is the claim entailed by, or directly inferable from, what the source actually states? Do not use outside knowledge. If the source is silent or merely topically related, the answer is no." },
  });
  const p = noul(r, "supported");
  return { supported: p, unsupported: p < threshold };
}

async function triageUrgency(config, { title, body = "", context = "" }) {
  const levels = ["Low", "Medium", "High", "Critical"];
  const r = await askJev(config, { title: title.slice(0, 500), body: body.slice(0, 4000), context: context.slice(0, 2000) }, {
    urgency: { type: "score", instructions: "How urgent is this item? Critical = active outage, data loss, or security breach. High = broken core flow or many users blocked. Medium = workaround exists or narrow impact. Low = cosmetic or backlog.", criteria: levels },
  });
  const s = score(r, "urgency");
  const idx = Math.max(0, Math.min(levels.length - 1, Math.round(s.score)));
  return { urgency: s.score, level: levels[idx], confidence: s.confidence };
}

module.exports = { JevError, askJev, noul, choice, score, validateQuestions, judgeDestructive, verifyClaim, triageUrgency, defaultTransport, DEFAULT_BASE_URL, DEFAULT_MODEL };
