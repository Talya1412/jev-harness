/**
 * Jev Playground — zero-dependency static server + thin ask proxy.
 *
 * The browser page talks only to this server; the API key stays in the
 * server environment (TYPESAFE_API_KEY) and is never sent to the client.
 * Run: node src/server.mjs  (binds 0.0.0.0, honors PORT)
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { askJev, listJevModels } from "@jev-harness/core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(join(__dirname, "..", "public"));
const PORT = Number(process.env.PORT) || 4173;
const HOST = "0.0.0.0";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

function hasKey() {
  return (process.env.TYPESAFE_API_KEY ?? "").trim() !== "";
}

function clientConfig(model) {
  const apiKey = (process.env.TYPESAFE_API_KEY ?? "").trim();
  const baseUrl = ((process.env.TYPESAFE_BASE_URL ?? "").trim() || undefined);
  const resolvedModel = (model ?? "").trim() || (process.env.TYPESAFE_DEFAULT_MODEL ?? "").trim() || undefined;
  const raw = Number((process.env.JEV_TIMEOUT_MS ?? "").trim());
  const timeoutMs = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
  return { apiKey: apiKey || undefined, baseUrl, model: resolvedModel, timeoutMs };
}

function send(res, status, body, contentType = "application/json; charset=utf-8") {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store" });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 2_000_000) throw new Error("request body too large (2 MB limit)");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/health") {
    // Always answers: the UI uses it to show server + key + model status.
    send(res, 200, {
      hasKey: hasKey(),
      baseUrl: process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai",
      model: process.env.TYPESAFE_DEFAULT_MODEL || "jev-latest",
      error: hasKey() ? undefined : "TYPESAFE_API_KEY is not set in the server environment. Add it to .env.local and restart the preview.",
    });
    return;
  }
  if (!hasKey()) {
    send(res, 500, { error: "TYPESAFE_API_KEY is not set in the server environment. Add it to .env.local and restart the preview." });
    return;
  }
  if (url.pathname === "/api/models") {
    try {
      const models = await listJevModels(clientConfig());
      send(res, 200, { models });
    } catch (err) {
      send(res, 502, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  if (url.pathname === "/api/ask" && req.method === "POST") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      send(res, 400, { error: "invalid JSON body: " + (err instanceof Error ? err.message : String(err)) });
      return;
    }
    if (body.state === undefined || body.state === null) {
      send(res, 400, { error: "state is required" });
      return;
    }
    if (!body.questions || typeof body.questions !== "object" || Object.keys(body.questions).length === 0) {
      send(res, 400, { error: "questions must be a non-empty object" });
      return;
    }
    const started = Date.now();
    try {
      const result = await askJev(clientConfig(body.model), body.state, body.questions);
      send(res, 200, { ...result, latencyMs: Date.now() - started });
    } catch (err) {
      send(res, 502, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  send(res, 404, { error: "not found" });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, { error: "method not allowed" });
      return;
    }
    // Static files from public/ only — normalize and keep inside the dir.
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const filePath = normalize(join(PUBLIC_DIR, rel));
    if (!filePath.startsWith(PUBLIC_DIR)) {
      send(res, 403, { error: "forbidden" });
      return;
    }
    const data = await readFile(filePath);
    const type = MIME[filePath.slice(filePath.lastIndexOf("."))] ?? "application/octet-stream";
    send(res, 200, data, type);
  } catch (err) {
    const status = err && typeof err === "object" && "code" in err && err.code === "ENOENT" ? 404 : 500;
    send(res, status, { error: status === 404 ? "not found" : String(err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Jev playground listening on http://${HOST}:${PORT} (key: ${hasKey() ? "configured" : "MISSING"})`);
});
