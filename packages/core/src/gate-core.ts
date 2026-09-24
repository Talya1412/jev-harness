/**
 * Transport plumbing shared by the paired pattern entry points: the injection
 * pair (`gateInjection` in ./patterns.js, `detectPromptInjection` in
 * ./patterns-extra.js) and the semantic-dedup pair (`isDuplicate` in
 * ./patterns.js, `dedupeItems` in ./patterns-ops.js).
 *
 * Deliberately NOT exported from the package index — external callers use the
 * pattern functions, not these helpers.
 *
 * @internal
 */
import { askJev, noul, type JevConfig } from "./client.js";

/**
 * The transport-and-read core shared by the two injection entry points
 * (`gateInjection` here, `detectPromptInjection` in ./patterns-extra.js):
 * build one noul question, spend ONE request, read the answer, compare it
 * against the caller's own threshold.
 *
 * The parts that genuinely differ between those two functions — the state
 * shape, the truncation limits, the prompt wording, and the threshold value
 * — deliberately stay with the caller. Only the plumbing is shared.
 *
 * A missing or malformed answer raises a JevError, exactly as `noul` always
 * has for these two gates: a screen that silently scored an unreadable
 * response 0 would report "safe" for a call it never got to judge. (The
 * dedup pair differs here on purpose — see `scoreQuestions`.)
 *
 * @internal
 */
export async function booleanGate(
  config: JevConfig,
  state: Record<string, unknown>,
  instructions: string,
  threshold: number,
  questionId: string,
  signal?: AbortSignal,
): Promise<{ probability: number; flagged: boolean }> {
  const response = await askJev(
    config,
    state,
    { [questionId]: { type: "noul", instructions } },
    signal,
  );
  const probability = noul(response, questionId);
  return { probability, flagged: probability >= threshold };
}

/**
 * How a scored question that Jev did not answer (or answered in the wrong
 * shape) is read.
 *
 * `zero` keeps the candidate with probability 0 — right for a broad
 * similarity sweep, where one unreadable row should not fail the batch.
 * `throw` surfaces the JevError — right when the caller must not silently
 * treat "no judgment" as a verdict. The two dedup entry points differ this
 * way on purpose, so the policy is a required argument rather than a
 * default that could be "tidied" into agreement.
 *
 * @internal
 */
export type MissingAnswerPolicy = "zero" | "throw";

/**
 * The transport-and-read core shared by the two semantic-dedup entry points
 * (`isDuplicate` here, `dedupeItems` in ./patterns-ops.js): turn a
 * question-id → instructions map into ONE request, then read one probability
 * per id.
 *
 * The parts that genuinely differ between the two callers — the state shape,
 * the question ids (`dup_i` vs `d{i}`), the caps, the per-question wording,
 * the threshold, and the missing-answer policy — stay with the caller.
 *
 * @internal
 */
export async function scoreQuestions(
  config: JevConfig,
  state: Record<string, unknown>,
  instructions: Record<string, string>,
  signal: AbortSignal | undefined,
  missing: MissingAnswerPolicy,
): Promise<Record<string, number>> {
  const questions: Record<string, { type: "noul"; instructions: string }> = {};
  for (const [id, text] of Object.entries(instructions)) {
    questions[id] = { type: "noul", instructions: text };
  }
  const response = await askJev(config, state, questions, signal);
  const probabilities: Record<string, number> = {};
  for (const id of Object.keys(instructions)) {
    if (missing === "throw") {
      probabilities[id] = noul(response, id);
    } else {
      const answer = response.answers[id];
      probabilities[id] = answer && answer.type === "noul" ? answer.noul : 0;
    }
  }
  return probabilities;
}
