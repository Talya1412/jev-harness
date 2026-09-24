import { afterEach, describe, expect, it, vi } from "vitest";
import { handleTool, TOOLS } from "../src/server.js";

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
