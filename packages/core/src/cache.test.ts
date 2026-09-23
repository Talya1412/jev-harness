import { describe, it, expect } from "vitest";
import {
  stableStringify,
  fnv1a,
  createJevCache,
  createCachedClient,
  createCoalescer,
} from "../src/cache.js";
import { JevError } from "../src/types.js";
import type { JevResponse } from "../src/types.js";

/** Echoes one noul answer per requested question id, recording request bodies. */
function echoFetch() {
  const bodies: any[] = [];
  const impl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    const answers: JevResponse["answers"] = {};
    for (const id of Object.keys(body.questions)) answers[id] = { type: "noul", noul: 0.5 };
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, bodies };
}

const noulQ = { type: "noul", instructions: "?" } as const;

describe("stableStringify", () => {
  it("is invariant under key order", () => {
    expect(stableStringify({ a: 1, b: { c: 2, d: 3 } })).toBe(
      stableStringify({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  it("distinguishes different states", () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });
});

describe("fnv1a", () => {
  it("is deterministic and hex-formatted", () => {
    expect(fnv1a("hello")).toBe(fnv1a("hello"));
    expect(fnv1a("hello")).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a("hello")).not.toBe(fnv1a("hellp"));
  });
});

describe("createJevCache", () => {
  const res: JevResponse = { model: "m", answers: { a: { type: "noul", noul: 0.5 } } };

  it("stores and expires entries by TTL", async () => {
    const cache = createJevCache({ ttlMs: 5 });
    cache.set("k", res);
    expect(cache.get("k")).toBeDefined();
    await new Promise((r) => setTimeout(r, 10));
    expect(cache.get("k")).toBeUndefined();
  });

  it("evicts the oldest entry when full", () => {
    const cache = createJevCache({ maxEntries: 2 });
    cache.set("a", res);
    cache.set("b", res);
    cache.set("c", res);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
    expect(cache.size).toBe(2);
  });

  it("clear() empties everything", () => {
    const cache = createJevCache();
    cache.set("a", res);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });
});

describe("createCachedClient", () => {
  it("serves identical state+questions from the cache without a second request", async () => {
    const { impl, bodies } = echoFetch();
    const client = createCachedClient({ apiKey: "k", fetchImpl: impl });
    const state = { diff: "same" };
    const questions = { touches_auth: noulQ };
    const first = await client.ask(state, questions);
    const second = await client.ask(state, questions);
    expect(bodies).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it("treats different questions as a different key", async () => {
    const { impl, bodies } = echoFetch();
    const client = createCachedClient({ apiKey: "k", fetchImpl: impl });
    await client.ask({ s: 1 }, { a: noulQ });
    await client.ask({ s: 1 }, { b: noulQ });
    expect(bodies).toHaveLength(2);
  });

  it("mutating a returned response does not poison the cache", async () => {
    const { impl } = echoFetch();
    const client = createCachedClient({ apiKey: "k", fetchImpl: impl });
    const first = await client.ask({ s: 1 }, { a: noulQ });
    first.answers.a = { type: "noul", noul: 0.99 };
    const second = await client.ask({ s: 1 }, { a: noulQ });
    expect((second.answers.a as { noul: number }).noul).toBe(0.5);
  });
});

describe("createCoalescer", () => {
  it("merges concurrent same-state calls into one request", async () => {
    const { impl, bodies } = echoFetch();
    const client = createCoalescer({ apiKey: "k", fetchImpl: impl }, { windowMs: 5 });
    const state = { diff: "same" };
    const [a, b] = await Promise.all([
      client.ask(state, { q1: noulQ }),
      client.ask(state, { q2: noulQ }),
    ]);
    expect(bodies).toHaveLength(1);
    expect(Object.keys(bodies[0].questions).sort()).toEqual(["0:q1", "1:q2"]);
    expect(a.answers.q1).toBeDefined();
    expect(b.answers.q2).toBeDefined();
    expect(a.answers["1:q2"]).toBeUndefined();
    expect(client.requestCount()).toBe(1);
  });

  it("keeps different states in separate requests", async () => {
    const { impl, bodies } = echoFetch();
    const client = createCoalescer({ apiKey: "k", fetchImpl: impl }, { windowMs: 5 });
    await Promise.all([client.ask({ s: 1 }, { a: noulQ }), client.ask({ s: 2 }, { b: noulQ })]);
    expect(bodies).toHaveLength(2);
    expect(client.requestCount()).toBe(2);
  });

  it("rejects non-object questions at ask() time with a usage error", async () => {
    const { impl, bodies } = echoFetch();
    const client = createCoalescer({ apiKey: "k", fetchImpl: impl }, { windowMs: 5 });
    await expect(
      client.ask({ s: 1 }, null as unknown as Parameters<typeof client.ask>[1]),
    ).rejects.toThrow(JevError);
    await expect(client.ask({ s: 1 }, {} as Parameters<typeof client.ask>[1])).rejects.toThrow(
      /non-empty/,
    );
    // No request was ever issued for the invalid calls.
    await new Promise((r) => setTimeout(r, 20));
    expect(bodies).toHaveLength(0);
    expect(client.requestCount()).toBe(0);
  });

  it("rejects an unserializable state at ask() time and still serves the good caller", async () => {
    const { impl, bodies } = echoFetch();
    const client = createCoalescer({ apiKey: "k", fetchImpl: impl }, { windowMs: 5 });
    const good = client.ask({ s: 1 }, { a: noulQ });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(client.ask(circular, { b: noulQ })).rejects.toThrow();
    await expect(good).resolves.toBeDefined();
    expect(bodies).toHaveLength(1);
  });

  it("propagates Jev failures to every caller in the group", async () => {
    const impl = (async () => new Response("boom", { status: 400 })) as unknown as typeof fetch;
    const client = createCoalescer({ apiKey: "k", fetchImpl: impl }, { windowMs: 5 });
    const results = await Promise.allSettled([
      client.ask({ s: 1 }, { a: noulQ }),
      client.ask({ s: 1 }, { b: noulQ }),
    ]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
  });
});
