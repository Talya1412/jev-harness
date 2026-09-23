/** Human-readable rendering of an EvalReport. */
import type { EvalReport, QuestionMetrics } from "./run.js";

function pct(x: number | null | undefined): string {
  return x === null || x === undefined ? "—" : `${(100 * x).toFixed(1)}%`;
}

function num(x: number | null | undefined, digits = 3): string {
  return x === null || x === undefined ? "—" : x.toFixed(digits);
}

function questionLines(q: QuestionMetrics): string[] {
  const lines: string[] = [
    `${q.questionId} (${q.type}, ${q.scored} scored${q.skipped ? `, ${q.skipped} skipped` : ""})`,
  ];
  if (q.noul) {
    lines.push(
      `  accuracy ${pct(q.noul.accuracy)}  precision ${pct(q.noul.precision)}  recall ${pct(q.noul.recall)}  f1 ${pct(q.noul.f1)}`,
    );
    lines.push(`  brier ${num(q.noul.brier, 4)}  auc ${num(q.noul.auc)}  ece ${num(eceOf(q), 4)}`);
    if (q.noul.suggestedThreshold !== undefined) {
      lines.push(
        `  suggested threshold (max F1): ${q.noul.suggestedThreshold.toFixed(2)}  (f1 ${pct(q.sweep?.best.f1 ?? null)}, youdenJ ${num(q.sweep?.best.youdenJ ?? null, 3)})`,
      );
    }
    if (q.reliability) {
      const nonEmpty = q.reliability.filter((b) => b.count > 0);
      if (nonEmpty.length > 0) {
        lines.push(
          "  reliability: " +
            nonEmpty
              .map(
                (b) =>
                  `[${b.lo.toFixed(1)}–${b.hi.toFixed(1)}) n=${b.count} avgP=${b.avgP.toFixed(2)} avgY=${b.avgY.toFixed(2)}`,
              )
              .join(" | "),
        );
      }
    }
  }
  if (q.choice) {
    lines.push(
      `  top1 ${pct(q.choice.top1)}  brier ${num(q.choice.brier, 4)}  confidence ECE ${num(q.choice.confidenceEce, 4)}`,
    );
  }
  if (q.score) {
    lines.push(
      `  mae ${num(q.score.mae)}  within-1 ${pct(q.score.withinOne)}  pearson ${num(q.score.pearson)}`,
    );
  }
  return lines;
}

function eceOf(q: QuestionMetrics): number | null {
  if (!q.reliability || q.scored === 0) return null;
  return q.reliability.reduce((s, b) => s + (b.count / q.scored) * Math.abs(b.avgP - b.avgY), 0);
}

export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`Jev eval — ${report.totalCases} cases, model ${report.model}, ${report.generatedAt}`);
  lines.push(
    `  requests ${report.usage.requests}  input tokens ${report.usage.inputTokens}  output tokens ${report.usage.outputTokens}  est. cost $${report.usage.estimatedCostUsd.toFixed(6)}`,
  );
  lines.push("");
  for (const q of report.metrics) {
    lines.push(...questionLines(q));
    lines.push("");
  }
  if (report.errors.length > 0) {
    lines.push(`failures (${report.errors.length}):`);
    for (const e of report.errors.slice(0, 10)) lines.push(`  ${e.id}: ${e.message}`);
    if (report.errors.length > 10) lines.push(`  … and ${report.errors.length - 10} more`);
  } else {
    lines.push("failures: 0");
  }
  return lines.join("\n");
}
