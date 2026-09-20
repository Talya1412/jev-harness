/**
 * Run a labeled dataset through Jev and compute per-question metrics.
 *
 * Every case is ONE batched request (all questions ride together), cases run
 * with bounded concurrency, and a failing case never aborts the run — it is
 * recorded and surfaced in the report instead.
 */
import { askJev, type JevConfig, type JevResponse } from "@jev-harness/core";
import { labelToBinary, labelToScoreIndex, type EvalDataset } from "./dataset.js";
import {
  binaryMetrics,
  choiceMetrics,
  reliabilityBins,
  scoreMetrics,
  thresholdSweep,
  type BinaryPair,
  type BinaryMetrics,
  type ChoiceMetrics,
  type ChoiceRow,
  type ReliabilityBin,
  type ScoreMetrics,
  type ScoreRow,
  type SweepRow,
} from "./metrics.js";

/**
 * Jev input pricing ($/Mtok) used for the cost estimate in reports.
 * Single source of truth — scripts/record-baseline.mjs imports this too.
 * Output is free ($0), so only input tokens feed the estimate.
 */
export const INPUT_USD_PER_MTOK = 0.042;
export const OUTPUT_USD_PER_MTOK = 0;

/** Cost estimate for a run: input tokens are billed, output tokens are free. */
export function estimateCostUsd(inputTokens: number, _outputTokens = 0): number {
  return (inputTokens * INPUT_USD_PER_MTOK + _outputTokens * OUTPUT_USD_PER_MTOK) / 1_000_000;
}

export interface EvalOptions {
  /** Parallel cases in flight. Default 4. */
  concurrency?: number;
  signal?: AbortSignal;
  /** Include the threshold sweep for noul questions. Default true. */
  sweep?: boolean;
  /** Sweep resolution. Default 20 (thresholds 0, 0.05, …, 1). */
  sweepSteps?: number;
}

export interface QuestionMetrics {
  questionId: string;
  type: "noul" | "choice" | "score";
  /** Cases that produced a usable score/answer. */
  scored: number;
  /** OK cases excluded because the label was missing or not coercible. */
  skipped: number;
  noul?: BinaryMetrics & { suggestedThreshold?: number };
  reliability?: ReliabilityBin[];
  sweep?: { rows: SweepRow[]; best: SweepRow };
  choice?: ChoiceMetrics;
  score?: ScoreMetrics;
}

export interface EvalReport {
  model: string;
  totalCases: number;
  failedCases: number;
  generatedAt: string;
  usage: { requests: number; inputTokens: number; outputTokens: number; estimatedCostUsd: number };
  metrics: QuestionMetrics[];
  errors: Array<{ id: string; message: string }>;
}

export async function runEval(config: JevConfig, dataset: EvalDataset, opts: EvalOptions = {}): Promise<EvalReport> {
  if (!dataset.questions || Object.keys(dataset.questions).length === 0) {
    throw new Error("dataset has no questions — add a \"questions\" map or pass --questions");
  }

  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const cases = dataset.cases;
  const results: Array<{ ok: boolean; response?: JevResponse; error?: string }> = new Array(cases.length);

  // An aborted run must not masquerade as N case errors with a full report.
  if (opts.signal?.aborted) {
    throw new Error("eval run aborted before any case started");
  }
  let cursor = 0;
  let aborted = false;
  const worker = async (): Promise<void> => {
    while (cursor < cases.length) {
      if (opts.signal?.aborted) {
        aborted = true;
        return;
      }
      const index = cursor++;
      const kase = cases[index]!;
      try {
        results[index] = { ok: true, response: await askJev(config, kase.state, dataset.questions, opts.signal) };
      } catch (err) {
        results[index] = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(cases.length, 1)) }, worker));
  if (aborted || opts.signal?.aborted) {
    throw new Error("eval run aborted");
  }

  const errors: EvalReport["errors"] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let requests = 0;
  for (let i = 0; i < cases.length; i++) {
    const r = results[i]!;
    // Every dispatched case is one askJev attempt, ok or failed.
    requests++;
    if (r.ok && r.response) {
      inputTokens += r.response.usage?.input_tokens ?? 0;
      outputTokens += r.response.usage?.output_tokens ?? 0;
    } else {
      errors.push({ id: cases[i]!.id, message: r.error ?? "unknown error" });
    }
  }

  const metrics: QuestionMetrics[] = [];
  for (const [questionId, question] of Object.entries(dataset.questions)) {
    const base: QuestionMetrics = { questionId, type: question.type, scored: 0, skipped: 0 };

    if (question.type === "noul") {
      const pairs: BinaryPair[] = [];
      for (let i = 0; i < cases.length; i++) {
        const r = results[i]!;
        if (!r.ok || !r.response) continue;
        const p = r.response.answers[questionId];
        const y = labelToBinary(cases[i]!.label[questionId]);
        if (!p || p.type !== "noul" || y === null) {
          base.skipped++;
          continue;
        }
        pairs.push({ p: p.noul, y });
      }
      base.scored = pairs.length;
      const m = binaryMetrics(pairs);
      base.noul = { ...m };
      if (pairs.length > 0) {
        base.reliability = reliabilityBins(pairs);
        if (opts.sweep !== false) {
          const sweep = thresholdSweep(pairs, { steps: opts.sweepSteps ?? 20 });
          base.sweep = sweep;
          base.noul.suggestedThreshold = sweep.best.threshold;
        }
      }
    } else if (question.type === "choice") {
      const rows: ChoiceRow[] = [];
      for (let i = 0; i < cases.length; i++) {
        const r = results[i]!;
        if (!r.ok || !r.response) continue;
        const a = r.response.answers[questionId];
        const truth = cases[i]!.label[questionId];
        if (!a || a.type !== "choice" || typeof truth !== "string") {
          base.skipped++;
          continue;
        }
        rows.push({ probabilities: a.probabilities ?? {}, picked: a.choice, truth });
      }
      base.scored = rows.length;
      base.choice = choiceMetrics(rows);
    } else {
      const rows: ScoreRow[] = [];
      for (let i = 0; i < cases.length; i++) {
        const r = results[i]!;
        if (!r.ok || !r.response) continue;
        const a = r.response.answers[questionId];
        const truthIndex = labelToScoreIndex(cases[i]!.label[questionId], question.criteria);
        if (!a || a.type !== "score" || truthIndex === null) {
          base.skipped++;
          continue;
        }
        rows.push({ score: a.score, truthIndex, maxIndex: question.criteria.length - 1 });
      }
      base.scored = rows.length;
      base.score = scoreMetrics(rows);
    }
    metrics.push(base);
  }

  return {
    model: config.model ?? "jev-latest",
    totalCases: cases.length,
    failedCases: errors.length,
    generatedAt: new Date().toISOString(),
    usage: {
      requests,
      inputTokens,
      outputTokens,
      estimatedCostUsd: estimateCostUsd(inputTokens, outputTokens),
    },
    metrics,
    errors,
  };
}
