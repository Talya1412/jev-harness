/**
 * Pure logic for the `jev-tune` CLI: arg parsing, dataset loading, and report
 * formatting. The I/O entrypoint (`./cli.js`) wires this to stdin/stdout/exit
 * so the logic is testable without a process.
 */
import type { TuneObjective, TuneSummary } from "./tune.js";

export interface TuneOptions {
  objective: TuneObjective;
  file?: string;
  json: boolean;
  help: boolean;
}

export type ParseResult = { ok: true; options: TuneOptions } | { ok: false; error: string };

function defaultOptions(): TuneOptions {
  return { objective: "f1", json: false, help: false };
}

export function parseArgs(argv: readonly string[]): ParseResult {
  const options = defaultOptions();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "-f":
      case "--file": {
        const raw = argv[++i];
        if (raw === undefined || raw.trim() === "")
          return { ok: false, error: arg + " requires a path" };
        options.file = raw;
        break;
      }
      case "--json":
        options.json = true;
        break;
      case "-o":
      case "--objective": {
        const raw = argv[++i];
        if (raw === undefined) return { ok: false, error: arg + " requires a value" };
        if (raw !== "f1" && raw !== "youden") {
          return { ok: false, error: arg + " must be 'f1' or 'youden', got '" + raw + "'" };
        }
        options.objective = raw;
        break;
      }
      default:
        return { ok: false, error: "unknown option '" + arg + "'" };
    }
  }
  return { ok: true, options };
}

export interface Sample {
  p: number;
  y: boolean;
}

export type DatasetResult = { ok: true; samples: Sample[] } | { ok: false; error: string };

/** Read a probability from any reasonable key. */
function readPrediction(obj: Record<string, unknown>): number | undefined {
  for (const k of ["p", "prediction", "prob", "probability", "score"]) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** Read an outcome as a boolean from any reasonable key/shape. */
function readOutcome(obj: Record<string, unknown>): boolean | undefined {
  let raw: unknown;
  for (const k of ["y", "outcome", "label", "actual", "target"]) {
    if (obj[k] !== undefined) {
      raw = obj[k];
      break;
    }
  }
  if (raw === undefined) return undefined;
  if (typeof raw === "boolean") return raw;
  if (
    raw === 1 ||
    raw === "1" ||
    raw === "true" ||
    raw === "yes" ||
    raw === "pos" ||
    raw === "positive"
  )
    return true;
  if (
    raw === 0 ||
    raw === "0" ||
    raw === "false" ||
    raw === "no" ||
    raw === "neg" ||
    raw === "negative"
  )
    return false;
  return undefined;
}

/**
 * Load a dataset from text. Accepts either a JSON array of objects or JSONL
 * (one object per line, blank lines ignored). Each object needs a numeric
 * probability and a boolean-ish outcome; the keys are forgiving.
 */
export function loadDataset(text: string): DatasetResult {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, error: "no data: stdin/file is empty" };

  let records: Record<string, unknown>[] = [];
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      return {
        ok: false,
        error: "invalid JSON array: " + (err instanceof Error ? err.message : String(err)),
      };
    }
    if (!Array.isArray(parsed)) return { ok: false, error: "JSON must be an array" };
    records = parsed as Record<string, unknown>[];
  } else {
    for (const line of trimmed.split(/\r?\n/)) {
      const l = line.trim();
      if (l === "") continue;
      if (l.startsWith("#")) continue;
      try {
        records.push(JSON.parse(l) as Record<string, unknown>);
      } catch (err) {
        return {
          ok: false,
          error:
            "invalid JSONL line '" +
            l.slice(0, 60) +
            "': " +
            (err instanceof Error ? err.message : String(err)),
        };
      }
    }
  }

  if (records.length === 0) return { ok: false, error: "no samples found" };

  const samples: Sample[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    const p = readPrediction(rec);
    const y = readOutcome(rec);
    if (p === undefined)
      return { ok: false, error: "sample " + i + " is missing a numeric probability" };
    if (y === undefined) return { ok: false, error: "sample " + i + " is missing an outcome" };
    if (p < 0 || p > 1)
      return { ok: false, error: "sample " + i + " probability " + p + " is outside [0,1]" };
    samples.push({ p, y });
  }
  return { ok: true, samples };
}

/** Human-readable report (or JSON when `json` is set). */
export function formatSummary(summary: TuneSummary, json: boolean): string {
  if (json) return JSON.stringify(summary, null, 2);
  const b = summary.atBest;
  const lines = [
    "jev-tune  threshold sweep",
    "",
    "data      n=" +
      summary.n +
      "  positives=" +
      summary.positives +
      "  (" +
      pct(summary.positives, summary.n) +
      ")",
    "objective " + summary.objective + "  ->  best threshold = " + summary.bestThreshold.toFixed(3),
    "",
    "at best   precision=" + num(b.precision) + "  recall=" + num(b.recall) + "  f1=" + num(b.f1),
    "          tp=" + b.tp + "  fp=" + b.fp + "  fn=" + b.fn + "  tn=" + b.tn,
    "",
    "calibration",
    "  brier   " + summary.brier.toFixed(4) + "    (lower is better; 0 is perfect)",
    "  ece     " + summary.ece.toFixed(4) + "    (lower is better)",
    "  rocAuc  " + num(summary.rocAuc, "n/a") + "    (0.5 = chance, 1 = perfect ranking)",
    "  prAuc   " + num(summary.prAuc, "n/a") + "    (better than ROC AUC on imbalanced data)",
    "",
    "top thresholds (best-first)",
  ];
  for (const row of summary.sweep.slice(0, 5)) {
    lines.push(
      "  t=" +
        row.threshold.toFixed(3) +
        "  f1=" +
        num(row.f1) +
        "  p=" +
        num(row.precision) +
        "  r=" +
        num(row.recall),
    );
  }
  return lines.join("\n");
}

/** Format a nullable metric; falls back to `fallback` for null. */
function num(v: number | null, fallback = "n/a"): string {
  return v === null ? fallback : v.toFixed(3);
}

function pct(n: number, total: number): string {
  if (total === 0) return "0%";
  return ((n / total) * 100).toFixed(1) + "%";
}

export const HELP = `Usage: jev-tune [options]

Tune a Jev decision threshold against a labeled dataset. Reads (p, y) pairs
from stdin or --file, sweeps thresholds, and reports the best one plus
calibration metrics (Brier, ECE, ROC AUC, PR AUC).

Dataset formats:
  JSONL      one object per line: {"p": 0.82, "y": true}
  JSON array [{"p":0.2,"y":false}, {"p":0.9,"y":true}]
Keys: probability is p | prediction | prob | probability | score;
      outcome is y | outcome | label | actual | target (bool or 0/1).

Options:
  -f, --file <path>     Read the dataset from a file (default: stdin)
  -o, --objective <o>    'f1' (default) or 'youden' (TPR-FPR)
      --json            Print the summary as JSON
  -h, --help            Show this message

Examples:
  cat labels.jsonl | jev-tune
  jev-tune -f eval.jsonl --json
  jev-tune -o youden < destructive-labels.jsonl
`;
