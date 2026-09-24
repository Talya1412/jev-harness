import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { MAX_TIMEOUT_MS, parseTimeoutMs, resolveEnvConfig } from "./config.js";
import { okResult, errorResult, errorText } from "./results.js";
import { createJevToolkit } from "./toolkit.js";
import { lexicalShortlist } from "./router.js";
import type { JevResponse } from "@jev-harness/core";

describe("resolveEnvConfig (adapter policy)", () => {
  const base = {
    TYPESAFE_BASE_URL: "https://env.test/",
    TYPESAFE_DEFAULT_MODEL: "env-model",
    JEV_TIMEOUT_MS: "500",
  };

  it("lets a caller's redact decision override the env, truthy or falsy", () => {
    // A caller with a context-dependent policy must not be overridden by JEV_REDACT.
    process.env.JEV_REDACT = "0";
    expect(resolveEnvConfig({ redact: true }).redact).toBe(true);
    delete process.env.JEV_REDACT;
    expect(resolveEnvConfig({ redact: false }).redact).toBe(false);
    expect(resolveEnvConfig().redact).toBe(true);
  });

  it("reads an injected env instead of process.env", () => {
    const cfg = resolveEnvConfig({
      env: { TYPESAFE_API_KEY: "  k  ", ...base },
    });
    expect(cfg).toMatchObject({
      apiKey: "k",
      baseUrl: "https://env.test",
      model: "env-model",
      timeoutMs: 500,
    });
  });

  it("lets explicit overrides win over the injected env", () => {
    const cfg = resolveEnvConfig({
      env: { TYPESAFE_API_KEY: "env", ...base },
      overrides: { apiKey: "override", model: "m", timeoutMs: 42, redact: false },
    });
    expect(cfg).toMatchObject({
      apiKey: "override",
      model: "m",
      timeoutMs: 42,
      redact: false,
      baseUrl: "https://env.test",
    });
  });

  it("keeps the modelOverride option as the middle precedence rung", () => {
    process.env.TYPESAFE_DEFAULT_MODEL = "pinned";
    const cfg = resolveEnvConfig({ modelOverride: "per-call", overrides: { apiKey: "k" } });
    expect(cfg.model).toBe("per-call");
  });
});

const ENV_KEYS = [
  "TYPESAFE_API_KEY",
  "TYPESAFE_BASE_URL",
  "TYPESAFE_DEFAULT_MODEL",
  "JEV_TIMEOUT_MS",
  "JEV_REDACT",
] as const;

// Sanitize around every test: the host machine may legitimately export these.
function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}
beforeEach(clearEnv);
afterEach(clearEnv);

describe("resolveEnvConfig", () => {
  it("returns defaults with no env", () => {
    const cfg = resolveEnvConfig();
    expect(cfg.apiKey).toBe("");
    expect(cfg.baseUrl).toBe("https://api.typesafe.ai");
    expect(cfg.model).toBe("jev-latest");
    expect(cfg.timeoutMs).toBeUndefined();
    expect(cfg.redact).toBe(true);
  });

  it("honours env overrides and strips trailing slashes", () => {
    process.env.TYPESAFE_API_KEY = " k ";
    process.env.TYPESAFE_BASE_URL = "https://example.com///";
    process.env.TYPESAFE_DEFAULT_MODEL = "jev-1.13.0";
    process.env.JEV_TIMEOUT_MS = "2500";
    const cfg = resolveEnvConfig();
    expect(cfg).toEqual({
      apiKey: "k",
      baseUrl: "https://example.com",
      model: "jev-1.13.0",
      timeoutMs: 2500,
      redact: true,
    });
    process.env.JEV_REDACT = "0";
    expect(resolveEnvConfig().redact).toBe(false);
  });

  it("throws for a missing key when required, not otherwise", () => {
    expect(() => resolveEnvConfig({ requireKey: true })).toThrow(/TYPESAFE_API_KEY/);
    expect(() => resolveEnvConfig()).not.toThrow();
  });

  it("gives the model override precedence", () => {
    process.env.TYPESAFE_DEFAULT_MODEL = "pinned";
    expect(resolveEnvConfig({ modelOverride: " per-call " }).model).toBe("per-call");
    expect(resolveEnvConfig().model).toBe("pinned");
  });

  it("ignores a non-positive timeout", () => {
    process.env.JEV_TIMEOUT_MS = "0";
    expect(resolveEnvConfig().timeoutMs).toBeUndefined();
  });

  it("caps a huge timeout at MAX_TIMEOUT_MS", () => {
    process.env.JEV_TIMEOUT_MS = "99999999999";
    expect(resolveEnvConfig().timeoutMs).toBe(MAX_TIMEOUT_MS);
    expect(parseTimeoutMs("99999999999")).toBe(MAX_TIMEOUT_MS);
    expect(parseTimeoutMs("2500")).toBe(2500);
    expect(parseTimeoutMs("")).toBeUndefined();
  });
});

describe("results", () => {
  it("wraps text and details in the standard envelope", () => {
    expect(okResult("hi", { a: 1 })).toEqual({
      content: [{ type: "text", text: "hi" }],
      details: { a: 1 },
    });
    expect(okResult("hi").details).toBeUndefined();
  });

  it("renders fail-open error text without throwing", () => {
    const text = errorText("jev_ask", new Error("boom: " + "x".repeat(600)));
    expect(text).toMatch(/^jev_ask failed \(fail-open, host unaffected\): boom/);
    expect(text.length).toBeLessThan(560);
    expect(errorResult("t", "plain").content[0].text).toContain("plain");
  });
});

describe("createJevToolkit", () => {
  it("resolves config per call and posts the per-call model override", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const bodies: any[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const answers: JevResponse["answers"] = {};
      for (const id of Object.keys(bodies[bodies.length - 1].questions))
        answers[id] = { type: "noul", noul: 0.5 };
      return new Response(JSON.stringify({ model: bodies[bodies.length - 1].model, answers }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const kit = createJevToolkit({ requireKey: true, fetchImpl });
    await kit.ask({ s: 1 }, { q: { type: "noul", instructions: "?" } }, { model: "jev-1.13.0" });
    expect(bodies[0].model).toBe("jev-1.13.0");

    process.env.TYPESAFE_DEFAULT_MODEL = "pinned";
    await kit.ask({ s: 1 }, { q: { type: "noul", instructions: "?" } });
    expect(bodies[1].model).toBe("pinned");
  });

  it("honours an aborted signal on models()", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const fetchImpl = (async () => {
      throw new Error("must not fetch when already aborted");
    }) as unknown as typeof fetch;
    const kit = createJevToolkit({ requireKey: true, fetchImpl });
    const controller = new AbortController();
    controller.abort();
    await expect(kit.models(controller.signal)).rejects.toThrow(/abort/i);
  });

  it("throws on a missing key only when requireKey is set", async () => {
    const strict = createJevToolkit({ requireKey: true });
    expect(() => strict.config()).toThrow(/TYPESAFE_API_KEY/);
    const lenient = createJevToolkit();
    expect(lenient.config().apiKey).toBe("");
  });
});

describe("lexicalShortlist", () => {
  const roster = [
    { name: "browser-testing", description: "Automate a browser." },
    { name: "fh6-modding", description: "Game modding." },
    { name: "desktop-automation", description: "OS input." },
  ];

  it("prefers lexically matching names", () => {
    const picked = lexicalShortlist("test the login page in a browser and the fh6 mod dir", roster);
    expect(picked[0]).toBe("browser-testing");
    expect(picked).toContain("fh6-modding");
  });

  it("falls back to the full roster when nothing matches", () => {
    const picked = lexicalShortlist("zzz qqq", roster);
    expect(picked).toEqual(roster.map((s) => s.name));
  });

  it("caps the fallback roster and skips empty names", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `s${i}` }));
    // Nothing matches "zzz" lexically -> full roster, capped to 12.
    expect(lexicalShortlist("zzz", many)).toHaveLength(12);
    // Lexical matches win and are not padded to the limit.
    expect(lexicalShortlist("s1 s2", many)).toEqual(["s1", "s2"]);
    expect(lexicalShortlist("x", [{ name: "" }, { name: "a" }], { limit: 1 })).toEqual(["a"]);
  });
});
