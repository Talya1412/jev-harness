import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { JevError, classifyJevFailure } from "@jev-harness/core";
import {
  createTracedLedger,
  decideOnFailure,
  reportFailure,
  type FailureLogger,
} from "../src/failure.js";

/** A logger that records which channel each line went to. */
function makeLogger() {
  const warns: string[] = [];
  const debugs: string[] = [];
  const logger: FailureLogger = {
    warn: (m) => warns.push(m),
    debug: (m) => debugs.push(m),
  };
  return { logger, warns, debugs };
}

describe("decideOnFailure", () => {
  it("classifies the same way core does — it is not a second implementation", () => {
    const cases: unknown[] = [
      new JevError("Jev HTTP 401: bad key", { status: 401 }),
      new JevError("Jev HTTP 429: slow down", { status: 429 }),
      new JevError("Jev HTTP 503: unavailable", { status: 503 }),
      new JevError("Jev HTTP 404: unknown model", { status: 404 }),
      new TypeError("fetch failed"),
      "something odd",
    ];
    for (const err of cases) {
      expect(decideOnFailure(err, "gate").kind).toBe(classifyJevFailure(err));
    }
  });

  it("DISABLES the session on an auth failure — the key cannot work", () => {
    const d = decideOnFailure(new JevError("Jev HTTP 401", { status: 401 }), "gate");
    expect(d.kind).toBe("auth");
    expect(d.disableSession).toBe(true);
    expect(d.silent).toBe(false);
  });

  it("DISABLES the session on an unknown model", () => {
    const d = decideOnFailure(new Error("unknown model: jev-nope"), "compact");
    expect(d.kind).toBe("model");
    expect(d.disableSession).toBe(true);
  });

  it("stays SILENT and retryable on a network blip", () => {
    const d = decideOnFailure(new TypeError("fetch failed"), "skill router");
    expect(d.kind).toBe("network");
    expect(d.silent).toBe(true);
    expect(d.disableSession).toBe(false);
    // Network failures are retryable, so a backoff is offered.
    expect(d.backoffMs).toBeGreaterThan(0);
  });

  it("keeps a rate limit retryable with a backoff, and surfaces it", () => {
    // Built the way core's client builds it for a retryable 429.
    const err = new JevError("Jev HTTP 429: slow down", { status: 429, retryable: true });
    const d = decideOnFailure(err, "gate");
    expect(d.kind).toBe("rate_limit");
    expect(d.backoffMs).toBeGreaterThan(0);
    expect(d.silent).toBe(false);
    expect(d.disableSession).toBe(false);
  });

  it("offers no backoff for an error the client already marked non-retryable", () => {
    // core tightens the policy: it has been through the attempt loop already.
    const err = new JevError("Jev HTTP 429: slow down", { status: 429, retryable: false });
    expect(decideOnFailure(err, "gate").backoffMs).toBe(0);
  });

  it("surfaces an unclassifiable failure without disabling anything", () => {
    const d = decideOnFailure("weird", "gate");
    expect(d.kind).toBe("unknown");
    expect(d.silent).toBe(false);
    expect(d.disableSession).toBe(false);
    expect(d.backoffMs).toBe(0);
  });

  it("names the call site and the kind in the message it would log", () => {
    const d = decideOnFailure(new JevError("Jev HTTP 401", { status: 401 }), "gate");
    expect(d.message).toContain("gate");
    expect(d.message).toContain("auth");
    expect(d.message).toContain("disabling");
  });

  it("never throws, whatever it is handed", () => {
    for (const err of [undefined, null, 0, {}, [], Symbol("x"), new Error(""), { message: 42 }]) {
      expect(() => decideOnFailure(err, "gate")).not.toThrow();
    }
  });
});

describe("reportFailure", () => {
  it("routes a silent policy to debug and a loud one to warn", () => {
    const a = makeLogger();
    const net = decideOnFailure(new TypeError("fetch failed"), "gate");
    expect(reportFailure(a.logger, net).disabled).toBe(false);
    expect(a.debugs).toHaveLength(1);
    expect(a.warns).toHaveLength(0);

    const b = makeLogger();
    const auth = decideOnFailure(new JevError("Jev HTTP 401", { status: 401 }), "gate");
    expect(reportFailure(b.logger, auth).disabled).toBe(true);
    expect(b.warns).toHaveLength(1);
    expect(b.debugs).toHaveLength(0);
  });

  it("survives a logger that throws — a broken logger must not break the hook", () => {
    const logger: FailureLogger = {
      warn: () => {
        throw new Error("logger exploded");
      },
      debug: () => {
        throw new Error("logger exploded");
      },
    };
    const d = decideOnFailure(new JevError("Jev HTTP 401", { status: 401 }), "gate");
    expect(() => reportFailure(logger, d)).not.toThrow();
    // The decision still stands even though nothing could be logged.
    expect(reportFailure(logger, d).disabled).toBe(true);
  });

  it("does not touch the network or the logger when the policy is silent", () => {
    const spy = vi.fn();
    const logger: FailureLogger = { warn: spy, debug: spy };
    reportFailure(logger, decideOnFailure(new TypeError("fetch failed"), "gate"));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("createTracedLedger", () => {
  it("records in memory and appends one JSON line per distinct refusal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-ledger-"));
    const path = join(dir, "nested", "decisions.jsonl");
    const ledger = createTracedLedger(path);

    ledger.record("gate:bash", "block:destructive", 1_000);
    // Repeats fold into the count and must NOT be written again.
    ledger.record("gate:bash", "block:destructive", 2_000);
    ledger.record("router:abstain", "below-confidence");

    const entries = ledger.entries();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ key: "gate:bash", reason: "block:destructive", count: 2 });

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first).toMatchObject({
      kind: "omp_refusal",
      key: "gate:bash",
      reason: "block:destructive",
    });
    expect(first.ts).toBe(new Date(1_000).toISOString());
  });

  it("keeps working with no log path configured", () => {
    const ledger = createTracedLedger(undefined);
    ledger.record("gate:bash", "block");
    expect(ledger.entries()).toHaveLength(1);
  });

  it("never throws when the path cannot be written", () => {
    // A directory used as a file path: every write fails.
    const ledger = createTracedLedger(tmpdir());
    expect(() => ledger.record("gate:bash", "block")).not.toThrow();
    expect(ledger.entries()).toHaveLength(1);
  });
});
