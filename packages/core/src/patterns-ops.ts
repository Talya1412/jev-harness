/**
 * DevOps-flavored decision patterns: git hygiene, migrations, test
 * selection, secret hygiene, list dedup, and log triage. Like every core
 * pattern, each is ONE batched Jev call over a state, advisory by default,
 * with explicit thresholds the caller can override after tuning on their
 * own labeled data (see @jev-harness/eval).
 */
import { askJev, noul, choice, score } from "./client.js";
import type { JevConfig } from "./types.js";

const MAX_DIFF_CHARS = 8_000;
const MAX_ITEM_CHARS = 500;
const MAX_ITEMS = 30;

// ----------------------------- commitGate -----------------------------

export interface CommitGateResult {
  /** P(the diff is safe to commit as-is). */
  safeToCommit: number;
  /** P(the diff embeds a credential or secret). */
  containsSecrets: number;
  /** Probability-weighted risk on [None..Critical]. */
  risk: { score: number; confidence: number };
  /** Default policy: safe and no likely secret. Override via thresholds. */
  commit: boolean;
}

/**
 * Should this diff be committed automatically? One call, three judgments:
 * safety, secret leak risk, and overall severity. Intended for auto-commit
 * agents and squash bots; humans can ignore the `commit` flag and read the
 * probabilities.
 */
export async function commitGate(
  config: JevConfig,
  diff: string,
  opts: { safeThreshold?: number; secretThreshold?: number; signal?: AbortSignal } = {},
): Promise<CommitGateResult> {
  const response = await askJev(
    config,
    { diff: diff.slice(0, MAX_DIFF_CHARS) },
    {
      safe_to_commit: {
        type: "noul",
        instructions:
          "This diff is safe to commit as-is: it does not leak credentials, does not delete data, " +
          "and contains no leftover debug scaffolding that the author would not want published.",
      },
      contains_secrets: {
        type: "noul",
        instructions:
          "The diff embeds a real credential or secret: an API key, token, password, private key, " +
          "or a connection string with credentials. Placeholder or example values do not count.",
      },
      risk: {
        type: "score",
        instructions: "Severity of harm if this diff turns out to be wrong after publication",
        criteria: ["None", "Low", "Moderate", "High", "Critical"],
      },
    },
    opts.signal,
  );
  const safeToCommit = noul(response, "safe_to_commit");
  const containsSecrets = noul(response, "contains_secrets");
  const risk = score(response, "risk");
  return {
    safeToCommit,
    containsSecrets,
    risk,
    commit: safeToCommit >= (opts.safeThreshold ?? 0.8) && containsSecrets < (opts.secretThreshold ?? 0.5),
  };
}

// ----------------------------- migrationSafety -----------------------------

export interface MigrationSafetyResult {
  /** P(the migration loses data that is not reconstructible). */
  dataLoss: number;
  /** P(the migration cannot be rolled back). */
  irreversible: number;
  risk: { score: number; confidence: number };
  /** choice winner among apply | review | block. */
  verdict: string;
  confidence: number;
  probabilities: Record<string, number>;
}

/**
 * Pre-flight for a schema migration: data loss, reversibility, and a verdict.
 * Advisory — wire the verdict into whatever gates the migration actually runs.
 */
export async function migrationSafety(
  config: JevConfig,
  migration: { sql?: string; summary: string; dialect?: string },
  opts: { signal?: AbortSignal } = {},
): Promise<MigrationSafetyResult> {
  const response = await askJev(
    config,
    {
      migration: { ...migration, sql: migration.sql?.slice(0, MAX_DIFF_CHARS) },
      dialect: migration.dialect ?? "sql",
    },
    {
      data_loss: {
        type: "noul",
        instructions:
          "Running this migration loses data that is not reconstructible from elsewhere " +
          "(dropped columns/tables, truncation, coercions that destroy values).",
      },
      irreversible: {
        type: "noul",
        instructions:
          "The migration cannot be reversed by a straightforward inverse migration " +
          "(drops, destructive type changes, removed constraints).",
      },
      risk: {
        type: "score",
        instructions: "Operational risk of running this migration in production",
        criteria: ["None", "Low", "Moderate", "High", "Critical"],
      },
      verdict: {
        type: "choice",
        instructions: "What should happen before this migration reaches production?",
        criteria: {
          apply: "Safe: run it in the normal path",
          review: "A human should look at the migration first",
          block: "Do not run: likely data loss or a destructive operation needing a plan",
        },
      },
    },
    opts.signal,
  );
  const verdict = choice(response, "verdict");
  return {
    dataLoss: noul(response, "data_loss"),
    irreversible: noul(response, "irreversible"),
    risk: score(response, "risk"),
    verdict: verdict.choice,
    confidence: verdict.confidence,
    probabilities: verdict.probabilities,
  };
}

// ----------------------------- testPrioritizer -----------------------------

export interface TestPrioritizerResult {
  /** Ranked test names, most relevant to the diff first. */
  ranked: Array<{ name: string; relevance: number }>;
  /** Indexes into the ORIGINAL input array, ranked the same way. */
  rankedIndexes: number[];
  /** True when the input exceeded MAX_ITEMS and only the first 30 were analyzed. */
  truncated: boolean;
}

/**
 * Which tests matter for this diff? One batched call scoring each test's
 * relevance; the caller decides the cutoff (e.g. run everything above 0.5,
 * schedule the rest).
 */
export async function testPrioritizer(
  config: JevConfig,
  diff: string,
  tests: string[],
  opts: { signal?: AbortSignal } = {},
): Promise<TestPrioritizerResult> {
  const selected = tests.slice(0, MAX_ITEMS);
  const truncated = tests.length > selected.length;
  if (selected.length === 0) return { ranked: [], rankedIndexes: [], truncated };
  const questions: Record<string, { type: "noul"; instructions: string }> = {};
  for (let i = 0; i < selected.length; i++) {
    questions[`t${i}`] = {
      type: "noul",
      instructions:
        "This test exercises code paths affected by the diff, so running it would likely catch a regression the diff might introduce.",
    };
  }
  const response = await askJev(
    config,
    {
      diff: diff.slice(0, MAX_DIFF_CHARS),
      tests: selected.map((name, i) => ({ id: `t${i}`, name: name.slice(0, MAX_ITEM_CHARS) })),
    },
    questions,
    opts.signal,
  );
  const scored = selected.map((name, i) => ({ name, index: i, relevance: noul(response, `t${i}`) }));
  scored.sort((a, b) => b.relevance - a.relevance);
  return {
    ranked: scored.map(({ name, relevance }) => ({ name, relevance })),
    rankedIndexes: scored.map(({ index }) => index),
    truncated,
  };
}

// ----------------------------- secretLeak -----------------------------

export interface SecretLeakResult {
  /** P(each ANALYZED text contains a real credential or secret), by analyzed index. */
  probabilities: number[];
  /** Analyzed indexes scoring at or above the threshold (default 0.6). */
  flagged: number[];
  /** True when the input exceeded MAX_ITEMS and only the first 30 were analyzed. */
  truncated: boolean;
}

/**
 * Scan a batch of texts (log lines, diff hunks, config snippets) for real
 * credentials. One call for the whole batch; `flagged` uses a conservative
 * default threshold — tune it on your own data.
 */
export async function secretLeak(
  config: JevConfig,
  texts: string[],
  opts: { threshold?: number; signal?: AbortSignal } = {},
): Promise<SecretLeakResult> {
  const selected = texts.slice(0, MAX_ITEMS);
  const truncated = texts.length > selected.length;
  if (selected.length === 0) return { probabilities: [], flagged: [], truncated };
  const questions: Record<string, { type: "noul"; instructions: string }> = {};
  for (let i = 0; i < selected.length; i++) {
    questions[`s${i}`] = {
      type: "noul",
      instructions:
        "This text contains a REAL credential or secret (API key, token, password, private key, " +
        "credentials-embedded connection string). Example or placeholder values do not count.",
    };
  }
  const response = await askJev(
    config,
    { texts: selected.map((t, i) => ({ id: `s${i}`, text: t.slice(0, MAX_ITEM_CHARS) })) },
    questions,
    opts.signal,
  );
  const probabilities = selected.map((_, i) => noul(response, `s${i}`));
  const threshold = opts.threshold ?? 0.6;
  return { probabilities, flagged: probabilities.map((p, i) => (p >= threshold ? i : -1)).filter((i) => i >= 0), truncated };
}

// ----------------------------- dedupeItems -----------------------------

export interface DedupeResult {
  /** Items judged unique, in original order, with their original indexes. */
  unique: Array<{ index: number; item: string }>;
  /** Original indexes judged to duplicate an EARLIER item. */
  duplicateIndexes: number[];
  /** True when the input exceeded MAX_ITEMS and only the first 30 were analyzed. */
  truncated: boolean;
}

/**
 * Semantic dedup of a string list in ONE call: each item is asked whether it
 * duplicates any earlier item. Later items that paraphrase earlier ones are
 * dropped; exact-equality dedup is the caller's cheap pre-pass.
 */
export async function dedupeItems(
  config: JevConfig,
  items: string[],
  opts: { signal?: AbortSignal } = {},
): Promise<DedupeResult> {
  const selected = items.slice(0, MAX_ITEMS);
  const truncated = items.length > selected.length;
  if (selected.length === 0) return { unique: [], duplicateIndexes: [], truncated };
  const questions: Record<string, { type: "noul"; instructions: string }> = {};
  for (let i = 1; i < selected.length; i++) {
    questions[`d${i}`] = {
      type: "noul",
      instructions:
        "This item conveys the same information as at least one EARLIER item in the list " +
        "(a paraphrase or restatement counts as a duplicate).",
    };
  }
  // A single item can never be a duplicate of an earlier one; skip the call.
  if (selected.length === 1) return { unique: [{ index: 0, item: selected[0]! }], duplicateIndexes: [], truncated };
  const response = await askJev(
    config,
    { items: selected.map((t, i) => ({ id: `d${i}`, text: t.slice(0, MAX_ITEM_CHARS) })) },
    questions,
    opts.signal,
  );
  const duplicateIndexes: number[] = [];
  for (let i = 1; i < selected.length; i++) {
    if (noul(response, `d${i}`) >= 0.5) duplicateIndexes.push(i);
  }
  const dupSet = new Set(duplicateIndexes);
  return {
    unique: selected.map((item, index) => ({ index, item })).filter(({ index }) => !dupSet.has(index)),
    duplicateIndexes,
    truncated,
  };
}

// ----------------------------- logSeverity -----------------------------

export type LogLevel = "debug" | "info" | "warn" | "error" | "critical";

export interface LogSeverityResult {
  /** Severity per ANALYZED line, by analyzed index. */
  levels: LogLevel[];
  confidence: Array<Record<string, number>>;
  /** True when the input exceeded MAX_ITEMS and only the first 30 were analyzed. */
  truncated: boolean;
}

/**
 * Classify log lines' severity in ONE batched call. Useful for triaging a
 * flood of output into what a human should see first.
 */
export async function logSeverity(
  config: JevConfig,
  lines: string[],
  opts: { signal?: AbortSignal } = {},
): Promise<LogSeverityResult> {
  const selected = lines.slice(0, MAX_ITEMS);
  const truncated = lines.length > selected.length;
  if (selected.length === 0) return { levels: [], confidence: [], truncated };
  const criteria: Record<LogLevel, string> = {
    debug: "Development detail; safe to ignore in production",
    info: "Normal operational event; no action needed",
    warn: "Something is off and may need attention soon",
    error: "An operation failed; needs attention",
    critical: "Service loss, data danger, or security impact; act immediately",
  };
  const questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }> = {};
  for (let i = 0; i < selected.length; i++) {
    questions[`l${i}`] = {
      type: "choice",
      instructions: "What severity does this log line warrant?",
      criteria,
    };
  }
  const response = await askJev(
    config,
    { lines: selected.map((t, i) => ({ id: `l${i}`, text: t.slice(0, MAX_ITEM_CHARS) })) },
    questions,
    opts.signal,
  );
  const levels: LogLevel[] = [];
  const confidence: Array<Record<string, number>> = [];
  for (let i = 0; i < selected.length; i++) {
    const c = choice(response, `l${i}`);
    levels.push(c.choice as LogLevel);
    confidence.push(c.probabilities);
  }
  return { levels, confidence, truncated };
}
