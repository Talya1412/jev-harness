import { askJev } from "./client.js";
import { THRESHOLDS } from "./patterns.js";
import type { JevConfig, JevResponse, Questions } from "./types.js";

/** One candidate for pruning: the caller's original content plus its kind. */
export interface PruneCandidate {
  id: string;
  text: string;
  kind?: "output" | "error" | "diagnostic";
}

/** The verdict for ONE candidate, index-aligned with the input array. */
export interface PruneDecision {
  id: string;
  keep: boolean;
  score: number;
  chars: number;
  /** Present iff `keep === false`: head + provenance note; caller keeps the original. */
  replacement?: string;
  /** Chars the replacement note accounts for (text length minus head), present iff drop. */
  omittedChars?: number;
}

/** Default head kept verbatim in a drop replacement. */
const DEFAULT_HEAD_CHARS = 300;
/** Items shorter than this are never asked about — a bounded preview already suffices. */
const DEFAULT_MIN_CHARS = 2000;
/** Question ids (one noul per item id) packed into a single `askJev` request. */
const DEFAULT_MAX_ITEMS_PER_REQUEST = 64;
/** State budget in approximate tokens; the guard divides chars by `CHARS_PER_TOKEN`. */
const DEFAULT_MAX_STATE_TOKENS = 25_000;
/** Cheap chars-per-token estimate behind the size guard (plan: `length / 4`). */
const CHARS_PER_TOKEN = 4;
/**
 * Score carried by a keep that NO readable judgment backed (size guard,
 * `protect` veto, sub-minChars text, missing/malformed answer). It is a
 * keep-only sentinel, not a model verdict — dropped items always carry a
 * real read, so a low score can never be confused with this one.
 */
const UNJUDGED_KEEP_SCORE = 1;

/**
 * The per-item noul question: does the conversation still need this item's
 * CONTENTS, or can the turn proceed with a bounded preview?
 *
 * The `error`/`diagnostic` variant holds the item to a STRICTER standard
 * before a low score is believable: dropping live error output is how bugs
 * hide, so the model must justify a low read (fully superseded, already
 * acted upon, or redundant) instead of merely finding a preview convenient.
 */
function needQuestion(kind: PruneCandidate["kind"]): string {
  const base =
    "Judge only by this item in the state: does the conversation still need this item's full " +
    "CONTENTS to continue, or can the turn proceed with a bounded preview (its id plus a short " +
    "head)? Answer high (toward 1) only if the full contents are still required to continue; " +
    "answer low (toward 0) if a bounded preview suffices.";
  if (kind === "error" || kind === "diagnostic") {
    return (
      base +
      " This is error/diagnostic output: dropping live error output is how bugs hide, so hold it " +
      "to a stricter standard — score low ONLY if this output is fully superseded, already acted " +
      "upon, or redundant."
    );
  }
  return base;
}

/**
 * Local tolerant read of one noul answer. Returns `null` for a missing id,
 * a wrong-shape answer, or a non-finite/out-of-range number — the caller
 * maps `null` to KEEP.
 *
 * Deliberately NOT `gate-core`'s `scoreQuestions` with its "zero" policy:
 * an unreadable row there becomes 0, and 0 here means "definitely droppable"
 * (0 < keepThreshold and 0 <= dropThreshold), i.e. an outage would delete
 * content. Fail-open for prune is keep, never read-as-zero.
 */
function readNeed(response: JevResponse, id: string): number | null {
  const answer = response.answers[id];
  if (!answer || answer.type !== "noul") return null;
  const n = answer.noul;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1) return null;
  return n;
}

/**
 * The drop decision table, exactly as specified: the score must clear the
 * keep bar AND land at-or-below the drop bar for its kind. Error-like kinds
 * (`error`, `diagnostic`) answer to the far stricter `errorDropThreshold`;
 * everything else to `dropThreshold`. The band between the bars always keeps.
 */
function shouldDrop(
  score: number,
  kind: PruneCandidate["kind"],
  keepThreshold: number,
  dropThreshold: number,
  errorDropThreshold: number,
): boolean {
  const errorLike = kind === "error" || kind === "diagnostic";
  const bar = errorLike ? errorDropThreshold : dropThreshold;
  return score < keepThreshold && score <= bar;
}

/** A keep that no readable judgment backed (see `UNJUDGED_KEEP_SCORE`). */
function unjudgedKeep(item: PruneCandidate): PruneDecision {
  return { id: item.id, keep: true, score: UNJUDGED_KEEP_SCORE, chars: item.text.length };
}

/**
 * Context pruning, non-destructive by contract: ask whether each candidate's
 * CONTENTS are still needed, and for every drop return a replacement string
 * (verbatim head + provenance note) while the caller keeps the original.
 * Nothing is ever deleted from the input — decisions are index-aligned and
 * the input array is never mutated.
 *
 * WHY the size guard runs first (before any request, before any short-circuit):
 * Astro-Han fed a 39.5M-char transcript to Jev, got HTTP 400, and the fail-open
 * path then shipped 15.8M tokens onward into the next context anyway (the
 * negative A/B's TB4 closed). Guarding on `JSON.stringify(items).length / 4 >
 * maxStateTokens` turns that whole class of failure into an honest
 * `deferred: true, reason: "state-too-large"` with ZERO requests spent.
 *
 * WHY the bars sit where they do — cross-repo MEASURED provenance (not a local
 * plateau; re-tune against your own read-backs; frozen in `THRESHOLDS.prune*`):
 * - keep 0.5 / drop 0.25: codex-context-diet (the band between drop and keep
 *   always keeps).
 * - errorDrop 0.1: codex-context-diet needs <=0.1 on failure-looking output and
 *   jev-pruner requires <=0.1 in every segment — a dropped error hides bugs.
 *
 * Fail-open contract: missing/malformed answers KEEP (local reader; a zero-read
 * would mean "droppable", so `scoreQuestions`' policy is not reused here);
 * `protect`/sub-minChars/guard keeps carry score 1 and ask nothing. Transport
 * failures propagate to the adapter boundary, which keeps the original — a
 * silent default is never returned.
 *
 * @param items Candidates with unique `id`s; `text.length < minChars` and
 *   `protect(item)` short-circuit to keep without spending a question.
 * @param options Thresholds (default `THRESHOLDS.prune*`), `headChars` (300),
 *   `minChars` (2000), `maxItemsPerRequest` (64), `maxStateTokens` (25000),
 *   `protect`, `signal`.
 * @returns Decisions (index-aligned) plus `deferred` — `true` only for the
 *   state-too-large guard, which also reports `reason`.
 */
export async function pruneContext(
  config: JevConfig,
  items: readonly PruneCandidate[],
  options?: {
    keepThreshold?: number;
    dropThreshold?: number;
    errorDropThreshold?: number;
    headChars?: number;
    minChars?: number;
    protect?: (item: PruneCandidate) => boolean;
    maxItemsPerRequest?: number;
    maxStateTokens?: number;
    signal?: AbortSignal;
  },
): Promise<{ decisions: PruneDecision[]; deferred: boolean; reason?: string }> {
  const keepThreshold = options?.keepThreshold ?? THRESHOLDS.pruneKeep;
  const dropThreshold = options?.dropThreshold ?? THRESHOLDS.pruneDrop;
  const errorDropThreshold = options?.errorDropThreshold ?? THRESHOLDS.pruneErrorDrop;
  const headChars = options?.headChars ?? DEFAULT_HEAD_CHARS;
  const minChars = options?.minChars ?? DEFAULT_MIN_CHARS;
  const protect = options?.protect;
  const maxItemsPerRequest = Math.max(
    1,
    options?.maxItemsPerRequest ?? DEFAULT_MAX_ITEMS_PER_REQUEST,
  );
  const maxStateTokens = options?.maxStateTokens ?? DEFAULT_MAX_STATE_TOKENS;

  // Guard FIRST: oversize state defers the whole pass with zero requests
  // (see the Astro-Han citation on this function). All-keep, unjudged.
  if (JSON.stringify(items).length / CHARS_PER_TOKEN > maxStateTokens) {
    return { decisions: items.map(unjudgedKeep), deferred: true, reason: "state-too-large" };
  }

  const decisions: PruneDecision[] = new Array<PruneDecision>(items.length);
  const judged: Array<{ index: number; item: PruneCandidate }> = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    // Short-circuit keeps: no question is spent on a vetoed or trivially
    // short item, so a protect list can never be outvoted by the model.
    if (protect?.(item) || item.text.length < minChars) {
      decisions[index] = unjudgedKeep(item);
    } else {
      judged.push({ index, item });
    }
  }

  // One noul per item id, batched: sequential requests of at most
  // maxItemsPerRequest questions each. Each batch is its own askJev call.
  for (let offset = 0; offset < judged.length; offset += maxItemsPerRequest) {
    const batch = judged.slice(offset, offset + maxItemsPerRequest);
    const questions: Questions = {};
    for (const { item } of batch) {
      questions[item.id] = { type: "noul", instructions: needQuestion(item.kind) };
    }
    const response = await askJev(
      config,
      { items: batch.map(({ item }) => item) },
      questions,
      options?.signal,
    );
    for (const { index, item } of batch) {
      const score = readNeed(response, item.id);
      if (score === null) {
        // Missing/malformed answer → KEEP (fail-open; never read-as-zero).
        decisions[index] = unjudgedKeep(item);
        continue;
      }
      if (shouldDrop(score, item.kind, keepThreshold, dropThreshold, errorDropThreshold)) {
        // Drop returns a replacement; the caller keeps the original text.
        const omittedChars = Math.max(0, item.text.length - headChars);
        decisions[index] = {
          id: item.id,
          keep: false,
          score,
          chars: item.text.length,
          replacement:
            item.text.slice(0, headChars) +
            `\n[... ${omittedChars} chars omitted by jev prune; id=${item.id} — original retained by caller]`,
          omittedChars,
        };
      } else {
        // In-band (or at/above keep) reads always keep.
        decisions[index] = { id: item.id, keep: true, score, chars: item.text.length };
      }
    }
  }

  return { decisions, deferred: false };
}
