/**
 * A Jev-driven PR review. Composes three core patterns — `judgeDestructive`,
 * `triageUrgency`, and `routeSkill` (used to pick a reviewer) — into one
 * advisory comment. Fail-open by design: a Jev outage never blocks the PR.
 *
 * Pure logic + the Jev calls live here so the comment shape and the fail-open
 * behavior are testable without a network. The GH-Action entrypoint
 * (`./action.js`) only does process I/O.
 */
import { type JevConfig } from "@jev-harness/core";
export interface ReviewerCandidate {
    name: string;
    description?: string;
}
export declare const DEFAULT_REVIEWERS: ReviewerCandidate[];
export interface ReviewDecisions {
    destructive: {
        probability: number;
        blocked: boolean;
    } | null;
    urgency: {
        level: string;
        score: number;
    } | null;
    reviewer: {
        reviewer: string | null;
        confidence: number;
    } | null;
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
export declare function runReview(config: JevConfig, input: ReviewInput, signal?: AbortSignal): Promise<ReviewResult>;
export interface CommentInput {
    decisions: ReviewDecisions;
    title: string;
    degraded: boolean;
    error?: string;
}
/** Render the PR comment as GitHub-flavored markdown. Pure. */
export declare function buildReviewComment(input: CommentInput): string;
//# sourceMappingURL=review.d.ts.map