/**
 * Dataset loading and label coercion for @jev-harness/eval.
 *
 * Two formats are supported:
 *
 * 1. JSON — one object: `{ "questions": {...}, "cases": [ { "id", "state", "label" }, ... ] }`
 *    (a bare array of cases also works; pair it with --questions).
 * 2. JSONL — one case per line; lines may carry a shared "questions" map.
 *
 * Labels are plain values, coerced per question type:
 *   - noul:  true/false, "yes"/"no", 0/1
 *   - choice: the criteria key as a string
 *   - score: the level name, or its 0-based index
 */
import { readFileSync } from "node:fs";
import type { Questions } from "@jev-harness/core";

export interface EvalCase {
  id: string;
  state: unknown;
  label: Record<string, unknown>;
  /**
   * Benchmark slice this case belongs to (e.g. "obfuscation", "steering",
   * "false-positive-trap"). Slice metrics show WHERE a regression landed; a
   * flat aggregate can hide a broken slice behind a healthy one.
   */
  slice?: string;
  /**
   * Invariance group. Cases sharing a `pair` describe the same action in
   * different words; their probabilities should be close (see
   * `invarianceDeltas`).
   */
  pair?: string;
  /** Why this case is labeled the way it is — the benchmark's audit trail. */
  note?: string;
}

export interface EvalDataset {
  questions: Questions;
  cases: EvalCase[];
}

function toCase(obj: Record<string, unknown>, index: number): EvalCase {
  if (!obj || typeof obj !== "object" || !("state" in obj) || !("label" in obj)) {
    throw new Error(`case #${index} needs "state" and "label" fields`);
  }
  if (typeof obj.label !== "object" || obj.label === null || Array.isArray(obj.label)) {
    throw new Error(`case #${index} label must be an object of questionId -> value`);
  }
  return {
    id: typeof obj.id === "string" && obj.id ? obj.id : `case_${index}`,
    state: obj.state,
    label: obj.label as Record<string, unknown>,
    ...(typeof obj.slice === "string" && obj.slice ? { slice: obj.slice } : {}),
    ...(typeof obj.pair === "string" && obj.pair ? { pair: obj.pair } : {}),
    ...(typeof obj.note === "string" && obj.note ? { note: obj.note } : {}),
  };
}

export function parseDatasetJson(text: string): EvalDataset {
  const parsed = JSON.parse(text) as unknown;
  if (Array.isArray(parsed)) {
    return { questions: {}, cases: parsed.map((c, i) => toCase(c as Record<string, unknown>, i)) };
  }
  const obj = parsed as { questions?: Questions; cases?: unknown[] };
  if (!obj || typeof obj !== "object")
    throw new Error("dataset JSON must be an object or an array of cases");
  return {
    questions: obj.questions ?? {},
    cases: (obj.cases ?? []).map((c, i) => toCase(c as Record<string, unknown>, i)),
  };
}

export function parseDatasetJsonl(text: string): EvalDataset {
  const questions: Questions = {};
  const cases: EvalCase[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
    let obj: { questions?: Questions } & Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as { questions?: Questions } & Record<string, unknown>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`invalid JSONL on line ${i + 1}: ${msg}`, { cause: err });
    }
    if (obj.questions) Object.assign(questions, obj.questions);
    cases.push(toCase(obj, cases.length));
  }
  return { questions, cases };
}

export function parseDataset(text: string, path: string): EvalDataset {
  if (/\.ndjson$/i.test(path) || /\.jsonl$/i.test(path)) return parseDatasetJsonl(text);
  return parseDatasetJson(text);
}

export function loadDataset(path: string): EvalDataset {
  return parseDataset(readFileSync(path, "utf8"), path);
}

const TRUTHY = new Set(["yes", "true", "y", "1", "positive", "pos"]);
const FALSY = new Set(["no", "false", "n", "0", "negative", "neg"]);

/** Coerce a label to 0/1 for a noul question; null when not coercible. */
export function labelToBinary(value: unknown): 0 | 1 | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value >= 0.5 ? 1 : 0;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (TRUTHY.has(s)) return 1;
    if (FALSY.has(s)) return 0;
  }
  return null;
}

/** Coerce a label to a 0-based score level index; null when not coercible. */
export function labelToScoreIndex(value: unknown, criteria: string[]): number | null {
  if (typeof value === "number") {
    const i = Math.round(value);
    return i >= 0 && i < criteria.length ? i : null;
  }
  if (typeof value === "string") {
    // Number("") is 0, so an empty/blank label must not coerce to level 0.
    if (value.trim() === "") return null;
    const byName = criteria.findIndex((c) => c.toLowerCase() === value.trim().toLowerCase());
    if (byName >= 0) return byName;
    const n = Number(value);
    if (value.trim() !== "" && Number.isFinite(n)) {
      const i = Math.round(n);
      return i >= 0 && i < criteria.length ? i : null;
    }
  }
  return null;
}
