import { describe, expect, it } from "vitest";
import {
  COMPACT_DEFAULTS,
  type CompactDefaults,
  batchCompactCalls,
  buildCompactState,
  collectCalls,
  estimateTokens,
  flatten,
  planCompaction,
  reduceCallQuestions,
} from "../src/compact.js";

/** A region with one large tool result, sized so reduction clears the ratio. */
function regionWithResult(text: string, id = "t1") {
  return [
    { role: "user", content: [{ type: "text", text: "fix the failing test" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id, name: "bash", input: { cmd: "cat big.log" } }],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] },
  ];
}

const bigLog = "log line with several words\n".repeat(400); // ~10k chars

/** Ask returns a caller-supplied probability per question id. */
function asker(probs: Record<string, number>) {
  return async (_state: unknown, questions: Record<string, unknown>) => {
    const out: Record<string, number> = {};
    for (const id of Object.keys(questions)) out[id] = probs[id] ?? 0;
    return out;
  };
}

/**
 * A region in OMP's OWN transcript spelling — the shape a real session file
 * holds: assistant messages carry `type: "toolCall"` blocks (id/name/
 * arguments) and every result is a separate `role: "toolResult"` message
 * (toolCallId/toolName/content). Verified against a 7.8 MB live transcript:
 * 720 toolCall blocks + 720 toolResult messages, and zero `tool_use` /
 * `tool_result` blocks.
 */
function nativeRegionWithResult(text: string, id = "call_1", tool = "bash") {
  return [
    { role: "user", content: [{ type: "text", text: "fix the failing test" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "running the log dump" },
        { type: "toolCall", id, name: tool, arguments: { cmd: "cat big.log" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: id,
      toolName: tool,
      content: [{ type: "text", text }],
      isError: false,
    },
  ];
}

const base: CompactDefaults = { ...COMPACT_DEFAULTS };

describe("flatten (native OMP shapes)", () => {
  it("reads text, tool_use, and tool_result blocks into one flat shape", () => {
    const [user, assistant, result] = flatten(regionWithResult("ok"));
    expect(user!.text).toBe("fix the failing test");
    expect(assistant!.toolUses).toEqual([
      { id: "t1", tool: "bash", input: { cmd: "cat big.log" } },
    ]);
    expect(result!.toolResults).toEqual([{ id: "t1", text: "ok" }]);
  });

  it("accepts the alternate tool_call/toolName/args spelling", () => {
    const [m] = flatten([
      {
        role: "assistant",
        content: [{ type: "tool_call", toolCallId: "c9", toolName: "read", args: { p: "a" } }],
      },
    ]);
    expect(m!.toolUses).toEqual([{ id: "c9", tool: "read", input: { p: "a" } }]);
  });

  it("reads a native toolCall block and its role:toolResult message", () => {
    const [user, assistant, result] = flatten(nativeRegionWithResult("ok"));
    expect(user!.text).toBe("fix the failing test");
    expect(assistant!.toolUses).toEqual([
      { id: "call_1", tool: "bash", input: { cmd: "cat big.log" } },
    ]);
    // The result body belongs to toolResults, never to the message text —
    // otherwise the render path would re-emit it verbatim.
    expect(result!.toolResults).toEqual([{ id: "call_1", text: "ok" }]);
    expect(result!.text).toBe("");
  });

  it("joins native toolResult content parts that are not a single string", () => {
    const [m] = flatten([
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
    ]);
    expect(m!.toolResults).toEqual([{ id: "c1", text: "a\nb" }]);
  });

  it("keeps the text of a toolResult message that carries no toolCallId", () => {
    const [m] = flatten([{ role: "toolResult", content: "orphan body" }]);
    expect(m!.text).toBe("orphan body");
    expect(m!.toolResults).toEqual([]);
  });

  it("joins array-form tool_result content and ignores unknown block types", () => {
    const [m] = flatten([
      {
        role: "user",
        content: [
          { type: "thing" },
          { type: "tool_result", tool_use_id: "a", content: [{ text: "x" }, "y"] },
        ],
      },
    ]);
    expect(m!.toolResults).toEqual([{ id: "a", text: "x\ny" }]);
  });
});

describe("collectCalls", () => {
  it("pairs a call with its result by id", () => {
    const calls = collectCalls(flatten(regionWithResult("hello")));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ id: "t1", tool: "bash", resultChars: 5, resultText: "hello" });
  });

  it("keeps a call with no result, but never invents one for an orphan result", () => {
    const msgs = flatten([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "no-result", name: "bash", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "orphan", content: "nobody asked" }],
      },
    ]);
    const calls = collectCalls(msgs);
    expect(calls.map((c) => c.id)).toEqual(["no-result"]);
    expect(calls[0]!.resultText).toBeNull();
  });
});

describe("estimateTokens", () => {
  it("lands above a naive word count and never collapses to zero", () => {
    expect(estimateTokens("")).toBe(8);
    expect(estimateTokens("hello world")).toBeGreaterThan(2);
  });

  it("prices digits above letters, matching the documented calibration", () => {
    const digits = estimateTokens("1234567890") - 8;
    const letters = estimateTokens("aaaaaaaaaa") - 8;
    expect(digits).toBeGreaterThan(letters);
  });
});

describe("buildCompactState", () => {
  it("replaces result bodies with a size note so state stays small", () => {
    const calls = collectCalls(flatten(regionWithResult(bigLog)));
    const state = JSON.stringify(buildCompactState(flatten(regionWithResult(bigLog)), calls));
    expect(state).toContain("chars (omitted)");
    expect(state).not.toContain(bigLog.slice(0, 80));
  });

  it("truncates an oversized assistant text instead of dropping it", () => {
    const [m] = flatten([
      { role: "assistant", content: [{ type: "text", text: "z".repeat(5000) }] },
    ]);
    const state = JSON.stringify(buildCompactState([m!], []));
    expect(state).toContain("...[truncated]...");
    expect(state.length).toBeLessThan(4500);
  });
});

describe("batchCompactCalls", () => {
  /** One call per index, so batch sizes are easy to count. */
  function manyCalls(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      id: "t" + i,
      tool: "bash",
      input: { cmd: "cmd" + i },
      resultChars: 10,
      resultText: "x".repeat(10),
    }));
  }

  it("keeps every call, in order, across the batches", () => {
    const calls = manyCalls(200);
    const flat = batchCompactCalls(calls, 2000, 30000).flat();
    expect(flat.map((c) => c.id)).toEqual(calls.map((c) => c.id));
  });

  it("splits once the budget can no longer hold the whole set", () => {
    const calls = manyCalls(200);
    // 30k budget minus a 25k state leaves room for roughly 29 question pairs.
    const batches = batchCompactCalls(calls, 25000, 30000);
    expect(batches.length).toBeGreaterThan(1);
    // Every batch must fit: its own questions plus the state stay under budget.
    for (const b of batches) {
      const questionTokens = estimateTokens(JSON.stringify(reduceCallQuestions(b)));
      expect(25000 + questionTokens).toBeLessThanOrEqual(30000);
    }
  });

  it("uses a single batch when the whole set fits", () => {
    const calls = manyCalls(5);
    expect(batchCompactCalls(calls, 1000, 30000)).toHaveLength(1);
  });

  it("still emits one call per batch when the state leaves no room", () => {
    const calls = manyCalls(3);
    const batches = batchCompactCalls(calls, 999999, 30000);
    expect(batches).toHaveLength(3);
    expect(batches.every((b) => b.length === 1)).toBe(true);
  });
});

describe("planCompaction", () => {
  it("defers when there is no message and when no call is scoreable", async () => {
    const empty = await planCompaction({ region: [], ask: asker({}), effective: base });
    expect(empty).toEqual({ kind: "defer", reason: "no-messages" });

    const textOnly = await planCompaction({
      region: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      ask: asker({}),
      effective: base,
    });
    expect(textOnly).toEqual({ kind: "defer", reason: "no-calls" });
  });

  it("defers when the state cannot fit, rather than sending a doomed request", async () => {
    const out = await planCompaction({
      region: regionWithResult(bigLog),
      ask: asker({}),
      effective: { ...base, maxStateTokens: 10 },
    });
    expect(out.kind).toBe("defer");
    if (out.kind === "defer") expect(out.reason).toBe("state-too-large");
  });

  it("defers when the saving is too small to justify the call", async () => {
    const out = await planCompaction({
      region: regionWithResult("short"),
      ask: asker({}),
      effective: base,
    });
    expect(out.kind).toBe("defer");
    if (out.kind === "defer") expect(out.reason).toBe("insufficient-reduction");
  });

  it("drops a large result the model scores as unnecessary, keeping its head", async () => {
    const out = await planCompaction({
      region: regionWithResult(bigLog),
      ask: asker({ call_t1: 0.9, result_t1: 0.05 }),
      effective: base,
    });
    expect(out.kind).toBe("compacted");
    if (out.kind !== "compacted") return;
    const { plan } = out;
    expect(plan.dropped.map((d) => d.call.id)).toEqual(["t1"]);
    // The head survives verbatim and the omission is announced with a count.
    expect(plan.summary).toContain(bigLog.slice(0, 50));
    expect(plan.summary).toContain("chars omitted by jev_compact");
    expect(plan.summary).not.toContain(bigLog);
    expect(plan.savedChars).toBe(bigLog.length - base.truncateHeadChars);
  });

  it("keeps a result the model scores as still-needed", async () => {
    const out = await planCompaction({
      region: regionWithResult(bigLog),
      ask: asker({ call_t1: 0.9, result_t1: 0.9 }),
      effective: base,
    });
    // Nothing dropped means no reduction, so the native compactor takes over.
    expect(out).toMatchObject({ kind: "defer", reason: "insufficient-reduction" });
  });

  it("fails open per id: a missing answer keeps the content", async () => {
    const out = await planCompaction({
      region: regionWithResult(bigLog),
      // Neither id answered — dropping requires a positive score.
      ask: async () => ({}),
      effective: base,
    });
    expect(out).toMatchObject({ kind: "defer", reason: "insufficient-reduction" });
  });

  it("records both probabilities on every decision", async () => {
    const out = await planCompaction({
      region: regionWithResult(bigLog),
      ask: asker({ call_t1: 0.33, result_t1: 0.11 }),
      effective: base,
    });
    if (out.kind !== "compacted") throw new Error("expected compaction");
    expect(out.plan.decisions[0]).toMatchObject({
      keepCall: 0.33,
      keepResult: 0.11,
      action: "drop_result",
    });
  });

  it("REGRESSION: a native-shaped transcript yields real calls, not a no-calls defer", async () => {
    // The shipped adapter recognised only Anthropic's tool_use/tool_result, so
    // a real OMP region flattened to zero calls and every compaction deferred
    // with reason "no-calls". flatten+collectCalls must see the native shape.
    const region = nativeRegionWithResult(bigLog);
    expect(collectCalls(flatten(region))).toHaveLength(1);
    const out = await planCompaction({
      region,
      ask: asker({ call_call_1: 0.9, result_call_1: 0.05 }),
      effective: base,
    });
    expect(out.kind).toBe("compacted");
    if (out.kind !== "compacted") return;
    expect(out.plan.dropped.map((d) => d.call.id)).toEqual(["call_1"]);
    expect(out.plan.savedChars).toBe(bigLog.length - base.truncateHeadChars);
  });

  it("REGRESSION: a truncated native result is HELD — head kept, body recoverable", async () => {
    const out = await planCompaction({
      region: nativeRegionWithResult(bigLog),
      ask: asker({ call_call_1: 0.9, result_call_1: 0.05 }),
      effective: base,
    });
    if (out.kind !== "compacted") throw new Error("expected compaction");
    const { summary } = out.plan;
    // The head survives byte-identically...
    expect(summary).toContain(bigLog.slice(0, base.truncateHeadChars));
    // ...the omission is announced with the exact count...
    expect(summary).toContain("chars omitted by jev_compact; re-run the tool to recover");
    expect(summary).toContain(String(bigLog.length - base.truncateHeadChars));
    // ...the full body is gone (that is the point of the reduction)...
    expect(summary).not.toContain(bigLog);
    // ...and the result is rendered exactly once, not twice and not zero times.
    const notes = summary.match(/chars omitted by jev_compact/g) ?? [];
    expect(notes).toHaveLength(1);
  });

  it("keeps a native result the model scores as still-needed, byte-identical", async () => {
    const out = await planCompaction({
      region: nativeRegionWithResult(bigLog),
      ask: asker({ call_call_1: 0.9, result_call_1: 0.95 }),
      effective: base,
    });
    expect(out).toMatchObject({ kind: "defer", reason: "insufficient-reduction" });
  });

  it("honours a custom truncate head", async () => {
    const out = await planCompaction({
      region: regionWithResult(bigLog),
      ask: asker({ call_t1: 0.9, result_t1: 0.05 }),
      effective: { ...base, truncateHeadChars: 20 },
    });
    if (out.kind !== "compacted") throw new Error("expected compaction");
    expect(out.plan.summary).toContain(bigLog.slice(0, 20));
    expect(out.plan.summary).not.toContain(bigLog.slice(0, 21));
  });
});
