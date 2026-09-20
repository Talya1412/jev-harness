import { describe, it, expect } from "vitest";
import { withFailMode } from "../src/guard.js";

describe("withFailMode", () => {
  it("passes through the result when nothing throws", async () => {
    const r = await withFailMode("open", async () => 42, { open: 0, closed: 1 });
    expect(r).toBe(42);
  });

  it("fails open with the open outcome", async () => {
    let seen: unknown;
    const r = await withFailMode(
      "open",
      async () => {
        throw new Error("jev down");
      },
      { open: "allow", closed: "deny", onError: (e) => (seen = e) },
    );
    expect(r).toBe("allow");
    expect((seen as Error).message).toBe("jev down");
  });

  it("fails closed with the closed outcome", async () => {
    const r = await withFailMode(
      "closed",
      async () => {
        throw new Error("jev down");
      },
      { open: "allow", closed: "deny" },
    );
    expect(r).toBe("deny");
  });

  it("still applies the policy when onError itself throws", async () => {
    const open = await withFailMode(
      "open",
      async () => { throw new Error("jev down"); },
      { open: "allow", closed: "deny", onError: () => { throw new Error("observer down"); } },
    );
    expect(open).toBe("allow");
    const closed = await withFailMode(
      "closed",
      async () => { throw new Error("jev down"); },
      { open: "allow", closed: "deny", onError: () => { throw new Error("observer down"); } },
    );
    expect(closed).toBe("deny");
    await expect(
      withFailMode("throw", async () => { throw new Error("boom"); }, {
        open: "allow", closed: "deny", onError: () => { throw new Error("observer down"); },
      }),
    ).rejects.toThrow("boom");
  });

  it("rethrows in throw mode", async () => {
    await expect(
      withFailMode(
        "throw",
        async () => {
          throw new Error("boom");
        },
        { open: "allow", closed: "deny" },
      ),
    ).rejects.toThrow("boom");
  });
});
