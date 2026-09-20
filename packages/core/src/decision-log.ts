/**
 * Decision log: one structured record per Jev judgment, plus flip-rate
 * comparison between two logs over the same decisions. This is the raw
 * material for tuning: which threshold moved, which model version flipped
 * which verdict, and how often. Digests use FNV-1a over the canonical state
 * (identity only — never security).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fnv1a, stableStringify } from "./cache.js";

export interface DecisionRecord {
  /** ISO-8601 timestamp of the decision. */
  ts: string;
  /** Pattern or decision kind, e.g. "judgeDestructive", "commitGate", or a custom id. */
  kind: string;
  model: string;
  /** Stable digest of (kind, state, question ids). Equal inputs -> equal digest. */
  digest: string;
  /** Primary answer per question id: noul/score values, choice keys. */
  answers: Record<string, number | string>;
  /** Optional full probability distributions per question id. */
  probabilities?: Record<string, Record<string, number>>;
  /** Threshold that was applied, when the caller enforced one. */
  threshold?: number;
  /** What the caller did with the judgment, e.g. "block" | "allow". */
  action?: string;
  latencyMs: number;
}

export interface FlipStats {
  /** Records whose digest matched between the two logs. */
  matched: number;
  /** Matched records where every shared answer is identical. */
  agreed: number;
  /** disagreements / matched; 0 when nothing matched. */
  flipRate: number;
  disagreements: Array<{ digest: string; kind: string; a: DecisionRecord; b: DecisionRecord }>;
}

export interface DecisionLog {
  record(decision: DecisionRecord): void;
  entries(): readonly DecisionRecord[];
  readonly size: number;
  /**
   * Compare with another log (or record list). Records match by digest; they
   * agree when every shared question id has the same answer.
   */
  compare(other: DecisionLog | readonly DecisionRecord[]): FlipStats;
}

export interface DecisionLogOptions {
  /** Called for every recorded decision (persist to JSONL, ship to OTel, ...). */
  sink?: (record: DecisionRecord) => void;
  /** Ring size for in-memory retention. Default 1000. */
  maxEntries?: number;
}

export function createDecisionLog(opts: DecisionLogOptions = {}): DecisionLog {
  const maxEntries = Math.max(1, opts.maxEntries ?? 1000);
  const entries: DecisionRecord[] = [];
  return {
    record(decision) {
      entries.push(decision);
      if (entries.length > maxEntries) entries.shift();
      try {
        opts.sink?.(decision);
      } catch {
        // A failing sink must never break the decision path.
      }
    },
    entries() {
      return entries;
    },
    get size() {
      return entries.length;
    },
    compare(other) {
      const rows = other instanceof Array ? other : other.entries();
      const byDigest = new Map<string, DecisionRecord>();
      for (const r of rows) {
        if (!byDigest.has(r.digest)) byDigest.set(r.digest, r);
      }
      const disagreements: FlipStats["disagreements"] = [];
      let matched = 0;
      let agreed = 0;
      for (const mine of entries) {
        const theirs = byDigest.get(mine.digest);
        if (!theirs) continue;
        matched++;
        let same = true;
        for (const [id, value] of Object.entries(mine.answers)) {
          const otherValue = theirs.answers[id];
          if (otherValue === undefined || otherValue !== value) {
            same = false;
            break;
          }
        }
        if (same) agreed++;
        else disagreements.push({ digest: mine.digest, kind: mine.kind, a: mine, b: theirs });
      }
      return { matched, agreed, flipRate: matched === 0 ? 0 : disagreements.length / matched, disagreements };
    },
  };
}

/** Stable digest for (kind, state, question ids). */
export function decisionDigest(kind: string, state: unknown, questionIds: readonly string[]): string {
  let canon: string;
  try {
    canon = stableStringify(state);
  } catch {
    // Circular state cannot be canonicalized; mark it so equal-kind circular
    // states still digest deterministically instead of throwing RangeError.
    canon = '{"circular":true}';
  }
  return fnv1a(kind + "\n" + canon + "\n" + [...questionIds].sort().join(","));
}

/**
 * Sink that appends each decision as one JSON line. Returns a plain callback
 * suitable for `createDecisionLog({ sink })`; the parent directory is created
 * lazily and write errors are thrown — the log wrapper catches them.
 */
export function jsonlSink(path: string): (record: DecisionRecord) => void {
  return (record) => {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
  };
}
