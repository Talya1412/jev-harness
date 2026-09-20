#!/usr/bin/env node
/**
 * GitHub Action entrypoint: gather PR context from the environment, run the
 * Jev review, post the comment via `gh`, exit. Fail-open: a missing key, a
 * Jev outage, or a missing `gh` never fails the workflow — the comment is
 * still posted (or printed) so the PR isn't blocked.
 */
import { execFileSync, execSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview, DEFAULT_REVIEWERS, type ReviewerCandidate } from "./review.js";

interface ActionEnv {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  prNumber?: string;
  title: string;
  body: string;
  diff: string;
  workspace?: string;
  reviewers: ReviewerCandidate[];
  post: boolean;
}

function gitDiff(workspace: string | undefined): string {
  try {
    const cwd = workspace ?? process.cwd();
    const diff = execSync("git diff origin/HEAD... 2>/dev/null || git diff HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      cwd,
    });
    return diff.trim();
  } catch {
    return "";
  }
}

function parseReviewers(raw: string | undefined): ReviewerCandidate[] {
  if (!raw || raw.trim() === "") return DEFAULT_REVIEWERS;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_REVIEWERS;
    return parsed.filter(
      (x): x is ReviewerCandidate => typeof x === "object" && x !== null && typeof x.name === "string",
    );
  } catch {
    return DEFAULT_REVIEWERS;
  }
}

function readEnv(env: NodeJS.ProcessEnv = process.env): ActionEnv {
  return {
    apiKey: (env.TYPESAFE_API_KEY ?? "").trim(),
    baseUrl: (env.TYPESAFE_BASE_URL ?? "").trim() || undefined,
    model: (env.TYPESAFE_DEFAULT_MODEL ?? "").trim() || undefined,
    prNumber: env.PR_NUMBER ?? env.INPUT_PR_NUMBER,
    title: env.PR_TITLE ?? env.INPUT_PR_TITLE ?? "(no title)",
    body: env.PR_BODY ?? env.INPUT_PR_BODY ?? "",
    diff: (env.PR_DIFF ?? env.INPUT_PR_DIFF ?? "").trim() || gitDiff(env.GITHUB_WORKSPACE),
    workspace: env.GITHUB_WORKSPACE,
    reviewers: parseReviewers(env.REVIEWERS ?? env.INPUT_REVIEWERS),
    post: (env.INPUT_POST ?? "true") !== "false",
  };
}

function postComment(prNumber: string, body: string): boolean {
  try {
    const dir = mkdtempSync(join(tmpdir(), "jev-review-"));
    const file = join(dir, "comment.md");
    writeFileSync(file, body, "utf8");
    // argv (no shell) so a hostile prNumber or file path cannot inject flags or commands.
    execFileSync("gh", ["pr", "comment", prNumber, "--body-file", file], {
      stdio: "inherit",
    });
    return true;
  } catch (err) {
    process.stderr.write(
      "could not post comment via gh: " + (err instanceof Error ? err.message : String(err)) + "\n",
    );
    return false;
  }
}

async function main(): Promise<number> {
  const env = readEnv();
  const config = env.apiKey
    ? ({ apiKey: env.apiKey, baseUrl: env.baseUrl, model: env.model } as { apiKey: string; baseUrl?: string; model?: string })
    : null;

  if (!config) {
    process.stderr.write("TYPESAFE_API_KEY not set; posting a fail-open comment.\n");
  }

  const review = config
    ? await runReview(config, {
        title: env.title,
        body: env.body,
        diff: env.diff,
        cwd: env.workspace,
        reviewers: env.reviewers,
      })
    : {
        decisions: { destructive: null, urgency: null, reviewer: null },
        comment:
          "## Jev review (degraded)\n\n> TYPESAFE_API_KEY is not set, so no Jev call was made. Nothing was blocked.\n\n**PR:** " +
          env.title,
        degraded: true,
        error: "TYPESAFE_API_KEY is not set",
      };

  process.stdout.write(review.comment + "\n");

  if (env.post && env.prNumber) {
    postComment(env.prNumber, review.comment);
  }
  // Advisory only: never fail the workflow.
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write("jev-review failed: " + (err instanceof Error ? err.message : String(err)) + "\n");
    // Still exit 0: an advisory action must not break CI.
    process.exit(0);
  });
