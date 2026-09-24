import { describe, expect, it } from "vitest";
import { THRESHOLDS } from "../src/patterns.js";
import { escalateOnLowConfidence } from "../src/patterns-escalate.js";
import type { Answer, Questions } from "../src/types.js";

/**
 * Route every fetch to the next canned step, recording the parsed request
 * bodies. A step that is an Error is thrown (transport failure); a request
 * with no step left throws, so over-asking fails even when the outcome still
 * looks right.
 */
function jevStub(...steps: Array<Record<string, Answer> | Error>) {
  const seen: any[] = [];
  const fetchImpl = (async (_url: any, init: any) => {
    const body = JSON.parse(String(init.body));
    seen.push(body);
    const step = steps[seen.length - 1];
    if (step === undefined) {
      throw new Error(`unexpected extra request #${seen.length}`);
    }
    if (step instanceof Error) {
      throw step;
    }
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers: step }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const state = { task: "review" };

const choiceGateQuestions: Questions = {
  gate: {
    type: "choice",
    instructions: "Is the answer confident enough to act on?",
    criteria: { high: "confident", low: "a guess" },
  },
  verdict: { type: "noul", instructions: "Does the verdict hold?" },
};

const noulGateQuestions: Questions = {
  gate: { type: "noul", instructions: "Is the model confident in its answer?" },
  verdict: { type: "noul", instructions: "Does the verdict hold?" },
};

/**
 * First-pass answers. The `first-pass-marker` string rides ONLY in this
 * response — finding it in a request body would mean first answers were
 * echoed back as anchors on the escalation pass.
 */
const firstAnswers: Record<string, Answer> = {
  gate: {
    type: "choice",
    choice: "first-pass-marker",
    probabilities: { high: 0.4, low: 0.6 },
    confidence: 0.4,
  },
  verdict: { type: "noul", noul: 0.9 },
};

/** Second-pass answers, clearly distinguishable from the first pass. */
const secondAnswers: Record<string, Answer> = {
  gate: {
    type: "choice",
    choice: "high",
    probabilities: { high: 0.95, low: 0.05 },
    confidence: 0.95,
  },
  verdict: { type: "noul", noul: 0.1 },
};

describe("escalateOnLowConfidence", () => {
  it("accepted-confident-choice", async () => {
    const answers: Record<string, Answer> = {
      gate: {
        type: "choice",
        choice: "high",
        probabilities: { high: 0.85, low: 0.15 },
        confidence: 0.85,
      },
      verdict: { type: "noul", noul: 0.9 },
    };
    const { fetchImpl } = jevStub(answers);
    const r = await escalateOnLowConfidence(
      { apiKey: "k", fetchImpl },
      state,
      choiceGateQuestions,
      { gateQuestionId: "gate" },
    );
    expect(r.outcome).toBe("accepted");
    expect(r.escalated).toBe(false);
    expect(r.target).toBe("none");
    expect(r.gateScore).toBe(0.85);
    expect(r.threshold).toBe(THRESHOLDS.escalateBelow);
    expect(r.answers).toEqual(answers);
    expect(r.first).toEqual(answers);
    expect(r.second).toBeUndefined();
    expect(r.error).toBeUndefined();
  });

  it("accepted-noul-outside-band", async () => {
    // Above the band: p 0.9 > uncertainBandHigh 0.7 → determined.
    const above: Record<string, Answer> = {
      gate: { type: "noul", noul: 0.9 },
      verdict: { type: "noul", noul: 0.9 },
    };
    const s1 = jevStub(above);
    const r1 = await escalateOnLowConfidence(
      { apiKey: "k", fetchImpl: s1.fetchImpl },
      state,
      noulGateQuestions,
      { gateQuestionId: "gate" },
    );
    expect(r1.outcome).toBe("accepted");
    expect(r1.gateScore).toBe(0.9);
    expect(s1.seen).toHaveLength(1);

    // Below the band: p 0.05 < uncertainBandLow 0.3 → determined too.
    const below: Record<string, Answer> = {
      gate: { type: "noul", noul: 0.05 },
      verdict: { type: "noul", noul: 0.9 },
    };
    const s2 = jevStub(below);
    const r2 = await escalateOnLowConfidence(
      { apiKey: "k", fetchImpl: s2.fetchImpl },
      state,
      noulGateQuestions,
      { gateQuestionId: "gate" },
    );
    expect(r2.outcome).toBe("accepted");
    expect(r2.gateScore).toBe(0.05);
    expect(s2.seen).toHaveLength(1);
  });

  it("escalated-secondConfig", async () => {
    // Sanity: the anchor sentinel really is present in the first answers, so
    // the not.toContain below cannot pass vacuously if fixtures drift.
    expect(JSON.stringify(firstAnswers)).toContain("first-pass-marker");

    const { fetchImpl, seen } = jevStub(firstAnswers, secondAnswers);
    const r = await escalateOnLowConfidence(
      { apiKey: "k", fetchImpl },
      state,
      choiceGateQuestions,
      {
        gateQuestionId: "gate",
        secondConfig: { apiKey: "k2", model: "jev-second", fetchImpl },
      },
    );
    expect(r.outcome).toBe("escalated");
    expect(r.escalated).toBe(true);
    expect(r.target).toBe("second-config");
    expect(r.gateScore).toBe(0.4);
    expect(r.answers).toEqual(secondAnswers);
    expect(r.second).toEqual(secondAnswers);
    expect(r.first).toEqual(firstAnswers);
    expect(r.error).toBeUndefined();

    // Exactly one escalation: two requests total, no loops.
    expect(seen).toHaveLength(2);
    // The second request re-asks the SAME questions…
    expect(seen[1].questions).toEqual(seen[0].questions);
    expect(seen[1].state).toEqual(seen[0].state);
    // …from the secondConfig (its model, not the first pass's)…
    expect(seen[1].model).toBe("jev-second");
    // …and carries NO first answers: anchor-free (SDE re-extraction).
    expect(JSON.stringify(seen[1])).not.toContain("first-pass-marker");
  });

  it("escalated-fallback", async () => {
    const { fetchImpl, seen } = jevStub(firstAnswers);
    let received: Record<string, Answer> | undefined;
    const r = await escalateOnLowConfidence(
      { apiKey: "k", fetchImpl },
      state,
      choiceGateQuestions,
      {
        gateQuestionId: "gate",
        fallback: async (first) => {
          received = first;
          return secondAnswers;
        },
      },
    );
    expect(received).toEqual(firstAnswers);
    expect(r.outcome).toBe("escalated");
    expect(r.escalated).toBe(true);
    expect(r.target).toBe("fallback");
    expect(r.answers).toEqual(secondAnswers);
    expect(r.second).toEqual(secondAnswers);
    expect(r.first).toEqual(firstAnswers);
    // The fallback replaces a transport second pass: only ONE fetch total.
    expect(seen).toHaveLength(1);
  });

  it("unresolved-missing-gate", async () => {
    // The response omits the gate id entirely.
    const partial: Record<string, Answer> = {
      verdict: { type: "noul", noul: 0.9 },
    };
    // A secondConfig is offered on purpose: a missing gate must short-circuit
    // BEFORE target selection, so no escalation request may go out.
    const { fetchImpl, seen } = jevStub(partial);
    const r = await escalateOnLowConfidence(
      { apiKey: "k", fetchImpl },
      state,
      choiceGateQuestions,
      { gateQuestionId: "gate", secondConfig: { apiKey: "k2", fetchImpl } },
    );
    expect(r.outcome).toBe("unresolved");
    expect(r.error).toBe("gate-question-missing");
    expect(r.answers).toEqual(partial);
    expect(r.first).toEqual(partial);
    expect(r.gateScore).toBe(0);
    expect(r.target).toBe("none");
    expect(r.escalated).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it("unresolved-no-target", async () => {
    // p 0.7 is INSIDE the default band (inclusive high edge) → uncertain,
    // but neither secondConfig nor fallback exists.
    const answers: Record<string, Answer> = {
      gate: { type: "noul", noul: 0.7 },
      verdict: { type: "noul", noul: 0.9 },
    };
    const { fetchImpl, seen } = jevStub(answers);
    const r = await escalateOnLowConfidence({ apiKey: "k", fetchImpl }, state, noulGateQuestions, {
      gateQuestionId: "gate",
    });
    expect(r.outcome).toBe("unresolved");
    expect(r.error).toBe("no-escalation-target");
    expect(r.gateScore).toBe(0.7);
    expect(r.answers).toEqual(answers);
    expect(r.first).toEqual(answers);
    expect(r.target).toBe("none");
    expect(r.escalated).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it("unresolved-second-throws-first-survives", async () => {
    const { fetchImpl, seen } = jevStub(firstAnswers, new Error("second-pass exploded"));
    const r = await escalateOnLowConfidence(
      { apiKey: "k", fetchImpl },
      state,
      choiceGateQuestions,
      { gateQuestionId: "gate", secondConfig: { apiKey: "k2", fetchImpl } },
    );
    expect(r.outcome).toBe("unresolved");
    expect(r.error).toBe("second-pass exploded");
    // The first result survives the failed escalation untouched.
    expect(r.answers).toEqual(firstAnswers);
    expect(r.first).toEqual(firstAnswers);
    expect(r.second).toBeUndefined();
    expect(r.escalated).toBe(false);
    expect(r.target).toBe("second-config");
    // The attempt was made exactly once…
    expect(seen).toHaveLength(2);
    // …and was anchor-free even though it failed.
    expect(JSON.stringify(seen[1])).not.toContain("first-pass-marker");
    expect(seen[1].questions).toEqual(seen[0].questions);
  });

  it("threshold/band-override", async () => {
    // (a1) threshold override: confidence 0.85 < 0.9 → escalate, where the
    // default 0.6 would have accepted.
    const a1: Record<string, Answer> = {
      gate: {
        type: "choice",
        choice: "high",
        probabilities: { high: 0.85, low: 0.15 },
        confidence: 0.85,
      },
      verdict: { type: "noul", noul: 0.9 },
    };
    const s1 = jevStub(a1);
    const r1 = await escalateOnLowConfidence(
      { apiKey: "k", fetchImpl: s1.fetchImpl },
      state,
      choiceGateQuestions,
      {
        gateQuestionId: "gate",
        threshold: 0.9,
        fallback: async () => secondAnswers,
      },
    );
    expect(r1.outcome).toBe("escalated");
    expect(r1.threshold).toBe(0.9);
    expect(r1.gateScore).toBe(0.85);

    // (a2) strict "<": confidence exactly AT the threshold is not uncertain.
    const a2: Record<string, Answer> = {
      gate: {
        type: "choice",
        choice: "high",
        probabilities: { high: 0.9, low: 0.1 },
        confidence: 0.9,
      },
      verdict: { type: "noul", noul: 0.9 },
    };
    const s2 = jevStub(a2);
    const r2 = await escalateOnLowConfidence(
      { apiKey: "k", fetchImpl: s2.fetchImpl },
      state,
      choiceGateQuestions,
      { gateQuestionId: "gate", threshold: 0.9 },
    );
    expect(r2.outcome).toBe("accepted");

    // (b1) band override: p 0.35 is inside the DEFAULT band [0.3, 0.7] but
    // outside the custom [0.4, 0.6] → accepted only if the override applies.
    const b1: Record<string, Answer> = {
      gate: { type: "noul", noul: 0.35 },
      verdict: { type: "noul", noul: 0.9 },
    };
    const s3 = jevStub(b1);
    const r3 = await escalateOnLowConfidence(
      { apiKey: "k", fetchImpl: s3.fetchImpl },
      state,
      noulGateQuestions,
      { gateQuestionId: "gate", band: [0.4, 0.6] },
    );
    expect(r3.outcome).toBe("accepted");
    expect(r3.gateScore).toBe(0.35);

    // (b2) inclusive low edge: p exactly at band[0] is uncertain → escalate.
    const b2: Record<string, Answer> = {
      gate: { type: "noul", noul: 0.4 },
      verdict: { type: "noul", noul: 0.9 },
    };
    const s4 = jevStub(b2);
    const r4 = await escalateOnLowConfidence(
      { apiKey: "k", fetchImpl: s4.fetchImpl },
      state,
      noulGateQuestions,
      { gateQuestionId: "gate", band: [0.4, 0.6], fallback: async () => secondAnswers },
    );
    expect(r4.outcome).toBe("escalated");
    expect(r4.gateScore).toBe(0.4);
    expect(r4.answers).toEqual(secondAnswers);
  });

  it("single-request-when-accepted", async () => {
    const answers: Record<string, Answer> = {
      gate: {
        type: "choice",
        choice: "high",
        probabilities: { high: 0.85, low: 0.15 },
        confidence: 0.85,
      },
      verdict: { type: "noul", noul: 0.9 },
    };
    const { fetchImpl, seen } = jevStub(answers);
    const r = await escalateOnLowConfidence(
      { apiKey: "k", fetchImpl },
      state,
      choiceGateQuestions,
      { gateQuestionId: "gate" },
    );
    expect(r.outcome).toBe("accepted");
    // ONE batched request carried every question, and nothing followed it.
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0].questions)).toEqual(["gate", "verdict"]);
  });
});
