import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import jevPi from "./extension.js";

/** Captured registrations from a fake ExtensionAPI. */
interface CapturedTool {
  name: string;
  execute: (...args: any[]) => Promise<any>;
}

function fakeApi() {
  const tools: CapturedTool[] = [];
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const api = {
    registerTool: vi.fn((tool: CapturedTool) => {
      tools.push(tool);
    }),
    on: vi.fn((event: string, handler: (...args: any[]) => unknown) => {
      handlers.set(event, handler);
    }),
    getAllTools: vi.fn(() => []),
  } as unknown as ExtensionAPI;
  return { api, tools, handlers };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("jevPi factory registration", () => {
  it("is an export-default factory registering five tools and two hooks", () => {
    expect(typeof jevPi).toBe("function");
    const { api, tools, handlers } = fakeApi();
    jevPi(api);
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["jev_ask", "jev_browse_action", "jev_models", "jev_pick_tool", "jev_route_skills"].sort(),
    );
    expect([...handlers.keys()].sort()).toEqual(["input", "session_before_compact"].sort());
  });
});

describe("fail-open tool path", () => {
  it("jev_models resolves advisory text instead of throwing when the network fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    const { api, tools } = fakeApi();
    jevPi(api);
    const models = tools.find((t) => t.name === "jev_models")!;
    const result = await models.execute("call-1", {}, undefined, undefined, {} as any);
    expect(result.content[0].text).toContain("fail-open");
  });
});

describe("fail-open hook paths", () => {
  it("input hook returns undefined for blank text without touching the network", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { api, handlers } = fakeApi();
    jevPi(api);
    const input = handlers.get("input")!;
    expect(input({ text: "   " }, {} as any)).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("session_before_compact returns undefined when no API key is configured", async () => {
    const saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      const { api, handlers } = fakeApi();
      jevPi(api);
      const hook = handlers.get("session_before_compact")!;
      const event = {
        type: "session_before_compact",
        branchEntries: [],
        preparation: { tokensBefore: 1 },
        reason: "manual",
        willRetry: false,
        signal: new AbortController().signal,
      };
      await expect(hook(event, {} as any)).resolves.toBeUndefined();
    } finally {
      if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    }
  });
});
