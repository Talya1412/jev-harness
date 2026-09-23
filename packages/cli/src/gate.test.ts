import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLD,
  EXIT_ERROR,
  EXIT_FAIL,
  EXIT_PASS,
  type GateSources,
  exitCodeFor,
  formatReport,
  parseArgs,
} from "../src/gate.js";

function ok(argv: string[]) {
  const r = parseArgs(argv);
  if (!r.ok) throw new Error("expected a successful parse, got: " + r.error);
  return r.options;
}

describe("parseArgs", () => {
  it("accepts criteria as a short flag, a long flag, or a bare argument", () => {
    expect(ok(["-c", "tests pass"]).criteria).toBe("tests pass");
    expect(ok(["--criteria", "tests pass"]).criteria).toBe("tests pass");
    expect(ok(["tests pass"]).criteria).toBe("tests pass");
  });

  it("defaults the threshold and never invents one from a bad value", () => {
    expect(ok(["-c", "x"]).threshold).toBe(DEFAULT_THRESHOLD);
    expect(ok(["-c", "x", "-p", "0.9"]).threshold).toBe(0.9);
    expect(ok(["-c", "x", "--min-prob", "0.5"]).threshold).toBe(0.5);
    const bad = parseArgs(["-c", "x", "-p", "high"]);
    expect(bad.ok).toBe(false);
  });

  it("reports a missing value instead of consuming the next flag", () => {
    for (const argv of [["-c"], ["-p"], ["-f"], ["-m"]]) {
      const r = parseArgs(argv);
      expect(r.ok, argv.join(" ")).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/requires/);
    }
  });

  it("rejects an unknown flag rather than ignoring it", () => {
    const r = parseArgs(["-c", "x", "--nope"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("--nope");
  });

  it("parses the boolean switches", () => {
    const o = ok(["-c", "x", "--diff", "--json", "--fail-open"]);
    expect(o).toMatchObject({ useDiff: true, json: true, failOpen: true });
    expect(ok(["-h"]).help).toBe(true);
  });

  it("keeps the first bare argument as criteria, ignoring later bare words", () => {
    expect(ok(["first", "second"]).criteria).toBe("first");
  });
});

/** Sources with no side effects, so precedence can be asserted directly. */
function sources(overrides: Partial<GateSources> = {}): GateSources {
  return {
    diff: () => null,
    stdin: () => "",
    file: () => "from-file",
    ...overrides,
  };
}

describe("resolveState", () => {
  it("prefers the diff over a file and stdin", async () => {
    const { resolveState } = await import("../src/gate.js");
    const out = resolveState(
      { ...ok(["-c", "x", "--diff", "-f", "p.txt"]), file: "p.txt" },
      sources({ diff: () => "diff text" }),
    );
    expect(out).toEqual({ ok: true, text: "diff text" });
  });

  it("says so explicitly when the repo has no changes", async () => {
    const { resolveState } = await import("../src/gate.js");
    const out = resolveState(ok(["-c", "x", "--diff"]), sources({ diff: () => null }));
    expect(out).toEqual({ ok: true, text: "No git changes detected." });
  });

  it("falls back to stdin when no diff or file is requested", async () => {
    const { resolveState } = await import("../src/gate.js");
    const out = resolveState(ok(["-c", "x"]), sources({ stdin: () => "piped output" }));
    expect(out).toEqual({ ok: true, text: "piped output" });
  });

  it("treats whitespace-only stdin as absent", async () => {
    const { resolveState } = await import("../src/gate.js");
    const out = resolveState(ok(["-c", "x"]), sources({ stdin: () => "   \n  " }));
    expect(out).toEqual({ ok: true, text: "No state provided." });
  });

  it("errors on an unreadable file instead of judging an empty state", async () => {
    const { resolveState } = await import("../src/gate.js");
    const opts = { ...ok(["-c", "x", "-f", "missing.txt"]), file: "missing.txt" };
    const out = resolveState(
      opts,
      sources({
        file: () => {
          throw new Error("ENOENT");
        },
      }),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("missing.txt");
  });
});

describe("exitCodeFor", () => {
  it("passes at or above the threshold and fails below", () => {
    expect(exitCodeFor(0.7, 0.7)).toBe(EXIT_PASS);
    expect(exitCodeFor(0.9, 0.7)).toBe(EXIT_PASS);
    expect(exitCodeFor(0.69, 0.7)).toBe(EXIT_FAIL);
    expect(exitCodeFor(0, 0.7)).toBe(EXIT_FAIL);
  });

  it("uses distinct codes for pass, fail, and error", () => {
    expect(new Set([EXIT_PASS, EXIT_FAIL, EXIT_ERROR]).size).toBe(3);
    expect(EXIT_ERROR).not.toBe(EXIT_FAIL);
  });
});

describe("formatReport", () => {
  const report = {
    passed: true,
    probability: 0.82,
    threshold: 0.7,
    criteria: "tests pass",
    elapsedMs: 240,
  };

  it("shows the verdict, score, and bar for a human", () => {
    const text = formatReport(report, false);
    expect(text).toContain("PASS");
    expect(text).toContain("0.820");
    expect(text).toContain("tests pass");
  });

  it("emits parseable JSON on request", () => {
    expect(JSON.parse(formatReport(report, true))).toEqual(report);
  });

  it("surfaces the error when there is one", () => {
    expect(formatReport({ ...report, passed: false, error: "boom" }, false)).toContain("boom");
  });
});
