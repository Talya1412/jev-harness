/**
 * Confidence escalation — re-ask once when Jev's own gate says the answer is
 * too uncertain to act on. Decision logic only; adapters stay thin.
 */
import { askJev, type Answer, type JevConfig, type Questions } from "./client.js";
import { THRESHOLDS } from "./patterns.js";

/**
 * What one gate question's answer gives us to read.
 *
 * The two uncertain tests differ because the primitives differ: a noul answer
 * carries only a probability (so "inside the band" is the only uncertainty
 * signal), while choice/score answers carry an explicit confidence.
 */
interface GateRead {
  kind: "noul" | "confidence";
  score: number;
}

/**
 * Tolerant gate reader: return the gate's score, or null when the gate id is
 * absent OR its answer is not a readable primitive.
 *
 * This deliberately does NOT use client.ts's `noul()`/`choice()` readers —
 * those throw on a missing/malformed answer by design, and here an unreadable
 * gate must degrade to `unresolved` + `error: "gate-question-missing"` with
 * the first answers preserved, never an exception (the missing/malformed pair
 * is treated as one "no readable gate judgment" case, same as elsewhere in
 * core: see prune's missing/malformed → keep rule in the plan).
 *
 * @internal
 */
function readGate(first: Record<string, Answer>, id: string): GateRead | null {
  const answer = first[id];
  if (!answer) return null;
  switch (answer.type) {
    case "noul":
      return { kind: "noul", score: answer.noul };
    case "choice":
    case "score":
      return { kind: "confidence", score: answer.confidence };
    default:
      // A future primitive with no readable score behaves as "no reading".
      return null;
  }
}

/** Message of an escalation-side failure, for `EscalationResult.error`. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What the caller should act on: `second`'s answers when escalated, otherwise the preserved first pass. */
export type EscalationOutcome = "accepted" | "escalated" | "unresolved";

export interface EscalationResult {
  /** `accepted` = first pass decided; `escalated` = the escalation pass took over; `unresolved` = no decision, see `error`. */
  outcome: EscalationOutcome;
  /** What the caller should act on: second's answers when escalated, otherwise the preserved first pass. */
  answers: Record<string, Answer>;
  /** Preserved first pass — always present, even when escalation fails. */
  first: Record<string, Answer>;
  /** The escalation pass's answers (secondConfig transport or fallback output); present iff one succeeded. */
  second?: Record<string, Answer>;
  /**
   * Gate reading: the noul probability or the choice/score confidence.
   * `0` is the documented no-reading sentinel for a missing/malformed gate —
   * `outcome: "unresolved"` + `error: "gate-question-missing"` carry the real
   * state (same convention as skillRouting's `confidence: 0` on no skill).
   */
  gateScore: number;
  /**
   * The resolved choice/score threshold in effect. Noul gates decide by the
   * band instead; the locked result shape has no band field, so the band is
   * not echoed (it is the caller's own `options.band` / THRESHOLDS default).
   */
  threshold: number;
  /** Which escalation target was used; `"none"` when accepted or never selected. */
  target: "second-config" | "fallback" | "none";
  /** True iff `outcome === "escalated"`. */
  escalated: boolean;
  /**
   * Present iff `outcome === "unresolved"`: `"gate-question-missing"`,
   * `"no-escalation-target"`, or the escalation-side error's message.
   */
  error?: string;
}

/**
 * ONE batched first pass, then at most ONE escalation when the gate says the
 * answer is too uncertain to act on.
 *
 * Evidence:
 * - Vendor confidence-routing routes decisions below 0.6 confidence to a
 *   human — a model that reports its own low confidence should have that
 *   uncertainty acted on, not swallowed. That is `THRESHOLDS.escalateBelow`
 *   for choice/score gates.
 * - The escalation pass follows the SDE recipe: re-extract from the ORIGINAL
 *   input — same state, same questions — passing NO first answers or
 *   probabilities. A second pass seeded with the first pass's numbers is
 *   anchored to them and stops being an independent second opinion, so the
 *   second request is anchor-free by construction.
 *
 * PROVENANCE: the band and threshold defaults come from `THRESHOLDS`
 * (`escalateBelow`, `uncertainBandLow`, `uncertainBandHigh`) and are
 * PROVISIONAL there — vendor-cited, never locally measured. Read their
 * provenance comments and tune against your own outcomes before relying on
 * them; `options.threshold`/`options.band` override per call.
 *
 * Decision table:
 * - ONE batched first `askJev` (state + questions; the gate question is one
 *   of `questions`).
 * - Gate read: `noul` → `gateScore = p`, uncertain iff `band[0] <= p <=
 *   band[1]`; `choice`/`score` → `gateScore = confidence`, uncertain iff
 *   `< threshold`. Gate id absent (or unreadable) → `unresolved`,
 *   `error: "gate-question-missing"`, first answers still returned.
 * - Not uncertain → `accepted`.
 * - Uncertain → target priority: `secondConfig` (re-asks the SAME questions,
 *   anchor-free), else `fallback(first)`, else `unresolved` +
 *   `error: "no-escalation-target"`.
 * - Second-pass transport error → `unresolved` with `error`, `first`
 *   preserved (escalation failure never loses the first result).
 * - Exactly one escalation attempt (no loops).
 *
 * Fail-open contract: every escalation-side problem — second transport
 * error, a rejecting `fallback` — degrades to `unresolved` with the first
 * answers preserved; this function never throws on them. Only a FIRST-pass
 * transport error propagates: there is no first result to preserve yet, and
 * the repo contract is that callers wrap the first pass with `withFailMode`.
 */
export async function escalateOnLowConfidence(
  config: JevConfig,
  state: unknown,
  questions: Questions,
  options: {
    gateQuestionId: string;
    /** choice/score gate; default THRESHOLDS.escalateBelow (PROVISIONAL). */
    threshold?: number;
    /** noul gate; default [THRESHOLDS.uncertainBandLow, THRESHOLDS.uncertainBandHigh] (PROVISIONAL). */
    band?: [number, number];
    secondConfig?: JevConfig;
    fallback?: (first: Record<string, Answer>) => Promise<Record<string, Answer>>;
    signal?: AbortSignal;
  },
): Promise<EscalationResult> {
  const threshold = options.threshold ?? THRESHOLDS.escalateBelow;
  const band: [number, number] = options.band ?? [
    THRESHOLDS.uncertainBandLow,
    THRESHOLDS.uncertainBandHigh,
  ];

  // ONE batched first pass. A transport failure here MAY propagate — callers
  // wrap with withFailMode (repo contract); there is no first result yet.
  const firstResponse = await askJev(config, state, questions, options.signal);
  const first = firstResponse.answers;

  // Gate id absent / answer unreadable → unresolved, first preserved.
  const gate = readGate(first, options.gateQuestionId);
  if (!gate) {
    return {
      outcome: "unresolved",
      answers: first,
      first,
      gateScore: 0, // documented no-reading sentinel; outcome+error carry the state
      threshold,
      target: "none",
      escalated: false,
      error: "gate-question-missing",
    };
  }

  // Uncertain test: noul → uncertainty BAND (inside, inclusive); choice/score
  // → confidence STRICTLY below the threshold.
  const uncertain =
    gate.kind === "noul" ? gate.score >= band[0] && gate.score <= band[1] : gate.score < threshold;

  if (!uncertain) {
    return {
      outcome: "accepted",
      answers: first,
      first,
      gateScore: gate.score,
      threshold,
      target: "none",
      escalated: false,
    };
  }

  // Uncertain → exactly one escalation attempt, target priority
  // secondConfig → fallback → none.

  if (options.secondConfig) {
    try {
      // Anchor-free re-ask (SDE recipe): SAME state, SAME questions, NO first
      // answers or probabilities passed.
      const secondResponse = await askJev(options.secondConfig, state, questions, options.signal);
      const second = secondResponse.answers;
      return {
        outcome: "escalated",
        answers: second,
        first,
        second,
        gateScore: gate.score,
        threshold,
        target: "second-config",
        escalated: true,
      };
    } catch (err) {
      // Escalation failure never loses the first result.
      return {
        outcome: "unresolved",
        answers: first,
        first,
        gateScore: gate.score,
        threshold,
        target: "second-config",
        escalated: false,
        error: errorMessage(err),
      };
    }
  }

  if (options.fallback) {
    try {
      const second = await options.fallback(first);
      return {
        outcome: "escalated",
        answers: second,
        first,
        second,
        gateScore: gate.score,
        threshold,
        target: "fallback",
        escalated: true,
      };
    } catch (err) {
      // A rejecting fallback is escalation-side too: unresolved, first kept.
      return {
        outcome: "unresolved",
        answers: first,
        first,
        gateScore: gate.score,
        threshold,
        target: "fallback",
        escalated: false,
        error: errorMessage(err),
      };
    }
  }

  return {
    outcome: "unresolved",
    answers: first,
    first,
    gateScore: gate.score,
    threshold,
    target: "none",
    escalated: false,
    error: "no-escalation-target",
  };
}
