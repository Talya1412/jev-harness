import { describe, it, expect } from "vitest";
import type { JevResponse } from "@jev-harness/core";
import { runEval } from "../src/run.js";
import type { EvalDataset } from "../src/dataset.js";

const questions = { q: { type: "noul", instructions: "ok?" } } as EvalDataset["questions"];

function dataset(n: number): EvalDataset {
  return {
    questions,
    cases: Array.from({ length: n }, (_, i) => ({
      id: `c${i}`,
      state: { i },
      label: { q: i % 2 === 0 },
    })),
  };
}

function okFetch(onCall?: (i: number) => void) {
  let calls = 0;
  const impl = (async (_url: unknown, init?: RequestInit) => {
    onCall?.(calls);
    calls++;
    const body = JSON.parse(String(init?.body));
    const answers: JevResponse["answers"] = {};
    for (const id of Object.keys(body.questions)) answers[id] = { type: "noul", noul: 0.9 };
    return new Response(
      JSON.stringify({ model: body.model, answers, usage: { input_tokens: 10, output_tokens: 5 } }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}

describe("runEval", () => {
  it("counts every attempt in requests and prices output as free", async () => {
    const { impl } = okFetch();
    const report = await runEval(
      { apiKey: "k", fetchImpl: impl },
      dataset(3),
      { sweep: false },
    );
    expect(report.failedCases).toBe(0);
    expect(report.usage.requests).toBe(3);
    expect(report.usage.inputTokens).toBe(30);
    expect(report.usage.outputTokens).toBe(15);
    // Output is free: only the 30 input tokens at $0.042/Mtok count.
    expect(report.usage.estimatedCostUsd).toBeCloseTo((30 * 0.042) / 1_000_000, 12);
  });

  it("counts failed attempts in requests too", async () => {
    const failing = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const realFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = failing;
    try {
      const report = await runEval({ apiKey: "k" }, dataset(2), { sweep: false });
      expect(report.failedCases).toBe(2);
      expect(report.usage.requests).toBe(2);
      expect(report.errors).toHaveLength(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("fails the run with a clear error when already aborted", async () => {
    const { impl, calls } = okFetch();
    const controller = new AbortController();
    controller.abort();
    await expect(runEval({ apiKey: "k", fetchImpl: impl }, dataset(4), { sweep: false, signal: controller.signal })).rejects.toThrow(
      /aborted/,
    );
    expect(calls()).toBe(0);
  });
});
