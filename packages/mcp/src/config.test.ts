import { describe, expect, it } from "vitest";
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from "@jev-harness/core";
import { parseTimeoutMs, resolveJevConfig } from "../src/config.js";

describe("parseTimeoutMs", () => {
  it("returns undefined for absent, blank, non-numeric, and non-positive input", () => {
    expect(parseTimeoutMs(undefined)).toBeUndefined();
    expect(parseTimeoutMs("")).toBeUndefined();
    expect(parseTimeoutMs("soon")).toBeUndefined();
    expect(parseTimeoutMs("0")).toBeUndefined();
    expect(parseTimeoutMs("-5")).toBeUndefined();
  });

  it("floors a valid value", () => {
    expect(parseTimeoutMs("1500.7")).toBe(1500);
  });
});

describe("resolveJevConfig", () => {
  it("names TYPESAFE_API_KEY in the error, so the fix is obvious", () => {
    expect(() => resolveJevConfig({}, {})).toThrow(/TYPESAFE_API_KEY is not set/);
    expect(() => resolveJevConfig({}, { TYPESAFE_API_KEY: "  " })).toThrow(/TYPESAFE_API_KEY is not set/);
  });

  it("defaults base URL and model, and omits an unset timeout", () => {
    const cfg = resolveJevConfig({}, { TYPESAFE_API_KEY: "k" });
    expect(cfg).toEqual({ apiKey: "k", baseUrl: DEFAULT_BASE_URL, model: DEFAULT_MODEL });
    expect(cfg).not.toHaveProperty("timeoutMs");
  });

  it("reads the environment overrides", () => {
    const cfg = resolveJevConfig({}, {
      TYPESAFE_API_KEY: "k",
      TYPESAFE_BASE_URL: "https://x.test",
      TYPESAFE_DEFAULT_MODEL: "m",
      JEV_TIMEOUT_MS: "900",
    });
    expect(cfg).toEqual({ apiKey: "k", baseUrl: "https://x.test", model: "m", timeoutMs: 900 });
  });

  it("lets an explicit override win over the environment", () => {
    const env = { TYPESAFE_API_KEY: "env", TYPESAFE_DEFAULT_MODEL: "envmodel", JEV_TIMEOUT_MS: "900" };
    const cfg = resolveJevConfig({ apiKey: "override", model: "m", timeoutMs: 42 }, env);
    expect(cfg).toMatchObject({ apiKey: "override", model: "m", timeoutMs: 42 });
  });

  it("trims a padded key rather than sending whitespace", () => {
    expect(resolveJevConfig({}, { TYPESAFE_API_KEY: "  k  " }).apiKey).toBe("k");
  });
});
