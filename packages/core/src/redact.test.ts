import { describe, it, expect } from "vitest";
import { BUILTIN_REDACT_PATTERNS, redactText, redactState } from "./redact.js";
import { askJev } from "./client.js";
import type { JevResponse } from "./types.js";

// Token-shaped fixtures are assembled at runtime: their literals must not
// appear in source, or GitHub push protection blocks the repo entirely.
const SLACK_TOKEN = ["xoxb", "123456789012", "abcdefghijklmnop"].join("-");
const GITHUB_TOKEN = "ghp_" + "0123456789abcdefghijklmnopqrstuvwxyz" + "XYZ";
const SK_KEY = "sk-" + "proj4bc9d8ef2gh1ijklm3nop";

describe("redactText", () => {
  it.each([
    ["aws access key", "key AKIAIOSFODNN7EXAMPLE in config", "key [REDACTED:aws-access-key] in config"],
    ["jwt", "auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U done", "auth [REDACTED:jwt] done"],
    [
      "private key",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
      "[REDACTED:private-key]",
    ],
    ["github token", "token " + GITHUB_TOKEN, "token [REDACTED:github-token]"],
    ["slack token", SLACK_TOKEN, "[REDACTED:slack-token]"],
    ["sk api key", "openai " + SK_KEY, "openai [REDACTED:api-key]"],
    ["bearer header", "Authorization: Bearer abcdef0123456789abcdef0123456789", "Authorization: Bearer [REDACTED]"],
    ["env assignment", "TYPESAFE_API_KEY=sk-abc123 in .env", "TYPESAFE_API_KEY=[REDACTED] in .env"],
    ["url credential", "https://host/db?password=hunter2&x=1", "https://host/db?password=[REDACTED]&x=1"],
    ["connection string", "postgres://admin:s3cret@db.internal:5432/app", "[REDACTED-connstring]@db.internal:5432/app"],
    ["email", "ping jane.doe+ops@example.co.uk today", "ping [REDACTED:email] today"],
    ["google api key", "key AIza" + "SyB1a2c3d4e5f6g7h8i9j0k1l2m3n4o5p67", "key [REDACTED:google-api-key]"],
  ])("redacts %s", (_name, input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it("leaves ordinary prose untouched", () => {
    const text = "The login redirect URL changed and session cookie flags were updated.";
    expect(redactText(text)).toBe(text);
  });

  it("leaves benign technical strings that merely look similar", () => {
    // Not a JWT (no three dot-separated segments), not a token prefix.
    const text = "package eyJ-core version 1.2.3; run npm test";
    expect(redactText(text)).toBe(text);
  });

  it("applies extra patterns as [REDACTED:custom]", () => {
    expect(redactText("acct 4111111111111111 ok", { extra: [/\b4\d{15}\b/g] })).toBe("acct [REDACTED:custom] ok");
  });

  it("never returns the original secret when a pattern list is empty", () => {
    expect(redactText("AKIAIOSFODNN7EXAMPLE", {})).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("keeps the builtin list documented via export", () => {
    expect(BUILTIN_REDACT_PATTERNS.length).toBeGreaterThanOrEqual(8);
  });
});

describe("redactState", () => {
  it("scrubs string leaves inside nested structures", () => {
    const state = {
      diff: "contact ops@corp.example about AKIAIOSFODNN7EXAMPLE",
      files: [{ path: "a.txt", note: "reach me at bob@corp.example" }],
      count: 3,
      flag: true,
      nothing: null,
    };
    const out = redactState(state) as typeof state;
    expect(out.diff).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out.diff).toContain("[REDACTED:email]");
    expect(out.files[0]!.note).not.toContain("bob@corp.example");
    expect(out.count).toBe(3);
    expect(out.flag).toBe(true);
    expect(out.nothing).toBeNull();
  });

  it("preserves Date/Map/Set/class instances instead of corrupting them", () => {
    const date = new Date("2026-09-20T00:00:00.000Z");
    const out = redactState({ d: date, m: new Map([["k", "v AKIAIOSFODNN7EXAMPLE"]]), s: new Set(["a@b.example"]), n: 1 }) as {
      d: unknown; m: unknown; s: unknown; n: unknown;
    };
    // Date keeps its ISO content (JSON.stringify semantics), Map/Set keep entries.
    expect(out.d).toBe("2026-09-20T00:00:00.000Z");
    expect(out.m).toEqual([["k", expect.stringContaining("[REDACTED:aws-access-key]")]]);
    expect(out.s).toEqual([expect.stringContaining("[REDACTED:email]")]);
    expect(out.n).toBe(1);
    // no-redact baseline really does serialize these shapes
    expect(JSON.parse(JSON.stringify({ d: date })).d).toBe("2026-09-20T00:00:00.000Z");
    class Point { constructor(public x = 1) {} toString() { return "point(1)"; } }
    expect(redactState({ p: new Point() })).toEqual({ p: "point(1)" });
  });

  it("does not mutate the input", () => {
    const state = { s: "mail a@b.example" };
    redactState(state);
    expect(state.s).toBe("mail a@b.example");
  });

  it("handles arrays and deep nesting up to maxDepth", () => {
    const deep = { a: { b: { c: { d: { e: "x AKIAIOSFODNN7EXAMPLE" } } } } };
    const out = redactState(deep, { maxDepth: 3 }) as typeof deep;
    // depth 4 string is past the cap and stays untouched
    expect(out.a.b.c.d.e).toContain("AKIAIOSFODNN7EXAMPLE");
    const full = redactState(deep) as typeof deep;
    expect(full.a.b.c.d.e).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});

describe("askJev redaction", () => {
  const captured: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: unknown, init?: { body?: string }) => {
    captured.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ model: "jev-test", answers: { q: { type: "noul", noul: 0.1 } } } satisfies JevResponse),
    } as unknown as Response;
  }) as typeof fetch;

  it("sends unredacted state by default", async () => {
    await askJev({ apiKey: "k", fetchImpl }, { secret: "AKIAIOSFODNN7EXAMPLE" }, { q: { type: "noul", instructions: "ok?" } });
    expect(JSON.stringify(captured[0])).toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("redacts state when config.redact is set", async () => {
    await askJev(
      { apiKey: "k", fetchImpl, redact: true },
      { secret: "AKIAIOSFODNN7EXAMPLE" },
      { q: { type: "noul", instructions: "ok?" } },
    );
    expect(JSON.stringify(captured[1])).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(JSON.stringify(captured[1])).toContain("[REDACTED:aws-access-key]");
  });
});
