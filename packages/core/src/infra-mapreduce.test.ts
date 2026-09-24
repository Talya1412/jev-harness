import { describe, it, expect } from "vitest";
import { withMapReduce } from "../src/infra.js";
import type { Answer, Questions } from "../src/types.js";

/** A fetch stub returning a canned JevResponse; records calls. */
function jevStub(answers: Answer[] | ((body: any, call: number) => Record<string, Answer>)) {
  const calls: any[] = [];
  const fetchImpl = (async (_url: any, init: any) => {
    const body = JSON.parse(String(init.body));
    calls.push(body);
    const resolved =
      typeof answers === "function" ? answers(body, calls.length) : answers[calls.length - 1];
    return new Response(JSON.stringify({ model: "jev-test", answers: resolved }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const ITEMS = ["alpha", "beta", "gamma"];

/** One noul per item, keyed by position — the shape buildQuestions produces. */
const buildQuestions = (item: string, _index: number): Questions => ({
  relevant: { type: "noul", instructions: `Is this item relevant? ITEM: ${item}` },
  label: {
    type: "choice",
    instructions: "Pick a label.",
    criteria: { keep: "Keep it.", drop: "Drop it." },
  },
});

describe("withMapReduce", () => {
  it("runs one call per item and returns index-aligned answers", async () => {
    const { fetchImpl, calls } = jevStub((body) => ({
      relevant: { type: "noul", noul: body.state.item === "beta" ? 0.9 : 0.1 },
      label: { type: "choice", choice: "keep", confidence: 0.8, probabilities: {} },
    }));
    const r = await withMapReduce({ apiKey: "k", fetchImpl }, ITEMS, buildQuestions);
    expect(calls).toHaveLength(3);
    expect(r.reduced).toBeNull();
    expect(r.perItem).toHaveLength(3);
    expect(r.perItem[1].relevant).toEqual({ type: "noul", noul: 0.9 });
    expect(r.perItem[0].label).toMatchObject({ choice: "keep" });
    // The item rides in state, with its position.
    expect(calls.map((c) => c.state.item)).toEqual(["alpha", "beta", "gamma"]);
    expect(calls.map((c) => c.state.index)).toEqual([0, 1, 2]);
    expect(calls.map((c) => c.state.total)).toEqual([3, 3, 3]);
  });

  it("passes the item's own index to buildQuestions", async () => {
    const seen: number[] = [];
    const { fetchImpl } = jevStub((_body, _call) => ({
      relevant: { type: "noul", noul: 0.5 },
    }));
    await withMapReduce({ apiKey: "k", fetchImpl }, ITEMS, (item, index) => {
      seen.push(index);
      return buildQuestions(item, index);
    });
    expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it("spends no request on an empty item list", async () => {
    const { fetchImpl, calls } = jevStub([]);
    const r = await withMapReduce<string>({ apiKey: "k", fetchImpl }, [], buildQuestions);
    expect(r).toEqual({ perItem: [], reduced: null });
    expect(calls).toHaveLength(0);
  });

  it("short-circuits the empty case even when a reduce is configured", async () => {
    const { fetchImpl, calls } = jevStub([]);
    const r = await withMapReduce<string>({ apiKey: "k", fetchImpl }, [], buildQuestions, {
      reduce: { instructions: "Summarize.", criteria: ["none", "all"] },
    });
    expect(r).toEqual({ perItem: [], reduced: null });
    expect(calls).toHaveLength(0);
  });

  it("runs one extra reduce call over the collected answers", async () => {
    const { fetchImpl, calls } = jevStub((body, call) =>
      call <= 3
        ? { relevant: { type: "noul", noul: 0.5 } }
        : { reduced: { type: "score", score: 2, confidence: 0.9, probabilities: {} } },
    );
    const r = await withMapReduce({ apiKey: "k", fetchImpl }, ITEMS, buildQuestions, {
      reduce: {
        instructions: "How many items are relevant?",
        criteria: ["none", "some", "most", "all"],
      },
    });
    expect(calls).toHaveLength(4);
    const reduceCall = calls[3];
    expect(reduceCall.questions.reduced.type).toBe("score");
    expect(reduceCall.questions.reduced.criteria).toEqual(["none", "some", "most", "all"]);
    expect(reduceCall.state.item_count).toBe(3);
    expect(r.reduced).toEqual({ type: "score", score: 2, confidence: 0.9, probabilities: {} });
    expect(r.perItem).toHaveLength(3);
  });

  it("infers a choice reduce from a keyed criteria map and honours an explicit type", async () => {
    const { fetchImpl, calls } = jevStub((body, call) =>
      call <= 3
        ? { relevant: { type: "noul", noul: 0.5 } }
        : { reduced: { type: "choice", choice: "ship", confidence: 0.7, probabilities: {} } },
    );
    await withMapReduce({ apiKey: "k", fetchImpl }, ITEMS, buildQuestions, {
      reduce: { instructions: "Ship?", criteria: { ship: "Yes.", hold: "No." } },
    });
    expect(calls[3].questions.reduced.type).toBe("choice");
    expect(calls[3].questions.reduced.criteria).toEqual({ ship: "Yes.", hold: "No." });

    const forced = await withMapReduce({ apiKey: "k", fetchImpl }, ITEMS, buildQuestions, {
      reduce: { instructions: "Ship?", criteria: ["no", "yes"], type: "noul" },
    });
    expect(forced.reduced).not.toBeUndefined();
    expect(calls[7].questions.reduced.type).toBe("noul");
    // A noul reduce gets the levels joined into one instruction-adjacent criterion.
    expect(calls[7].questions.reduced.criteria).toBe("no; yes");
  });

  it("turns an array criteria into keyed options when the reduce type is choice", async () => {
    const { fetchImpl, calls } = jevStub((body, call) =>
      call <= 2
        ? { relevant: { type: "noul", noul: 0.5 } }
        : { reduced: { type: "choice", choice: "option_1", confidence: 0.6, probabilities: {} } },
    );
    await withMapReduce({ apiKey: "k", fetchImpl }, ["a", "b"], buildQuestions, {
      reduce: { instructions: "Pick.", criteria: ["low", "high"], type: "choice" },
    });
    expect(calls[2].questions.reduced.criteria).toEqual({ option_0: "low", option_1: "high" });
  });

  it("sends a digest of the answers to the reduce call, never the corpus", async () => {
    const SECRET = "TOP-SECRET-CORPUS-MARKER";
    const { fetchImpl, calls } = jevStub((body, call) =>
      call <= 2
        ? { relevant: { type: "noul", noul: 0.42 } }
        : { reduced: { type: "score", score: 1, confidence: 0.5, probabilities: {} } },
    );
    await withMapReduce({ apiKey: "k", fetchImpl }, [SECRET, SECRET + "-2"], buildQuestions, {
      reduce: { instructions: "Summarize.", criteria: ["none", "all"] },
    });
    const reduceState = JSON.stringify(calls[2].state);
    expect(reduceState).not.toContain(SECRET);
    expect(reduceState).not.toContain("Is this item relevant");
    expect(reduceState).toContain("noul 0.42");
  });

  it("caps the reduce state so a huge corpus cannot blow the request", async () => {
    const items = Array.from({ length: 500 }, (_, i) => `item ${i}`);
    const { fetchImpl, calls } = jevStub((body, call) =>
      call <= items.length
        ? { relevant: { type: "noul", noul: 0.5 } }
        : { reduced: { type: "score", score: 0, confidence: 0.5, probabilities: {} } },
    );
    await withMapReduce({ apiKey: "k", fetchImpl }, items, buildQuestions, {
      reduce: { instructions: "Summarize.", criteria: ["none", "all"] },
      concurrency: 16,
    });
    const reduceState = calls[items.length].state;
    expect(reduceState.item_count).toBe(500);
    expect(reduceState.answers.length).toBeLessThanOrEqual(200);
    expect(reduceState.omitted_items).toBe(500 - reduceState.answers.length);
    expect(JSON.stringify(reduceState).length).toBeLessThan(6_000);
  });

  it("bounds concurrency to the configured limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = (async (_url: any, init: any) => {
      JSON.parse(String(init.body));
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return new Response(
        JSON.stringify({ model: "m", answers: { relevant: { type: "noul", noul: 0.5 } } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await withMapReduce(
      { apiKey: "k", fetchImpl },
      Array.from({ length: 12 }, (_, i) => `i${i}`),
      buildQuestions,
      { concurrency: 3 },
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it("propagates a transport failure rather than swallowing it", async () => {
    const fetchImpl = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    await expect(
      withMapReduce({ apiKey: "k", fetchImpl, maxAttempts: 1 }, ITEMS, buildQuestions),
    ).rejects.toThrow();
  });

  it("honours an already-aborted signal", async () => {
    const { fetchImpl } = jevStub([{ relevant: { type: "noul", noul: 0.5 } }]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      withMapReduce({ apiKey: "k", fetchImpl }, ITEMS, buildQuestions, {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/i);
  });
});
