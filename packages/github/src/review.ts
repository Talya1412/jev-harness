/**
 * A Jev-driven PR review. Composes three core patterns — `judgeDestructive`,
 * `triageUrgency`, and `routeSkill` (used to pick a reviewer) — into one
 * advisory comment. Fail-open by design: a Jev outage never blocks the PR.
 *
 * Pure logic + the Jev calls live here so the comment shape and the fail-open
 * behavior are testable without a network. The GH-Action entrypoint
 * (`./action.js`) only does process I/O.
 */
import {
  judgeDestructive,
  routeSkill,
  triageUrgency,
  type JevConfig,
} from "@jev-harness/core";

export interface ReviewerCandidate {
  name: string;
  description?: string;
}

export const DEFAULT_REVIEWERS: ReviewerCandidate[] = [
  { name: "auto", description: "No human review needed; trivial or well-tested change." },
  { name: "peer", description: "Normal code review by a teammate." },
  { name: "security", description: "Security review: touches auth, crypto, secrets, or untrusted input." },
  { name: "perf", description: "Performance review: hot path, allocation, or scaling-sensitive change." },
];

export interface ReviewDecisions {
  destructive: { probability: number; blocked: boolean } | null;
  urgency: { level: string; score: number } | null;
  reviewer: { reviewer: string | null; confidence: number } | null;
}

export interface ReviewInput {
  title: string;
  body: string;
  diff: string;
  cwd?: string;
  reviewers?: ReviewerCandidate[];
  /** Override the destructive block threshold (default 0.75, matches core). */
  destructiveThreshold?: number;
}

export interface ReviewResult {
  decisions: ReviewDecisions;
  comment: string;
  /** Set when one or more Jev calls failed; the comment is still produced. */
  degraded: boolean;
  error?: string;
}

/**
 * Run the three decisions in parallel and build the comment. Each decision is
 * independent against a different state, so they cannot share one Jev call —
 * parallel is the honest shape here. Any failure degrades to advisory only.
 */
export async function runReview(
  config: JevConfig,
  input: ReviewInput,
  signal?: AbortSignal,
): Promise<ReviewResult> {
  const reviewers = input.reviewers && input.reviewers.length > 0 ? input.reviewers : DEFAULT_REVIEWERS;
  const message = (input.title + "\n\n" + input.body).slice(0, 3000);

  const [destructive, urgency, reviewer] = await Promise.allSettled([
    judgeDestructive(config, { tool: "git-diff", input: { diff: input.diff }, cwd: input.cwd }, {
      threshold: input.destructiveThreshold,
      signal,
    }),
    triageUrgency(config, { title: input.title, body: input.body }, { signal }),
    routeSkill(config, message, reviewers, { minConfidence: 0.4, signal }),
  ]);

  const decisions: ReviewDecisions = {
    destructive:
      destructive.status === "fulfilled"
        ? { probability: destructive.value.destructive, blocked: destructive.value.blocked }
        : null,
    urgency:
      urgency.status === "fulfilled"
        ? { level: urgency.value.level, score: urgency.value.urgency }
        : null,
    reviewer:
      reviewer.status === "fulfilled"
        ? { reviewer: reviewer.value.skill, confidence: reviewer.value.confidence }
        : null,
  };

  const failures = [destructive, urgency, reviewer].filter((r) => r.status === "rejected");
  const degraded = failures.length > 0;
  const error =
    failures.length > 0
      ? failures
          .map((r, i) => "decision " + i + ": " + ((r as PromiseRejectedResult).reason instanceof Error ? (r as PromiseRejectedResult).reason.message : String((r as PromiseRejectedResult).reason)))
          .join("; ")
      : undefined;

  return { decisions, comment: buildReviewComment({ decisions, title: input.title, degraded, error }), degraded, error };
}

export interface CommentInput {
  decisions: ReviewDecisions;
  title: string;
  degraded: boolean;
  error?: string;
}

/** Render the PR comment as GitHub-flavored markdown. Pure. */
export function buildReviewComment(input: CommentInput): string {
  const { decisions, title, degraded, error } = input;
  const lines: string[] = [
    "## Jev review" + (degraded ? " (degraded)" : ""),
    "",
    "> Advisory only. Jev emits calibrated probabilities; thresholds and side effects stay in your workflow.",
    "",
    "| decision | result |",
    "| --- | --- |",
  ];

  if (decisions.destructive) {
    const flag = decisions.destructive.blocked ? "BLOCKED" : "ok";
    lines.push(
      `| destructive | ${flag} (p=${decisions.destructive.probability.toFixed(2)}) |`,
    );
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
    lines.push(
      `| reviewer | ${who} (conf=${decisions.reviewer.confidence.toFixed(2)}) |`,
    );
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
