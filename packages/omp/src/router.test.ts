import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_CANDIDATES,
  createSkillRouter,
  defaultSkillDirs,
  loadSkillRoster,
  parseSkillFrontmatter,
  readSkillDir,
  shortlist,
  skillHint,
  userAlreadyChose,
  type RosterSkill,
} from "../src/router.js";

const roster: RosterSkill[] = [
  { name: "fh6-modding", description: "Forza Horizon 6 modding playbook" },
  { name: "playwright-cli", description: "Automate browser interactions" },
  { name: "computer-use", description: "Drive native desktop apps" },
  { name: "xlsx", description: "Spreadsheet files" },
];

/** A temp skills root holding real `SKILL.md` files. */
function fixtureRoot(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "jev-skills-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "SKILL.md"), text, "utf8");
  }
  return dir;
}

describe("parseSkillFrontmatter", () => {
  it("reads flat name/description pairs", () => {
    expect(parseSkillFrontmatter("---\nname: xlsx\ndescription: Spreadsheets\n---\nbody")).toEqual({
      name: "xlsx",
      description: "Spreadsheets",
    });
  });

  it("folds a YAML block description from a real skill file into one line", () => {
    // Mirrors ~/.omp/agent/skills/fh6-modding/SKILL.md, which uses `>-`.
    const text = [
      "---",
      "name: fh6-modding",
      "description: >-",
      "  Forza Horizon 6 (ForzaTech) modding playbook.",
      "  Use BEFORE any FH6 modding task: XML, textures, audio.",
      "---",
      "",
      "# body",
    ].join("\n");
    expect(parseSkillFrontmatter(text)).toEqual({
      name: "fh6-modding",
      description:
        "Forza Horizon 6 (ForzaTech) modding playbook. Use BEFORE any FH6 modding task: XML, textures, audio.",
    });
  });

  it("returns null without frontmatter or without a name", () => {
    expect(parseSkillFrontmatter("# just a body")).toBeNull();
    expect(parseSkillFrontmatter("---\ndescription: nameless\n---")).toBeNull();
  });
});

describe("readSkillDir / loadSkillRoster", () => {
  it("reads a real directory tree of SKILL.md files", () => {
    const dir = fixtureRoot({
      "fh6-modding": "---\nname: fh6-modding\ndescription: modding\n---\n",
      xlsx: "---\nname: xlsx\ndescription: sheets\n---\n",
    });
    expect(
      readSkillDir(dir)
        .map((s) => s.name)
        .sort(),
    ).toEqual(["fh6-modding", "xlsx"]);
  });

  it("skips a directory with no SKILL.md and a missing root", () => {
    const dir = fixtureRoot({ ok: "---\nname: ok\ndescription: d\n---\n" });
    mkdirSync(join(dir, "not-a-skill"), { recursive: true });
    expect(readSkillDir(dir).map((s) => s.name)).toEqual(["ok"]);
    expect(readSkillDir(join(dir, "does-not-exist"))).toEqual([]);
  });

  it("lets an earlier root shadow a later one on a name collision", () => {
    const project = fixtureRoot({ dup: "---\nname: dup\ndescription: project version\n---\n" });
    const user = fixtureRoot({ dup: "---\nname: dup\ndescription: user version\n---\n" });
    const loaded = loadSkillRoster([project, user]);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.description).toBe("project version");
  });

  it("derives the same roots OMP discovers skills from", () => {
    const dirs = defaultSkillDirs("/work/repo", "/home/u");
    expect(dirs).toEqual([
      join("/work/repo", ".omp", "skills"),
      join("/home/u", ".omp", "agent", "skills"),
      join("/home/u", ".agents", "skills"),
    ]);
  });
});

describe("shortlist", () => {
  it("keeps descriptions with the names the prefilter picks", () => {
    const out = shortlist("run the playwright script for me", roster);
    expect(out.map((s) => s.name)).toEqual(["playwright-cli"]);
    expect(out[0]!.description).toBe("Automate browser interactions");
  });

  it("widens to the roster when no name matches, instead of abstaining", () => {
    expect(shortlist("help me with texture zips", roster).map((s) => s.name)).toEqual(
      roster.map((s) => s.name),
    );
  });

  it("caps the choice set so the question stays a valid choice", () => {
    const wide = Array.from({ length: MAX_CANDIDATES + 8 }, (_, i) => ({
      name: "skill-" + i,
      description: "d" + i,
    }));
    expect(shortlist("mention skill-3 here", wide)).toHaveLength(MAX_CANDIDATES);
  });
});

describe("userAlreadyChose", () => {
  it("recognises a /skill: token and a bare skill name", () => {
    expect(userAlreadyChose("/skill:fh6-modding now", roster)).toBe(true);
    expect(userAlreadyChose("use playwright-cli here", roster)).toBe(true);
  });

  it("is false for an ordinary prompt", () => {
    expect(userAlreadyChose("please automate the browser login flow", roster)).toBe(false);
  });
});

describe("createSkillRouter scheduling", () => {
  /** A judge that resolves once the caller releases it. */
  function deferredJudge() {
    const calls: Array<{
      text: string;
      release: (a: { skill: string | null; confidence: number }) => void;
    }> = [];
    const judge = (text: string) =>
      new Promise<{ skill: string | null; confidence: number }>((resolve) => {
        calls.push({ text, release: resolve });
      });
    return { calls, judge };
  }

  it("promotes a high-confidence answer and caches it per query", async () => {
    const judge = vi.fn(async () => ({ skill: "playwright-cli", confidence: 0.9 }));
    const router = createSkillRouter({ debounceMs: 0, judge });

    const first = await router.route("automate the playwright flow", roster);
    expect(first).toEqual({ skill: "playwright-cli", confidence: 0.9 });
    const second = await router.route("automate the playwright flow", roster);
    expect(second).toEqual(first);
    expect(judge).toHaveBeenCalledTimes(1);
    expect(router.stats().cached).toBe(1);
  });

  it("re-decides once the cached answer has aged out", async () => {
    let clock = 0;
    const judge = vi.fn(async () => ({ skill: "xlsx", confidence: 0.8 }));
    const router = createSkillRouter({ debounceMs: 0, cacheTtlMs: 100, now: () => clock, judge });
    await router.route("spreadsheets please", roster);
    clock = 500;
    await router.route("spreadsheets please", roster);
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it("a burst of DIFFERENT prompts never overlaps and never delivers a stale answer", async () => {
    // Two distinct prompts genuinely need two judgments (the question is
    // "which skill fits THIS message"), so the guarantee is not "one call for
    // any burst" — it is that the calls are serialized, the superseded answer
    // is discarded rather than delivered, and nothing is stacked in parallel.
    let concurrent = 0;
    let maxConcurrent = 0;
    const judge = vi.fn(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 15));
      concurrent--;
      return { skill: "xlsx" as string | null, confidence: 0.9 };
    });
    const router = createSkillRouter({ debounceMs: 10, judge });
    const [a, b] = await Promise.all([
      router.route("first prompt about spreadsheets", roster),
      router.route("second prompt about spreadsheets", roster),
    ]);

    expect(maxConcurrent).toBe(1);
    // Exactly one of the two is reported as superseded, and it is not given an
    // answer as if it were current; the survivor carries the real judgment.
    expect(router.stats().superseded).toBe(1);
    expect([a, b].filter((x) => x === null)).toHaveLength(1);
    expect([a, b].filter((x) => x !== null)).toEqual([{ skill: "xlsx", confidence: 0.9 }]);
  });

  it("a repeated prompt inside the burst window costs no second call", async () => {
    // The common real burst: the same text submitted twice (a double Enter, a
    // retry). The per-query cache must absorb it.
    const judge = vi.fn(async () => ({ skill: "xlsx", confidence: 0.9 }));
    const router = createSkillRouter({ debounceMs: 10_000, judge });
    const first = await router.route("the very same spreadsheet prompt", roster);
    const second = await router.route("the very same spreadsheet prompt", roster);
    expect(second).toEqual(first);
    expect(judge).toHaveBeenCalledTimes(1);
    expect(router.stats().cached).toBe(1);
  });

  it("does NOT delay a lone prompt: the input hook awaits this call", async () => {
    const judge = vi.fn(async () => ({ skill: "xlsx", confidence: 0.9 }));
    const router = createSkillRouter({ debounceMs: 5_000, judge });
    const started = Date.now();
    const answer = await router.route("one single spreadsheet question", roster);
    // A 5s debounce that applied to the first prompt would return here after 5s.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(answer).toEqual({ skill: "xlsx", confidence: 0.9 });
  });

  it("never runs two judgments at once", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const judge = async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent--;
      return { skill: "xlsx", confidence: 0.9 };
    };
    const router = createSkillRouter({ debounceMs: 0, judge });
    await Promise.all([
      router.route("alpha spreadsheet question", roster),
      router.route("beta spreadsheet question", roster),
      router.route("gamma spreadsheet question", roster),
    ]);
    expect(maxConcurrent).toBe(1);
  });

  it("DISCARDS an answer that a newer prompt obsoleted before it settled", async () => {
    const { calls, judge } = deferredJudge();
    const router = createSkillRouter({ debounceMs: 0, judge });
    const first = router.route("first spreadsheet question", roster);
    await new Promise((r) => setTimeout(r, 5));
    const second = router.route("second spreadsheet question", roster);

    // Let the first judgment settle, then release the second.
    calls[0]!.release({ skill: "xlsx", confidence: 0.99 });
    await new Promise((r) => setTimeout(r, 5));
    if (calls[1]) calls[1].release({ skill: "xlsx", confidence: 0.99 });

    const [a, b] = await Promise.all([first, second]);
    // The superseded answer must not be delivered as if it were current.
    expect(a).toBeNull();
    expect(b).toEqual({ skill: "xlsx", confidence: 0.99 });
  });

  it("surfaces no suggestion when the judge abstains", async () => {
    const router = createSkillRouter({
      debounceMs: 0,
      judge: async () => ({ skill: null, confidence: 0.2 }),
    });
    expect(await router.route("unrelated text here", roster)).toEqual({
      skill: null,
      confidence: 0.2,
    });
  });

  it("propagates a judge rejection so the caller can classify the failure", async () => {
    const router = createSkillRouter({
      debounceMs: 0,
      judge: async () => {
        throw new Error("fetch failed");
      },
    });
    await expect(router.route("some spreadsheet prompt", roster)).rejects.toThrow("fetch failed");
  });
});

describe("skillHint", () => {
  it("renders the name and rounded confidence, and nothing for an abstain", () => {
    expect(skillHint({ skill: "fh6-modding", confidence: 0.723 })).toBe(
      "[jev] Consider loading skill: fh6-modding (72% from the installed roster)",
    );
    expect(skillHint({ skill: null, confidence: 0.9 })).toBeNull();
  });
});
