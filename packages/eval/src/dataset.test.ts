import { describe, it, expect } from "vitest";
import {
  parseDatasetJson,
  parseDatasetJsonl,
  parseDataset,
  labelToBinary,
  labelToScoreIndex,
} from "../src/dataset.js";

describe("parseDatasetJson", () => {
  it("reads questions + cases", () => {
    const ds = parseDatasetJson(
      JSON.stringify({
        questions: { toxic: { type: "noul", instructions: "Is this toxic?" } },
        cases: [
          { id: "c1", state: { text: "hi" }, label: { toxic: false } },
          { state: { text: "bye" }, label: { toxic: true } },
        ],
      }),
    );
    expect(Object.keys(ds.questions)).toEqual(["toxic"]);
    expect(ds.cases).toHaveLength(2);
    expect(ds.cases[0].id).toBe("c1");
    expect(ds.cases[1].id).toBe("case_1");
  });

  it("accepts a bare array of cases", () => {
    const ds = parseDatasetJson(JSON.stringify([{ state: { x: 1 }, label: { q: 1 } }]));
    expect(ds.questions).toEqual({});
    expect(ds.cases).toHaveLength(1);
  });

  it("rejects cases without state or label", () => {
    expect(() => parseDatasetJson(JSON.stringify([{ state: { x: 1 } }]))).toThrow(/needs "state" and "label"/);
    expect(() => parseDatasetJson(JSON.stringify([{ state: {}, label: "not-an-object" }]))).toThrow(/label must be an object/);
  });
});

describe("parseDatasetJsonl", () => {
  it("merges per-line questions and skips comments", () => {
    const ds = parseDatasetJsonl(
      [
        "# a comment",
        "",
        `{"questions": {"q": {"type": "noul", "instructions": "?"}}, "state": {"n": 1}, "label": {"q": true}}`,
        `{"questions": {"r": {"type": "noul", "instructions": "?!"}}, "state": {"n": 2}, "label": {"q": false, "r": true}}`,
      ].join("\n"),
    );
    expect(Object.keys(ds.questions).sort()).toEqual(["q", "r"]);
    expect(ds.cases).toHaveLength(2);
    expect(ds.cases[0].label).toEqual({ q: true });
  });
});

describe("parseDataset", () => {
  it("dispatches on file extension", () => {
    const line = `{"state": {}, "label": {}}`;
    expect(parseDataset(line, "cases.jsonl").cases).toHaveLength(1);
    expect(parseDataset(line, "cases.ndjson").cases).toHaveLength(1);
    // As JSON, two bare objects are malformed and must throw.
    expect(() => parseDataset(`${line}\n${line}`, "cases.json")).toThrow();
  });
});

describe("label coercion", () => {
  it("coerces binary labels", () => {
    expect(labelToBinary(true)).toBe(1);
    expect(labelToBinary(false)).toBe(0);
    expect(labelToBinary("YES")).toBe(1);
    expect(labelToBinary("no")).toBe(0);
    expect(labelToBinary("1")).toBe(1);
    expect(labelToBinary(0)).toBe(0);
    expect(labelToBinary("maybe")).toBeNull();
  });

  it("coerces score labels by name and index", () => {
    const criteria = ["None", "Low", "Moderate", "High", "Critical"];
    expect(labelToScoreIndex("High", criteria)).toBe(3);
    expect(labelToScoreIndex("high", criteria)).toBe(3);
    expect(labelToScoreIndex(2, criteria)).toBe(2);
    expect(labelToScoreIndex("2", criteria)).toBe(2);
    expect(labelToScoreIndex(9, criteria)).toBeNull();
    expect(labelToScoreIndex("bogus", criteria)).toBeNull();
  });

  it("treats empty-string score labels as missing, not level 0", () => {
    const criteria = ["None", "Low"];
    expect(labelToScoreIndex("", criteria)).toBeNull();
    expect(labelToScoreIndex("   ", criteria)).toBeNull();
  });

  it("wraps JSONL parse errors with the line number", () => {
    expect(() => parseDatasetJsonl(`{"state": {}, "label": {}}\n{broken`)).toThrow(/line 2/);
  });
});
