import { describe, it, expect, vi } from "vitest";
import { askJev, noul, choice } from "../src/client.js";
import {
  withCache,
  jevBatch,
  createAuditLog,
  withAudit,
  localRouteSkill,
} from "../src/infra.js";

/** A fetch stub returning a canned JevResponse; records calls. */
function jevStub(answers: any) {
  const calls: any[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    calls.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ model: "jev-test", answers }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("withCache", () => {
  it("serves a repeat call from the cache without hitting fetch", async () => {
    let fetchCalls = 0;
    const base = (async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ model: "m", answers: { q: { type: "noul", noul: 0.5 } } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const cfg = withCache({ apiKey: "k", fetchImpl: base });
    const q = { q: { type: "noul", instructions: "?" } };
    await askJev(cfg, { x: 1 }, q);
    await askJev(cfg, { x: 1 }, q);
    expect(fetchCalls).toBe(1);
  });

  it("treats a different question as a miss", async () => {
    let fetchCalls = 0;
    const base = (async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ model: "m", answers: { q: { type: "noul", noul: 0.5 } } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const cfg = withCache({ apiKey: "k", fetchImpl: base }, { onHit: () => {} });
    await askJev(cfg, { x: 1 }, { a: { type: "noul", instructions: "?" } });
    await askJev(cfg, { x: 1 }, { b: { type: "noul", instructions: "?" } });
    expect(fetchCalls).toBe(2);
  });

  it("refreshes recency on hit (true LRU)", async () => {
    let fetchCalls = 0;
    const base = (async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ model: "m", answers: { q: { type: "noul", noul: 0.5 } } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const cfg = withCache({ apiKey: "k", fetchImpl: base }, { maxEntries: 2 });
    const q = { q: { type: "noul", instructions: "?" } };
    await askJev(cfg, { x: 1 }, q); // [1]
    await askJev(cfg, { x: 2 }, q); // [1, 2]
    await askJev(cfg, { x: 1 }, q); // hit: refresh -> [2, 1]
    await askJev(cfg, { x: 3 }, q); // evicts 2, not 1
    expect(fetchCalls).toBe(3);
    await askJev(cfg, { x: 1 }, q); // still cached
    expect(fetchCalls).toBe(3);
    await askJev(cfg, { x: 2 }, q); // evicted -> refetch
    expect(fetchCalls).toBe(4);
  });

  it("does not serve /v1/models from the body cache", async () => {
    let fetchCalls = 0;
    const base = (async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ models: [{ name: "m" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const cfg = withCache({ apiKey: "k", fetchImpl: base });
    await cfg.fetchImpl!("https://api.typesafe.ai/v1/models", { headers: {} });
    await cfg.fetchImpl!("https://api.typesafe.ai/v1/models", { headers: {} });
    expect(fetchCalls).toBe(2);
  });

  it("evicts the oldest entry once full", async () => {
    let fetchCalls = 0;
    const base = (async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ model: "m", answers: { q: { type: "noul", noul: 0.5 } } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const cfg = withCache({ apiKey: "k", fetchImpl: base }, { maxEntries: 1 });
    await askJev(cfg, { x: 1 }, { q: { type: "noul", instructions: "?" } });
    await askJev(cfg, { x: 2 }, { q: { type: "noul", instructions: "?" } });
    // re-ask the first: was evicted, so it hits fetch again
    await askJev(cfg, { x: 1 }, { q: { type: "noul", instructions: "?" } });
    expect(fetchCalls).toBe(3);
  });
});

describe("jevBatch", () => {
  it("merges independent question-sets into one call and splits the answers back", async () => {
    const { fetchImpl, calls } = jevStub({
      c0__gate: { type: "noul", noul: 0.9 },
      c1__best: { type: "choice", choice: "browser", confidence: 0.8, probabilities: {} },
    });
    const batch = jevBatch({ apiKey: "k", fetchImpl }, { shared: "state" });

    const p1 = batch.add({ gate: { type: "noul", instructions: "?" } });
    const p2 = batch.add({ best: { type: "choice", instructions: "?", criteria: { a: "x", b: "y" } } });
    await Promise.all([p1, p2]);

    // exactly one network call, with namespaced keys
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].questions).sort()).toEqual(["c0__gate", "c1__best"]);
    expect(calls[0].state).toEqual({ shared: "state" });

    // each caller only sees its own (de-namespaced) keys
    const r1 = await p1;
    const r2 = await p2;
    expect(r1.answers.gate).toEqual({ type: "noul", noul: 0.9 });
    expect(r2.answers.best).toEqual({ type: "choice", choice: "browser", confidence: 0.8, probabilities: {} });
    expect(r1.answers.best).toBeUndefined();
    expect(r2.answers.gate).toBeUndefined();
  });

  it("propagates a failure to every pending caller", async () => {
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const batch = jevBatch({ apiKey: "k", fetchImpl, maxAttempts: 1 }, { s: 1 });
    const p1 = batch.add({ q: { type: "noul", instructions: "?" } });
    const p2 = batch.add({ q: { type: "noul", instructions: "?" } });
    await expect(p1).rejects.toThrow();
    await expect(p2).rejects.toThrow();
  });

  it("rejects an invalid question map at add() time without poisoning the batch", async () => {
    const { fetchImpl, calls } = jevStub({ c0__ok: { type: "noul", noul: 0.5 } });
    const batch = jevBatch({ apiKey: "k", fetchImpl }, { s: 1 });
    await expect(batch.add({} as Parameters<typeof batch.add>[0])).rejects.toThrow(/non-empty/);
    const good = await batch.add({ ok: { type: "noul", instructions: "?" } });
    expect(good.answers.ok).toBeDefined();
    expect(calls).toHaveLength(1);
  });

  it("flush with no pending callers resolves to an empty answers object", async () => {
    const { fetchImpl, calls } = jevStub({});
    const batch = jevBatch({ apiKey: "k", fetchImpl }, { s: 1 });
    const r = await batch.flush();
    expect(r.answers).toEqual({});
    expect(calls).toHaveLength(0);
  });

  it("round-trips answers through the typed accessors", async () => {
    const { fetchImpl } = jevStub({
      c0__n: { type: "noul", noul: 0.42 },
      c0__c: { type: "choice", choice: "b", confidence: 0.7, probabilities: { a: 0.3, b: 0.7 } },
    });
    const batch = jevBatch({ apiKey: "k", fetchImpl }, { s: 1 });
    const p = batch.add({
      n: { type: "noul", instructions: "?" },
      c: { type: "choice", instructions: "?", criteria: { a: "x", b: "y" } },
    });
    const r = await p;
    expect(noul(r, "n")).toBe(0.42);
    expect(choice(r, "c").choice).toBe("b");
  });
});

describe("createAuditLog + withAudit", () => {
  it("records a successful call with answers, state, and questions", async () => {
    const { fetchImpl } = jevStub({ q: { type: "noul", noul: 0.5 } });
    const log = createAuditLog();
    const cfg = withAudit({ apiKey: "k", fetchImpl }, log);
    await askJev(cfg, { task: "x" }, { q: { type: "noul", instructions: "?" } });
    expect(log.size()).toBe(1);
    const [e] = log.all();
    expect(e.ok).toBe(true);
    expect(e.status).toBe(200);
    expect(e.state).toEqual({ task: "x" });
    expect(e.questions).toBeDefined();
    expect(e.answers?.q).toEqual({ type: "noul", noul: 0.5 });
    expect(e.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("records a failure with the error message and ok=false", async () => {
    const fetchImpl = (async () => {
      throw new Error("network gone");
    }) as unknown as typeof fetch;
    const log = createAuditLog();
    const cfg = withAudit({ apiKey: "k", fetchImpl, maxAttempts: 1 }, log);
    await expect(askJev(cfg, { x: 1 }, { q: { type: "noul", instructions: "?" } })).rejects.toThrow();
    const [e] = log.all();
    expect(e.ok).toBe(false);
    expect(e.error).toBe("network gone");
  });

  it("mirrors entries to a sink", async () => {
    const { fetchImpl } = jevStub({ q: { type: "noul", noul: 0.5 } });
    const sink = vi.fn();
    const log = createAuditLog({ sink });
    const cfg = withAudit({ apiKey: "k", fetchImpl }, log);
    await askJev(cfg, { x: 1 }, { q: { type: "noul", instructions: "?" } });
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("caps retained entries at maxEntries", async () => {
    const log = createAuditLog({ maxEntries: 2 });
    log.record({ ts: 1, url: "u", ok: true, elapsedMs: 0 });
    log.record({ ts: 2, url: "u", ok: true, elapsedMs: 0 });
    log.record({ ts: 3, url: "u", ok: true, elapsedMs: 0 });
    expect(log.size()).toBe(2);
    expect(log.all().map((e) => e.ts)).toEqual([2, 3]);
  });

  it("drain clears the log", async () => {
    const { fetchImpl } = jevStub({ q: { type: "noul", noul: 0.5 } });
    const log = createAuditLog();
    const cfg = withAudit({ apiKey: "k", fetchImpl }, log);
    await askJev(cfg, { x: 1 }, { q: { type: "noul", instructions: "?" } });
    expect(log.drain()).toHaveLength(1);
    expect(log.size()).toBe(0);
  });
});

describe("localRouteSkill", () => {
  it("picks the skill whose description overlaps the message", () => {
    const r = localRouteSkill("test the login page in a browser", [
      { name: "browser", description: "Automate browser interactions and Playwright tests." },
      { name: "desktop", description: "OS-level window inspection and input." },
    ]);
    expect(r.skill).toBe("browser");
    expect(r.score).toBeGreaterThan(0);
  });

  it("abstains when no skill is topically related", () => {
    const r = localRouteSkill("write a haiku", [
      { name: "browser", description: "Automate browser interactions." },
    ]);
    expect(r.skill).toBeNull();
  });

  it("returns null for an empty skill list", () => {
    expect(localRouteSkill("do anything", [])).toEqual({ skill: null, score: 0 });
  });
});
