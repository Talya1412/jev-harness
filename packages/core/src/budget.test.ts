import { describe, it, expect, vi } from "vitest";
import { createBudgetGuard } from "./budget.js";
import { askJev } from "./client.js";
import { JevError } from "./types.js";

function okFetch(calls: string[] = []): typeof fetch {
  return (async (_url: unknown) => {
    calls.push("x");
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ model: "m", answers: { q: { type: "noul", noul: 0.5 } } }),
    } as unknown as Response;
  }) as typeof fetch;
}

const QUESTIONS = { q: { type: "noul", instructions: "ok?" } } as const;

describe("createBudgetGuard", () => {
  it("lets calls through while under the cap and counts them", async () => {
    const guard = createBudgetGuard({ maxPerWindow: 3, windowMs: 60_000 });
    const cfg = guard.wrap({ apiKey: "k", fetchImpl: okFetch() });
    await askJev(cfg, "s", QUESTIONS);
    await askJev(cfg, "s", QUESTIONS);
    expect(guard.stats()).toEqual({ windowCalls: 2, totalCalls: 2, rejected: 0 });
  });

  it("rejects with JevError once the window cap is hit", async () => {
    const guard = createBudgetGuard({ maxPerWindow: 2, windowMs: 60_000 });
    const cfg = guard.wrap({ apiKey: "k", fetchImpl: okFetch() });
    await askJev(cfg, "s", QUESTIONS);
    await askJev(cfg, "s", QUESTIONS);
    await expect(askJev(cfg, "s", QUESTIONS)).rejects.toThrow(/budget exhausted/);
    expect(guard.stats().rejected).toBe(1);
    expect(guard.stats().totalCalls).toBe(2);
  });

  it("enforces the lifetime cap", async () => {
    const guard = createBudgetGuard({ maxPerWindow: 100, maxTotal: 1 });
    const cfg = guard.wrap({ apiKey: "k", fetchImpl: okFetch() });
    await askJev(cfg, "s", QUESTIONS);
    await expect(askJev(cfg, "s", QUESTIONS)).rejects.toBeInstanceOf(JevError);
    expect(guard.stats().rejected).toBe(1);
  });

  it("slides the window over time", async () => {
    vi.useFakeTimers();
    try {
      const guard = createBudgetGuard({ maxPerWindow: 1, windowMs: 1000 });
      const cfg = guard.wrap({ apiKey: "k", fetchImpl: okFetch() });
      await askJev(cfg, "s", QUESTIONS);
      await expect(askJev(cfg, "s", QUESTIONS)).rejects.toThrow(/budget exhausted/);
      vi.advanceTimersByTime(1001);
      await askJev(cfg, "s", QUESTIONS);
      expect(guard.stats().windowCalls).toBe(1);
      expect(guard.stats().totalCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports limits through onLimit", async () => {
    const seen: Array<{ reason: string; used: number; limit: number }> = [];
    const guard = createBudgetGuard({
      maxPerWindow: 1,
      windowMs: 60_000,
      onLimit: (info) => seen.push(info),
    });
    const cfg = guard.wrap({ apiKey: "k", fetchImpl: okFetch() });
    await askJev(cfg, "s", QUESTIONS);
    await expect(askJev(cfg, "s", QUESTIONS)).rejects.toThrow();
    expect(seen).toEqual([{ reason: "window", used: 1, limit: 1 }]);
  });

  it("reset clears everything", async () => {
    const guard = createBudgetGuard({ maxPerWindow: 1, windowMs: 60_000 });
    const cfg = guard.wrap({ apiKey: "k", fetchImpl: okFetch() });
    await askJev(cfg, "s", QUESTIONS);
    await expect(askJev(cfg, "s", QUESTIONS)).rejects.toThrow();
    guard.reset();
    expect(guard.stats()).toEqual({ windowCalls: 0, totalCalls: 0, rejected: 0 });
    await askJev(cfg, "s", QUESTIONS);
  });
});
