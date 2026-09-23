import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import jevExtension from "../src/extension.js";

const TOOL_NAMES = [
  "jev_ask",
  "jev_models",
  "jev_route_skills",
  "jev_browse_action",
  "jev_pick_tool",
];
const HOOK_NAMES = ["tool_call", "input", "session_before_compact"];

/** Minimal pi host: captures tool + hook registrations for observable assertions. */
function makeHost() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const warnings: Array<{ msg: string; extra?: unknown }> = [];
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
      debug: () => {},
      info: () => {},
      error: () => {},
    },
  };
  return { host, tools, handlers, warnings };
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
  vi.unstubAllGlobals();
});

describe("jevExtension factory registration", () => {
  it("registers all five Jev tools and the three auto hooks", () => {
    setEnv({ TYPESAFE_API_KEY: "test-key" });
    const { host, tools, handlers } = makeHost();

    jevExtension(host);

    expect([...tools.keys()].sort()).toEqual([...TOOL_NAMES].sort());
    for (const name of HOOK_NAMES) expect(handlers.has(name)).toBe(true);
    // Tools carry the metadata OMP needs to list them.
    for (const tool of tools.values()) {
      expect(typeof tool.description).toBe("string");
      expect(tool.execute).toBeTypeOf("function");
    }
  });
});

describe("jev_models tool path", () => {
  it("returns the stubbed model list without touching the network", async () => {
    setEnv({ TYPESAFE_API_KEY: "test-key" });
    const { host, tools } = makeHost();
    jevExtension(host);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ models: [{ name: "jev-latest" }] }),
      })),
    );

    const tool = tools.get("jev_models")!;
    const out = await tool.execute("id-1", {}, undefined);
    expect(out.details.models).toEqual([{ name: "jev-latest" }]);
    expect(out.content[0].text).toContain("jev-latest");
  });
});

describe("tool_call gate fail-open", () => {
  it("allows a mutating tool call when Jev errors instead of blocking it", async () => {
    setEnv({ TYPESAFE_API_KEY: "test-key", OMP_JEV_AUTO: "1" });
    const { host, handlers, warnings } = makeHost();
    jevExtension(host);

    // Non-retryable Jev error: fails fast (no retry sleeps) into the fail-open path.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        text: async () => "bad request",
      })),
    );

    const gate = handlers.get("tool_call")!;
    const verdict = await gate({ toolName: "bash", input: { cmd: "rm -rf /tmp/x" } });

    expect(verdict).toBeUndefined();
    expect(warnings.some((w) => w.msg.includes("fail-open"))).toBe(true);
  });

  it("stays inert when the master switch is off, spending no Jev call", async () => {
    setEnv({ TYPESAFE_API_KEY: "test-key" });
    const { host, handlers } = makeHost();
    jevExtension(host);

    const fetchSpy = vi.fn(async () => {
      throw new Error("must not be called");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const gate = handlers.get("tool_call")!;
    const verdict = await gate({ toolName: "bash", input: { cmd: "rm -rf /tmp/x" } });

    expect(verdict).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
