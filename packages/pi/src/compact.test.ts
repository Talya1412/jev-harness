import { describe, expect, it } from "vitest";
import {
  DEFAULT_KEEP_THRESHOLD,
  FIELD_LIMIT,
  MAX_COMPACTION_PAIRS,
  blockText,
  collectToolPairs,
  keepThreshold,
  truncate,
} from "../src/compact.js";

/** Minimal assistant toolCall entry. */
function call(id: string, name = "bash", args: unknown = { cmd: "ls" }) {
  return {
    type: "message",
    message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
  };
}

/** Minimal toolResult entry matching a call id. */
function result(id: string, text = "output") {
  return {
    type: "message",
    message: { role: "toolResult", toolCallId: id, content: [{ type: "text", text }] },
  };
}

describe("keepThreshold", () => {
  it("accepts a probability and falls back outside 0..1", () => {
    expect(keepThreshold("0.35")).toBe(0.35);
    expect(keepThreshold("0")).toBe(0);
    expect(keepThreshold("1")).toBe(1);
    expect(keepThreshold("2")).toBe(DEFAULT_KEEP_THRESHOLD);
    expect(keepThreshold("-1")).toBe(DEFAULT_KEEP_THRESHOLD);
    expect(keepThreshold(undefined)).toBe(DEFAULT_KEEP_THRESHOLD);
  });
});

describe("truncate", () => {
  it("leaves short text alone and marks a cut", () => {
    expect(truncate("abc", 5)).toBe("abc");
    expect(truncate("abcdef", 3)).toBe("abc [truncated]");
  });
});

describe("blockText", () => {
  it("reads a plain string and joins text blocks", () => {
    expect(blockText("plain")).toBe("plain");
    expect(
      blockText([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\nb");
  });

  it("ignores non-text and malformed blocks instead of throwing", () => {
    expect(blockText([{ type: "image" }, null, "stray", { type: "text" }])).toBe("");
    expect(blockText(42)).toBe("");
  });
});

describe("collectToolPairs", () => {
  it("pairs a call with its result", () => {
    const pairs = collectToolPairs([call("a"), result("a", "hello")]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ key: "a", tool: "bash", resultText: "hello" });
  });

  it("skips a call with no result, so nothing scoreable is judged", () => {
    expect(collectToolPairs([call("orphan")])).toEqual([]);
  });

  it("skips a result with no call", () => {
    expect(collectToolPairs([result("nobody")])).toEqual([]);
  });

  it("ignores entries that are not messages", () => {
    expect(collectToolPairs([{ type: "summary" }, call("a"), result("a")])).toHaveLength(1);
  });

  it("caps the pairs scored in one pass", () => {
    const entries = [];
    for (let i = 0; i < MAX_COMPACTION_PAIRS + 10; i++) {
      entries.push(call("t" + i), result("t" + i));
    }
    expect(collectToolPairs(entries)).toHaveLength(MAX_COMPACTION_PAIRS);
  });

  it("serializes arguments and caps each field", () => {
    const big = "x".repeat(FIELD_LIMIT * 2);
    const pairs = collectToolPairs([call("a", "bash", { cmd: big }), result("a", big)]);
    expect(pairs[0]!.argsText).toHaveLength(FIELD_LIMIT + " [truncated]".length);
    expect(pairs[0]!.resultText).toHaveLength(FIELD_LIMIT + " [truncated]".length);
  });
});
