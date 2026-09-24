import { describe, it, expect } from "vitest";
import {
  THRESHOLDS,
  routeSkill,
  judgeDestructive,
  pickTool,
  chooseBrowserAction,
  rankCandidates,
  gateInjection,
  verifyStep,
  needsClarification,
  isDuplicate,
  routeEffort,
} from "../src/patterns.js";
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

describe("routeSkill", () => {
  it("returns null when there are no candidates", async () => {
    const { fetchImpl } = jevStub({});
    const r = await routeSkill({ apiKey: "k", fetchImpl }, "do a thing", []);
    expect(r.skill).toBeNull();
  });

  it("sends skill DESCRIPTIONS, not just names", async () => {
    const { fetchImpl, seen } = jevStub({
      best: { type: "choice", choice: "browser", confidence: 0.9, probabilities: {} },
    });
    await routeSkill({ apiKey: "k", fetchImpl }, "test the login page", [
      { name: "browser", description: "Automate browser interactions and run Playwright tests." },
      { name: "desktop", description: "OS-level window inspection and input." },
    ]);
    const criteria = seen[0].questions.best.criteria;
    expect(criteria.browser).toMatch(/Automate browser interactions/);
    expect(criteria.desktop).toMatch(/OS-level window/);
  });

  it("abstains below the confidence floor", async () => {
    const { fetchImpl } = jevStub({
      best: { type: "choice", choice: "browser", confidence: 0.3, probabilities: {} },
    });
    const r = await routeSkill({ apiKey: "k", fetchImpl }, "x", [{ name: "browser" }]);
    expect(r.skill).toBeNull();
  });

  it("treats an explicit none as no match", async () => {
    const { fetchImpl } = jevStub({
      best: { type: "choice", choice: "none", confidence: 0.99, probabilities: {} },
    });
    const r = await routeSkill({ apiKey: "k", fetchImpl }, "write a haiku", [{ name: "browser" }]);
    expect(r.skill).toBeNull();
  });

  it("caps the candidate list", async () => {
    const { fetchImpl, seen } = jevStub({
      best: { type: "choice", choice: "s1", confidence: 0.9, probabilities: {} },
    });
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `s${i}` }));
    await routeSkill({ apiKey: "k", fetchImpl }, "x", many, { maxCandidates: 5 });
    expect(Object.keys(seen[0].questions.best.criteria)).toHaveLength(6); // 5 + none
  });

  it("throws a usage error for a candidate literally named none", async () => {
    const { fetchImpl, seen } = jevStub({});
    await expect(routeSkill({ apiKey: "k", fetchImpl }, "x", [{ name: "none" }])).rejects.toThrow(
      /reserved/,
    );
    expect(seen).toHaveLength(0);
  });
});

describe("judgeDestructive", () => {
  it("blocks at or above the threshold", async () => {
    const { fetchImpl } = jevStub({ destructive: { type: "noul", noul: 0.84 } });
    const r = await judgeDestructive(
      { apiKey: "k", fetchImpl },
      { tool: "bash", input: { cmd: "rm -rf /" } },
    );
    expect(r.blocked).toBe(true);
  });

  it("allows below the threshold", async () => {
    const { fetchImpl } = jevStub({ destructive: { type: "noul", noul: 0.01 } });
    const r = await judgeDestructive(
      { apiKey: "k", fetchImpl },
      { tool: "bash", input: { cmd: "git status" } },
    );
    expect(r.blocked).toBe(false);
  });

  it("honours a custom threshold", async () => {
    const { fetchImpl } = jevStub({ destructive: { type: "noul", noul: 0.6 } });
    const r = await judgeDestructive(
      { apiKey: "k", fetchImpl },
      { tool: "bash", input: {} },
      { threshold: 0.5 },
    );
    expect(r.blocked).toBe(true);
  });
});

describe("pickTool", () => {
  it("flags confirmation when the risk score is high", async () => {
    const { fetchImpl } = jevStub({
      tool: { type: "choice", choice: "bash", confidence: 0.97, probabilities: {} },
      risky: { type: "noul", noul: 0.64 },
    });
    const r = await pickTool(
      { apiKey: "k", fetchImpl },
      { task: "rename files", tools: [{ name: "bash", description: "run a command" }] },
    );
    expect(r.tool).toBe("bash");
    expect(r.confirmRequired).toBe(true);
  });

  it("does not act on a low-confidence pick", async () => {
    const { fetchImpl } = jevStub({
      tool: { type: "choice", choice: "bash", confidence: 0.2, probabilities: {} },
      risky: { type: "noul", noul: 0.1 },
    });
    const r = await pickTool(
      { apiKey: "k", fetchImpl },
      { task: "x", tools: [{ name: "bash", description: "d" }] },
    );
    expect(r.act).toBe(false);
  });

  it("returns a null pick for an empty tool list without calling Jev", async () => {
    const { fetchImpl, seen } = jevStub({});
    const r = await pickTool({ apiKey: "k", fetchImpl }, { task: "x", tools: [] });
    expect(r.tool).toBeNull();
    expect(seen).toHaveLength(0);
  });

  it("throws a usage error for a tool literally named none", async () => {
    const { fetchImpl, seen } = jevStub({});
    await expect(
      pickTool(
        { apiKey: "k", fetchImpl },
        { task: "x", tools: [{ name: "none", description: "d" }] },
      ),
    ).rejects.toThrow(/reserved/);
    expect(seen).toHaveLength(0);
  });
});

describe("chooseBrowserAction", () => {
  it("returns the operation and its matching target", async () => {
    const { fetchImpl } = jevStub({
      operation: { type: "choice", choice: "CLICK", confidence: 0.84, probabilities: {} },
      click_target: { type: "choice", choice: "1", confidence: 0.9, probabilities: {} },
    });
    const r = await chooseBrowserAction(
      { apiKey: "k", fetchImpl },
      {
        goal: "search",
        page: { url: "https://example.com" },
        elements: [{ index: "1", label: "Search", operations: ["CLICK", "TYPE_TEXT"] }],
      },
    );
    expect(r.operation).toBe("CLICK");
    expect(r.target).toBe("1");
    expect(r.act).toBe(true);
  });

  it("only asks for targets of operations present in the snapshot", async () => {
    const { fetchImpl, seen } = jevStub({
      operation: { type: "choice", choice: "CLICK", confidence: 0.9, probabilities: {} },
      click_target: { type: "choice", choice: "1", confidence: 0.9, probabilities: {} },
    });
    await chooseBrowserAction(
      { apiKey: "k", fetchImpl },
      {
        goal: "g",
        page: { url: "u" },
        elements: [{ index: "1", label: "L", operations: ["CLICK"] }],
      },
    );
    const q = seen[0].questions;
    expect(q.click_target).toBeDefined();
    expect(q.type_text_target).toBeUndefined();
    expect(q.select_target).toBeUndefined();
  });

  it("does not act on a low-confidence operation", async () => {
    const { fetchImpl } = jevStub({
      operation: { type: "choice", choice: "CLICK", confidence: 0.2, probabilities: {} },
    });
    const r = await chooseBrowserAction(
      { apiKey: "k", fetchImpl },
      {
        goal: "g",
        page: { url: "u" },
        elements: [{ index: "1", label: "L", operations: ["CLICK"] }],
      },
    );
    expect(r.act).toBe(false);
  });

  it("caps the element list and page text, flagging truncation", async () => {
    const { fetchImpl, seen } = jevStub({
      operation: { type: "choice", choice: "CLICK", confidence: 0.9, probabilities: {} },
      click_target: { type: "choice", choice: "none", confidence: 0.9, probabilities: {} },
    });
    const many = Array.from({ length: 40 }, (_, i) => ({
      index: String(i),
      label: "L".repeat(600),
      operations: ["CLICK"] as string[],
    }));
    const r = await chooseBrowserAction(
      { apiKey: "k", fetchImpl },
      {
        goal: "g",
        page: { url: "u", text: "t".repeat(9000) },
        elements: many,
      },
    );
    expect(r.truncated).toBe(true);
    expect(seen[0].state.elements).toHaveLength(30);
    expect((seen[0].state.elements as Array<{ label: string }>)[0].label).toHaveLength(500);
    expect((seen[0].state.page as { text: string }).text).toHaveLength(8000);
  });

  it("reports truncated false when nothing exceeds a cap", async () => {
    const { fetchImpl } = jevStub({
      operation: { type: "choice", choice: "CLICK", confidence: 0.9, probabilities: {} },
      click_target: { type: "choice", choice: "none", confidence: 0.9, probabilities: {} },
    });
    const r = await chooseBrowserAction(
      { apiKey: "k", fetchImpl },
      {
        goal: "g",
        page: { url: "u", text: "short" },
        elements: [{ index: "1", label: "L", operations: ["CLICK"] }],
      },
    );
    expect(r.truncated).toBe(false);
  });

  it("throws a usage error for an element literally indexed none", async () => {
    const { fetchImpl, seen } = jevStub({});
    await expect(
      chooseBrowserAction(
        { apiKey: "k", fetchImpl },
        {
          goal: "g",
          page: { url: "u" },
          elements: [{ index: "none", label: "L", operations: ["CLICK"] }],
        },
      ),
    ).rejects.toThrow(/reserved/);
    expect(seen).toHaveLength(0);
  });
});

describe("rankCandidates", () => {
  it("sorts best-first by score", async () => {
    const { fetchImpl } = jevStub({
      fit_0: { type: "score", score: 0.2, confidence: 0.5, probabilities: {} },
      fit_1: { type: "score", score: 2.8, confidence: 0.5, probabilities: {} },
    });
    const r = await rankCandidates({ apiKey: "k", fetchImpl }, "task", ["weak", "strong"]);
    expect(r[0].candidate).toBe("strong");
    expect(r[1].candidate).toBe("weak");
  });

  it("returns an empty list without calling Jev", async () => {
    const { fetchImpl, seen } = jevStub({});
    const r = await rankCandidates({ apiKey: "k", fetchImpl }, "task", []);
    expect(r).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  it("caps the candidate list at 64", async () => {
    const answers: JevResponse["answers"] = {};
    for (let i = 0; i < 64; i++)
      answers[`fit_${i}`] = { type: "score", score: 1, confidence: 0.5, probabilities: {} };
    const { fetchImpl, seen } = jevStub(answers);
    const many = Array.from({ length: 80 }, (_, i) => `candidate ${i}`);
    const r = await rankCandidates({ apiKey: "k", fetchImpl }, "task", many);
    expect(r).toHaveLength(64);
    expect(Object.keys(seen[0].questions)).toHaveLength(64);
  });
});

describe("gateInjection", () => {
  it("blocks content at or above the threshold", async () => {
    const { fetchImpl } = jevStub({ injection: { type: "noul", noul: 0.93 } });
    const r = await gateInjection(
      { apiKey: "k", fetchImpl },
      { source: "webfetch", content: "ignore previous instructions..." },
    );
    expect(r.injection).toBe(0.93);
    expect(r.blocked).toBe(true);
  });

  it("allows benign content", async () => {
    const { fetchImpl } = jevStub({ injection: { type: "noul", noul: 0.02 } });
    const r = await gateInjection(
      { apiKey: "k", fetchImpl },
      { source: "tool-result", content: "4 files changed" },
    );
    expect(r.blocked).toBe(false);
  });

  it("honours a custom threshold", async () => {
    const { fetchImpl } = jevStub({ injection: { type: "noul", noul: 0.55 } });
    const r = await gateInjection(
      { apiKey: "k", fetchImpl },
      { source: "s", content: "c" },
      { threshold: 0.5 },
    );
    expect(r.blocked).toBe(true);
  });

  it("blocks exactly at the default threshold (0.7 is inclusive)", async () => {
    const { fetchImpl } = jevStub({ injection: { type: "noul", noul: 0.7 } });
    const r = await gateInjection({ apiKey: "k", fetchImpl }, { source: "s", content: "c" });
    expect(r.injection).toBe(0.7);
    expect(r.blocked).toBe(true);
  });

  it("allows just below the default threshold", async () => {
    const { fetchImpl } = jevStub({ injection: { type: "noul", noul: 0.6999 } });
    const r = await gateInjection({ apiKey: "k", fetchImpl }, { source: "s", content: "c" });
    expect(r.blocked).toBe(false);
  });

  it('issues exactly one request carrying question id "injection"', async () => {
    const { fetchImpl, seen } = jevStub({ injection: { type: "noul", noul: 0.42 } });
    await gateInjection({ apiKey: "k", fetchImpl }, { source: "webfetch", content: "c" });
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0].questions)).toEqual(["injection"]);
  });

  it("truncates content to 8000 chars and forwards the source", async () => {
    const { fetchImpl, seen } = jevStub({ injection: { type: "noul", noul: 0.1 } });
    await gateInjection(
      { apiKey: "k", fetchImpl },
      { source: "webfetch", content: "c".repeat(9000) },
    );
    expect(seen[0].state.source).toBe("webfetch");
    expect(seen[0].state.content).toHaveLength(8000);
  });

  it("rejects on a missing answer rather than guessing", async () => {
    const { fetchImpl } = jevStub({});
    await expect(
      gateInjection({ apiKey: "k", fetchImpl }, { source: "s", content: "c" }),
    ).rejects.toThrow(/not a valid noul/);
  });

  it("rejects on an unparseable answer", async () => {
    const { fetchImpl } = jevStub({
      injection: { type: "noul", noul: "high" },
    } as unknown as JevResponse["answers"]);
    await expect(
      gateInjection({ apiKey: "k", fetchImpl }, { source: "s", content: "c" }),
    ).rejects.toThrow(/not a valid noul/);
  });
});

describe("verifyStep", () => {
  it("marks the step done at or above the threshold", async () => {
    const { fetchImpl, seen } = jevStub({ complete: { type: "noul", noul: 0.88 } });
    const r = await verifyStep(
      { apiKey: "k", fetchImpl },
      { task: "fix the login redirect", report: "Changed X; tests pass." },
    );
    expect(r.complete).toBe(0.88);
    expect(r.done).toBe(true);
    expect(seen[0].state.task).toBe("fix the login redirect");
  });

  it("keeps looping on partial work", async () => {
    const { fetchImpl } = jevStub({ complete: { type: "noul", noul: 0.3 } });
    const r = await verifyStep({ apiKey: "k", fetchImpl }, { task: "t", report: "half done" });
    expect(r.done).toBe(false);
  });
});

describe("needsClarification", () => {
  it("flags a genuine fork", async () => {
    const { fetchImpl } = jevStub({ ambiguous: { type: "noul", noul: 0.81 } });
    const r = await needsClarification(
      { apiKey: "k", fetchImpl },
      { message: "update the config" },
    );
    expect(r.ambiguous).toBe(0.81);
    expect(r.ask).toBe(true);
  });

  it("lets an unambiguous request through", async () => {
    const { fetchImpl } = jevStub({ ambiguous: { type: "noul", noul: 0.1 } });
    const r = await needsClarification(
      { apiKey: "k", fetchImpl },
      { message: "bump eslint to 9.0 in package.json" },
    );
    expect(r.ask).toBe(false);
  });
});

describe("isDuplicate", () => {
  it("asks one batched noul per candidate and filters by threshold", async () => {
    const { fetchImpl, seen } = jevStub({
      dup_0: { type: "noul", noul: 0.92 },
      dup_1: { type: "noul", noul: 0.11 },
    });
    const r = await isDuplicate({ apiKey: "k", fetchImpl }, "please fix the flaky login test", [
      "login test is flaky, fix it",
      "dark mode toggle broken",
    ]);
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0].questions)).toEqual(["dup_0", "dup_1"]);
    expect(r.duplicates).toEqual(["login test is flaky, fix it"]);
    expect(r.any).toBe(true);
    expect(r.scores[1].probability).toBe(0.11);
  });

  it("keeps per-question instructions short — the item rides in state", async () => {
    const { fetchImpl, seen } = jevStub({ dup_0: { type: "noul", noul: 0.9 } });
    await isDuplicate({ apiKey: "k", fetchImpl }, "x".repeat(5000), ["y".repeat(5000)]);
    const instructions = String(seen[0].questions.dup_0.instructions);
    expect(instructions).not.toMatch(/INCOMING/);
    expect(instructions.length).toBeLessThan(2500);
    expect(String(seen[0].state.item)).toHaveLength(2000);
  });

  it("short-circuits on an empty candidate list", async () => {
    const { fetchImpl, seen } = jevStub({});
    const r = await isDuplicate({ apiKey: "k", fetchImpl }, "item", []);
    expect(r).toEqual({ duplicates: [], any: false, scores: [] });
    expect(seen).toHaveLength(0);
  });

  it("scores a missing answer as 0 instead of dropping the candidate", async () => {
    const { fetchImpl } = jevStub({ dup_0: { type: "noul", noul: 0.9 } });
    const r = await isDuplicate({ apiKey: "k", fetchImpl }, "item", ["kept", "unanswered"]);
    expect(r.scores).toEqual([
      { candidate: "kept", probability: 0.9 },
      { candidate: "unanswered", probability: 0 },
    ]);
    expect(r.duplicates).toEqual(["kept"]);
  });

  it("caps candidates at 64 by default and honours maxCandidates", async () => {
    const { fetchImpl, seen } = jevStub({});
    await isDuplicate(
      { apiKey: "k", fetchImpl },
      "item",
      Array.from({ length: 70 }, (_, i) => `c${i}`),
    );
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0].questions)).toHaveLength(64);
    expect(Object.keys(seen[0].questions)[63]).toBe("dup_63");

    const { fetchImpl: f2, seen: s2 } = jevStub({});
    await isDuplicate({ apiKey: "k", fetchImpl: f2 }, "item", ["a", "b", "c"], {
      maxCandidates: 2,
    });
    expect(Object.keys(s2[0].questions)).toEqual(["dup_0", "dup_1"]);
  });

  it("truncates each candidate to 2000 chars in its own question", async () => {
    const { fetchImpl, seen } = jevStub({ dup_0: { type: "noul", noul: 0.1 } });
    await isDuplicate({ apiKey: "k", fetchImpl }, "i".repeat(5000), ["y".repeat(5000)]);
    expect(String(seen[0].state.item)).toHaveLength(2000);
    expect(String(seen[0].questions.dup_0.instructions)).toContain("y".repeat(2000));
    expect(String(seen[0].questions.dup_0.instructions)).not.toContain("y".repeat(2001));
  });
});

describe("routeEffort", () => {
  it("sends hard tasks to the expensive model", async () => {
    const { fetchImpl } = jevStub({ hard: { type: "noul", noul: 0.87 } });
    const r = await routeEffort({ apiKey: "k", fetchImpl }, { task: "redesign the sync protocol" });
    expect(r.hard).toBe(0.87);
    expect(r.useExpensive).toBe(true);
  });

  it("keeps routine work on the cheap tier", async () => {
    const { fetchImpl } = jevStub({ hard: { type: "noul", noul: 0.08 } });
    const r = await routeEffort({ apiKey: "k", fetchImpl }, { task: "rename this variable" });
    expect(r.useExpensive).toBe(false);
  });
});

describe("THRESHOLDS (frozen tuned constants)", () => {
  it("is frozen, so a caller cannot retune it by accident", () => {
    expect(Object.isFrozen(THRESHOLDS)).toBe(true);
  });

  it("pins every value added by the escalate/prune/review pass", () => {
    // Provenance lives in the THRESHOLDS comments (MEASURED vs PROVISIONAL);
    // this test exists so a silent retune breaks CI instead of drifting.
    expect(THRESHOLDS.escalateBelow).toBe(0.6);
    expect(THRESHOLDS.uncertainBandLow).toBe(0.3);
    expect(THRESHOLDS.uncertainBandHigh).toBe(0.7);
    expect(THRESHOLDS.pruneKeep).toBe(0.5);
    expect(THRESHOLDS.pruneDrop).toBe(0.25);
    expect(THRESHOLDS.pruneErrorDrop).toBe(0.1);
    expect(THRESHOLDS.refute).toBe(0.75);
    expect(THRESHOLDS.findingReal).toBe(0.5);
  });

  it("keeps the noul uncertainty band well-formed", () => {
    expect(THRESHOLDS.uncertainBandLow).toBeLessThan(THRESHOLDS.uncertainBandHigh);
    expect(THRESHOLDS.uncertainBandLow).toBeGreaterThan(0);
    expect(THRESHOLDS.uncertainBandHigh).toBeLessThan(1);
  });

  it("keeps the prune bars ordered (drop < keep, error bar strictly lowest)", () => {
    expect(THRESHOLDS.pruneDrop).toBeLessThan(THRESHOLDS.pruneKeep);
    expect(THRESHOLDS.pruneErrorDrop).toBeLessThan(THRESHOLDS.pruneDrop);
  });
});
