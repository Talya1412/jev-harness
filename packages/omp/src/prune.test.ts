import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// The cross-session persistent cache would serve a repeat request body from a
// previous run instead of fetching — every body-observing assertion below
// depends on it not doing that. Only that one wrapper is stubbed; the cache's
// ledger, pruneContext, askJev, and the thresholds all stay real.
vi.mock("@jev-harness/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@jev-harness/core")>();
  return {
    ...actual,
    withPersistentCache: (config: Parameters<typeof actual.withPersistentCache>[0]) => config,
  };
});

import jevExtension, { refusals } from "../src/extension.js";

/** Minimal pi host: captures tool + hook registrations for observable assertions. */
function makeHost() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const host: any = {
    zod: z,
    registerTool: (def: any) => {
      tools.set(def.name, def);
    },
    on: (name: string, handler: (...args: any[]) => unknown) => {
      handlers.set(name, handler);
    },
    logger: {
      warn: () => {},
      debug: () => {},
      info: () => {},
      error: () => {},
    },
  };
  return { host, handlers };
}

const ENV_KEYS = ["TYPESAFE_API_KEY", "OMP_JEV_AUTO", "OMP_JEV_PRUNE"];

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

/** Deterministic bulky text: no secrets, so hook redaction can never alter the head. */
const bulk = (chars: number) =>
  "result line 0001 ok\n".repeat(Math.ceil(chars / 20)).slice(0, chars);

function textResult(toolCallId: string, text: string, isError = false) {
  return {
    toolCallId,
    input: {},
    content: [{ type: "text", text }],
    isError,
  };
}

/** A Jev answer body: one noul read for the candidate id. */
function noulBody(id: string, noul: number) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ answers: { [id]: { type: "noul", noul } } }),
  };
}

describe("prune tool_result hook", () => {
  it("disabled-by-default: zero work and no fetch, even with the master switch on", async () => {
    // OMP_JEV_AUTO=1 must NOT arm this hook: the opt-in is OMP_JEV_PRUNE=1 only.
    setEnv({ TYPESAFE_API_KEY: "test-key", OMP_JEV_AUTO: "1" });
    const { host, handlers } = makeHost();
    jevExtension(host);
    expect(handlers.has("tool_result")).toBe(true);

    const fetchSpy = vi.fn(async (_url: any, _init: any) => noulBody("tc-off", 0.1));
    vi.stubGlobal("fetch", fetchSpy);

    const verdict = await handlers.get("tool_result")!(textResult("tc-off", bulk(5000)));
    expect(verdict).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("idempotent: a result already carrying the prune marker is returned undefined", async () => {
    setEnv({ TYPESAFE_API_KEY: "test-key", OMP_JEV_PRUNE: "1" });
    const { host, handlers } = makeHost();
    jevExtension(host);

    const fetchSpy = vi.fn(async (_url: any, _init: any) => noulBody("tc-marked", 0.1));
    vi.stubGlobal("fetch", fetchSpy);

    // Bulky enough to reach Jev without the marker — the marker must stop it.
    const text =
      bulk(3000) +
      "\n[... 123 chars omitted by jev prune; id=tc-marked — original retained by caller]";
    const verdict = await handlers.get("tool_result")!(textResult("tc-marked", text));
    expect(verdict).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("oversize: locally caps head+tail with no Jev call", async () => {
    setEnv({ TYPESAFE_API_KEY: "test-key", OMP_JEV_PRUNE: "1" });
    const { host, handlers } = makeHost();
    jevExtension(host);

    const fetchSpy = vi.fn(async (_url: any, _init: any) => noulBody("tc-big", 0.1));
    vi.stubGlobal("fetch", fetchSpy);

    const text = "start-of-output\n" + bulk(210_000) + "\nend-of-output";
    const out: any = await handlers.get("tool_result")!(textResult("tc-big", text));
    expect(out).toBeDefined();
    const replaced = out.content[0];
    expect(replaced.type).toBe("text");
    // Bounded, strictly smaller, and still under the hard cap.
    expect(replaced.text.length).toBeLessThan(text.length);
    expect(replaced.text.length).toBeLessThan(200_000);
    // Head and tail kept verbatim, note names the omission and the recovery.
    expect(replaced.text.startsWith("start-of-output")).toBe(true);
    expect(replaced.text.endsWith("end-of-output")).toBe(true);
    expect(replaced.text).toContain("locally capped");
    expect(replaced.text).toContain("id=tc-big");
    expect(replaced.text).toContain("original retained by host");
    // Oversize state must never reach Jev.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("small: leaves a short result untouched", async () => {
    setEnv({ TYPESAFE_API_KEY: "test-key", OMP_JEV_PRUNE: "1" });
    const { host, handlers } = makeHost();
    jevExtension(host);

    const fetchSpy = vi.fn(async (_url: any, _init: any) => noulBody("tc-small", 0.1));
    vi.stubGlobal("fetch", fetchSpy);

    const verdict = await handlers.get("tool_result")!(textResult("tc-small", "tiny ok"));
    expect(verdict).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("happy drop: replaces with verbatim head + provenance note", async () => {
    setEnv({ TYPESAFE_API_KEY: "test-key", OMP_JEV_PRUNE: "1" });
    const { host, handlers } = makeHost();
    jevExtension(host);

    // 0.1 clears the output drop bar (<=0.25) while staying below the keep bar.
    const fetchSpy = vi.fn(async (_url: any, _init: any) => noulBody("tc-drop", 0.1));
    vi.stubGlobal("fetch", fetchSpy);

    const text = bulk(3000);
    const out: any = await handlers.get("tool_result")!(textResult("tc-drop", text));
    expect(out).toBeDefined();
    const replaced = out.content[0];
    expect(replaced.type).toBe("text");
    expect(replaced.text.startsWith(text.slice(0, 300))).toBe(true);
    expect(replaced.text).toContain("omitted by jev prune");
    expect(replaced.text).toContain("id=tc-drop");
    expect(replaced.text.length).toBeLessThan(text.length);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // The adapter passed kind=output (not error) for a successful tool.
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.state.items[0].kind).toBe("output");
  });

  it("Jev throw: fails open and records the refusal", async () => {
    setEnv({ TYPESAFE_API_KEY: "test-key", OMP_JEV_PRUNE: "1" });
    const { host, handlers } = makeHost();
    jevExtension(host);

    // 400 is non-retryable: one attempt, then the hook's fail-open catch.
    const fetchSpy = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => "bad request",
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const verdict = await handlers.get("tool_result")!(textResult("tc-down", bulk(3000)));
    expect(verdict).toBeUndefined();
    const entry = refusals.entries().find((e) => e.key === "prune:output");
    expect(entry).toBeDefined();
    expect(entry!.reason.length).toBeGreaterThan(0);
  });

  it("isError true: candidate kind is error", async () => {
    setEnv({ TYPESAFE_API_KEY: "test-key", OMP_JEV_PRUNE: "1" });
    const { host, handlers } = makeHost();
    jevExtension(host);

    // 0.05 clears the stricter error drop bar (<=0.1): an errored result that
    // Jev judges spent must actually drop under the error rules.
    const fetchSpy = vi.fn(async (_url: any, _init: any) => noulBody("tc-err", 0.05));
    vi.stubGlobal("fetch", fetchSpy);

    const out: any = await handlers.get("tool_result")!(textResult("tc-err", bulk(3000), true));
    expect(out).toBeDefined();
    expect(out.content[0].text).toContain("omitted by jev prune");
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.state.items[0].kind).toBe("error");
    // The error-kind question holds the drop to the stricter standard.
    expect(body.questions["tc-err"].instructions).toContain("stricter");
  });

  it("preserves image blocks when replacing text", async () => {
    setEnv({ TYPESAFE_API_KEY: "test-key", OMP_JEV_PRUNE: "1" });
    const { host, handlers } = makeHost();
    jevExtension(host);

    const fetchSpy = vi.fn(async (_url: any, _init: any) => noulBody("tc-img", 0.1));
    vi.stubGlobal("fetch", fetchSpy);

    const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
    const out: any = await handlers.get("tool_result")!({
      toolCallId: "tc-img",
      input: {},
      content: [{ type: "text", text: bulk(3000) }, image],
      isError: false,
    });
    expect(out).toBeDefined();
    expect(out.content[0].type).toBe("text");
    expect(out.content[0].text).toContain("omitted by jev prune");
    // The screenshot is content the hook must never delete.
    expect(out.content[1]).toEqual(image);
  });
});
