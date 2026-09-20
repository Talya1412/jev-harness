import { describe, expect, it } from "vitest";
import {
  DEFAULT_DESTRUCTIVE_THRESHOLD,
  DEFAULT_SKILL_CONFIDENCE,
  GATED_TOOLS,
  denyPayload,
  isSkill,
  parseNumber,
  parseSkills,
  skillPayload,
} from "../hooks/decisions.js";

describe("GATED_TOOLS", () => {
  it("covers the mutating tools and nothing read-only", () => {
    for (const tool of ["Bash", "Write", "Edit", "NotebookEdit"]) {
      expect(GATED_TOOLS.has(tool)).toBe(true);
    }
    for (const tool of ["Read", "Grep", "Glob", "BashOutput"]) {
      expect(GATED_TOOLS.has(tool)).toBe(false);
    }
  });
});

describe("parseNumber", () => {
  it("falls back on blank and unparseable input", () => {
    expect(parseNumber(undefined, 0.75)).toBe(0.75);
    expect(parseNumber("", 0.75)).toBe(0.75);
    expect(parseNumber("   ", 0.75)).toBe(0.75);
    expect(parseNumber("nope", 0.75)).toBe(0.75);
  });

  it("honours zero, which a truthiness check would silently drop", () => {
    expect(parseNumber("0", 0.75)).toBe(0);
  });
});

describe("isSkill", () => {
  it("accepts a named entry, with or without a description", () => {
    expect(isSkill({ name: "a", description: "d" })).toBe(true);
    expect(isSkill({ name: "a" })).toBe(true);
  });

  it("rejects anything a router could not use", () => {
    expect(isSkill(null)).toBe(false);
    expect(isSkill("a")).toBe(false);
    expect(isSkill({})).toBe(false);
    expect(isSkill({ name: "" })).toBe(false);
    expect(isSkill({ name: 5 })).toBe(false);
    expect(isSkill({ name: "a", description: 7 })).toBe(false);
  });
});

describe("parseSkills", () => {
  it("keeps the valid entries and drops the rest", () => {
    expect(parseSkills('[{"name":"a","description":"x"},{"nope":1},{"name":"b"}]')).toEqual([
      { name: "a", description: "x" },
      { name: "b" },
    ]);
  });

  it("returns nothing rather than throwing on a bad document", () => {
    // The hook is fail-open: a broken config means "no skills", never a crash.
    expect(parseSkills("not json")).toEqual([]);
    expect(parseSkills('{"name":"a"}')).toEqual([]);
    expect(parseSkills("")).toEqual([]);
    expect(parseSkills("null")).toEqual([]);
  });
});

describe("denyPayload", () => {
  it("names the tool, the score, and the bar", () => {
    const payload = denyPayload("Bash", 0.84, DEFAULT_DESTRUCTIVE_THRESHOLD);
    expect(payload.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(payload.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(payload.hookSpecificOutput.permissionDecisionReason).toContain("Bash");
    expect(payload.hookSpecificOutput.permissionDecisionReason).toContain("0.84");
    expect(payload.hookSpecificOutput.permissionDecisionReason).toContain("0.75");
  });
});

describe("skillPayload", () => {
  it("appends context and never replaces the prompt", () => {
    const payload = skillPayload("fh6-modding", 0.72);
    const out = payload.hookSpecificOutput;
    expect(out.hookEventName).toBe("UserPromptSubmit");
    expect(out.additionalContext).toContain("fh6-modding");
    expect(out.additionalContext).toContain("72%");
    // Append-only is the cache-safety invariant: no replacement field may exist.
    expect(out).not.toHaveProperty("permissionDecision");
    expect(Object.keys(out).sort()).toEqual(["additionalContext", "hookEventName"]);
  });

  it("rounds confidence to whole percent", () => {
    expect(skillPayload("s", 0.5).hookSpecificOutput.additionalContext).toContain("50%");
    expect(skillPayload("s", 0.999).hookSpecificOutput.additionalContext).toContain("100%");
  });
});

describe("defaults", () => {
  it("match the documented values", () => {
    expect(DEFAULT_DESTRUCTIVE_THRESHOLD).toBe(0.75);
    expect(DEFAULT_SKILL_CONFIDENCE).toBe(0.5);
  });
});
