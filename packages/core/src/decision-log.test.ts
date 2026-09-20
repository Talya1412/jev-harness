import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecisionLog, decisionDigest, jsonlSink } from "./decision-log.js";
import type { DecisionRecord } from "./decision-log.js";

function rec(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    ts: "2026-09-20T00:00:00.000Z",
    kind: "judgeDestructive",
    model: "jev-latest",
    digest: "d1",
    answers: { destructive: 0.84 },
    threshold: 0.75,
    action: "block",
    latencyMs: 120,
    ...overrides,
  };
}

describe("decisionDigest", () => {
  it("is stable across key order and whitespace in containers", () => {
    const a = decisionDigest("k", { b: 1, a: "x" }, ["q2", "q1"]);
    const b = decisionDigest("k", { a: "x", b: 1 }, ["q1", "q2"]);
    expect(a).toBe(b);
  });

  it("digests circular state with a marker instead of throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const digest = decisionDigest("k", circular, ["q"]);
    expect(typeof digest).toBe("string");
    expect(digest).toBe(decisionDigest("k", circular, ["q"]));
  });

  it("changes when kind, state, or questions change", () => {
    const base = decisionDigest("k", { a: 1 }, ["q"]);
    expect(decisionDigest("other", { a: 1 }, ["q"])).not.toBe(base);
    expect(decisionDigest("k", { a: 2 }, ["q"])).not.toBe(base);
    expect(decisionDigest("k", { a: 1 }, ["r"])).not.toBe(base);
  });
});

describe("createDecisionLog", () => {
  it("records decisions and enforces the ring cap", () => {
    const log = createDecisionLog({ maxEntries: 2 });
    log.record(rec({ digest: "1" }));
    log.record(rec({ digest: "2" }));
    log.record(rec({ digest: "3" }));
    expect(log.size).toBe(2);
    expect(log.entries().map((r) => r.digest)).toEqual(["2", "3"]);
  });

  it("survives a throwing sink", () => {
    const log = createDecisionLog({ sink: () => { throw new Error("sink down"); } });
    expect(() => log.record(rec())).not.toThrow();
    expect(log.size).toBe(1);
  });

  it("compare reports agreement and flips over matching digests", () => {
    const a = createDecisionLog();
    const b = createDecisionLog();
    a.record(rec({ digest: "same", answers: { destructive: 0.84 } }));
    a.record(rec({ digest: "flip", answers: { destructive: 0.9 } }));
    a.record(rec({ digest: "only-a" }));
    b.record(rec({ digest: "same", answers: { destructive: 0.84 } }));
    b.record(rec({ digest: "flip", answers: { destructive: 0.1 } }));

    const stats = a.compare(b);
    expect(stats.matched).toBe(2);
    expect(stats.agreed).toBe(1);
    expect(stats.flipRate).toBeCloseTo(0.5);
    expect(stats.disagreements).toHaveLength(1);
    expect(stats.disagreements[0]!.digest).toBe("flip");
  });

  it("compare accepts a plain record list and handles no overlap", () => {
    const log = createDecisionLog();
    log.record(rec({ digest: "x" }));
    const stats = log.compare([rec({ digest: "y" })]);
    expect(stats).toEqual({ matched: 0, agreed: 0, flipRate: 0, disagreements: [] });
  });
});

describe("jsonlSink", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jev-dlog-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends one JSON object per decision", () => {
    const path = join(dir, "decisions.jsonl");
    const log = createDecisionLog({ sink: jsonlSink(path) });
    log.record(rec({ digest: "1" }));
    log.record(rec({ digest: "2", action: "allow" }));

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const second = JSON.parse(lines[1]!) as DecisionRecord;
    expect(second.digest).toBe("2");
    expect(second.action).toBe("allow");
  });
});
