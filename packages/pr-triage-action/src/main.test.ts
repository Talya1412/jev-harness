import { afterEach, describe, expect, it } from "vitest";
import { githubFetch, normalizeRoute } from "./main.js";

const realFetch = globalThis.fetch;

function stubFetch() {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  globalThis.fetch = (async (url: any, init: any) => {
    seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return seen;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.INPUT_GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
});

describe("normalizeRoute", () => {
  it("passes through the known routes", () => {
    for (const route of ["auto", "peer", "security"]) {
      expect(normalizeRoute(route)).toBe(route);
    }
  });

  it("clamps model free text to peer so outputs and labels stay in-allowlist", () => {
    expect(normalizeRoute("admin")).toBe("peer");
    expect(normalizeRoute("")).toBe("peer");
    expect(normalizeRoute("security\ncomment_url: evil")).toBe("peer");
  });
});

describe("githubFetch token wiring", () => {
  it("prefers the github_token action input over the GITHUB_TOKEN env", async () => {
    process.env.INPUT_GITHUB_TOKEN = "input-token";
    process.env.GITHUB_TOKEN = "env-token";
    const seen = stubFetch();
    await githubFetch("/repos/o/r/pulls/1");
    expect(seen[0]!.headers.Authorization).toBe("Bearer input-token");
  });

  it("falls back to GITHUB_TOKEN when the action input is unset", async () => {
    process.env.GITHUB_TOKEN = "env-token";
    const seen = stubFetch();
    await githubFetch("/repos/o/r/pulls/1");
    expect(seen[0]!.headers.Authorization).toBe("Bearer env-token");
  });
});
