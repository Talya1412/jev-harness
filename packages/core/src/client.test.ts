import { describe, it, expect } from "vitest";
import {
  askJev,
  listJevModels,
  validateQuestions,
  noul,
  choice,
  score,
  JevError,
} from "../src/client.js";
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
    expect(() =>
      validateQuestions({ q: { type: "choice", instructions: "pick", criteria: { only: "one" } } }),
    ).toThrow(/map of option -> description/);
  });

  it("rejects a score with fewer than two levels", () => {
    expect(() =>
      validateQuestions({ q: { type: "score", instructions: "rate", criteria: ["single"] } }),
    ).toThrow(/2 to 10 levels/);
  });

  it("accepts a well-formed noul without criteria", () => {
    expect(() => validateQuestions({ q: { type: "noul", instructions: "is it?" } })).not.toThrow();
  });

  // The failure class below is invisible at runtime: the API answers one option
  // at confidence 1.0 instead of reporting a malformed question, so a caller
  // that gets it wrong never finds out. These tests pin the shapes that were
  // silently accepted before.
  it("rejects a choice whose criteria is an ARRAY (read as one option at 1.0)", () => {
    expect(() =>
      validateQuestions({
        q: { type: "choice", instructions: "pick", criteria: ["a", "b"] as any },
      }),
    ).toThrow(/map of option -> description/);
  });

  it("rejects a choice wrapped as { options: [...] }", () => {
    expect(() =>
      validateQuestions({
        q: { type: "choice", instructions: "pick", criteria: { options: ["a", "b"] } as any },
      }),
    ).toThrow(/map of option -> description/);
  });

  it("rejects a choice option with a non-string description", () => {
    expect(() =>
      validateQuestions({
        q: { type: "choice", instructions: "pick", criteria: { a: 1, b: "two" } as any },
      }),
    ).toThrow(/needs a string description/);
  });

  it("rejects a score with more than ten levels", () => {
    expect(() =>
      validateQuestions({
        q: {
          type: "score",
          instructions: "rate",
          criteria: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"],
        },
      }),
    ).toThrow(/2 to 10 levels/);
  });

  it("rejects a score whose levels are not strings", () => {
    expect(() =>
      validateQuestions({ q: { type: "score", instructions: "rate", criteria: [1, 2] as any } }),
    ).toThrow(/levels must be strings/);
  });

  it("rejects a noul with criteria keys other than true/false", () => {
    expect(() =>
      validateQuestions({
        q: { type: "noul", instructions: "is it?", criteria: { yes: "a", no: "b" } as any },
      }),
    ).toThrow(/criteria keys must be "true"\/"false"/);
  });

  it("accepts prose criteria and a {true,false} map for noul", () => {
    expect(() =>
      validateQuestions({ q: { type: "noul", instructions: "is it?", criteria: "some prose" } }),
    ).not.toThrow();
    expect(() =>
      validateQuestions({
        q: {
          type: "noul",
          instructions: "is it?",
          criteria: { true: "yes case", false: "no case" },
        },
      }),
    ).not.toThrow();
  });

  it("accepts a well-formed choice map and a well-formed score", () => {
    expect(() =>
      validateQuestions({
        q: { type: "choice", instructions: "pick", criteria: { a: "one", b: "two" } },
      }),
    ).not.toThrow();
    expect(() =>
      validateQuestions({ q: { type: "score", instructions: "rate", criteria: ["lo", "hi"] } }),
    ).not.toThrow();
  });
});
// The failure class below is invisible at runtime: the API answers one option
// at confidence 1.0 instead of reporting a malformed question, so a caller
// that gets it wrong never finds out. These tests pin the shapes that were
// silently accepted before.
it("rejects a choice whose criteria is an ARRAY (read as one option at 1.0)", () => {
  expect(() =>
    validateQuestions({
      q: { type: "choice", instructions: "pick", criteria: ["a", "b"] as any },
    }),
  ).toThrow(/map of option -> description/);
});

it("rejects a choice wrapped as { options: [...] }", () => {
  expect(() =>
    validateQuestions({
      q: { type: "choice", instructions: "pick", criteria: { options: ["a", "b"] } as any },
    }),
  ).toThrow(/map of option -> description/);
});

it("rejects a choice option with a non-string description", () => {
  expect(() =>
    validateQuestions({
      q: { type: "choice", instructions: "pick", criteria: { a: 1, b: "two" } as any },
    }),
  ).toThrow(/needs a string description/);
});

it("rejects a score with more than ten levels", () => {
  expect(() =>
    validateQuestions({
      q: {
        type: "score",
        instructions: "rate",
        criteria: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"],
      },
    }),
  ).toThrow(/2 to 10 levels/);
});

it("rejects a score whose levels are not strings", () => {
  expect(() =>
    validateQuestions({ q: { type: "score", instructions: "rate", criteria: [1, 2] as any } }),
  ).toThrow(/levels must be strings/);
});

it("rejects a noul with criteria keys other than true/false", () => {
  expect(() =>
    validateQuestions({
      q: { type: "noul", instructions: "is it?", criteria: { yes: "a", no: "b" } as any },
    }),
  ).toThrow(/criteria keys must be "true"\/"false"/);
});

it("accepts prose criteria and a {true,false} map for noul", () => {
  expect(() =>
    validateQuestions({ q: { type: "noul", instructions: "is it?", criteria: "some prose" } }),
  ).not.toThrow();
  expect(() =>
    validateQuestions({
      q: { type: "noul", instructions: "is it?", criteria: { true: "yes case", false: "no case" } },
    }),
  ).not.toThrow();
});

it("accepts a well-formed choice map and a well-formed score", () => {
  expect(() =>
    validateQuestions({
      q: { type: "choice", instructions: "pick", criteria: { a: "one", b: "two" } },
    }),
  ).not.toThrow();
  expect(() =>
    validateQuestions({ q: { type: "score", instructions: "rate", criteria: ["lo", "hi"] } }),
  ).not.toThrow();
});

describe("askJev", () => {
  it("requires an api key", async () => {
    await expect(
      askJev({ apiKey: "" }, { x: 1 }, { q: { type: "noul", instructions: "?" } }),
    ).rejects.toThrow(/TYPESAFE_API_KEY/);
  });

  it("posts the model, state and questions to /v1/systemone", async () => {
    const { impl, calls } = stubFetch(ok);
    await askJev(
      { apiKey: "k", fetchImpl: impl },
      { task: "x" },
      { q: { type: "noul", instructions: "?" } },
    );
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
    const res = await askJev(
      { apiKey: "k", fetchImpl: impl },
      { x: 1 },
      { q: { type: "noul", instructions: "?" } },
    );
    expect(n).toBe(2);
    expect(res.model).toBe("jev-1.13.0");
  });

  it("does not retry a 400", async () => {
    let n = 0;
    const impl = (async () => {
      n++;
      return new Response("bad", { status: 400 });
    }) as unknown as typeof fetch;
    await expect(
      askJev(
        { apiKey: "k", fetchImpl: impl },
        { x: 1 },
        { q: { type: "noul", instructions: "?" } },
      ),
    ).rejects.toThrow(/400/);
    expect(n).toBe(1);
  });

  it("rejects a response without answers", async () => {
    const { impl } = stubFetch({ model: "jev-latest" });
    await expect(
      askJev(
        { apiKey: "k", fetchImpl: impl },
        { x: 1 },
        { q: { type: "noul", instructions: "?" } },
      ),
    ).rejects.toThrow(/missing `answers`/);
  });

  it("gives up after maxAttempts on persistent 500s", async () => {
    let n = 0;
    const impl = (async () => {
      n++;
      return new Response("boom", { status: 500 });
    }) as unknown as typeof fetch;
    await expect(
      askJev(
        { apiKey: "k", fetchImpl: impl, maxAttempts: 2 },
        { x: 1 },
        { q: { type: "noul", instructions: "?" } },
      ),
    ).rejects.toThrow();
    expect(n).toBe(2);
  });

  it("does not fire a live request when the signal is already aborted", async () => {
    let n = 0;
    const impl = (async () => {
      n++;
      return new Response(JSON.stringify(ok), { status: 200 });
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    controller.abort();
    await expect(
      askJev(
        { apiKey: "k", fetchImpl: impl },
        { x: 1 },
        { q: { type: "noul", instructions: "?" } },
        controller.signal,
      ),
    ).rejects.toThrow(/aborted/);
    expect(n).toBe(0);
  });

  it("stops retrying when the signal aborts during backoff", async () => {
    let n = 0;
    const impl = (async () => {
      n++;
      return new Response("boom", { status: 500 });
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    await expect(
      askJev(
        { apiKey: "k", fetchImpl: impl, maxAttempts: 3, onRetry: () => controller.abort() },
        { x: 1 },
        { q: { type: "noul", instructions: "?" } },
        controller.signal,
      ),
    ).rejects.toThrow(/aborted/);
    expect(n).toBe(1);
  });
});

describe("listJevModels", () => {
  it("returns the model list", async () => {
    const { impl } = stubFetch({ models: [{ name: "jev-latest" }] });
    const models = await listJevModels({ apiKey: "k", fetchImpl: impl });
    expect(models).toEqual([{ name: "jev-latest" }]);
  });

  it("throws JevError when the body has no models array", async () => {
    const { impl } = stubFetch({ nope: true });
    await expect(listJevModels({ apiKey: "k", fetchImpl: impl, maxAttempts: 1 })).rejects.toThrow(
      /missing `models`/,
    );
  });

  it("retries a 429 then succeeds", async () => {
    let n = 0;
    const impl = (async () => {
      n++;
      if (n === 1) return new Response("slow down", { status: 429 });
      return new Response(JSON.stringify({ models: [{ name: "m" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const models = await listJevModels({ apiKey: "k", fetchImpl: impl });
    expect(n).toBe(2);
    expect(models).toEqual([{ name: "m" }]);
  });

  it("does not retry a 400", async () => {
    let n = 0;
    const impl = (async () => {
      n++;
      return new Response("bad", { status: 400 });
    }) as unknown as typeof fetch;
    await expect(listJevModels({ apiKey: "k", fetchImpl: impl }, undefined)).rejects.toThrow(/400/);
    expect(n).toBe(1);
  });

  it("honors an aborted signal without firing a request", async () => {
    let n = 0;
    const impl = (async () => {
      n++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    controller.abort();
    await expect(
      listJevModels({ apiKey: "k", fetchImpl: impl }, controller.signal),
    ).rejects.toThrow(/aborted/);
    expect(n).toBe(0);
  });

  it("aborts a hung models call at the configured timeout", async () => {
    const impl = ((_url: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          rej(e);
        });
      })) as unknown as typeof fetch;
    await expect(
      listJevModels({ apiKey: "k", fetchImpl: impl, timeoutMs: 10, maxAttempts: 1 }),
    ).rejects.toThrow();
    await expect(
      listJevModels({ apiKey: "k", fetchImpl: impl, timeoutMs: 10, maxAttempts: 1 }),
    ).rejects.toThrow();
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
