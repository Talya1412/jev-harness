import { describe, it, expect } from "vitest";
import { runReview, buildReviewComment, DEFAULT_REVIEWERS } from "../src/review.js";

/**
 * A fetch stub that inspects the request's question keys and returns canned
 * answers. The three review decisions each ask a differently-named question, so
 * the stub can route without inspecting the state.
 */
function reviewStub(map: Record<string, any>, opts: { failBest?: boolean } = {}) {
  const fetchImpl = (async (_url: any, init: any) => {
    const body = JSON.parse(String(init.body));
    const keys = Object.keys(body.questions);
    if (opts.failBest && keys.includes("best")) {
      return new Response("nope", { status: 400 });
    }
    const answers: Record<string, any> = {};
    for (const k of keys) answers[k] = map[k] ?? { type: "noul", noul: 0.5 };
    return new Response(JSON.stringify({ model: "jev-test", answers }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl };
}

const cfg = (fetchImpl: typeof fetch) => ({ apiKey: "k", fetchImpl, maxAttempts: 1 }) as any;

describe("runReview", () => {
  it("reports a destructive, critical PR that needs a security reviewer", async () => {
    const { fetchImpl } = reviewStub({
      destructive: { type: "noul", noul: 0.9 },
      urgency: { type: "score", score: 3.1, confidence: 0.8, probabilities: {} },
      best: { type: "choice", choice: "security", confidence: 0.85, probabilities: {} },
    });
    const r = await runReview(cfg(fetchImpl), {
      title: "rewrite auth",
      body: "changes session handling",
      diff: "- session cookie\n+ localStorage token",
    });
    expect(r.degraded).toBe(false);
    expect(r.decisions.destructive!.blocked).toBe(true);
    expect(r.decisions.urgency!.level).toBe("Critical");
    expect(r.decisions.reviewer!.reviewer).toBe("security");
    expect(r.comment).toContain("BLOCKED");
    expect(r.comment).toContain("Critical");
    expect(r.comment).toContain("security");
  });

  it("reports a benign PR routed to auto", async () => {
    const { fetchImpl } = reviewStub({
      destructive: { type: "noul", noul: 0.02 },
      urgency: { type: "score", score: 0.4, confidence: 0.6, probabilities: {} },
      best: { type: "choice", choice: "auto", confidence: 0.7, probabilities: {} },
    });
    const r = await runReview(cfg(fetchImpl), { title: "fix typo", body: "", diff: "s/teh/the/" });
    expect(r.decisions.destructive!.blocked).toBe(false);
    expect(r.decisions.urgency!.level).toBe("Low");
    expect(r.decisions.reviewer!.reviewer).toBe("auto");
    expect(r.comment).not.toContain("BLOCKED");
  });

  it("degrades gracefully when one decision fails", async () => {
    const { fetchImpl } = reviewStub(
      {
        destructive: { type: "noul", noul: 0.1 },
        urgency: { type: "score", score: 1.2, confidence: 0.5, probabilities: {} },
      },
      { failBest: true },
    );
    const r = await runReview(cfg(fetchImpl), { title: "x", body: "", diff: "d" });
    expect(r.degraded).toBe(true);
    expect(r.decisions.destructive).not.toBeNull();
    expect(r.decisions.urgency).not.toBeNull();
    expect(r.decisions.reviewer).toBeNull();
    expect(r.comment).toContain("degraded");
    expect(r.comment).toContain("_unavailable_");
  });

  it("does not throw on a total failure — still builds a comment", async () => {
    const fetchImpl = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const r = await runReview(cfg(fetchImpl), { title: "x", body: "", diff: "d" });
    expect(r.degraded).toBe(true);
    expect(r.decisions.destructive).toBeNull();
    expect(r.decisions.urgency).toBeNull();
    expect(r.decisions.reviewer).toBeNull();
    expect(r.comment).toContain("degraded");
  });

  it("ships a sensible default reviewer list", () => {
    expect(DEFAULT_REVIEWERS.map((r) => r.name)).toEqual(
      expect.arrayContaining(["auto", "peer", "security", "perf"]),
    );
  });
});

describe("buildReviewComment", () => {
  it("renders a full table when all decisions are present", () => {
    const out = buildReviewComment({
      decisions: {
        destructive: { probability: 0.8, blocked: true },
        urgency: { level: "High", score: 2.1 },
        reviewer: { reviewer: "security", confidence: 0.9 },
      },
      title: "rewrite auth",
      degraded: false,
    });
    expect(out).toContain("| decision | result |");
    expect(out).toContain("BLOCKED");
    expect(out).toContain("High");
    expect(out).toContain("security");
    expect(out).toContain("rewrite auth");
    expect(out).not.toContain("degraded");
  });

  it("marks unavailable rows and shows errors when degraded", () => {
    const out = buildReviewComment({
      decisions: { destructive: null, urgency: null, reviewer: null },
      title: "x",
      degraded: true,
      error: "connection refused",
    });
    expect(out).toContain("degraded");
    expect(out).toContain("_unavailable_");
    expect(out).toContain("connection refused");
  });
});
