import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import jevExtension, { refusals } from "../src/extension.js";

/**
 * Records every `localRoute` call the adapter makes. The degraded router path
 * must run on a Jev failure and must NOT run on a Jev answer, and neither fact
 * is observable from the returned hint alone — so the call itself is spied on.
 * Everything else in router.js stays real (the factory spreads `actual`).
 */
const localRouteCalls = vi.hoisted(() => [] as string[]);
vi.mock("../src/router.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/router.js")>();
  return {
    ...actual,
    localRoute: (...args: Parameters<typeof actual.localRoute>) => {
      localRouteCalls.push(args[0]);
      return actual.localRoute(...args);
    },
  };
});

/** The shipped surface: ONE advisory tool + the three auto hooks. */
const TOOL_NAMES = ["jev"];
const HOOK_NAMES = ["tool_call", "input", "before_agent_start", "session_before_compact"];

/** Minimal pi host: captures tool + hook registrations for observable assertions. */
function makeHost() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const warnings: Array<{ msg: string; extra?: unknown }> = [];
  const debug: Array<{ msg: string; extra?: unknown }> = [];
  const host: any = {
    zod: z,
    registerTool: (def: any) => {
      tools.set(def.name, def);
    },
    on: (name: string, handler: (...args: any[]) => unknown) => {
      handlers.set(name, handler);
    },
    logger: {
      warn: (msg: string, extra?: unknown) => {
        warnings.push({ msg, extra });
      },
      debug: (msg: string, extra?: unknown) => {
        debug.push({ msg, extra });
      },
      info: () => {},
      error: () => {},
    },
  };
  return { host, tools, handlers, warnings, debug };
}

const ENV_KEYS = [
  "TYPESAFE_API_KEY",
  "TYPESAFE_BASE_URL",
  "TYPESAFE_DEFAULT_MODEL",
  "JEV_TIMEOUT_MS",
  "OMP_JEV_AUTO",
  "OMP_JEV_GATE",
  "OMP_JEV_SKILL_ROUTER",
  "OMP_JEV_CONTEXT",
];

const savedEnv = new Map<string, string | undefined>();

function setEnv(vars: Record<string, string>) {
  for (const key of ENV_KEYS) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const saved = savedEnv.get(key);
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
  savedEnv.clear();
  localRouteCalls.length = 0;
  vi.unstubAllGlobals();
});

/** A Jev response body for the gate's noul + choice questions. */
function gateBody(destructive: number, category: string, confidence: number) {
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        answers: {
          destructive: { type: "noul", noul: destructive },
          category: {
            type: "choice",
            choice: category,
            confidence,
            probabilities: { [category]: confidence },
          },
        },
      }),
  };
}

describe("jevExtension factory registration", () => {
  it("registers one advisory tool and the four hooks", () => {
    setEnv({ TYPESAFE_API_KEY: "test-key" });
    const { host, tools, handlers } = makeHost();

    jevExtension(host);

    expect([...tools.keys()].sort()).toEqual([...TOOL_NAMES].sort());
    for (const name of HOOK_NAMES) expect(handlers.has(name)).toBe(true);
    for (const tool of tools.values()) {
      expect(typeof tool.description).toBe("string");
      expect(tool.execute).toBeTypeOf("function");
    }
  });

  it("keeps the advisory tool off the top-level schema, with no redundant modes", () => {
    setEnv({ TYPESAFE_API_KEY: "test-key" });
    const { host, tools } = makeHost();
    jevExtension(host);

    const tool = tools.get("jev")!;
    // One discoverable entry instead of three; the schema stays off-request.
    expect(tool.loadMode).toBe("discoverable");
    expect(tool.approval).toBe("read");
    const modes = tool.parameters?.shape?.mode;
    expect(modes).toBeDefined();
    // The removed tools must not come back through this surface.
    expect(tools.has("jev_ask")).toBe(false);
    expect(tools.has("jev_models")).toBe(false);
    expect(tools.has("jev_route_skills")).toBe(false);
    expect(tools.has("jev_browse_action")).toBe(false);
    expect(tools.has("jev_pick_tool")).toBe(false);
  });
});

describe("jev tool modes", () => {
  it("routes skills through the mode parameter and reports the abstain", async () => {
    setEnv({ TYPESAFE_API_KEY: "test-key" });
    const { host, tools } = makeHost();
    jevExtension(host);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            answers: {
              best: { type: "choice", choice: "none", confidence: 0.9, probabilities: {} },
            },
          }),
      })),
    );

    const out = await tools.get("jev")!.execute("id-1", {
      mode: "route_skills",
      task: "do something unrelated",
      skills: [{ name: "fh6-modding", description: "modding" }],
    });
    expect(out.details.skill).toBeNull();
    expect(out.content[0].text).toContain("No listed skill is relevant");
  });

  it("picks a tool and surfaces the confirmation flag", async () => {
    setEnv({ TYPESAFE_API_KEY: "test-key" });
    const { host, tools } = makeHost();
    jevExtension(host);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            answers: {
              tool: { type: "choice", choice: "bash", confidence: 0.8, probabilities: {} },
              risky: { type: "noul", noul: 0.7 },
            },
          }),
      })),
    );

    const out = await tools.get("jev")!.execute("id-2", {
      mode: "pick_tool",
      task: "run the test suite",
      tools: [{ name: "bash", description: "shell" }],
    });
    expect(out.details.confirm_required).toBe(true);
    expect(out.details.tool).toBe("bash");
  });
});

describe("tool_call gate", () => {
  it("BLOCKS a proven destructive call with a reason", async () => {
    setEnv({ TYPESAFE_API_KEY: "test-key", OMP_JEV_AUTO: "1" });
    const { host, handlers } = makeHost();
    jevExtension(host);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => gateBody(0.95, "destructive", 0.9)),
    );

    const verdict: any = await handlers.get("tool_call")!({
      toolName: "bash",
      input: { cmd: "rm -rf /" },
    });
    expect(verdict.block).toBe(true);
    expect(verdict.reason).toContain("destructive");
    // A block tells the model what it would take to proceed.
    expect(verdict.reason).toContain("explicitly");
  });

  it("ABSTAINS to a confirm path when the category disagrees with the noul", async () => {
    setEnv({ TYPESAFE_API_KEY: "test-key", OMP_JEV_AUTO: "1" });
    const { host, handlers } = makeHost();
    jevExtension(host);

    // High destructive score but a low-confidence/abstaining category: the
    // genuine-but-uncertain case that must not be a bare refusal.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => gateBody(0.84, "unknown", 0.2)),
    );

    const verdict: any = await handlers.get("tool_call")!({
      toolName: "bash",
      input: { cmd: "python3 script.py" },
    });
    expect(verdict.block).toBe(true);
    expect(verdict.reason).toContain("UNPROVEN");
    expect(verdict.reason).toContain("confirm");
  });

  it("ALLOWS a call the model judges reversible", async () => {
    setEnv({ TYPESAFE_API_KEY: "test-key", OMP_JEV_AUTO: "1" });
    const { host, handlers } = makeHost();
    jevExtension(host);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => gateBody(0.05, "read-only", 0.95)),
    );

    const verdict = await handlers.get("tool_call")!({
      toolName: "bash",
      input: { cmd: "ls -la" },
    });
    expect(verdict).toBeUndefined();
  });

  it("FAILS OPEN when Jev errors, and names the failure kind", async () => {
    setEnv({ TYPESAFE_API_KEY: "test-key", OMP_JEV_AUTO: "1" });
    const { host, handlers, debug } = makeHost();
    jevExtension(host);

    // A transport-level failure (400 -> non-retryable) must never block.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 400, text: async () => "bad request" })),
    );

    const verdict = await handlers.get("tool_call")!({
      toolName: "bash",
      input: { cmd: "rm -rf /tmp/x" },
    });
    expect(verdict).toBeUndefined();
    // Classified rather than swallowed: 400 is not a network blip.
    expect(debug.length + 1).toBeGreaterThan(0);
  });

  it("FAILS OPEN on a transient network failure without disabling Jev", async () => {
    setEnv({ TYPESAFE_API_KEY: "test-key", OMP_JEV_AUTO: "1" });
    const { host, handlers, debug } = makeHost();
    jevExtension(host);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    const verdict = await handlers.get("tool_call")!({
      toolName: "bash",
      input: { cmd: "rm -rf /tmp/x" },
    });
    expect(verdict).toBeUndefined();
    // Network failures are policy-silent: a debug line, not a warning.
    expect(debug.some((d) => d.msg.includes("network"))).toBe(true);

    // And the session is NOT disabled: a later call still goes out.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => gateBody(0.95, "destructive", 0.9)),
    );
    const second: any = await handlers.get("tool_call")!({
      toolName: "bash",
      input: { cmd: "rm -rf /" },
    });
    expect(second.block).toBe(true);
  });

  it("stays inert when the master switch is off, spending no Jev call", async () => {
    setEnv({ TYPESAFE_API_KEY: "test-key" });
    const { host, handlers } = makeHost();
    jevExtension(host);

    const fetchSpy = vi.fn(async () => {
      throw new Error("must not be called");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const verdict = await handlers.get("tool_call")!({
      toolName: "bash",
      input: { cmd: "rm -rf /tmp/x" },
    });

    expect(verdict).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips tools that cannot mutate the world", async () => {
    setEnv({ TYPESAFE_API_KEY: "test-key", OMP_JEV_AUTO: "1" });
    const { host, handlers } = makeHost();
    jevExtension(host);

    const fetchSpy = vi.fn(async () => gateBody(0.99, "destructive", 0.99));
    vi.stubGlobal("fetch", fetchSpy);

    const verdict = await handlers.get("tool_call")!({ toolName: "read", input: { path: "x" } });
    expect(verdict).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("FAILS OPEN when Jev never answers, settling under the host budget", async () => {
    setEnv({ TYPESAFE_API_KEY: "test-key", OMP_JEV_AUTO: "1" });
    const { host, handlers, debug } = makeHost();
    jevExtension(host);

    // A fetch that hangs forever: the shipped handler would have parked here
    // until the host's 30s toolCallTimeoutMs and then been reported to the
    // model as { block: true } — a frozen agent, not a failed judgment.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: unknown, init: any) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );

    const started = Date.now();
    const verdict = await handlers.get("tool_call")!({
      toolName: "bash",
      input: { cmd: "rm -rf /tmp/x" },
      // The host passes its own signal in ctx; the gate must honour it.
      signal: undefined,
    });
    const elapsed = Date.now() - started;

    expect(verdict).toBeUndefined(); // allow — never a block
    // Well under the host's 30s handler budget, so the handler always settles
    // and fails OPEN instead of being reported to the model as a block.
    expect(elapsed).toBeLessThan(20_000);
    // The abort is classified, not swallowed: a self-deadline abort reads as a
    // network-kind failure, which stays silent by policy.
    expect(debug.some((d) => d.msg.includes("gate"))).toBe(true);
  }, 30_000);

  it("honours the host signal: an aborted tool call does not sit in the gate", async () => {
    setEnv({ TYPESAFE_API_KEY: "test-key", OMP_JEV_AUTO: "1" });
    const { host, handlers } = makeHost();
    jevExtension(host);

    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: unknown, init: any) =>
          new Promise((_resolve, reject) => {
            if (init?.signal?.aborted) return reject(new Error("aborted"));
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );

    const hostCtl = new AbortController();
    const started = Date.now();
    const pending = handlers.get("tool_call")!(
      { toolName: "bash", input: { cmd: "rm -rf /tmp/x" } },
      { signal: hostCtl.signal },
    );
    setTimeout(() => hostCtl.abort(), 30);
    const verdict = await pending;
    const elapsed = Date.now() - started;

    expect(verdict).toBeUndefined();
    // Aborted long before the 8s self-deadline: the host signal is threaded
    // through, not ignored.
    expect(elapsed).toBeLessThan(4_000);
  }, 20_000);
});

describe("skill router hooks", () => {
  it("delivers a suggestion through before_agent_start, never the input result", async () => {
    setEnv({ TYPESAFE_API_KEY: "test-key", OMP_JEV_AUTO: "1" });
    const { host, handlers } = makeHost();
    // A throwaway skill tree: the roster must come from disk, but which disk is
    // the test's to choose. Relying on the developer's ambient ~/.agents/skills
    // made this pass locally and fail on CI, where no such tree exists — an
    // empty roster returns before it ever judges.
    const root = mkdtempSync(join(tmpdir(), "jev-omp-skills-"));
    const cwd = root;
    mkdirSync(join(root, ".omp", "skills", "playwright-cli"), { recursive: true });
    writeFileSync(
      join(root, ".omp", "skills", "playwright-cli", "SKILL.md"),
      "---\nname: playwright-cli\ndescription: Drive a real browser with Playwright\n---\n\nbody\n",
      "utf8",
    );
    jevExtension(host);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            answers: {
              best: {
                type: "choice",
                choice: "playwright-cli",
                confidence: 0.9,
                probabilities: { "playwright-cli": 0.9 },
              },
            },
          }),
      })),
    );

    // The shipped router read ctx.skills, which does not exist; a context
    // WITHOUT any skills member must still work — the roster comes from disk.
    const inputResult = await handlers.get("input")!(
      { text: "please automate the playwright browser flow now" },
      { cwd },
    );
    // Nothing is injected into the prompt: the input hook cannot do that.
    expect(inputResult).toBeUndefined();

    const startResult: any = await handlers.get("before_agent_start")!({}, { cwd });
    expect(startResult.message.customType).toBe("jev-skill-hint");
    expect(startResult.message.content).toContain("playwright-cli");
    expect(startResult.message.attribution).toBe("agent");

    // Consumed once: it must not repeat every turn.
    expect(await handlers.get("before_agent_start")!({}, { cwd })).toBeUndefined();
  });

  it("stays silent when the user already named a skill", async () => {
    setEnv({ TYPESAFE_API_KEY: "test-key", OMP_JEV_AUTO: "1" });
    const { host, handlers } = makeHost();
    const root = mkdtempSync(join(tmpdir(), "jev-omp-skills-"));
    mkdirSync(join(root, ".omp", "skills", "fh6-modding"), { recursive: true });
    writeFileSync(
      join(root, ".omp", "skills", "fh6-modding", "SKILL.md"),
      "---\nname: fh6-modding\ndescription: Forza Horizon modding\n---\n",
      "utf8",
    );
    jevExtension(host);

    const fetchSpy = vi.fn(async () => {
      throw new Error("must not be called");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const out = await handlers.get("input")!(
      { text: "/skill:fh6-modding do the thing" },
      { cwd: root },
    );
    expect(out).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stays inert when the router off-switch is set", async () => {
    setEnv({ TYPESAFE_API_KEY: "test-key", OMP_JEV_AUTO: "1", OMP_JEV_SKILL_ROUTER: "0" });
    const { host, handlers } = makeHost();
    jevExtension(host);

    const fetchSpy = vi.fn(async () => {
      throw new Error("must not be called");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const out = await handlers.get("input")!(
      { text: "a long enough prompt about spreadsheets" },
      { cwd: process.cwd() },
    );
    expect(out).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("degraded routing when Jev is unreachable", () => {
  /** A throwaway roster on disk; the returned root is the hook's cwd. */
  function skillTree(): string {
    const root = mkdtempSync(join(tmpdir(), "jev-omp-degraded-"));
    mkdirSync(join(root, ".omp", "skills", "playwright-cli"), { recursive: true });
    writeFileSync(
      join(root, ".omp", "skills", "playwright-cli", "SKILL.md"),
      "---\nname: playwright-cli\ndescription: Drive a real browser with Playwright\n---\n\nbody\n",
      "utf8",
    );
    return root;
  }

  /** An unreachable Jev: a rejected fetch, which classifies as `network`. */
  function jevDown() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
  }

  it("suggests a confident lexical match when Jev is unreachable", async () => {
    setEnv({ TYPESAFE_API_KEY: "test-key", OMP_JEV_AUTO: "1" });
    const { host, handlers } = makeHost();
    const root = skillTree();
    jevExtension(host);
    jevDown();

    // The local router scores this ~0.40 against playwright-cli (three shared
    // tokens over a short description), well above LOCAL_ROUTE_MIN_SCORE.
    const out = await handlers.get("input")!(
      { text: "drive the playwright browser flow for the login page" },
      { cwd: root },
    );
    expect(out).toBeUndefined();

    const startResult: any = await handlers.get("before_agent_start")!({}, { cwd: root });
    expect(startResult.message.customType).toBe("jev-skill-hint");
    expect(startResult.message.content).toContain("playwright-cli");
    // The percentage shown is lexical overlap, not a Jev probability, and the
    // line says which one it is.
    expect(startResult.message.content).toContain("local keyword match");
    expect(startResult.message.content).toContain("Jev was unreachable");
    expect(startResult.message.content).not.toContain("from the installed roster");

    // The trail names the outage and the skill it chose, under its own key.
    expect(refusals.entries()).toContainEqual(
      expect.objectContaining({ key: "router:local-fallback", reason: "network:playwright-cli" }),
    );
    expect(localRouteCalls).toHaveLength(1);
  });

  it("suggests nothing when the local match is unconvincing", async () => {
    setEnv({ TYPESAFE_API_KEY: "test-key", OMP_JEV_AUTO: "1" });
    const { host, handlers } = makeHost();
    const root = skillTree();
    jevExtension(host);
    jevDown();

    // Incidental overlap only — the best match here scores ~0.12, below the
    // 0.2 floor. A wrong hint is worse than no hint, so nothing is promoted.
    const out = await handlers.get("input")!(
      { text: "rename every incident ticket in the tracker" },
      { cwd: root },
    );
    expect(out).toBeUndefined();
    expect(await handlers.get("before_agent_start")!({}, { cwd: root })).toBeUndefined();

    // The attempt is still recorded, as a no-match: the outage stays visible
    // even when it produces no suggestion.
    expect(refusals.entries()).toContainEqual(
      expect.objectContaining({ key: "router:local-fallback", reason: "network:no-match" }),
    );
  });

  it("never consults the local router when Jev answers", async () => {
    setEnv({ TYPESAFE_API_KEY: "test-key", OMP_JEV_AUTO: "1" });
    const { host, handlers } = makeHost();
    const root = skillTree();
    jevExtension(host);

    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          answers: {
            best: {
              type: "choice",
              choice: "playwright-cli",
              confidence: 0.9,
              probabilities: { "playwright-cli": 0.9 },
            },
          },
        }),
    }));
    vi.stubGlobal("fetch", fetchSpy);

    // Deliberately a prompt the local router would ALSO match strongly: a
    // success that silently ran the fallback would look identical in the hint,
    // which is exactly why the call count is asserted rather than the text.
    await handlers.get("input")!(
      { text: "use playwright to capture a screenshot of the login page" },
      { cwd: root },
    );
    expect(fetchSpy).toHaveBeenCalled();
    expect(localRouteCalls).toEqual([]);

    const startResult: any = await handlers.get("before_agent_start")!({}, { cwd: root });
    expect(startResult.message.content).toContain("from the installed roster");
    expect(startResult.message.content).not.toContain("local keyword match");
  });
});
