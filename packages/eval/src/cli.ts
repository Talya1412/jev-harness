#!/usr/bin/env node
/**
 * jev-eval CLI — run a labeled dataset through Jev and print calibration.
 *
 *   TYPESAFE_API_KEY=... jev-eval --dataset cases.jsonl
 *   jev-eval --dataset cases.json --questions questions.json --out report.json
 *
 * The argument parsing and run logic live here as an importable function so
 * the unified `jev` CLI (@jev-harness/cli) can delegate `jev eval` to it;
 * ./bin.js is the thin executable entry.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_BASE_URL, DEFAULT_MODEL, type Questions } from "@jev-harness/core";
import { loadDataset } from "./dataset.js";
import { runEval } from "./run.js";
import { formatReport } from "./report.js";

interface CliArgs {
  dataset?: string;
  questions?: string;
  out?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  concurrency?: number;
  sweepSteps?: number;
  noSweep?: boolean;
  help?: boolean;
}

const USAGE = `jev-eval — evaluate Jev questions against a labeled dataset

Usage:
  jev-eval --dataset <cases.json|cases.jsonl> [options]

Options:
  --dataset <path>      Labeled dataset (required). JSON: { questions, cases } or [cases].
                        JSONL: one { state, label } per line; lines may carry "questions".
  --questions <path>    JSON question map, merged under any per-line questions.
  --out <path>          Also write the full report as JSON.
  --model <name>        Jev model (default ${DEFAULT_MODEL}).
  --base-url <url>      API base override (default ${DEFAULT_BASE_URL}).
  --timeout-ms <n>      Per-request timeout (default 15000).
  --concurrency <n>     Cases in flight (default 4).
  --no-sweep            Skip the threshold sweep for noul questions.
  --sweep-steps <n>     Sweep resolution (default 20).
  -h, --help            Show this help.

Labels: noul -> true/false or "yes"/"no"; choice -> criteria key; score -> level name or 0-based index.`;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => argv[++i];
    switch (flag) {
      case "--dataset": args.dataset = next(); break;
      case "--questions": args.questions = next(); break;
      case "--out": args.out = next(); break;
      case "--model": args.model = next(); break;
      case "--base-url": args.baseUrl = next(); break;
      case "--timeout-ms": args.timeoutMs = Number(next()); break;
      case "--concurrency": args.concurrency = Number(next()); break;
      case "--sweep-steps": args.sweepSteps = Number(next()); break;
      case "--no-sweep": args.noSweep = true; break;
      case "-h": case "--help": args.help = true; break;
      default: throw new Error(`unknown flag: ${flag} (see --help)`);
    }
  }
  return args;
}

/**
 * Run the eval CLI against the given argv (no process.argv / process.exit
 * side effects except explicit usage-error exits). Throws on failure; the
 * caller decides how to surface it.
 */
export async function runEvalCli(argv: string[]): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }

  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (!args.dataset) {
    console.error("--dataset is required (see --help)");
    process.exit(2);
  }

  const apiKey = (process.env.TYPESAFE_API_KEY ?? "").trim();
  if (!apiKey) {
    console.error("TYPESAFE_API_KEY is not set. Export it or run with it in the environment.");
    process.exit(2);
  }

  const dataset = loadDataset(args.dataset);
  if (args.questions) {
    const extra = JSON.parse(readFileSync(args.questions, "utf8")) as Questions;
    dataset.questions = { ...extra, ...dataset.questions };
  }

  const report = await runEval(
    {
      apiKey,
      model: args.model,
      baseUrl: args.baseUrl,
      timeoutMs: args.timeoutMs,
    },
    dataset,
    { concurrency: args.concurrency, sweep: !args.noSweep, sweepSteps: args.sweepSteps },
  );

  process.stdout.write(formatReport(report) + "\n");
  if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2) + "\n");
  if (report.failedCases > 0) console.error(`${report.failedCases}/${report.totalCases} case(s) failed — see the report`);
}
