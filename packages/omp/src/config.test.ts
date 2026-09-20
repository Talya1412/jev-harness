import { describe, expect, it } from "vitest";
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from "@jev-harness/core";
import { DEFAULT_TIMEOUT_MS, autoOn, envNum, readConfig } from "../src/config.js";

describe("readConfig", () => {
  it("throws a credential error when the key is absent", () => {
    expect(() => readConfig({})).toThrow(/TYPESAFE_API_KEY is not set/);
    expect(() => readConfig({ TYPESAFE_API_KEY: "   " })).toThrow(/TYPESAFE_API_KEY is not set/);
  });

  it("defaults base URL, model, and timeout", () => {
    const cfg = readConfig({ TYPESAFE_API_KEY: "k" });
    expect(cfg).toEqual({
      apiKey: "k",
      baseUrl: DEFAULT_BASE_URL,
      model: DEFAULT_MODEL,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  });

  it("strips trailing slashes so paths never double up", () => {
    expect(readConfig({ TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: "https://x.test///" }).baseUrl).toBe(
      "https://x.test"
    );
  });

  it("prefers an explicit model over the environment default", () => {
    const env = { TYPESAFE_API_KEY: "k", TYPESAFE_DEFAULT_MODEL: "from-env" };
    expect(readConfig(env, "explicit").model).toBe("explicit");
    expect(readConfig(env).model).toBe("from-env");
    // An all-whitespace override must not shadow the environment default.
    expect(readConfig(env, "  ").model).toBe("from-env");
  });

  it("ignores an unparseable timeout instead of producing NaN", () => {
    expect(readConfig({ TYPESAFE_API_KEY: "k", JEV_TIMEOUT_MS: "soon" }).timeoutMs).toBe(
      DEFAULT_TIMEOUT_MS
    );
    expect(readConfig({ TYPESAFE_API_KEY: "k", JEV_TIMEOUT_MS: "2500" }).timeoutMs).toBe(2500);
  });
});

describe("autoOn", () => {
  it("requires the master switch", () => {
    expect(autoOn({}, "OMP_JEV_GATE")).toBe(false);
    expect(autoOn({ OMP_JEV_AUTO: "yes" }, "OMP_JEV_GATE")).toBe(false);
    expect(autoOn({ OMP_JEV_AUTO: "1" }, "OMP_JEV_GATE")).toBe(true);
  });

  it("lets one hook be disabled without touching the others", () => {
    const env = { OMP_JEV_AUTO: "1", OMP_JEV_GATE: "0" };
    expect(autoOn(env, "OMP_JEV_GATE")).toBe(false);
    expect(autoOn(env, "OMP_JEV_SKILL_ROUTER")).toBe(true);
  });
});

describe("envNum", () => {
  it("falls back on unset, empty, and non-numeric values", () => {
    expect(envNum({}, "X", 7)).toBe(7);
    expect(envNum({ X: "  " }, "X", 7)).toBe(7);
    expect(envNum({ X: "abc" }, "X", 7)).toBe(7);
  });

  it("accepts zero and negative overrides", () => {
    expect(envNum({ X: "0" }, "X", 7)).toBe(0);
    expect(envNum({ X: "-1" }, "X", 7)).toBe(-1);
  });
});
