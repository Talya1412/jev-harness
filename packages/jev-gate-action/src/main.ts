/**
 * Jev Gate — GitHub Action entrypoint.
 *
 * One batched Jev call per pull request (destructive effect, secret leak,
 * risk), then reports via action outputs and the job summary. The default
 * posture is advisory: `fail_on_block: "true"` turns the verdict into a
 * failing check for repos that want a hard gate.
 *
 * Fail-open by design: a missing TYPESAFE_API_KEY, a non-PR event, or any
 * error skips the gate with a notice instead of blocking the pull request;
 * `strict: "true"` inverts that.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { askJev, noul, score } from "@jev-harness/core";

interface EventPayload {
  pull_request?: { number: number };
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

async function githubFetch(path: string, init: RequestInit = {}, accept?: string): Promise<Response> {
  const base = env("GITHUB_API_URL") || "https://api.github.com";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env("GITHUB_TOKEN")}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "jev-harness-gate",
    "Content-Type": "application/json",
  };
  if (accept) headers.Accept = accept;
  return fetch(`${base}${path}`, { ...init, headers });
}

function readPullRequest(): { repo: string; number: number } | null {
  const eventPath = env("GITHUB_EVENT_PATH");
  if (!eventPath) return null;
  const repo = env("GITHUB_REPOSITORY");
  if (!repo) return null;
  const payload = JSON.parse(readFileSync(eventPath, "utf8")) as EventPayload;
  const pr = payload.pull_request;
  if (!pr || typeof pr.number !== "number") return null;
  return { repo, number: pr.number };
}

async function run(): Promise<void> {
  const apiKey = env("TYPESAFE_API_KEY").trim();
  if (!apiKey) {
    notice("TYPESAFE_API_KEY is not set — Jev gate skipped (fail-open).");
    return;
  }
  const pr = readPullRequest();
  if (!pr) {
    notice("No pull_request event context — gate skipped.");
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
      redact: true,
    },
    { diff },
    {
      destructive: {
        type: "noul",
        instructions:
          "Merging this diff would destroy or irreversibly change data, history, or system state " +
          "(recursive/bulk deletion, dropped tables or columns, force-push or history rewrite, " +
          "disabled safety checks, or infrastructure teardown).",
      },
      secret_leak: {
        type: "noul",
        instructions:
          "The diff embeds a REAL credential or secret: an API key, token, password, private key, " +
          "or a connection string with credentials. Placeholder or example values do not count.",
      },
      risk: {
        type: "score",
        instructions: "Severity of harm if this change turns out to be wrong after merge.",
        criteria: ["None", "Low", "Moderate", "High", "Critical"],
      },
    },
  );

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

  appendSummary(
    [
      "### Jev gate",
      "",
      "| signal | value |",
      "|---|---|",
      `| destructive | ${destructive.toFixed(2)} (threshold ${destructiveThreshold}) |`,
      `| secret leak | ${secretLeakP.toFixed(2)} (threshold ${secretThreshold}) |`,
      `| risk | ${risk.toFixed(2)} |`,
      `| verdict | **${verdict}** |`,
      "",
      "_Jev returns calibrated probabilities, not truth. Tune thresholds on your own labeled data — see `@jev-harness/eval`._",
    ].join("\n"),
  );

  if (verdict === "block") {
    if (boolInput("fail_on_block", false)) {
      console.log(
        `::error::Jev gate blocks this PR: destructive=${destructive.toFixed(2)}, secret_leak=${secretLeakP.toFixed(2)}`,
      );
      process.exit(1);
    }
    warning(
      `Jev gate verdict: block (destructive=${destructive.toFixed(2)}, secret_leak=${secretLeakP.toFixed(2)}) — advisory only.`,
    );
  }
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  if (boolInput("strict", false)) {
    console.log(`::error::Jev gate failed: ${message}`);
    process.exit(1);
  }
  warning(`Jev gate failed (fail-open): ${message}`);
});
