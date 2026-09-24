import { describe, expect, it } from "vitest";
import { DEFAULT_BASE_URL, DEFAULT_MODEL, THRESHOLDS } from "@jev-harness/core";
import {
  DEFAULT_TIMEOUT_MS,
  GATE_DEADLINE_MS,
  GATE_THRESHOLD,
  SKILL_MIN_CONFIDENCE,
  autoOn,
  envNum,
  readConfig,
  redactOn,
  withDeadline,
} from "../src/config.js";

describe("shared thresholds", () => {
  it("uses core's tuned numbers rather than adapter-local copies", () => {
    // A drifted copy is exactly how the adapter once compared the wrong way
    // round against core's default, so these must BE core's values.
    expect(GATE_THRESHOLD).toBe(THRESHOLDS.destructiveGate);
    expect(SKILL_MIN_CONFIDENCE).toBe(THRESHOLDS.skillRouting);
  });

  it("keeps the gate deadline safely under the host's 30s handler budget", () => {
    // The host maps a tool_call timeout to { block: true }, so a handler that
    // outlives its budget fails CLOSED. The deadline must leave headroom for
    // the handler to still settle and fail open.
    expect(GATE_DEADLINE_MS).toBeLessThan(30_000);
    expect(GATE_DEADLINE_MS).toBeGreaterThan(1_000);
  });
});

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
    expect(
      readConfig({ TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: "https://x.test///" }).baseUrl,
    ).toBe("https://x.test");
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
      DEFAULT_TIMEOUT_MS,
    );
    expect(readConfig({ TYPESAFE_API_KEY: "k", JEV_TIMEOUT_MS: "2500" }).timeoutMs).toBe(2500);
  });

  it("carries the redaction flag through", () => {
    expect(readConfig({ TYPESAFE_API_KEY: "k" }, undefined, true).redact).toBe(true);
    expect(readConfig({ TYPESAFE_API_KEY: "k" }, undefined, false).redact).toBe(false);
  });

  it("leaves redact ABSENT when the caller does not decide", () => {
    // Core's documented default is redaction-off, and OMP's policy is the
    // context-dependent redactOn(). If this field were materialised from the
    // env, a tool that deliberately keeps full fidelity would silently start
    // sending scrubbed state.
    expect("redact" in readConfig({ TYPESAFE_API_KEY: "k" })).toBe(false);
    expect("redact" in readConfig({ TYPESAFE_API_KEY: "k", JEV_REDACT: "1" })).toBe(false);
  });

  it("always resolves a numeric timeout, defaulting to DEFAULT_TIMEOUT_MS", () => {
    // Kit omits the field when unset; OMP promises a number so callers never
    // apply core's default themselves.
    expect(readConfig({ TYPESAFE_API_KEY: "k" }).timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("caps an overflowing timeout instead of letting setTimeout wrap to ~1ms", () => {
    const huge = readConfig({ TYPESAFE_API_KEY: "k", JEV_TIMEOUT_MS: "99999999999999" });
    expect(huge.timeoutMs).toBeLessThanOrEqual(2147483647);
    expect(huge.timeoutMs).toBeGreaterThan(0);
  });
});

describe("redactOn", () => {
  it("redacts hooks by default, tools not", () => {
    expect(redactOn({}, "hook")).toBe(true);
    expect(redactOn({}, "tool")).toBe(false);
  });

  it("OMP_JEV_REDACT=1 forces redaction everywhere, =0 disables it", () => {
    expect(redactOn({ OMP_JEV_REDACT: "1" }, "tool")).toBe(true);
    expect(redactOn({ OMP_JEV_REDACT: "1" }, "hook")).toBe(true);
    expect(redactOn({ OMP_JEV_REDACT: "0" }, "hook")).toBe(false);
    expect(redactOn({ OMP_JEV_REDACT: "0" }, "tool")).toBe(false);
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

describe("withDeadline", () => {
  it("aborts on its own deadline even when the caller passes no signal", async () => {
    const signal = withDeadline(undefined, 20);
    expect(signal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(signal.aborted).toBe(true);
  });

  it("aborts early when the host signal aborts first", async () => {
    const host = new AbortController();
    const signal = withDeadline(host.signal, 10_000);
    host.abort();
    // The host's abort must win: a cancelled tool call cannot sit in the gate.
    expect(signal.aborted).toBe(true);
  });

  it("is already aborted when the host signal already is", () => {
    const host = new AbortController();
    host.abort();
    expect(withDeadline(host.signal, 10_000).aborted).toBe(true);
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
