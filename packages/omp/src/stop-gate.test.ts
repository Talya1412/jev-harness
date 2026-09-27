import { describe, expect, it } from "vitest";
import {
  collectStopEvidence,
  decideStop,
  stopGateReason,
  verificationQuestions,
} from "../src/stop-gate.js";

/** OMP's own assistant spelling: { type: "toolCall", id, name, arguments }. */
const call = (id: string, name: string, args: Record<string, unknown>) => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name, arguments: args }],
});
/** OMP's own result spelling: a whole message with toolCallId. */
const result = (id: string, text: string, isError = false) => ({
  role: "toolResult",
  toolCallId: id,
  isError,
  content: [{ type: "text", text }],
});
/** Anthropic spelling, which must resolve to the same facts. */
const use = (id: string, name: string, input: Record<string, unknown>) => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name, input }],
});
const toolResult = (id: string, text: string) => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: text }],
});

describe("collectStopEvidence", () => {
  it("finds an edit and a passing check in OMP's spelling", () => {
    const ev = collectStopEvidence([
      call("1", "write", { file_path: "src/a.ts" }),
      result("1", "ok"),
      call("2", "bash", { cmd: "npm test" }),
      result("2", "42 passed, 0 failed"),
    ]);
    expect(ev.edits).toHaveLength(1);
    expect(ev.edits[0].path).toBe("src/a.ts");
    expect(ev.checks).toHaveLength(1);
    expect(ev.checks[0].passed).toBe(true);
  });

  it("finds the same facts in the Anthropic spelling", () => {
    const ev = collectStopEvidence([
      use("a", "edit", { file_path: "src/b.ts" }),
      toolResult("a", "done"),
      use("b", "bash", { cmd: "npx vitest run" }),
      toolResult("b", "Tests 12 passed"),
    ]);
    expect(ev.edits[0].path).toBe("src/b.ts");
    expect(ev.checks[0].passed).toBe(true);
  });

  it("marks a FAILED check as not passed", () => {
    const ev = collectStopEvidence([
      call("1", "write", { file_path: "src/a.ts" }),
      result("1", "ok"),
      call("2", "bash", { cmd: "npm test" }),
      result("2", "FAIL src/a.test.ts\nTests 1 failed"),
    ]);
    expect(ev.checks[0].passed).toBe(false);
  });

  it("marks a check with an isError flag as not passed even with cheerful text", () => {
    const ev = collectStopEvidence([
      call("1", "bash", { cmd: "npm run build" }),
      result("1", "all good", true),
    ]);
    expect(ev.checks[0].passed).toBe(false);
  });

  it("recognises the common check commands and ignores plain reads", () => {
    for (const cmd of [
      "npm test",
      "npm run lint",
      "pnpm typecheck",
      "npx vitest run",
      "pytest -q",
      "cargo test",
      "go build ./...",
    ]) {
      expect(collectStopEvidence([call("1", "bash", { cmd })]).checks).toHaveLength(1);
    }
    for (const cmd of ["ls -la", "cat a.txt", "grep -rn x src"]) {
      const ev = collectStopEvidence([call("1", "bash", { cmd })]);
      expect(ev.checks).toHaveLength(0);
      expect(ev.mutationsAfterLastCheck).toBe(0);
    }
  });

  it("counts a mutating command after the last passed check", () => {
    const ev = collectStopEvidence([
      call("1", "bash", { cmd: "npm test" }),
      result("1", "10 passed"),
      call("2", "bash", { cmd: "rm -rf dist" }),
      result("2", "ok"),
    ]);
    expect(ev.mutationsAfterLastCheck).toBe(1);
  });

  it("reads an ast_edit paths list, not just file_path", () => {
    const ev = collectStopEvidence([call("1", "ast_edit", { paths: ["a.ts", "b.ts"] })]);
    expect(ev.edits[0].path).toBe("a.ts");
  });

  it("survives a malformed message without throwing", () => {
    const ev = collectStopEvidence([
      null,
      42,
      {},
      { role: "assistant", content: "text" },
      { content: [null] },
    ]);
    expect(ev.edits).toHaveLength(0);
    expect(ev.checks).toHaveLength(0);
  });
});

describe("decideStop", () => {
  const ev = (over: Partial<ReturnType<typeof collectStopEvidence>>) => ({
    edits: [],
    checks: [],
    mutationsAfterLastCheck: 0,
    ...over,
  });

  it("does not block when nothing changed", () => {
    expect(decideStop(ev({})).block).toBe(false);
  });

  it("does not block when a check passed AFTER the last edit", () => {
    const v = decideStop(
      ev({
        edits: [{ tool: "write", path: "a.ts", at: 1 }],
        checks: [{ command: "npm test", passed: true, at: 2 }],
      }),
    );
    expect(v.block).toBe(false);
    if (!v.block) expect(v.reason).toBe("verified");
  });

  it("BLOCKS an edit with no check after it", () => {
    const v = decideStop(ev({ edits: [{ tool: "write", path: "a.ts", at: 1 }] }));
    expect(v.block).toBe(true);
    if (v.block) {
      expect(v.reason).toBe("unverified-edits");
      expect(v.files).toEqual(["a.ts"]);
      expect(v.lastCheck).toBeNull();
    }
  });

  it("BLOCKS when the check ran BEFORE the edit", () => {
    const v = decideStop(
      ev({
        edits: [{ tool: "write", path: "a.ts", at: 5 }],
        checks: [{ command: "npm test", passed: true, at: 2 }],
      }),
    );
    expect(v.block).toBe(true);
  });

  it("does not count a failed check as verification", () => {
    const v = decideStop(
      ev({
        edits: [{ tool: "write", path: "a.ts", at: 1 }],
        checks: [{ command: "npm test", passed: false, at: 2 }],
      }),
    );
    expect(v.block).toBe(true);
  });

  it("does not block on an edit that a later passing check covers, after a failed one", () => {
    const v = decideStop(
      ev({
        edits: [{ tool: "write", path: "a.ts", at: 1 }],
        checks: [
          { command: "npm test", passed: false, at: 2 },
          { command: "npm test", passed: true, at: 3 },
        ],
      }),
    );
    expect(v.block).toBe(false);
  });

  it("names the last passing check in the refusal", () => {
    const v = decideStop(
      ev({
        edits: [{ tool: "write", path: "a.ts", at: 5 }],
        checks: [{ command: "npm run lint", passed: true, at: 2 }],
      }),
    );
    expect(v.block).toBe(true);
    if (v.block) expect(v.lastCheck).toBe("npm run lint");
  });
});

describe("stopGateReason / verificationQuestions", () => {
  it("names the changed files and the last check", () => {
    const r = stopGateReason(["src/a.ts", "src/b.ts"], "npm test");
    expect(r).toContain("src/a.ts");
    expect(r).toContain("npm test");
    expect(r).toContain("no check applies");
  });

  it("says so when no check ever passed", () => {
    expect(stopGateReason([], null)).toContain("No check has passed");
  });

  it("asks exactly one question, phrased so only a no-op change reads yes", () => {
    const q = verificationQuestions(["README.md"]);
    expect(Object.keys(q)).toEqual(["needs_check"]);
    expect(q.needs_check.type).toBe("noul");
    expect(q.needs_check.instructions).toContain("README.md");
    expect(q.needs_check.instructions).toContain("yes only when");
  });
});

describe("module hygiene", () => {
  it("contains no interpolated shell-template artifacts", async () => {
    // A patch tool once left a literal `__omp_shell(...)` fragment inside a
    // boolean expression; it compiles nowhere and only fails at runtime. Guard
    // the whole source tree so the whole class stays dead.
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const e of readdirSync(dir)) {
        const fp = join(dir, e);
        if (statSync(fp).isDirectory()) out.push(...walk(fp));
        else if (e.endsWith(".ts") && !e.endsWith(".test.ts")) out.push(fp);
      }
      return out;
    };
    const bad = walk(join(import.meta.dirname, "..", "src")).filter((f) =>
      readFileSync(f, "utf8").includes("__omp" + "_shell"),
    );
    expect(bad).toEqual([]);
  });
});
