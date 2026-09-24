import { describe, it, expect } from "vitest";
import { findingRealness, refutationFilter, type ReviewFinding } from "../src/patterns-review.js";
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

const CFG = { apiKey: "k" };

describe("findingRealness", () => {
  it("realness-below → report:false in ONE request carrying both questions", async () => {
    const { fetchImpl, seen } = jevStub({
      realness: { type: "noul", noul: 0.49 },
      severity: { type: "choice", choice: "low", confidence: 0.9, probabilities: {} },
    });
    const r = await findingRealness(
      { ...CFG, fetchImpl },
      { path: "src/a.ts", content: "off-by-one in the loop bound" },
    );
    expect(r).toEqual({ realness: 0.49, report: false, severity: "low", severityProvided: false });
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0].questions)).toEqual(["realness", "severity"]);
    expect(seen[0].state.path).toBe("src/a.ts");
  });

  it("realness-above → report:true, honours a per-call threshold override", async () => {
    const { fetchImpl } = jevStub({
      realness: { type: "noul", noul: 0.8 },
      severity: { type: "choice", choice: "medium", confidence: 0.9, probabilities: {} },
    });
    const finding = { path: "src/a.ts", content: "wrong default breaks callers" };
    const r = await findingRealness({ ...CFG, fetchImpl }, finding);
    expect(r.realness).toBe(0.8);
    expect(r.report).toBe(true);
    const stricter = await findingRealness({ ...CFG, fetchImpl }, finding, { threshold: 0.9 });
    expect(stricter.report).toBe(false);
  });

  it("missing-realness → -1 + false + severity untouched (missing or malformed realness alike)", async () => {
    // Model answered severity but never realness: caller's severity must be untouched.
    const missing = jevStub({
      severity: { type: "choice", choice: "low", confidence: 0.9, probabilities: {} },
    });
    const withSeverity = await findingRealness(
      { ...CFG, fetchImpl: missing.fetchImpl },
      { path: "src/a.ts", content: "x", severity: "critical" },
    );
    expect(withSeverity).toEqual({
      realness: -1,
      report: false,
      severity: "critical",
      severityProvided: true,
    });
    const withoutSeverity = await findingRealness(
      { ...CFG, fetchImpl: missing.fetchImpl },
      { path: "src/a.ts", content: "x" },
    );
    expect(withoutSeverity).toEqual({
      realness: -1,
      report: false,
      severity: "",
      severityProvided: false,
    });
    // Malformed (wrong-typed) realness is equally unjudged.
    const malformed = jevStub({
      realness: { type: "noul", noul: "high" },
    } as unknown as JevResponse["answers"]);
    const bad = await findingRealness(
      { ...CFG, fetchImpl: malformed.fetchImpl },
      { path: "src/a.ts", content: "x", severity: "high" },
    );
    expect(bad).toEqual({ realness: -1, report: false, severity: "high", severityProvided: true });
  });

  it("severity-choice incl not-an-issue; an unknown label passes through, never coerced", async () => {
    const { fetchImpl, seen } = jevStub({
      realness: { type: "noul", noul: 0.7 },
      severity: { type: "choice", choice: "not-an-issue", confidence: 0.88, probabilities: {} },
    });
    const r = await findingRealness({ ...CFG, fetchImpl }, { path: "p.ts", content: "x" });
    expect(r.severity).toBe("not-an-issue");
    expect(r.report).toBe(true);
    expect(Object.keys(seen[0].questions.severity.criteria)).toEqual([
      "critical",
      "high",
      "medium",
      "low",
      "not-an-issue",
    ]);
    // code_comment.go:184-190 would coerce this to "low"; we return it verbatim.
    const unknownLabel = jevStub({
      realness: { type: "noul", noul: 0.6 },
      severity: { type: "choice", choice: "urgent", confidence: 0.7, probabilities: {} },
    });
    const r2 = await findingRealness(
      { ...CFG, fetchImpl: unknownLabel.fetchImpl },
      { path: "p.ts", content: "x" },
    );
    expect(r2.severity).toBe("urgent");
  });
});

describe("refutationFilter", () => {
  const ordinary = { type: "choice", choice: "ordinary", confidence: 0.9, probabilities: {} };

  it("refute-below keeps / refute-above (at the bar) drops", async () => {
    const { fetchImpl, seen } = jevStub({
      refute_0: { type: "noul", noul: 0.74 },
      class_0: ordinary,
      refute_1: { type: "noul", noul: 0.75 },
      class_1: ordinary,
    });
    const findings: ReviewFinding[] = [
      { path: "a.ts", content: "x" },
      { path: "b.ts", content: "y" },
    ];
    const r = await refutationFilter({ ...CFG, fetchImpl }, findings);
    expect(r.kept).toEqual([{ index: 0, score: 0.74, protectedSubject: false }]);
    expect(r.refuted).toHaveLength(1);
    expect(r.refuted[0].index).toBe(1);
    expect(r.refuted[0].score).toBe(0.75); // inclusive: at the bar drops
    expect(r.refuted[0].reason).toMatch(/Disproved above bar/);
    expect(seen).toHaveLength(1);
  });

  it("protected-subject survives a high refute", async () => {
    const { fetchImpl } = jevStub({
      refute_0: { type: "noul", noul: 0.95 },
      class_0: { type: "choice", choice: "memory-safety", confidence: 0.95, probabilities: {} },
    });
    const r = await refutationFilter({ ...CFG, fetchImpl }, [
      { path: "a.ts", content: "possible use-after-free" },
    ]);
    expect(r.refuted).toEqual([]);
    expect(r.kept).toEqual([{ index: 0, score: 0.95, protectedSubject: true }]);
    expect(r.scores).toEqual([
      { index: 0, probability: 0.95, cls: "memory-safety", protectedSubject: true },
    ]);
  });

  it("missing-refute → keep (malformed refute keeps too)", async () => {
    const { fetchImpl } = jevStub({
      refute_0: { type: "noul", noul: 0.9 },
      class_0: ordinary,
      class_1: ordinary, // refute_1 missing entirely
      refute_2: { type: "noul", noul: "high" }, // wrong-typed → malformed
      class_2: ordinary,
    } as unknown as JevResponse["answers"]);
    const findings: ReviewFinding[] = [
      { path: "a.ts", content: "x" },
      { path: "b.ts", content: "y" },
      { path: "c.ts", content: "z" },
    ];
    const r = await refutationFilter({ ...CFG, fetchImpl }, findings);
    expect(r.refuted.map((d) => d.index)).toEqual([0]);
    expect(r.kept.map((k) => k.index)).toEqual([1, 2]);
    expect(r.kept[0].score).toBe(-1); // unjudged, never a fabricated 0
    expect(r.kept[1].score).toBe(-1);
    expect(r.scores[1].probability).toBe(-1);
  });

  it("high-refute + missing class → keep (veto unproven)", async () => {
    const { fetchImpl } = jevStub({
      refute_0: { type: "noul", noul: 0.9 }, // no class_0 answer at all
    });
    const r = await refutationFilter({ ...CFG, fetchImpl }, [{ path: "a.ts", content: "x" }]);
    expect(r.refuted).toEqual([]);
    expect(r.kept).toEqual([{ index: 0, score: 0.9, protectedSubject: false }]);
    expect(r.scores).toEqual([{ index: 0, probability: 0.9, cls: null, protectedSubject: false }]);
  });

  it("batching >32 findings → 3 index-aligned requests, evidence once per shared state", async () => {
    const answers: JevResponse["answers"] = {};
    for (let i = 0; i < 65; i++) {
      answers[`refute_${i}`] = { type: "noul", noul: 0.1 };
      answers[`class_${i}`] = ordinary;
    }
    const { fetchImpl, seen } = jevStub(answers);
    const findings: ReviewFinding[] = Array.from({ length: 65 }, (_, i) => ({
      path: `src/f${i}.ts`,
      content: `finding ${i}`,
    }));
    const r = await refutationFilter({ ...CFG, fetchImpl }, findings, {
      evidence: "test run: 12 passed, 0 failed",
    });
    expect(seen).toHaveLength(3); // request count: ceil(65 / 32)
    expect(Object.keys(seen[0].questions)).toHaveLength(64); // 32 findings × 2 questions
    expect(Object.keys(seen[1].questions)).toHaveLength(64);
    expect(Object.keys(seen[2].questions)).toHaveLength(2); // last finding alone (1 × 2)
    expect(seen[1].questions).toHaveProperty("refute_32"); // ids stay globally index-aligned
    expect(seen[1].questions).toHaveProperty("class_32");
    expect(seen[1].state.findings[0].index).toBe(32);
    expect(seen[2].questions).not.toHaveProperty("refute_31");
    expect(r.scores.map((s) => s.index)).toEqual(Array.from({ length: 65 }, (_, i) => i));
    expect(r.kept).toHaveLength(65); // refute 0.1 is far below the bar
    expect(r.refuted).toHaveLength(0);
    // evidence rides ONCE at the top of the shared state — never copied per finding
    expect(seen[0].state.evidence).toBe("test run: 12 passed, 0 failed");
    expect(seen[2].state.evidence).toBe("test run: 12 passed, 0 failed");
    expect(seen[0].state.findings).toHaveLength(32);
    for (const row of seen[0].state.findings) expect(row).not.toHaveProperty("evidence");
  });

  it("input unchanged — frozen findings survive both patterns", async () => {
    const a = Object.freeze({ path: "a.ts", content: "x", diff: "-a\n+b", context: "around" });
    const list = Object.freeze([a]);
    const before = JSON.stringify(list);
    const { fetchImpl } = jevStub({
      refute_0: { type: "noul", noul: 0.9 },
      class_0: { type: "choice", choice: "memory-safety", confidence: 0.9, probabilities: {} },
    });
    const r = await refutationFilter({ ...CFG, fetchImpl }, list, { evidence: "ev" });
    expect(r.kept).toHaveLength(1);
    expect(JSON.stringify(list)).toBe(before);
    expect(Object.isFrozen(list)).toBe(true);

    const finding = Object.freeze({ path: "a.ts", content: "x", severity: "high" });
    const fBefore = JSON.stringify(finding);
    const stub = jevStub({
      realness: { type: "noul", noul: 0.9 },
      severity: { type: "choice", choice: "high", confidence: 0.9, probabilities: {} },
    });
    const rr = await findingRealness({ ...CFG, fetchImpl: stub.fetchImpl }, finding);
    expect(rr).toEqual({ realness: 0.9, report: true, severity: "high", severityProvided: true });
    expect(JSON.stringify(finding)).toBe(fBefore);
  });
});
