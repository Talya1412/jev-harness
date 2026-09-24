import { afterEach, describe, expect, it } from "vitest";
import { createPiToolkit } from "../src/config.js";

const saved = process.env.TYPESAFE_API_KEY;
afterEach(() => {
  if (saved === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = saved;
});

describe("createPiToolkit", () => {
  it("stays fail-open without a key", () => {
    delete process.env.TYPESAFE_API_KEY;
    expect(createPiToolkit().config().apiKey).toBe("");
  });

  it("never redacts a tool's state, even when JEV_REDACT=0 asks for it", () => {
    process.env.TYPESAFE_API_KEY = "k";
    const savedRedact = process.env.JEV_REDACT;
    process.env.JEV_REDACT = "0";
    try {
      // The model chose this state deliberately, so Pi sends it intact.
      expect(createPiToolkit().config().redact).toBe(false);
    } finally {
      if (savedRedact === undefined) delete process.env.JEV_REDACT;
      else process.env.JEV_REDACT = savedRedact;
    }
  });
});
