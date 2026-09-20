import { describe, expect, it } from "vitest";
import { TOOLS } from "../src/server.js";

/** The tool surface is a contract: clients cache it, so a rename breaks callers. */
describe("MCP tool list", () => {
  const names = TOOLS.map((t) => t.name);

  it("exposes the documented tools with unique names", () => {
    expect(names).toEqual([
      "jev_ask",
      "jev_models",
      "jev_route_skills",
      "jev_pick_tool",
      "jev_judge_destructive",
      "jev_browse_action",
      "jev_rank",
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("uses safe identifier names that MCP clients will not mangle", () => {
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("gives every tool a description and an object schema", () => {
    for (const tool of TOOLS) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(tool.inputSchema.properties, tool.name).toBeTypeOf("object");
    }
  });

  it("requires the arguments a handler cannot default", () => {
    const byName = new Map(TOOLS.map((t) => [t.name, t]));
    expect(byName.get("jev_ask")!.inputSchema.required).toEqual(["state", "questions"]);
    expect(byName.get("jev_judge_destructive")!.inputSchema.required).toEqual(["tool", "input"]);
    expect(byName.get("jev_pick_tool")!.inputSchema.required).toEqual(["task", "tools"]);
    expect(byName.get("jev_rank")!.inputSchema.required).toEqual(["task", "candidates"]);
    expect(byName.get("jev_browse_action")!.inputSchema.required).toEqual(["goal", "page", "elements"]);
  });

  it("declares no required arguments for the argument-free tools", () => {
    const byName = new Map(TOOLS.map((t) => [t.name, t]));
    expect(byName.get("jev_models")!.inputSchema.required).toBeUndefined();
  });

  it("tells the caller that a destructive verdict can be unknown, not safe", () => {
    const tool = TOOLS.find((t) => t.name === "jev_judge_destructive")!;
    // An isError result means the judgment failed; treating that as "safe"
    // would silently disable the gate on any Jev outage.
    expect(tool.description).toMatch(/isError/);
    expect(tool.description).toMatch(/unknown, not as confirmed-safe/);
  });

  it("marks the advisory tools as non-executing", () => {
    for (const name of ["jev_browse_action", "jev_pick_tool"]) {
      const tool = TOOLS.find((t) => t.name === name)!;
      expect(tool.description, name).toMatch(/[Dd]oes not execute/);
    }
  });
});
