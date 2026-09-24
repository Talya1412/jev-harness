import { describe, it, expect } from "vitest";
import { judgeDestructiveDual, THRESHOLDS } from "../src/patterns.js";
import type { JevResponse } from "../src/types.js";

/** Route every call through a canned response, recording the request bodies. */
function jevStub(answers: JevResponse["answers"]) {
  const seen: any[] = [];
  const fetchImpl = (async (_url: any, init: any) => {
    seen.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const CALL = { tool: "bash", input: { cmd: "rm -rf /" }, cwd: "/tmp" };

describe("judgeDestructiveDual", () => {
  it("blocks when the noul is high and the category agrees with usable confidence", async () => {
    const { fetchImpl, seen } = jevStub({
      destructive: { type: "noul", noul: 0.92 },
      category: {
        type: "choice",
        choice: "destructive",
        confidence: 0.88,
        probabilities: {},
      },
    });
    const r = await judgeDestructiveDual({ apiKey: "k", fetchImpl }, CALL);
    expect(r).toEqual({
      destructive: 0.92,
      category: "destructive",
      confidence: 0.88,
      decision: "block",
    });
    // Both questions ride in ONE request.
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0].questions)).toEqual(["destructive", "category"]);
  });

  it("confirms when the category disagrees with the noul", async () => {
    const { fetchImpl } = jevStub({
      destructive: { type: "noul", noul: 0.84 },
      category: { type: "choice", choice: "read-only", confidence: 0.95, probabilities: {} },
    });
    const r = await judgeDestructiveDual({ apiKey: "k", fetchImpl }, CALL);
    expect(r.decision).toBe("confirm");
    expect(r.category).toBe("read-only");
  });

  it("confirms rather than blocks when the category confidence is low", async () => {
    const { fetchImpl } = jevStub({
      destructive: { type: "noul", noul: 0.95 },
      category: { type: "choice", choice: "destructive", confidence: 0.2, probabilities: {} },
    });
    const r = await judgeDestructiveDual({ apiKey: "k", fetchImpl }, CALL);
    expect(r.decision).toBe("confirm");
  });

  it("treats the category confidence boundary as proven", async () => {
    const { fetchImpl } = jevStub({
      destructive: { type: "noul", noul: 0.9 },
      category: {
        type: "choice",
        choice: "destructive",
        confidence: THRESHOLDS.categoryConfidence,
        probabilities: {},
      },
    });
    const r = await judgeDestructiveDual({ apiKey: "k", fetchImpl }, CALL);
    expect(r.decision).toBe("block");
  });

  it("allows a low-probability call regardless of the category", async () => {
    const { fetchImpl } = jevStub({
      destructive: { type: "noul", noul: 0.03 },
      category: { type: "choice", choice: "destructive", confidence: 0.99, probabilities: {} },
    });
    const r = await judgeDestructiveDual({ apiKey: "k", fetchImpl }, CALL);
    expect(r.decision).toBe("allow");
    expect(r.destructive).toBe(0.03);
  });

  it("confirms on abstain: an unknown category with a high noul is not a silent block", async () => {
    const { fetchImpl, seen } = jevStub({
      destructive: { type: "noul", noul: 0.88 },
      category: { type: "choice", choice: "unknown", confidence: 0.71, probabilities: {} },
    });
    const r = await judgeDestructiveDual({ apiKey: "k", fetchImpl }, CALL);
    expect(r.decision).toBe("confirm");
    expect(r.category).toBe("unknown");
    // The abstain option must exist in the choice set: a choice without one
    // forces an answer where "I do not know" is the truth.
    expect(Object.keys(seen[0].questions.category.criteria)).toEqual([
      "destructive",
      "reversible-mutation",
      "read-only",
      "unknown",
    ]);
  });

  it("reads an unrecognised category label as an abstain", async () => {
    const { fetchImpl } = jevStub({
      destructive: { type: "noul", noul: 0.9 },
      category: {
        type: "choice",
        choice: "EXTREMELY-DESTRUCTIVE",
        confidence: 0.99,
        probabilities: {},
      },
    });
    const r = await judgeDestructiveDual({ apiKey: "k", fetchImpl }, CALL);
    expect(r.category).toBe("unknown");
    expect(r.decision).toBe("confirm");
  });

  it("honours a custom threshold", async () => {
    const { fetchImpl } = jevStub({
      destructive: { type: "noul", noul: 0.6 },
      category: { type: "choice", choice: "destructive", confidence: 0.9, probabilities: {} },
    });
    const r = await judgeDestructiveDual({ apiKey: "k", fetchImpl }, CALL, { threshold: 0.5 });
    expect(r.decision).toBe("block");
  });

  it("allows a malformed response instead of throwing", async () => {
    const { fetchImpl } = jevStub({});
    const r = await judgeDestructiveDual({ apiKey: "k", fetchImpl }, CALL);
    expect(r).toEqual({ destructive: 0, category: "unknown", confidence: 0, decision: "allow" });
  });

  it("allows an unparseable noul value instead of throwing", async () => {
    const { fetchImpl } = jevStub({
      destructive: { type: "noul", noul: "high" as unknown as number },
      category: { type: "choice", choice: "destructive", confidence: 0.9, probabilities: {} },
    });
    const r = await judgeDestructiveDual({ apiKey: "k", fetchImpl }, CALL);
    // A missing probability is "no evidence", never a block; the other answer
    // is parsed independently and still reported.
    expect(r.destructive).toBe(0);
    expect(r.decision).toBe("allow");
    expect(r.category).toBe("destructive");
  });

  it("caps the forwarded input so a huge payload cannot bloat the request", async () => {
    const { fetchImpl, seen } = jevStub({
      destructive: { type: "noul", noul: 0.1 },
      category: { type: "choice", choice: "read-only", confidence: 0.9, probabilities: {} },
    });
    await judgeDestructiveDual(
      { apiKey: "k", fetchImpl },
      { tool: "bash", input: { cmd: "x".repeat(9000) }, cwd: "/tmp" },
    );
    expect(String(seen[0].state.input)).toHaveLength(4000);
  });

  it("honours an already-aborted signal", async () => {
    const { fetchImpl } = jevStub({
      destructive: { type: "noul", noul: 0.9 },
      category: { type: "choice", choice: "destructive", confidence: 0.9, probabilities: {} },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      judgeDestructiveDual({ apiKey: "k", fetchImpl }, CALL, { signal: controller.signal }),
    ).rejects.toThrow(/aborted/i);
  });
});
