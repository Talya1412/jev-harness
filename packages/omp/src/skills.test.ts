import { describe, expect, it } from "vitest";
import { MAX_CANDIDATES, candidatePayload, lexicalScores, shortlistSkills } from "../src/skills.js";

const roster = [
  { name: "fh6-modding", description: "Forza Horizon 6 modding playbook" },
  { name: "playwright-cli", description: "Automate browser interactions" },
  { name: "computer-use", description: "Drive native desktop apps" },
  { name: "xlsx", description: "Spreadsheet files" },
];

describe("lexicalScores", () => {
  it("scores a long name part above a short one", () => {
    const [modding] = lexicalScores("fh6 modding question", roster).filter((s) => s.name === "fh6-modding");
    // "modding" (>3 chars) is worth 2; "fh6" (<=4 chars) is worth 1.
    expect(modding!.score).toBe(3);
  });

  it("matches the acronym half of a hyphenated name", () => {
    const hit = lexicalScores("texture zips for fh6", roster).find((s) => s.name === "fh6-modding");
    expect(hit!.score).toBeGreaterThan(0);
  });
});

describe("shortlistSkills", () => {
  it("narrows to lexical matches when some exist", () => {
    const out = shortlistSkills("run the playwright script for me", roster);
    expect(out.map((s) => s.name)).toEqual(["playwright-cli"]);
  });

  it("treats a prompt with no name token as unknown, not irrelevant", () => {
    // "browser" appears in a description but in no name — the prefilter is
    // lexical only, so this must widen to the roster rather than abstain.
    const out = shortlistSkills("please automate the browser login flow", roster);
    expect(out.map((s) => s.name)).toEqual(roster.map((s) => s.name));
  });

  it("falls back to the whole roster when nothing matches lexically", () => {
    // Regression: an early prefilter required a literal name token, so
    // "texture zips" shortlisted nothing and routing silently abstained.
    const out = shortlistSkills("help me with texture zips", roster);
    expect(out.map((s) => s.name)).toEqual(roster.map((s) => s.name));
  });

  it("caps the choice set so the request stays a valid choice question", () => {
    const wide = Array.from({ length: MAX_CANDIDATES + 8 }, (_, i) => ({
      name: "skill-" + i,
      description: "d" + i,
    }));
    expect(shortlistSkills("mention skill-3 here", wide)).toHaveLength(MAX_CANDIDATES);
  });
});

describe("candidatePayload", () => {
  it("carries a one-line description for every shortlisted candidate", () => {
    const short = [roster[0]!];
    const payload = candidatePayload(roster, short);
    expect(payload).toEqual([
      { name: "fh6-modding", description: "Forza Horizon 6 modding playbook" },
    ]);
  });

  it("collapses whitespace and truncates long descriptions", () => {
    const long = [{ name: "a", description: "x".repeat(400) + "\n\nend" }];
    const [sent] = candidatePayload(long, long);
    expect(sent!.description).toHaveLength(180);
    expect(sent!.description).not.toContain("\n");
  });

  it("yields an empty description rather than dropping an unknown name", () => {
    const payload = candidatePayload(roster, [{ name: "ghost", description: "ignored" }]);
    expect(payload).toEqual([{ name: "ghost", description: "" }]);
  });
});
