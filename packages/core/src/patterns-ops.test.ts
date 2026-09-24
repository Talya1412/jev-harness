import { describe, it, expect } from "vitest";
import {
  commitGate,
  migrationSafety,
  testPrioritizer,
  secretLeak,
  dedupeItems,
  logSeverity,
} from "../src/patterns-ops.js";
import type { JevResponse } from "../src/types.js";

function jevStub(answers: JevResponse["answers"]) {
  const seen: any[] = [];
  const fetchImpl = (async (_url: any, init: any) => {
    seen.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const n = (p: number) => ({ type: "noul" as const, noul: p });
const c = (choice: string, confidence = 0.9) => ({
  type: "choice" as const,
  choice,
  confidence,
  probabilities: {},
});
const s = (score: number) => ({
  type: "score" as const,
  score,
  probabilities: {},
  confidence: 0.8,
});

describe("commitGate", () => {
  it("commits when safe and secret-free", async () => {
    const { fetchImpl } = jevStub({
      safe_to_commit: n(0.95),
      contains_secrets: n(0.01),
      risk: s(0.5),
    });
    const r = await commitGate({ apiKey: "k", fetchImpl }, "diff --git a/x b/x");
    expect(r.commit).toBe(true);
    expect(r.safeToCommit).toBe(0.95);
    expect(r.risk.score).toBeCloseTo(0.5);
  });

  it("refuses to commit when a secret is likely", async () => {
    const { fetchImpl } = jevStub({
      safe_to_commit: n(0.9),
      contains_secrets: n(0.9),
      risk: s(4.2),
    });
    const r = await commitGate({ apiKey: "k", fetchImpl }, "diff");
    expect(r.commit).toBe(false);
    expect(r.containsSecrets).toBe(0.9);
  });

  it("honours a custom safety threshold", async () => {
    const { fetchImpl } = jevStub({
      safe_to_commit: n(0.6),
      contains_secrets: n(0.01),
      risk: s(1),
    });
    const r = await commitGate({ apiKey: "k", fetchImpl }, "diff", { safeThreshold: 0.5 });
    expect(r.commit).toBe(true);
  });
});

describe("migrationSafety", () => {
  it("returns the verdict and probabilities", async () => {
    const { fetchImpl, seen } = jevStub({
      data_loss: n(0.85),
      irreversible: n(0.9),
      risk: s(3.9),
      verdict: c("block"),
    });
    const r = await migrationSafety(
      { apiKey: "k", fetchImpl },
      { summary: "DROP TABLE users;", dialect: "postgres" },
    );
    expect(r.verdict).toBe("block");
    expect(r.dataLoss).toBe(0.85);
    expect(r.irreversible).toBe(0.9);
    expect(seen[0].state.dialect).toBe("postgres");
  });

  it("slices an oversized sql payload before sending", async () => {
    const { fetchImpl, seen } = jevStub({
      data_loss: n(0.1),
      irreversible: n(0.1),
      risk: s(1),
      verdict: c("apply"),
    });
    await migrationSafety(
      { apiKey: "k", fetchImpl },
      { sql: "x".repeat(12000), summary: "add column", dialect: "postgres" },
    );
    expect(String(seen[0].state.migration.sql)).toHaveLength(8000);
  });

  it("defaults the dialect label", async () => {
    const { fetchImpl, seen } = jevStub({
      data_loss: n(0.1),
      irreversible: n(0.1),
      risk: s(1),
      verdict: c("apply"),
    });
    await migrationSafety({ apiKey: "k", fetchImpl }, { summary: "ADD INDEX" });
    expect(seen[0].state.dialect).toBe("sql");
  });
});

describe("testPrioritizer", () => {
  it("ranks tests by relevance, best first", async () => {
    const { fetchImpl, seen } = jevStub({ t0: n(0.3), t1: n(0.9), t2: n(0.6) });
    const r = await testPrioritizer({ apiKey: "k", fetchImpl }, "changed login", [
      "auth.spec.ts",
      "login.spec.ts",
      "billing.spec.ts",
    ]);
    expect(r.ranked.map((x) => x.name)).toEqual([
      "login.spec.ts",
      "billing.spec.ts",
      "auth.spec.ts",
    ]);
    expect(r.rankedIndexes).toEqual([1, 2, 0]);
    // questions are batched: one call, one question per test
    expect(Object.keys(seen[0].questions)).toHaveLength(3);
  });

  it("handles an empty list without a call", async () => {
    const { fetchImpl } = jevStub({});
    const r = await testPrioritizer({ apiKey: "k", fetchImpl }, "diff", []);
    expect(r.ranked).toEqual([]);
  });

  it("caps the batch at 30 tests", async () => {
    const answers: JevResponse["answers"] = {};
    for (let i = 0; i < 40; i++) answers[`t${i}`] = n(0.5);
    const { fetchImpl, seen } = jevStub(answers);
    const r = await testPrioritizer(
      { apiKey: "k", fetchImpl },
      "diff",
      Array.from({ length: 40 }, (_, i) => `test${i}`),
    );
    expect(Object.keys(seen[0].questions)).toHaveLength(30);
    expect(r.truncated).toBe(true);
  });

  it("reports truncated false inside the cap", async () => {
    const { fetchImpl } = jevStub({ t0: n(0.3), t1: n(0.9) });
    const r = await testPrioritizer({ apiKey: "k", fetchImpl }, "diff", ["a", "b"]);
    expect(r.truncated).toBe(false);
  });
});

describe("secretLeak", () => {
  it("flags texts at or above the threshold by original index", async () => {
    const { fetchImpl } = jevStub({ s0: n(0.05), s1: n(0.97), s2: n(0.6) });
    const r = await secretLeak({ apiKey: "k", fetchImpl }, ["ok", "AKIA...real", "borderline"]);
    expect(r.probabilities).toEqual([0.05, 0.97, 0.6]);
    expect(r.flagged).toEqual([1, 2]);
  });

  it("honours a stricter threshold", async () => {
    const { fetchImpl } = jevStub({ s0: n(0.6) });
    const r = await secretLeak({ apiKey: "k", fetchImpl }, ["x"], { threshold: 0.8 });
    expect(r.flagged).toEqual([]);
  });

  it("flags truncation past the 30-item cap", async () => {
    const answers: JevResponse["answers"] = {};
    for (let i = 0; i < 30; i++) answers[`s${i}`] = n(0.1);
    const { fetchImpl, seen } = jevStub(answers);
    const r = await secretLeak(
      { apiKey: "k", fetchImpl },
      Array.from({ length: 35 }, (_, i) => `text${i}`),
    );
    expect(Object.keys(seen[0].questions)).toHaveLength(30);
    expect(r.truncated).toBe(true);
  });
});

describe("dedupeItems", () => {
  it("drops later duplicates of earlier items", async () => {
    const { fetchImpl, seen } = jevStub({ d1: n(0.9), d2: n(0.05), d3: n(0.8) });
    const r = await dedupeItems({ apiKey: "k", fetchImpl }, [
      "fix login",
      "fix the login bug",
      "add footer",
      "login fix",
    ]);
    expect(r.duplicateIndexes).toEqual([1, 3]);
    expect(r.unique).toEqual([
      { index: 0, item: "fix login" },
      { index: 2, item: "add footer" },
    ]);
    // the first item is never asked (it cannot duplicate an earlier one)
    expect(Object.keys(seen[0].questions)).toHaveLength(3);
  });

  it("skips the call entirely for a single item", async () => {
    const { fetchImpl } = jevStub({});
    const r = await dedupeItems({ apiKey: "k", fetchImpl }, ["only"]);
    expect(r.unique).toEqual([{ index: 0, item: "only" }]);
  });

  it("flags truncation past the 30-item cap", async () => {
    const answers: JevResponse["answers"] = {};
    for (let i = 1; i < 30; i++) answers[`d${i}`] = n(0.1);
    const { fetchImpl, seen } = jevStub(answers);
    const r = await dedupeItems(
      { apiKey: "k", fetchImpl },
      Array.from({ length: 35 }, (_, i) => `item${i}`),
    );
    expect(Object.keys(seen[0].questions)).toHaveLength(29);
    expect(r.truncated).toBe(true);
  });

  it("returns an empty result for an empty input without calling Jev", async () => {
    const { fetchImpl, seen } = jevStub({});
    const r = await dedupeItems({ apiKey: "k", fetchImpl }, []);
    expect(r).toEqual({ unique: [], duplicateIndexes: [], truncated: false });
    expect(seen).toHaveLength(0);
  });

  it("asks one request with ids d1..dN — never d0 — and reads its own answer map", async () => {
    const { fetchImpl, seen } = jevStub({ d1: n(0.9), d2: n(0.2), d3: n(0.5) });
    const r = await dedupeItems({ apiKey: "k", fetchImpl }, ["a", "a again", "b", "b again"]);
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0].questions)).toEqual(["d1", "d2", "d3"]);
    expect(r.duplicateIndexes).toEqual([1, 3]);
    expect(r.truncated).toBe(false);
  });

  it("truncates each item to 500 chars in state and keeps the id alongside it", async () => {
    const { fetchImpl, seen } = jevStub({ d1: n(0.1) });
    await dedupeItems({ apiKey: "k", fetchImpl }, ["x".repeat(900), "short"]);
    expect(seen[0].state.items).toEqual([
      { id: "d0", text: "x".repeat(500) },
      { id: "d1", text: "short" },
    ]);
  });

  it("rejects on a missing answer rather than silently keeping the item", async () => {
    const { fetchImpl } = jevStub({ d1: n(0.9) });
    await expect(dedupeItems({ apiKey: "k", fetchImpl }, ["a", "b", "c"])).rejects.toThrow(
      /not a valid noul/,
    );
  });

  it("rejects on an unparseable answer", async () => {
    const { fetchImpl } = jevStub({
      d1: { type: "noul", noul: "high" },
    } as unknown as JevResponse["answers"]);
    await expect(dedupeItems({ apiKey: "k", fetchImpl }, ["a", "b"])).rejects.toThrow(
      /not a valid noul/,
    );
  });
});

describe("logSeverity", () => {
  it("classifies each line and returns its distribution", async () => {
    const { fetchImpl, seen } = jevStub({
      l0: c("info", 0.7),
      l1: c("error", 0.95),
    });
    const r = await logSeverity({ apiKey: "k", fetchImpl }, [
      "GET /health 200",
      "DB connection refused",
    ]);
    expect(r.levels).toEqual(["info", "error"]);
    expect(Object.keys(seen[0].questions)).toHaveLength(2);
    // the criteria carry the meaning, one shared map per line
    expect(seen[0].questions.l1.criteria.critical).toMatch(/act immediately/);
  });

  it("handles an empty batch", async () => {
    const { fetchImpl } = jevStub({});
    const r = await logSeverity({ apiKey: "k", fetchImpl }, []);
    expect(r.levels).toEqual([]);
  });

  it("flags truncation past the 30-line cap", async () => {
    const answers: JevResponse["answers"] = {};
    for (let i = 0; i < 30; i++) answers[`l${i}`] = c("info");
    const { fetchImpl, seen } = jevStub(answers);
    const r = await logSeverity(
      { apiKey: "k", fetchImpl },
      Array.from({ length: 35 }, (_, i) => `line${i}`),
    );
    expect(Object.keys(seen[0].questions)).toHaveLength(30);
    expect(r.levels).toHaveLength(30);
    expect(r.truncated).toBe(true);
  });
});
