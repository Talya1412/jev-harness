import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPersistentCache, withPersistentCache } from "./persist-cache.js";
import { createCachedClient } from "./cache.js";
import type { JevResponse } from "./types.js";

function resp(noul: number): JevResponse {
  return { model: "m", answers: { q: { type: "noul", noul } } };
}

const QUESTIONS = { q: { type: "noul", instructions: "ok?" } } as const;

describe("createPersistentCache", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jev-pcache-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists entries across instances in the same dir", () => {
    const first = createPersistentCache({ dir });
    first.set("k", resp(0.9));
    expect(first.size).toBe(1);

    const second = createPersistentCache({ dir });
    expect(second.size).toBe(1);
    expect(second.get("k")?.answers.q).toEqual({ type: "noul", noul: 0.9 });
  });

  it("tracks hit rate", () => {
    const cache = createPersistentCache({ dir });
    cache.set("k", resp(0.5));
    cache.get("k");
    cache.get("nope");
    expect(cache.stats()).toEqual({ hits: 1, misses: 1, hitRate: 0.5 });
  });

  it("drops expired entries when loading", () => {
    // ttl 0 makes the entry expire the instant it is written.
    const first = createPersistentCache({ dir, ttlMs: 0 });
    first.set("gone", resp(0.2));
    expect(first.get("gone")).toBeUndefined();

    const second = createPersistentCache({ dir });
    expect(second.get("gone")).toBeUndefined();
    expect(second.stats().misses).toBe(1);
  });

  it("evicts the oldest entry beyond maxEntries", () => {
    const cache = createPersistentCache({ dir, maxEntries: 2 });
    cache.set("a", resp(0.1));
    cache.set("b", resp(0.2));
    cache.set("c", resp(0.3));
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")?.answers.q).toEqual({ type: "noul", noul: 0.2 });
    expect(cache.get("c")).toBeDefined();
  });

  it("survives a corrupt cache file by starting fresh", () => {
    const first = createPersistentCache({ dir });
    first.set("k", resp(0.4));
    const raw = JSON.parse(readFileSync(join(dir, "jev-cache.json"), "utf8")) as Record<
      string,
      unknown
    >;
    raw.entries = "not-an-object";
    writeFileSync(join(dir, "jev-cache.json"), JSON.stringify(raw), "utf8");
    const second = createPersistentCache({ dir });
    expect(second.size).toBe(0);
    expect(second.get("k")).toBeUndefined();
  });

  it("clear removes everything and persists the empty state", () => {
    const first = createPersistentCache({ dir });
    first.set("k", resp(0.6));
    first.clear();
    expect(first.size).toBe(0);
    const second = createPersistentCache({ dir });
    expect(second.size).toBe(0);
  });

  it("passes non-string bodies straight through without caching", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify(resp(0.5)), { status: 200 });
    }) as unknown as typeof fetch;
    const cfg = withPersistentCache({ apiKey: "k", fetchImpl }, createPersistentCache({ dir }));
    const stream = () =>
      new ReadableStream({
        start: (c) => {
          c.enqueue(new TextEncoder().encode("{}"));
          c.close();
        },
      });
    await cfg.fetchImpl!("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      body: stream() as unknown as BodyInit,
    });
    await cfg.fetchImpl!("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      body: stream() as unknown as BodyInit,
    });
    // Both went to transport (no collapsed "[object ReadableStream]" cache hit).
    expect(calls).toBe(2);
  });

  it("wires into createCachedClient for cross-restart hits", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(resp(0.7)),
      } as unknown as Response;
    }) as typeof fetch;

    const cache = createPersistentCache({ dir });
    const config = { apiKey: "k", fetchImpl };
    const client1 = createCachedClient(config, { cache });
    await client1.ask("state", QUESTIONS);
    const client2 = createCachedClient(config, { cache: createPersistentCache({ dir }) });
    await client2.ask("state", QUESTIONS);
    expect(calls).toBe(1);
  });
});
