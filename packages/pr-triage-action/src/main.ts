/**
 * Jev PR triage — GitHub Action entrypoint.
 *
 * One batched Jev call per pull request (auth impact, risk score, review
 * route), then reports via action outputs, the job summary, an upserted PR
 * comment, and optional `jev:*` labels.
 *
 * Fail-open by design: a missing TYPESAFE_API_KEY, a non-PR event, or any
 * error skips triage with a notice instead of blocking the pull request.
 * Set `strict: "true"` to invert that for repos that want a hard gate.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { askJev, choice, noul, score } from "@jev-harness/core";

const MARKER = "<!-- jev-pr-triage -->";
const ALLOWED_ROUTES: ReadonlySet<string> = new Set(["auto", "peer", "security"]);

/** Clamp the model's free-text route to the allowlist so unexpected values
 *  never flow into action outputs or silently change labeling. */
export function normalizeRoute(route: string): string {
  return ALLOWED_ROUTES.has(route) ? route : "peer";
}
const RISK_LEVELS = ["None", "Low", "Moderate", "High", "Critical"] as const;

interface Judgment {
  touches: number;
  risk: number;
  route: string;
  routeConfidence: number;
}

interface EventPayload {
  pull_request?: { number: number; title?: string; body?: string | null; labels?: Array<{ name: string }> };
}

interface PullRequest {
  repo: string;
  number: number;
  labels: string[];
  title: string;
  body: string;
}

function env(name: string): string {
  return process.env[name] ?? "";
}

function boolInput(name: string, fallback: boolean): boolean {
  const raw = env(`INPUT_${name.toUpperCase()}`);
  if (raw === "") return fallback;
  return raw === "true" || raw === "1";
}

function numInput(name: string, fallback: number): number {
  const n = Number(env(`INPUT_${name.toUpperCase()}`));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function notice(message: string): void {
  console.log(`::notice::${message}`);
}

function warning(message: string): void {
  console.log(`::warning::${message}`);
}

function setOutput(name: string, value: string): void {
  const file = env("GITHUB_OUTPUT");
  if (file) appendFileSync(file, `${name}=${value}\n`);
}

function appendSummary(text: string): void {
  const file = env("GITHUB_STEP_SUMMARY");
  if (file) appendFileSync(file, text + "\n");
}

export async function githubFetch(path: string, init: RequestInit = {}, accept?: string): Promise<Response> {
  const base = env("GITHUB_API_URL") || "https://api.github.com";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env("INPUT_GITHUB_TOKEN") || env("GITHUB_TOKEN")}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "jev-harness-pr-triage",
    "Content-Type": "application/json",
  };
  if (accept) headers.Accept = accept;
  return fetch(`${base}${path}`, { ...init, headers });
}

function readPullRequest(): PullRequest | null {
  const eventPath = env("GITHUB_EVENT_PATH");
  if (!eventPath) return null;
  const repo = env("GITHUB_REPOSITORY");
  if (!repo) return null;
  const payload = JSON.parse(readFileSync(eventPath, "utf8")) as EventPayload;
  const pr = payload.pull_request;
  if (!pr || typeof pr.number !== "number") return null;
  return {
    repo,
    number: pr.number,
    labels: (pr.labels ?? []).map((l) => l.name),
    title: pr.title ?? "",
    body: pr.body ?? "",
  };
}

function riskLabel(risk: number): string {
  const index = Math.min(RISK_LEVELS.length - 1, Math.max(0, Math.round(risk)));
  return RISK_LEVELS[index]!;
}

function renderBody(j: Judgment): string {
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
    "_Jev returns calibrated probabilities, not truth. Tune thresholds on your own labeled data — see `@jev-harness/eval`._",
  ].join("\n");
}

async function upsertComment(repo: string, prNumber: number, body: string): Promise<string | null> {
  const listRes = await githubFetch(`/repos/${repo}/issues/${prNumber}/comments?per_page=100`);
  if (!listRes.ok) throw new Error(`listing PR comments failed: HTTP ${listRes.status}`);
  const comments = (await listRes.json()) as Array<{ id: number; body?: string }>;
  const existing = comments.find((c) => typeof c.body === "string" && c.body.includes(MARKER));

  const method = existing ? "PATCH" : "POST";
  const path = existing ? `/repos/${repo}/issues/comments/${existing.id}` : `/repos/${repo}/issues/${prNumber}/comments`;
  const res = await githubFetch(path, { method, body: JSON.stringify({ body }) });
  if (!res.ok) throw new Error(`upserting the triage comment failed: HTTP ${res.status}`);
  const out = (await res.json()) as { html_url?: string };
  return out.html_url ?? null;
}

async function applyLabels(pr: PullRequest, additions: string[]): Promise<void> {
  const toAdd = additions.filter((label) => label && !pr.labels.includes(label));
  if (toAdd.length === 0) return;
  const res = await githubFetch(`/repos/${pr.repo}/issues/${pr.number}/labels`, {
    method: "POST",
    body: JSON.stringify({ labels: toAdd }),
  });
  if (!res.ok) throw new Error(`adding labels failed: HTTP ${res.status}`);
}

async function run(): Promise<void> {
  const apiKey = env("TYPESAFE_API_KEY").trim();
  if (!apiKey) {
    notice("TYPESAFE_API_KEY is not set — Jev triage skipped (fail-open).");
    return;
  }
  const pr = readPullRequest();
  if (!pr) {
    notice("No pull_request event context — skipped.");
    return;
  }

  const diffRes = await githubFetch(`/repos/${pr.repo}/pulls/${pr.number}`, {}, "application/vnd.github.diff");
  if (!diffRes.ok) throw new Error(`fetching the PR diff failed: HTTP ${diffRes.status}`);
  const diff = (await diffRes.text()).slice(0, numInput("max_diff_chars", 60000));

  const response = await askJev(
    {
      apiKey,
      baseUrl: env("TYPESAFE_BASE_URL") || undefined,
      model: env("TYPESAFE_DEFAULT_MODEL") || undefined,
      timeoutMs: env("JEV_TIMEOUT_MS") ? Number(env("JEV_TIMEOUT_MS")) : undefined,
    },
    {
      pr_title: (env("PR_TITLE") || pr.title).slice(0, 500),
      pr_body: (env("PR_BODY") || pr.body).slice(0, 4000),
      diff,
    },
    {
      touches_auth: {
        type: "noul",
        instructions: "Does this change affect authentication or session security?",
      },
      risk: {
        type: "score",
        instructions: "Security and correctness risk level of merging this change as-is.",
        criteria: ["None", "Low", "Moderate", "High", "Critical"],
      },
      route: {
        type: "choice",
        instructions: "Who should review this?",
        criteria: {
          auto: "No human needed",
          peer: "Normal peer review",
          security: "Needs a security reviewer",
        },
      },
    },
  );

  const routeAnswer = choice(response, "route");
  const judgment: Judgment = {
    touches: noul(response, "touches_auth"),
    risk: score(response, "risk").score,
    route: normalizeRoute(routeAnswer.choice),
    routeConfidence: routeAnswer.confidence,
  };

  setOutput("touches_auth", judgment.touches.toFixed(3));
  setOutput("risk", judgment.risk.toFixed(2));
  setOutput("route", judgment.route);
  setOutput("route_confidence", judgment.routeConfidence.toFixed(3));

  const body = renderBody(judgment);
  appendSummary(body.replace(MARKER, "").trim());

  if (boolInput("comment", true)) {
    const url = await upsertComment(pr.repo, pr.number, body);
    if (url) setOutput("comment_url", url);
  }

  if (boolInput("labels", true)) {
    const additions: string[] = [];
    if (judgment.route === "security") additions.push("jev:security");
    if (judgment.risk >= numInput("risk_label_threshold", 4)) additions.push("jev:risk-high");
    if (judgment.touches >= numInput("auth_label_threshold", 0.7)) additions.push("jev:auth");
    await applyLabels(pr, additions);
  }
}

// Guarded so unit tests can import helpers without firing the action.
if (process.env.VITEST_WORKER_ID === undefined) {
  run().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    if (boolInput("strict", false)) {
      console.log(`::error::Jev triage failed: ${message}`);
      process.exit(1);
    }
    warning(`Jev triage failed (fail-open): ${message}`);
  });
}
