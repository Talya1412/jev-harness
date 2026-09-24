import { afterEach, describe, expect, it, vi } from "vitest";
import { callTool, handleTool, TOOLS } from "../src/server.js";

const ENV_KEYS = ["TYPESAFE_API_KEY", "TYPESAFE_BASE_URL", "TYPESAFE_DEFAULT_MODEL"] as const;

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) delete process.env[k];
});

/** The tool surface is a contract: clients cache it, so a rename breaks callers. */
describe("MCP tool list", () => {
  const names = TOOLS.map((t) => t.name);

  it("exposes the documented tools with unique names", () => {
    expect(names).toEqual([
      "jev_ask",
      "jev_models",
      "jev_route_skills",
      "jev_pick_tool",
      "jev_judge_destructive",
      "jev_browse_action",
      "jev_rank",
      "jev_classify",
      "jev_escalate",
      "jev_prune",
      "jev_finding_realness",
      "jev_refute",
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("uses safe identifier names that MCP clients will not mangle", () => {
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("gives every tool a description and an object schema", () => {
    for (const tool of TOOLS) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(tool.inputSchema.properties, tool.name).toBeTypeOf("object");
    }
  });

  it("requires the arguments a handler cannot default", () => {
    const byName = new Map(TOOLS.map((t) => [t.name, t]));
    expect(byName.get("jev_ask")!.inputSchema.required).toEqual(["state", "questions"]);
    expect(byName.get("jev_judge_destructive")!.inputSchema.required).toEqual(["tool", "input"]);
    expect(byName.get("jev_pick_tool")!.inputSchema.required).toEqual(["task", "tools"]);
    expect(byName.get("jev_rank")!.inputSchema.required).toEqual(["task", "candidates"]);
    expect(byName.get("jev_classify")!.inputSchema.required).toEqual(["items", "questions"]);
    expect(byName.get("jev_browse_action")!.inputSchema.required).toEqual([
      "goal",
      "page",
      "elements",
    ]);
    expect(byName.get("jev_escalate")!.inputSchema.required).toEqual([
      "state",
      "questions",
      "gateQuestionId",
    ]);
    expect(byName.get("jev_prune")!.inputSchema.required).toEqual(["items"]);
    expect(byName.get("jev_finding_realness")!.inputSchema.required).toEqual(["finding"]);
    expect(byName.get("jev_refute")!.inputSchema.required).toEqual(["findings"]);
  });

  it("declares no required arguments for the argument-free tools", () => {
    const byName = new Map(TOOLS.map((t) => [t.name, t]));
    expect(byName.get("jev_models")!.inputSchema.required).toBeUndefined();
  });

  it("tells the caller that a destructive verdict can be unknown, not safe", () => {
    const tool = TOOLS.find((t) => t.name === "jev_judge_destructive")!;
    // An isError result means the judgment failed; treating that as "safe"
    // would silently disable the gate on any Jev outage.
    expect(tool.description).toMatch(/isError/);
    expect(tool.description).toMatch(/unknown, not as confirmed-safe/);
  });

  it("marks the advisory tools as non-executing", () => {
    for (const name of ["jev_browse_action", "jev_pick_tool"]) {
      const tool = TOOLS.find((t) => t.name === name)!;
      expect(tool.description, name).toMatch(/[Dd]oes not execute/);
    }
  });
});

/**
 * jev_classify — one request per item, an optional reduce over the capped
 * digest of verdicts, and per-item failure reporting. The fetch stub below
 * answers like the Jev API and records every request body.
 */
function jevFetch(opts: { fail400For?: (body: any) => boolean } = {}) {
  const bodies: any[] = [];
  const impl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (opts.fail400For?.(body)) {
      return new Response("bad item payload", { status: 400 });
    }
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions ?? {})) {
      // Deterministic per item, so assertions can name the item they check.
      const item = JSON.stringify(body.state?.item ?? "");
      answers[id] = { type: "noul", noul: item.length / 100 };
    }
    return new Response(
      JSON.stringify({
        model: body.model,
        answers,
        usage: { input_tokens: 10, output_tokens: 1 },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { impl, bodies };
}

/** Every request whose state is an item (not the reduce digest). */
const itemBodies = (bodies: any[]) => bodies.filter((b) => !("answers" in b.state));

describe("jev_classify", () => {
  it("asks the same questions of every item: one request per item", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const items = ["a", "bb", "ccc"];
    const { impl, bodies } = jevFetch();
    vi.stubGlobal("fetch", impl);
    const result: any = await handleTool("jev_classify", {
      items,
      questions: { q: { type: "noul", instructions: "is it good?" } },
    });
    expect(bodies).toHaveLength(3);
    expect(bodies.map((b) => b.state.item).sort()).toEqual(items);
    expect(result.perItem).toHaveLength(3);
    for (const entry of result.perItem) {
      expect(Object.keys(entry)).toEqual(["q"]);
    }
    // item "bb" -> its serialized length drives the stub verdict
    expect(result.perItem[1].q.noul).toBeCloseTo(0.045);
    expect(result.reduced).toBeNull();
    expect(result.failures).toEqual([]);
    expect(result.usage).toEqual({ input_tokens: 30, output_tokens: 3 });
  });

  it("judges the reduce over a capped digest of answers, never the corpus", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    // 230 items so the 200-item digest cap actually bites.
    const items = Array.from({ length: 230 }, (_, i) => "corpus-item-" + i);
    const { impl, bodies } = jevFetch();
    vi.stubGlobal("fetch", impl);
    const result: any = await handleTool("jev_classify", {
      items,
      questions: { q: { type: "noul", instructions: "is it good?" } },
      reduce: {
        instructions: "summarize the verdicts",
        criteria: ["bad", "good"],
      },
    });
    expect(itemBodies(bodies)).toHaveLength(230);
    const reduceBodies = bodies.filter((b) => "answers" in b.state);
    expect(reduceBodies).toHaveLength(1);
    const digest = reduceBodies[0].state;
    expect(digest.item_count).toBe(230);
    expect(digest.answers).toHaveLength(200);
    expect(digest.omitted_items).toBe(30);
    // The digest holds verdicts only: no corpus text, no item questions.
    expect(JSON.stringify(digest)).not.toContain("corpus-item");
    expect(typeof result.reduced.noul).toBe("number");
    // one reduce request on top of the 230 item requests
    expect(result.usage).toEqual({ input_tokens: 231 * 10, output_tokens: 231 * 1 });
  });

  it("honours the 4000-char digest cap before the item cap", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    // 200 items x 12 questions is far past 4k chars of digest lines.
    const questions: Record<string, unknown> = {};
    for (let i = 0; i < 12; i++) {
      questions["question_number_" + i] = { type: "noul", instructions: "is it good?" };
    }
    const { impl, bodies } = jevFetch();
    vi.stubGlobal("fetch", impl);
    const result: any = await handleTool("jev_classify", {
      items: Array.from({ length: 200 }, (_, i) => i),
      questions,
      reduce: { instructions: "summarize the verdicts", criteria: ["bad", "good"] },
    });
    const digest = bodies.filter((b) => "answers" in b.state)[0].state;
    expect(digest.answers.length).toBeGreaterThan(0);
    expect(digest.answers.length).toBeLessThan(200);
    const chars = digest.answers.join("\n").length;
    expect(chars).toBeLessThanOrEqual(4000);
    expect(digest.omitted_items).toBe(200 - digest.answers.length);
    expect(result.reduced).not.toBeNull();
  });

  it("names the failed items and still answers the rest", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const { impl, bodies } = jevFetch({
      fail400For: (body) => body.state?.item === "poison",
    });
    vi.stubGlobal("fetch", impl);
    const result: any = await handleTool("jev_classify", {
      items: ["ok-1", "poison", "ok-2"],
      questions: { q: { type: "noul", instructions: "is it good?" } },
      reduce: { instructions: "summarize", criteria: ["bad", "good"] },
    });
    // First attempt batches all three and is rejected, then each item is
    // retried alone: 3 + 3 requests, and no reduce (the digest is incomplete).
    expect(itemBodies(bodies)).toHaveLength(6);
    expect(bodies.filter((b) => "answers" in b.state)).toHaveLength(0);
    expect(result.failures).toEqual([{ index: 1, error: expect.stringContaining("400") }]);
    expect(result.perItem[0]).toHaveProperty("q");
    expect(result.perItem[1]).toBeNull();
    expect(result.perItem[2]).toHaveProperty("q");
    expect(result.reduced).toBeNull();
    expect(result.reduceSkipped).toContain("1 of 3");
  });

  it("keeps auth failures batch-level instead of retrying every item", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const bodies: any[] = [];
    vi.stubGlobal("fetch", (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response("nope", { status: 401 });
    }) as unknown as typeof fetch);
    await expect(
      handleTool("jev_classify", {
        items: ["a"],
        questions: { q: { type: "noul", instructions: "ok?" } },
      }),
    ).rejects.toThrow(/401/);
    // Exactly one attempt: an auth failure is batch-level, so there is no
    // item-by-item retry (that path would have spent two requests per item).
    expect(bodies).toHaveLength(1);
  });

  it("fails clearly when the API key is missing", async () => {
    const { impl, bodies } = jevFetch();
    vi.stubGlobal("fetch", impl);
    await expect(
      handleTool("jev_classify", {
        items: ["a"],
        questions: { q: { type: "noul", instructions: "ok?" } },
      }),
    ).rejects.toThrow(/TYPESAFE_API_KEY is not set/);
    expect(bodies).toHaveLength(0);
  });

  it("rejects a reduce missing its criteria", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const { impl } = jevFetch();
    vi.stubGlobal("fetch", impl);
    await expect(
      handleTool("jev_classify", {
        items: ["a"],
        questions: { q: { type: "noul", instructions: "ok?" } },
        reduce: { instructions: "summarize" },
      }),
    ).rejects.toThrow(/reduce\.criteria/);
  });
});

/**
 * The four pattern tools — one stub that answers each question id from a
 * caller-provided function and records every request body. Answering with
 * `undefined` omits that id from the response (a missing answer, which core
 * must treat as unjudged rather than as a verdict).
 */
function patternFetch(answer: (id: string, body: any, index: number) => unknown) {
  const bodies: any[] = [];
  const impl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions ?? {})) {
      const value = answer(id, body, bodies.length);
      if (value !== undefined) answers[id] = value;
    }
    return new Response(JSON.stringify({ model: body.model, answers }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, bodies };
}

describe("jev_escalate", () => {
  it("accepted gate: ONE request; question ids asserted; first answers mapped", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const { impl, bodies } = patternFetch((id) =>
      id === "gate"
        ? { type: "choice", choice: "yes", confidence: 0.9 }
        : { type: "noul", noul: 0.71 },
    );
    vi.stubGlobal("fetch", impl);
    const result: any = await handleTool("jev_escalate", {
      state: { topic: "release" },
      questions: {
        gate: { type: "choice", instructions: "confident?", criteria: { yes: "go", stop: "hold" } },
        ship: { type: "noul", instructions: "ship the release?" },
      },
      gateQuestionId: "gate",
    });
    // A confident gate decides on the spot: exactly one request.
    expect(bodies).toHaveLength(1);
    expect(Object.keys(bodies[0].questions)).toEqual(["gate", "ship"]);
    expect(result.outcome).toBe("accepted");
    expect(result.escalated).toBe(false);
    expect(result.target).toBe("none");
    expect(result.gateScore).toBe(0.9);
    expect(result.threshold).toBe(0.6);
    expect(result.answers.ship.noul).toBe(0.71);
    expect(result.first.ship.noul).toBe(0.71);
    expect(result.second).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it("uncertain gate + secondModel: TWO requests, same questions, no first answers passed", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const { impl, bodies } = patternFetch((id, _body, index) => {
      const first = index === 1;
      if (id === "gate") {
        return { type: "choice", choice: first ? "no" : "yes", confidence: first ? 0.3 : 0.95 };
      }
      return { type: "noul", noul: first ? 0.55 : 0.9 };
    });
    vi.stubGlobal("fetch", impl);
    const result: any = await handleTool("jev_escalate", {
      state: { topic: "release" },
      questions: {
        gate: { type: "choice", instructions: "confident?", criteria: { yes: "go", stop: "hold" } },
        ship: { type: "noul", instructions: "ship the release?" },
      },
      gateQuestionId: "gate",
      secondModel: "jev-second",
    });
    expect(bodies).toHaveLength(2);
    // The escalation pass runs on the model override; the first pass does not.
    expect(bodies[0].model).not.toBe("jev-second");
    expect(bodies[1].model).toBe("jev-second");
    // Anchor-free re-ask: SAME state, SAME questions, NO first answers passed.
    expect(bodies[1].questions).toEqual(bodies[0].questions);
    expect(bodies[1].state).toEqual(bodies[0].state);
    expect(bodies[1].state).not.toHaveProperty("answers");
    expect(JSON.stringify(bodies[1])).not.toContain('"answers"');
    expect(result.outcome).toBe("escalated");
    expect(result.target).toBe("second-config");
    expect(result.escalated).toBe(true);
    expect(result.gateScore).toBe(0.3);
    expect(result.answers.ship.noul).toBe(0.9);
    expect(result.second.ship.noul).toBe(0.9);
    expect(result.first.ship.noul).toBe(0.55);
    expect(result.error).toBeUndefined();
  });
});

describe("jev_prune", () => {
  it("one noul per candidate id; a drop returns replacement text, a keep returns none", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const longText = "lorem ".repeat(70); // 420 chars > headChars 300
    const { impl, bodies } = patternFetch((id) => ({
      type: "noul",
      noul: id === "log-drop" ? 0.2 : 0.9,
    }));
    vi.stubGlobal("fetch", impl);
    const result: any = await handleTool("jev_prune", {
      items: [
        { id: "log-drop", text: longText, kind: "output" },
        { id: "log-keep", text: "short enough to judge", kind: "output" },
      ],
      minChars: 1,
    });
    expect(bodies).toHaveLength(1);
    expect(Object.keys(bodies[0].questions)).toEqual(["log-drop", "log-keep"]);
    expect(bodies[0].state.items).toHaveLength(2);
    expect(result.deferred).toBe(false);
    expect(result.reason).toBeUndefined();
    const [drop, keep] = result.decisions;
    // 0.2 < keep 0.5 and <= drop 0.25 → drop, non-destructively.
    expect(drop.id).toBe("log-drop");
    expect(drop.keep).toBe(false);
    expect(drop.score).toBe(0.2);
    expect(drop.chars).toBe(longText.length);
    expect(drop.omittedChars).toBe(120);
    expect(drop.replacement.startsWith(longText.slice(0, 300))).toBe(true);
    expect(drop.replacement).toContain(
      "120 chars omitted by jev prune; id=log-drop — original retained by caller]",
    );
    // 0.9 keeps: no replacement text at all.
    expect(keep.id).toBe("log-keep");
    expect(keep.keep).toBe(true);
    expect(keep.score).toBe(0.9);
    expect(keep.replacement).toBeUndefined();
  });

  it("oversized state defers with ZERO fetch calls and all-keep decisions", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const { impl, bodies } = patternFetch(() => ({ type: "noul", noul: 0 }));
    vi.stubGlobal("fetch", impl);
    const result: any = await handleTool("jev_prune", {
      items: [{ id: "big", text: "y".repeat(64), kind: "output" }],
      maxStateTokens: 1,
    });
    expect(bodies).toHaveLength(0);
    expect(result.deferred).toBe(true);
    expect(result.reason).toBe("state-too-large");
    expect(result.decisions).toEqual([{ id: "big", keep: true, score: 1, chars: 64 }]);
  });
});

describe("jev_finding_realness", () => {
  it("asks realness + severity, maps the 4-field result, never sends caller metadata", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const { impl, bodies } = patternFetch((id) =>
      id === "realness"
        ? { type: "noul", noul: 0.82 }
        : { type: "choice", choice: "high", confidence: 0.9 },
    );
    vi.stubGlobal("fetch", impl);
    const result: any = await handleTool("jev_finding_realness", {
      finding: {
        path: "src/a.ts",
        content: "off-by-one in the loop bound",
        severity: "low",
        category: "bug",
      },
    });
    expect(bodies).toHaveLength(1);
    expect(Object.keys(bodies[0].questions)).toEqual(["realness", "severity"]);
    // Caller severity/category are metadata only: state is path + content.
    expect(bodies[0].state).toEqual({
      path: "src/a.ts",
      content: "off-by-one in the loop bound",
    });
    // 0.82 >= default 0.5 → report; the model's label wins, ours is recorded.
    expect(result).toEqual({
      realness: 0.82,
      report: true,
      severity: "high",
      severityProvided: true,
    });
  });
});

describe("jev_refute", () => {
  it("asks refute_i + class_i per finding and maps refuted/kept/scores", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const rows: Record<string, unknown> = {
      refute_0: { type: "noul", noul: 0.9 },
      class_0: { type: "choice", choice: "ordinary", confidence: 0.8 },
      refute_1: { type: "noul", noul: 0.2 },
      class_1: { type: "choice", choice: "concurrency", confidence: 0.9 },
    };
    const { impl, bodies } = patternFetch((id) => rows[id]);
    vi.stubGlobal("fetch", impl);
    const result: any = await handleTool("jev_refute", {
      findings: [
        { path: "src/a.ts", content: "unused variable" },
        { path: "src/b.ts", content: "race on shutdown" },
      ],
    });
    expect(bodies).toHaveLength(1);
    expect(Object.keys(bodies[0].questions)).toEqual([
      "refute_0",
      "class_0",
      "refute_1",
      "class_1",
    ]);
    expect(bodies[0].state.findings.map((f: any) => f.index)).toEqual([0, 1]);
    // 0.9 >= default 0.75 AND classed ordinary → refuted.
    expect(result.refuted).toEqual([{ index: 0, score: 0.9, reason: expect.any(String) }]);
    // 0.2 below the bar and a protected class → kept.
    expect(result.kept).toEqual([{ index: 1, score: 0.2, protectedSubject: true }]);
    expect(result.scores).toEqual([
      { index: 0, probability: 0.9, cls: "ordinary", protectedSubject: false },
      { index: 1, probability: 0.2, cls: "concurrency", protectedSubject: true },
    ]);
  });

  it("a missing refute answer keeps the finding — unjudged is never a verdict", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const { impl, bodies } = patternFetch((id) =>
      id === "refute_0" ? undefined : { type: "choice", choice: "ordinary", confidence: 0.8 },
    );
    vi.stubGlobal("fetch", impl);
    const result: any = await handleTool("jev_refute", {
      findings: [{ path: "src/a.ts", content: "unused variable" }],
    });
    expect(bodies).toHaveLength(1);
    expect(result.refuted).toEqual([]);
    expect(result.kept).toEqual([{ index: 0, score: -1, protectedSubject: false }]);
    expect(result.scores).toEqual([
      { index: 0, probability: -1, cls: "ordinary", protectedSubject: false },
    ]);
  });
});

describe("fail-open envelope (callTool)", () => {
  it("a first-pass transport throw becomes an isError result, never a thrown crash", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    vi.stubGlobal("fetch", (async () => {
      throw new Error("mock transport outage");
    }) as unknown as typeof fetch);
    const result: any = await callTool("jev_escalate", {
      state: { topic: "release" },
      questions: { gate: { type: "noul", instructions: "sure?" } },
      gateQuestionId: "gate",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("mock transport outage");
  });
});
