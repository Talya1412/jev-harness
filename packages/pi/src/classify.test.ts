import { afterEach, describe, expect, it, vi } from "vitest";
import { JevError } from "@jev-harness/core";
import { classifyItems, isBatchLevelError } from "./classify.js";

const ENV_KEYS = ["TYPESAFE_API_KEY", "TYPESAFE_BASE_URL", "TYPESAFE_DEFAULT_MODEL"] as const;

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) delete process.env[k];
});

/** Answers like the Jev API and records every request body. */
function jevFetch(opts: { fail400For?: (body: any) => boolean } = {}) {
  const bodies: any[] = [];
  const impl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (opts.fail400For?.(body)) return new Response("bad item payload", { status: 400 });
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions ?? {})) {
      answers[id] = { type: "noul", noul: 0.5 };
    }
    return new Response(
      JSON.stringify({ model: body.model, answers, usage: { input_tokens: 7, output_tokens: 2 } }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { impl, bodies };
}

const itemBodies = (bodies: any[]) => bodies.filter((b) => !("answers" in b.state));

function config(fetchImpl: typeof fetch) {
  return { apiKey: "k", fetchImpl };
}

const QUESTIONS = { q: { type: "noul", instructions: "ok?" } } as const;

describe("classifyItems", () => {
  it("asks the same questions of every item: one request per item", async () => {
    const { impl, bodies } = jevFetch();
    const result = await classifyItems(config(impl), ["a", "bb", "ccc"], { ...QUESTIONS });
    expect(itemBodies(bodies)).toHaveLength(3);
    expect(bodies.map((b) => b.state.item)).toEqual(["a", "bb", "ccc"]);
    expect(result.perItem).toHaveLength(3);
    for (const answers of result.perItem) expect(Object.keys(answers!)).toEqual(["q"]);
    expect(result.reduced).toBeNull();
    expect(result.failures).toEqual([]);
    expect(result.usage).toEqual({ input_tokens: 21, output_tokens: 6 });
  });

  it("reduces over a capped digest of verdicts, never the corpus", async () => {
    const { impl, bodies } = jevFetch();
    const items = Array.from({ length: 230 }, (_, i) => "corpus-item-" + i);
    const result = await classifyItems(
      config(impl),
      items,
      { ...QUESTIONS },
      {
        reduce: { instructions: "summarize", criteria: ["bad", "good"] },
      },
    );
    expect(itemBodies(bodies)).toHaveLength(230);
    const reduceBodies = bodies.filter((b) => "answers" in b.state);
    expect(reduceBodies).toHaveLength(1);
    const digest = reduceBodies[0].state;
    expect(digest.item_count).toBe(230);
    expect(digest.answers).toHaveLength(200);
    expect(digest.omitted_items).toBe(30);
    expect(JSON.stringify(digest)).not.toContain("corpus-item");
    expect(result.reduced).not.toBeNull();
  });

  it("names the failed items and still answers the rest", async () => {
    const { impl, bodies } = jevFetch({ fail400For: (b) => b.state?.item === "poison" });
    const result = await classifyItems(
      config(impl),
      ["ok-1", "poison", "ok-2"],
      { ...QUESTIONS },
      {
        reduce: { instructions: "summarize", criteria: ["bad", "good"] },
      },
    );
    // Batch rejected once, then every item retried alone: 3 + 3 requests.
    expect(itemBodies(bodies)).toHaveLength(6);
    expect(bodies.filter((b) => "answers" in b.state)).toHaveLength(0);
    expect(result.failures).toEqual([{ index: 1, error: expect.stringContaining("400") }]);
    expect(result.perItem[0]).toHaveProperty("q");
    expect(result.perItem[1]).toBeNull();
    expect(result.perItem[2]).toHaveProperty("q");
    expect(result.reduced).toBeNull();
    expect(result.reduceSkipped).toContain("1 of 3");
  });

  it("keeps batch-level failures atomic instead of retrying every item", async () => {
    const bodies: any[] = [];
    const impl = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response("no", { status: 401 });
    }) as unknown as typeof fetch;
    await expect(classifyItems(config(impl), ["a"], { ...QUESTIONS })).rejects.toThrow(/401/);
    expect(bodies).toHaveLength(1);
    expect(isBatchLevelError(new JevError("TYPESAFE_API_KEY is not set"))).toBe(true);
    expect(isBatchLevelError(new JevError("bad request", { status: 400 }))).toBe(false);
    expect(isBatchLevelError(new Error("network"))).toBe(true);
  });

  it("fails clearly when the key is missing, with no request spent", async () => {
    const { impl, bodies } = jevFetch();
    await expect(classifyItems({ fetchImpl: impl }, ["a"], { ...QUESTIONS })).rejects.toThrow(
      /TYPESAFE_API_KEY is not set/,
    );
    expect(bodies).toHaveLength(0);
  });
});
