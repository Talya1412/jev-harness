import { describe, expect, it } from "vitest";
import { summarizeSavings, formatSavings } from "../src/savings.js";
import type { DecisionRecord } from "../src/decision-log.js";

const rec = (over: Partial<DecisionRecord>): DecisionRecord => ({
  ts: "2026-09-27T00:00:00.000Z",
  kind: "omp_gate",
  model: "jev-latest",
  digest: "d",
  answers: {},
  latencyMs: 0,
  ...over,
});

describe("summarizeSavings", () => {
  it("separates skips from judged calls by the action prefix", () => {
    const s = summarizeSavings([
      rec({ action: "skip:read-command:ls", latencyMs: 0 }),
      rec({ action: "skip:read-command:grep", latencyMs: 0 }),
      rec({ action: "skip:read-subcommand:git", latencyMs: 0 }),
      rec({ action: "allow", latencyMs: 300 }),
      rec({ action: "block", latencyMs: 250 }),
    ]);
    expect(s.decisions).toBe(5);
    expect(s.skipped).toEqual({
      "read-command:ls": 1,
      "read-command:grep": 1,
      "read-subcommand:git": 1,
    });
    expect(s.judged).toEqual({ allow: 1, block: 1 });
    expect(s.blocked).toBe(1);
    expect(s.judgedLatencyMs).toBe(550);
  });

  it("never invents a token count it was not given", () => {
    const s = summarizeSavings([rec({ action: "skip:read-command:cat" })]);
    expect(s.meanJudgedTokens).toBe(0);
    expect(s.estimatedUsdAvoided).toBe(0);
  });

  it("prices the skips when a measured mean is supplied", () => {
    // 100 skips x 725 tok x $0.042/Mtok = $0.003045
    const s = summarizeSavings(
      [rec({ action: "skip:read-command:ls" }), rec({ action: "skip:read-command:ls" })],
      { meanJudgedTokens: 725 },
    );
    const per = (725 * 0.042) / 1_000_000;
    expect(s.estimatedUsdAvoided).toBeCloseTo(2 * per, 9);
  });

  it("estimates avoided latency from the judged calls only", () => {
    const s = summarizeSavings(
      [
        rec({ action: "allow", latencyMs: 200 }),
        rec({ action: "allow", latencyMs: 400 }),
        rec({ action: "skip:read-command:ls" }),
        rec({ action: "skip:read-command:ls" }),
      ],
      {},
    );
    expect(s.estimatedMsAvoided).toBe(600); // mean 300 x 2 skips
  });

  it("treats a malformed latency as zero rather than NaN", () => {
    const s = summarizeSavings([rec({ action: "allow", latencyMs: Number.NaN })]);
    expect(s.judgedLatencyMs).toBe(0);
  });

  it("counts a `confirm` as a block so the strict path stays visible", () => {
    expect(summarizeSavings([rec({ action: "confirm", latencyMs: 1 })]).blocked).toBe(1);
  });

  it("handles an empty log without dividing by zero", () => {
    const s = summarizeSavings([]);
    expect(s.decisions).toBe(0);
    expect(s.estimatedMsAvoided).toBe(0);
    expect(formatSavings(s)).toContain("decisions          0");
  });

  it("formats one line per rule, most frequent first", () => {
    const out = formatSavings(
      summarizeSavings([
        rec({ action: "skip:read-command:ls" }),
        rec({ action: "skip:read-command:ls" }),
        rec({ action: "skip:read-subcommand:git" }),
      ]),
    );
    const ls = out.indexOf("read-command:ls");
    const git = out.indexOf("read-subcommand:git");
    expect(ls).toBeGreaterThan(-1);
    expect(ls).toBeLessThan(git);
    expect(out).toContain("MEASURED");
    expect(out).toContain("ESTIMATED");
  });
});
