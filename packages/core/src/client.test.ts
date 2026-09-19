import { describe, it, expect, vi } from "vitest";
import { askJev, validateQuestions, noul, choice, score, JevError } from "../src/client.js";
import type { JevResponse } from "../src/types.js";

/** A fetch stub that returns a canned response and records the request. */
function stubFetch(payload: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, calls };
}

const ok: JevResponse = { model: "jev-1.13.0", answers: { a: { type: "noul", noul: 0.9 } } };

describe("validateQuestions", () => {
  it("rejects an empty question map", () => {
    expect(() => validateQuestions({})).toThrow(JevError);
  });

  it("rejects a choice with fewer than two criteria", () => {
    expect(() => validateQuestions({ q: { type: "choice", instructions: "pick", criteria: { only: "one" } } }))
      .toThrow(/at least 2 criteria/);
  });

  it("rejects a score with fewer than two levels", () => {
    expect(() => validateQuestions({ q: { type: "score", instructions: "rate", criteria: ["single"] } }))
      .toThrow(/at least 2 ordered levels/);
  });

  it("accepts a well-formed noul without criteria", () => {
    expect(() => validateQuestions({ q: { type: "noul", instructions: "is it?" } })).not.toThrow();
  });
});

describe("askJev", () => {
  it("requires an api key", async () => {
    await expect(askJev({ apiKey: "" }, { x: 1 }, { q: { type: "noul", instructions: "?" } }))
      .rejects.toThrow(/TYPESAFE_API_KEY/);
  });

  it("posts the model, state and questions to /v1/systemone", async () => {
    const { impl, calls } = stubFetch(ok);
    await askJev({ apiKey: "k", fetchImpl: impl }, { task: "x" }, { q: { type: "noul", instructions: "?" } });
    expect(calls[0].url).toBe("https://api.typesafe.ai/v1/systemone");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe("jev-latest");
    expect(body.state).toEqual({ task: "x" });
    expect(body.questions.q.type).toBe("noul");
  });

  it("retries a 429 then succeeds", async () => {
    let n = 0;
    const impl = (async () => {
      n++;
      if (n === 1) return new Response("slow down", { status: 429 });
      return new Response(JSON.stringify(ok), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await askJev({ apiKey: "k", fetchImpl: impl }, { x: 1 }, { q: { type: "noul", instructions: "?" } });
    expect(n).toBe(2);
    expect(res.model).toBe("jev-1.13.0");
  });

  it("does not retry a 400", async () => {
    let n = 0;
    const impl = (async () => { n++; return new Response("bad", { status: 400 }); }) as unknown as typeof fetch;
    await expect(askJev({ apiKey: "k", fetchImpl: impl }, { x: 1 }, { q: { type: "noul", instructions: "?" } }))
      .rejects.toThrow(/400/);
    expect(n).toBe(1);
  });

  it("rejects a response without answers", async () => {
    const { impl } = stubFetch({ model: "jev-latest" });
    await expect(askJev({ apiKey: "k", fetchImpl: impl }, { x: 1 }, { q: { type: "noul", instructions: "?" } }))
      .rejects.toThrow(/missing `answers`/);
  });

  it("gives up after maxAttempts on persistent 500s", async () => {
    let n = 0;
    const impl = (async () => { n++; return new Response("boom", { status: 500 }); }) as unknown as typeof fetch;
    await expect(askJev({ apiKey: "k", fetchImpl: impl, maxAttempts: 2 }, { x: 1 }, { q: { type: "noul", instructions: "?" } }))
      .rejects.toThrow();
    expect(n).toBe(2);
  });
});

describe("typed accessors", () => {
  const res: JevResponse = {
    model: "m",
    answers: {
      n: { type: "noul", noul: 0.42 },
      c: { type: "choice", choice: "b", confidence: 0.8, probabilities: { a: 0.2, b: 0.8 } },
      s: { type: "score", score: 1.5, confidence: 0.6, probabilities: { "0": 0.5, "1": 0.5 } },
    },
  };

  it("reads each primitive", () => {
    expect(noul(res, "n")).toBe(0.42);
    expect(choice(res, "c").choice).toBe("b");
    expect(score(res, "s").score).toBe(1.5);
  });

  it("throws on a type mismatch rather than returning undefined", () => {
    expect(() => noul(res, "c")).toThrow(/not a valid noul/);
    expect(() => choice(res, "n")).toThrow(/not a valid choice/);
    expect(() => score(res, "missing")).toThrow(/not a valid score/);
  });
});
