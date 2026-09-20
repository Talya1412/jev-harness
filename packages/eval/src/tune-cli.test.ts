import { describe, it, expect } from "vitest";
import { parseArgs, loadDataset, formatSummary, HELP } from "../src/tune-cli.js";
import { tune } from "../src/tune.js";

function ok(argv: string[]) {
  const r = parseArgs(argv);
  if (!r.ok) throw new Error("expected a successful parse, got: " + r.error);
  return r.options;
}

describe("parseArgs", () => {
  it("parses the objective and json flags", () => {
    expect(ok(["-o", "youden"]).objective).toBe("youden");
    expect(ok(["--objective", "f1"]).objective).toBe("f1");
    expect(ok(["--json"]).json).toBe(true);
    expect(ok(["-h"]).help).toBe(true);
  });

  it("parses --file", () => {
    expect(ok(["-f", "data.jsonl"]).file).toBe("data.jsonl");
  });

  it("rejects an unknown objective", () => {
    const r = parseArgs(["-o", "accuracy"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/must be 'f1' or 'youden'/);
  });

  it("rejects an unknown option", () => {
    const r = parseArgs(["--nope"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("--nope");
  });
});

describe("loadDataset", () => {
  it("reads JSONL with the canonical keys", () => {
    const r = loadDataset('{"p":0.1,"y":false}\n{"p":0.9,"y":true}\n');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.samples).toEqual([
        { p: 0.1, y: false },
        { p: 0.9, y: true },
      ]);
    }
  });

  it("reads a JSON array with forgiving keys", () => {
    const r = loadDataset('[{"prediction":0.2,"outcome":0},{"probability":0.8,"label":1}]');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.samples[0]).toEqual({ p: 0.2, y: false });
      expect(r.samples[1]).toEqual({ p: 0.8, y: true });
    }
  });

  it("ignores blank and comment lines in JSONL", () => {
    const r = loadDataset('# header\n{"p":0.5,"y":true}\n\n  \n{"p":0.5,"y":false}\n');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.samples).toHaveLength(2);
  });

  it("reports an error for empty input", () => {
    const r = loadDataset("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/empty/);
  });

  it("reports an error for a missing probability", () => {
    const r = loadDataset('{"y":true}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing a numeric probability/);
  });

  it("reports an error for a missing outcome", () => {
    const r = loadDataset('{"p":0.5}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing an outcome/);
  });

  it("rejects an out-of-range probability", () => {
    const r = loadDataset('{"p":1.7,"y":true}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/outside \[0,1\]/);
  });

  it("rejects malformed JSONL with a line reference", () => {
    const r = loadDataset("not json at all");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invalid JSONL line/);
  });
});

describe("formatSummary", () => {
  const summary = tune([0.1, 0.9, 0.5, 0.5], [false, true, false, true]);

  it("renders a human report with the best threshold and metrics", () => {
    const out = formatSummary(summary, false);
    expect(out).toContain("best threshold");
    expect(out).toContain("brier");
    expect(out).toContain("rocAuc");
    expect(out).toContain("prAuc");
    expect(out).toContain("top thresholds");
  });

  it("renders valid JSON when --json is set", () => {
    const out = formatSummary(summary, true);
    const parsed = JSON.parse(out);
    expect(parsed.n).toBe(4);
    expect(parsed.bestThreshold).toBeTypeOf("number");
    expect(Array.isArray(parsed.sweep)).toBe(true);
  });

  it("the help text documents the dataset keys", () => {
    expect(HELP).toMatch(/JSONL/);
    expect(HELP).toMatch(/prediction/);
    expect(HELP).toMatch(/outcome/);
  });
});
