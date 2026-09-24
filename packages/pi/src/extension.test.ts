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
  it("is an export-default factory registering six tools and two hooks", () => {
    expect(typeof jevPi).toBe("function");
    const { api, tools, handlers } = fakeApi();
    jevPi(api);
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "jev_ask",
        "jev_browse_action",
        "jev_classify",
        "jev_models",
        "jev_pick_tool",
        "jev_route_skills",
      ].sort(),
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
describe("jev_classify tool", () => {
  it("asks each item and reports the per-item answers", async () => {
    const saved = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = "k";
    try {
      const bodies: any[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: unknown, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body));
          bodies.push(body);
          return new Response(
            JSON.stringify({ model: body.model, answers: { q: { type: "noul", noul: 0.5 } } }),
            { status: 200 },
          );
        }),
      );
      const { api, tools } = fakeApi();
      jevPi(api);
      const classify = tools.find((t) => t.name === "jev_classify")!;
      const result = await classify.execute(
        "call-1",
        { items: ["a", "b"], questions: { q: { type: "noul", instructions: "ok?" } } },
        undefined,
        undefined,
        {} as any,
      );
      expect(bodies).toHaveLength(2);
      expect(result.content[0].text).toContain("[0]");
      expect(result.details.perItem).toHaveLength(2);
    } finally {
      if (saved === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = saved;
    }
  });

  it("fails open with the key check message when no key is configured", async () => {
    const saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const { api, tools } = fakeApi();
      jevPi(api);
      const classify = tools.find((t) => t.name === "jev_classify")!;
      const result = await classify.execute(
        "call-1",
        { items: ["a"], questions: { q: { type: "noul", instructions: "ok?" } } },
        undefined,
        undefined,
        {} as any,
      );
      expect(result.content[0].text).toContain("fail-open");
      expect(result.content[0].text).toContain("TYPESAFE_API_KEY");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    }
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

describe("input hook skill shortlist", () => {
  it("keeps a lexically matching tool that roster order alone would hide", async () => {
    const saved = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = "k";
    const bodies: any[] = [];
    const fetchSpy = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return new Response(
        JSON.stringify({
          model: body.model,
          answers: { best: { type: "choice", choice: "zzz-special", confidence: 0.9 } },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchSpy);
    const notifications: string[] = [];
    const { api, handlers } = fakeApi();
    // 20 filler tools + one real match: core slices to the first 12 candidates,
    // so without a lexical prefilter "zzz-special" would never reach Jev.
    const roster = Array.from({ length: 20 }, (_, i) => ({
      name: "alpha-" + i,
      description: "filler",
    }));
    roster.push({ name: "zzz-special", description: "the one that matters" });
    (api as any).getAllTools = vi.fn(() => roster);
    jevPi(api);
    try {
      const hook = handlers.get("input")!;
      hook({ text: "please run the zzz special workflow" }, {
        ui: { notify: (m: string) => notifications.push(m) },
      } as any);
      await vi.waitFor(() => expect(bodies).toHaveLength(1));
      const criteria = Object.keys(bodies[0].questions.best.criteria);
      expect(criteria).toContain("zzz-special");
      expect(criteria).not.toContain("alpha-0");
      await vi.waitFor(() => expect(notifications).toHaveLength(1));
      expect(notifications[0]).toContain("zzz-special");
    } finally {
      if (saved === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = saved;
    }
  });
});
