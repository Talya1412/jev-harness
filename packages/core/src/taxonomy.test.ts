import { describe, it, expect } from "vitest";
import {
  classifyJevFailure,
  policyForFailure,
  retryAfterMs,
  type JevFailureKind,
} from "../src/taxonomy.js";
import { JevError } from "../src/types.js";

describe("classifyJevFailure", () => {
  it("maps a rejected key to auth", () => {
    expect(classifyJevFailure(new JevError("Jev HTTP 401: bad key", { status: 401 }))).toBe("auth");
    expect(classifyJevFailure(new JevError("Jev HTTP 403: forbidden", { status: 403 }))).toBe(
      "auth",
    );
  });

  it("maps a missing model to model even though it arrives as a 404", () => {
    expect(
      classifyJevFailure(new JevError("Jev HTTP 404: model jev-0.1 not found", { status: 404 })),
    ).toBe("model");
    expect(classifyJevFailure(new Error("unknown model: jev-nope"))).toBe("model");
  });

  it("keeps a bare 404 as unknown", () => {
    expect(classifyJevFailure(new JevError("Jev HTTP 404: no route", { status: 404 }))).toBe(
      "unknown",
    );
  });

  it("maps 429 to rate_limit", () => {
    expect(classifyJevFailure(new JevError("Jev HTTP 429: slow down", { status: 429 }))).toBe(
      "rate_limit",
    );
  });

  it("maps a 5xx to server", () => {
    expect(classifyJevFailure(new JevError("Jev HTTP 503: unavailable", { status: 500 }))).toBe(
      "server",
    );
    expect(classifyJevFailure(new JevError("Jev HTTP 502: bad gateway", { status: 502 }))).toBe(
      "server",
    );
  });

  it("maps a fetch rejection to network", () => {
    expect(classifyJevFailure(new TypeError("fetch failed"))).toBe("network");
    const abort = new Error("The operation was aborted.");
    abort.name = "AbortError";
    expect(classifyJevFailure(abort)).toBe("network");
    expect(classifyJevFailure(new Error("request timed out"))).toBe("network");
  });

  it("falls back to unknown for anything unrecognised", () => {
    expect(classifyJevFailure(new Error("something odd"))).toBe("unknown");
    expect(classifyJevFailure("a bare string")).toBe("unknown");
    expect(classifyJevFailure(undefined)).toBe("unknown");
  });

  it("reads a status nested on an axios-style error", () => {
    expect(classifyJevFailure({ response: { status: 401 } })).toBe("auth");
  });
});

describe("policyForFailure", () => {
  it("disables the session for auth and model failures", () => {
    for (const kind of ["auth", "model"] as const) {
      const p = policyForFailure(kind);
      expect(p.disableSession).toBe(true);
      expect(p.retryable).toBe(false);
      expect(p.backoffMs).toBe(0);
      expect(p.silent).toBe(false);
    }
  });

  it("retries rate limits and network blips, silently for network", () => {
    expect(policyForFailure("rate_limit")).toMatchObject({ retryable: true, backoffMs: 30_000 });
    expect(policyForFailure("network")).toMatchObject({ retryable: true, silent: true });
  });

  it("retries 5xx and never disables the session for it", () => {
    expect(policyForFailure("server")).toMatchObject({ retryable: true, disableSession: false });
  });

  it("covers every kind", () => {
    const kinds: JevFailureKind[] = ["auth", "model", "rate_limit", "network", "server", "unknown"];
    for (const kind of kinds) expect(policyForFailure(kind).kind).toBe(kind);
  });

  it("honours Retry-After in seconds", () => {
    const err = new JevError("429", { status: 429, retryable: true });
    (err as { headers?: unknown }).headers = new Headers({ "retry-after": "12" });
    expect(policyForFailure("rate_limit", err).backoffMs).toBe(12_000);
    expect(retryAfterMs(err)).toBe(12_000);
  });

  it("honours Retry-After as a plain header object and as an HTTP date", () => {
    expect(retryAfterMs({ headers: { "Retry-After": "5" } })).toBe(5_000);
    const future = new Date(Date.now() + 20_000).toUTCString();
    const ms = retryAfterMs({ headers: { "retry-after": future } });
    expect(ms).toBeGreaterThan(15_000);
    expect(ms).toBeLessThanOrEqual(20_000);
  });

  it("ignores an unreadable Retry-After and keeps the default", () => {
    expect(retryAfterMs({ headers: new Headers({ "retry-after": "soon" }) })).toBeUndefined();
    expect(policyForFailure("rate_limit", { headers: {} }).backoffMs).toBe(30_000);
    expect(policyForFailure("rate_limit").backoffMs).toBe(30_000);
  });

  it("never reports a JevError with retryable:false as retryable", () => {
    const p = policyForFailure(
      "rate_limit",
      new JevError("429", { status: 429, retryable: false }),
    );
    expect(p.retryable).toBe(false);
    expect(p.backoffMs).toBe(0);
    expect(policyForFailure("network", new JevError("down", { retryable: false })).retryable).toBe(
      false,
    );
  });

  it("returns frozen policies so a caller cannot mutate the table", () => {
    const p = policyForFailure("server");
    expect(Object.isFrozen(p)).toBe(true);
  });
});
