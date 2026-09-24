import { describe, it, expect } from "vitest";
import { createRefusalLedger } from "../src/infra.js";

describe("createRefusalLedger", () => {
  it("folds repeats of the same (key, reason) into one entry with an incrementing count", () => {
    const ledger = createRefusalLedger({ now: () => 1_000 });
    ledger.record("bash", "destructive command needs confirmation");
    ledger.record("bash", "destructive command needs confirmation");
    ledger.record("bash", "destructive command needs confirmation");
    const [entry] = ledger.entries();
    expect(ledger.entries()).toHaveLength(1);
    expect(entry.count).toBe(3);
    expect(entry.key).toBe("bash");
    expect(entry.reason).toBe("destructive command needs confirmation");
  });

  it("keeps the most recent occurrence time on a folded entry", () => {
    let clock = 100;
    const ledger = createRefusalLedger({ now: () => clock });
    ledger.record("write", "path outside the workspace");
    clock = 900;
    ledger.record("write", "path outside the workspace");
    expect(ledger.entries()[0].at).toBe(900);
  });

  it("keeps a different key or a different reason as a distinct entry", () => {
    const ledger = createRefusalLedger();
    ledger.record("bash", "needs confirmation");
    ledger.record("web", "needs confirmation");
    ledger.record("bash", "target not resolvable");
    expect(ledger.entries()).toHaveLength(3);
    expect(ledger.entries().map((e) => e.count)).toEqual([1, 1, 1]);
  });

  it("does not confuse keys that would collide under a naive join", () => {
    const ledger = createRefusalLedger();
    ledger.record("a", "b|c");
    ledger.record("a|b", "c");
    expect(ledger.entries()).toHaveLength(2);
  });

  it("caps retained distinct entries at max, newest kept", () => {
    const ledger = createRefusalLedger({ max: 3, now: () => 5 });
    for (let i = 0; i < 5; i++) ledger.record(`tool${i}`, `reason ${i}`);
    const keys = ledger.entries().map((e) => e.key);
    expect(keys).toEqual(["tool2", "tool3", "tool4"]);
  });

  it("keeps folding an entry that survives eviction and re-adds an evicted one as new", () => {
    const ledger = createRefusalLedger({ max: 2 });
    ledger.record("a", "r");
    ledger.record("b", "r");
    ledger.record("c", "r"); // evicts "a"
    ledger.record("b", "r"); // still folds
    ledger.record("a", "r"); // "b" is evicted, "a" is fresh
    const entries = ledger.entries();
    expect(entries.map((e) => e.key)).toEqual(["c", "a"]);
    expect(entries.map((e) => e.count)).toEqual([1, 1]);
  });

  it("uses a caller-supplied timestamp when given", () => {
    const ledger = createRefusalLedger({ now: () => 1 });
    ledger.record("k", "r", 42);
    expect(ledger.entries()[0].at).toBe(42);
  });

  it("returns frozen copies, so a caller cannot mutate ledger state", () => {
    const ledger = createRefusalLedger();
    ledger.record("k", "r");
    const snap = ledger.entries() as Array<{ count: number }>;
    expect(Object.isFrozen(snap[0])).toBe(true);
    expect(() => {
      snap[0].count = 99;
    }).toThrow(TypeError);
    expect(ledger.entries()[0].count).toBe(1);
  });

  it("clamps a nonsensical max instead of discarding everything", () => {
    const ledger = createRefusalLedger({ max: 0 });
    ledger.record("k", "r");
    expect(ledger.entries()).toHaveLength(1);
  });
});
