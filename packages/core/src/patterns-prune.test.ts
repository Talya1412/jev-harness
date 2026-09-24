import { describe, it, expect } from "vitest";
import { pruneContext } from "../src/patterns-prune.js";
import type { PruneCandidate } from "../src/patterns-prune.js";
import type { JevResponse } from "../src/types.js";

/** Route every call through a canned response, recording the request bodies. */
function jevStub(answers: JevResponse["answers"]) {
  const seen: any[] = [];
  const fetchImpl = (async (_url: any, init: any) => {
    seen.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

describe("pruneContext", () => {
  it("drop+replacement-exact", async () => {
    const { fetchImpl } = jevStub({ a: { type: "noul", noul: 0.1 } });
    const text = "A".repeat(300) + "B".repeat(4700); // 5000 chars: head is exactly the As
    const r = await pruneContext({ apiKey: "k", fetchImpl }, [{ id: "a", text }]);
    expect(r.deferred).toBe(false);
    expect(r.decisions).toHaveLength(1);
    const [d] = r.decisions;
    expect(d.keep).toBe(false);
    expect(d.score).toBe(0.1);
    expect(d.chars).toBe(5000);
    expect(d.replacement).toBe(
      "A".repeat(300) +
        "\n[... 4700 chars omitted by jev prune; id=a — original retained by caller]",
    );
    expect(d.omittedChars).toBe(4700);
  });

  it("keep-in-band", async () => {
    const { fetchImpl } = jevStub({
      band: { type: "noul", noul: 0.4 }, // below keep, above drop → band keeps
      edge: { type: "noul", noul: 0.5 }, // exactly the keep bar: strict < keeps
      near: { type: "noul", noul: 0.26 }, // just above the drop bar → keeps
    });
    const r = await pruneContext({ apiKey: "k", fetchImpl }, [
      { id: "band", text: "b".repeat(2000) },
      { id: "edge", text: "e".repeat(2000) },
      { id: "near", text: "n".repeat(2000) },
    ]);
    expect(r.deferred).toBe(false);
    expect(r.decisions.map((d) => d.keep)).toEqual([true, true, true]);
    expect(r.decisions.map((d) => d.score)).toEqual([0.4, 0.5, 0.26]);
    for (const d of r.decisions) expect(d.replacement).toBeUndefined();
  });

  it("error-kind-needs-errorDrop", async () => {
    const { fetchImpl } = jevStub({
      errBand: { type: "noul", noul: 0.25 }, // would drop as plain output, keeps as error
      errBar: { type: "noul", noul: 0.1 }, // at the error bar (inclusive) → drops
      errAbove: { type: "noul", noul: 0.11 }, // just above the error bar → keeps
      diagBar: { type: "noul", noul: 0.1 }, // diagnostic answers to the error bar too
      outSame: { type: "noul", noul: 0.11 }, // 0.11 as plain output DOES drop (<= 0.25)
    });
    const r = await pruneContext({ apiKey: "k", fetchImpl }, [
      { id: "errBand", text: "e".repeat(2000), kind: "error" },
      { id: "errBar", text: "e".repeat(2000), kind: "error" },
      { id: "errAbove", text: "e".repeat(2000), kind: "error" },
      { id: "diagBar", text: "d".repeat(2000), kind: "diagnostic" },
      { id: "outSame", text: "o".repeat(2000), kind: "output" },
    ]);
    expect(r.deferred).toBe(false);
    expect(r.decisions.map((d) => d.keep)).toEqual([true, false, true, false, false]);
  });

  it("minChars-no-request", async () => {
    const { fetchImpl, seen } = jevStub({});
    const r = await pruneContext({ apiKey: "k", fetchImpl }, [{ id: "s", text: "x".repeat(1999) }]);
    expect(seen.length).toBe(0); // short text costs no question
    expect(r.deferred).toBe(false);
    expect(r.decisions).toEqual([{ id: "s", keep: true, score: 1, chars: 1999 }]);
  });

  it("protect-veto", async () => {
    const { fetchImpl, seen } = jevStub({
      p1: { type: "noul", noul: 0 }, // would drop if ever asked
      p2: { type: "noul", noul: 0 },
    });
    const items = [
      { id: "p1", text: "x".repeat(5000) },
      { id: "p2", text: "y".repeat(5000) },
    ];
    const r = await pruneContext({ apiKey: "k", fetchImpl }, items, {
      protect: (item) => item.id === "p1",
    });
    expect(seen.length).toBe(1);
    expect(seen[0].questions.p1).toBeUndefined(); // vetoed item: NO question asked
    expect(seen[0].questions.p2).toBeTruthy();
    expect(r.decisions[0]).toEqual({ id: "p1", keep: true, score: 1, chars: 5000 });
    expect(r.decisions[1].keep).toBe(false); // the unprotected sibling still drops
    expect(r.decisions[1].replacement).toContain("id=p2");
  });

  it("missing-keeps", async () => {
    const { fetchImpl } = jevStub({
      judged: { type: "noul", noul: 0.1 },
      // "absent" is simply not answered; "wrong-type" and "out-of-range"
      // are answered in unreadable shapes.
      "wrong-type": { type: "choice", choice: "drop", confidence: 0.9, probabilities: {} },
      "out-of-range": { type: "noul", noul: 7 },
    });
    const r = await pruneContext({ apiKey: "k", fetchImpl }, [
      { id: "judged", text: "a".repeat(3000) },
      { id: "absent", text: "b".repeat(3000) },
      { id: "wrong-type", text: "c".repeat(3000) },
      { id: "out-of-range", text: "d".repeat(3000) },
    ]);
    expect(r.deferred).toBe(false);
    expect(r.decisions.map((d) => d.keep)).toEqual([false, true, true, true]);
    // Unreadable judgments are kept unjudged (sentinel 1), never read-as-zero.
    for (const d of r.decisions.slice(1)) {
      expect(d.score).toBe(1);
      expect(d.replacement).toBeUndefined();
    }
  });

  it("oversized-defers-zero-requests", async () => {
    const { fetchImpl, seen } = jevStub({});
    const r = await pruneContext({ apiKey: "k", fetchImpl }, [
      { id: "big", text: "z".repeat(120_000) },
    ]);
    // 120k+ chars / 4 ≈ 30k tokens > maxStateTokens 25000 → guard fires first.
    expect(seen.length).toBe(0);
    expect(r.deferred).toBe(true);
    expect(r.reason).toBe("state-too-large");
    expect(r.decisions).toEqual([{ id: "big", keep: true, score: 1, chars: 120_000 }]);
    expect(r.decisions[0].replacement).toBeUndefined();
  });

  it("batching-70→2-requests index-aligned", async () => {
    const answers: JevResponse["answers"] = {};
    const items: PruneCandidate[] = [];
    for (let i = 0; i < 70; i++) {
      const id = `item-${i}`;
      items.push({ id, text: "t".repeat(2000) });
      answers[id] = { type: "noul", noul: 0.9 };
    }
    const { fetchImpl, seen } = jevStub(answers);
    // 70 × 2000 chars ≈ 35k tokens, so widen the state budget for this batch test.
    const r = await pruneContext({ apiKey: "k", fetchImpl }, items, { maxStateTokens: 100_000 });
    expect(seen.length).toBe(2); // 64 + 6: sequential batches of ≤ maxItemsPerRequest
    expect(Object.keys(seen[0].questions)).toHaveLength(64);
    expect(Object.keys(seen[1].questions)).toEqual([
      "item-64",
      "item-65",
      "item-66",
      "item-67",
      "item-68",
      "item-69",
    ]);
    expect(r.deferred).toBe(false);
    expect(r.decisions).toHaveLength(70);
    r.decisions.forEach((d, i) => {
      expect(d.id).toBe(`item-${i}`); // decisions are index-aligned with the input
      expect(d.keep).toBe(true);
    });
  });

  it("input-unchanged", async () => {
    const { fetchImpl } = jevStub({
      a: { type: "noul", noul: 0.1 },
      b: { type: "noul", noul: 0.1 },
    });
    const items: PruneCandidate[] = [
      { id: "a", text: "x".repeat(5000), kind: "output" },
      { id: "b", text: "y".repeat(5000), kind: "error" },
    ];
    const before = JSON.parse(JSON.stringify(items));
    await pruneContext({ apiKey: "k", fetchImpl }, items);
    expect(items).toEqual(before); // both drop, but the input array is untouched
  });
});
