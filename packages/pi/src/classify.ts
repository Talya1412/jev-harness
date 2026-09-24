/**
 * Map-reduce over a corpus, for the Pi adapter.
 *
 * The same questions are asked of every item (one Jev request per item), and
 * an optional reduce judges the collected verdicts. Both live in core
 * (`withMapReduce`, packages/core/src/infra.ts); this module adds only what a
 * corpus tool needs on top:
 * - the reduce state is a capped digest of the answers (200 items / 4000
 *   chars in core), never the corpus;
 * - core rejects the WHOLE batch when one item fails, which would throw away
 *   every answer, so a payload rejection (400/413/422) is retried item by
 *   item to name the failed indices while the rest survive.
 *
 * Kept free of ExtensionAPI so the failure policy is testable directly.
 */
import {
  JevError,
  withMapReduce,
  type Answer,
  type JevConfig,
  type MapReduceOptions,
  type Questions,
} from "@jev-harness/core";

export interface ItemFailure {
  index: number;
  error: string;
}

export interface ClassifyResult {
  /** Index-aligned with the input; null where that item failed. */
  perItem: Array<Record<string, Answer> | null>;
  /** The reduce answer, or null (no reduce requested, or it was skipped). */
  reduced: Answer | null;
  /** Item-level failures, ascending by index. Empty on a clean run. */
  failures: ItemFailure[];
  /** Set when a requested reduce did not run, and why. */
  reduceSkipped?: string;
  /** Sum of every response usage in the run; undefined when none reported any. */
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Item judgments in flight while attributing failures. Core default is 4. */
export const DEFAULT_CLASSIFY_CONCURRENCY = 4;

const ITEM_LEVEL_STATUS = new Set([400, 413, 422]);

/**
 * True when the error says nothing about one item and everything about the
 * call as a whole (missing key, auth, rate limit, server, network). Those must
 * stay batch-level: retrying them per item would multiply the cost of a
 * condition no item can fix.
 */
export function isBatchLevelError(err: unknown): boolean {
  if (err instanceof JevError) {
    return err.status === undefined || !ITEM_LEVEL_STATUS.has(err.status);
  }
  return true;
}

function mergeUsage(
  a?: { input_tokens?: number; output_tokens?: number },
  b?: { input_tokens?: number; output_tokens?: number },
): { input_tokens?: number; output_tokens?: number } | undefined {
  if (a === undefined && b === undefined) return undefined;
  return {
    input_tokens: (a?.input_tokens ?? 0) + (b?.input_tokens ?? 0),
    output_tokens: (a?.output_tokens ?? 0) + (b?.output_tokens ?? 0),
  };
}

/**
 * Sum usage across every response in the run. The wrapped fetch is the only
 * place they pass through, so the reducer and the items are both counted
 * without changing what core sees.
 */
export function collectUsage(config: JevConfig): {
  config: JevConfig;
  usage: () => { input_tokens?: number; output_tokens?: number } | undefined;
} {
  let totals: { input_tokens?: number; output_tokens?: number } | undefined;
  const inner = config.fetchImpl ?? fetch;
  const wrapped: typeof fetch = async (url, init) => {
    const res = await inner(url, init);
    if (res.ok) {
      try {
        const body = (await res.clone().json()) as { usage?: typeof totals };
        if (body?.usage) totals = mergeUsage(totals, body.usage);
      } catch {
        // Usage is best-effort: an unreadable body must never break a call.
      }
    }
    return res;
  };
  return { config: { ...config, fetchImpl: wrapped }, usage: () => totals };
}

export interface ClassifyOptions {
  /** Optional final judgment over the digest of per-item answers. */
  reduce?: MapReduceOptions["reduce"];
  concurrency?: number;
  signal?: AbortSignal;
}

/**
 * Ask the same questions of every item, then optionally reduce.
 *
 * A non-ITEM_LEVEL_STATUS failure propagates unchanged, preserving core
 * atomicity for conditions that say nothing about an individual item.
 */
export async function classifyItems(
  config: JevConfig,
  items: readonly unknown[],
  questions: Questions,
  opts: ClassifyOptions = {},
): Promise<ClassifyResult> {
  const collector = collectUsage(config);
  try {
    const { perItem, reduced } = await withMapReduce(collector.config, items, () => questions, {
      reduce: opts.reduce,
      concurrency: opts.concurrency,
      signal: opts.signal,
    });
    return { perItem, reduced, failures: [], usage: collector.usage() };
  } catch (err) {
    if (isBatchLevelError(err)) throw err;
    return await attributeItemFailures(collector, items, questions, opts, err);
  }
}

async function attributeItemFailures(
  collector: ReturnType<typeof collectUsage>,
  items: readonly unknown[],
  questions: Questions,
  opts: ClassifyOptions,
  batchErr: unknown,
): Promise<ClassifyResult> {
  const perItem: Array<Record<string, Answer> | null> = new Array(items.length).fill(null);
  const failures: ItemFailure[] = [];
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_CLASSIFY_CONCURRENCY));
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        // One item per call; core concurrency is the outer pool job.
        const one = await withMapReduce(collector.config, [items[index]], () => questions, {
          concurrency: 1,
          signal: opts.signal,
        });
        perItem[index] = one.perItem[0] ?? {};
      } catch (err) {
        if (isBatchLevelError(err)) throw err;
        failures.push({ index, error: err instanceof Error ? err.message : String(err) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  failures.sort((a, b) => a.index - b.index);
  const reduce = opts.reduce;
  const skipped =
    reduce === undefined
      ? undefined
      : failures.length > 0
        ? failures.length +
          " of " +
          items.length +
          " item(s) failed, so the reduce digest would be incomplete"
        : "reduce failed: " + (batchErr instanceof Error ? batchErr.message : String(batchErr));
  return { perItem, reduced: null, failures, reduceSkipped: skipped, usage: collector.usage() };
}
