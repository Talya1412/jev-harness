#!/usr/bin/env node
/**
 * `jev-gate` entrypoint: resolve state, ask Jev once, print a verdict, exit.
 *
 * The judgment itself is `judgeDestructive`'s sibling — a single `noul` over
 * the criteria. Everything decision-shaped lives in ./gate.ts, so this file
 * only does I/O and process control.
 */
import { askJev, noul } from "@jev-harness/core";
import { parseTimeoutMs } from "@jev-harness/kit";
import {
  EXIT_ERROR,
  EXIT_FAIL,
  EXIT_PASS,
  HELP,
  type GateReport,
  exitCodeFor,
  formatReport,
  parseArgs,
  realSources,
  resolveState,
} from "./gate.js";

const DEFAULT_TIMEOUT_MS = 30_000;

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(parsed.error + "\n\n" + HELP);
    return EXIT_ERROR;
  }
  const { options } = parsed;

  if (options.help) {
    process.stdout.write(HELP);
    return EXIT_PASS;
  }

  if (options.criteria.trim() === "") {
    process.stderr.write("missing criteria: pass one with -c \"<text>\" or as a bare argument\n\n" + HELP);
    return EXIT_ERROR;
  }

  const sources = realSources();
  const state = resolveState(options, sources);
  if (!state.ok) {
    process.stderr.write(state.error + "\n");
    return EXIT_ERROR;
  }

  const apiKey = (process.env.TYPESAFE_API_KEY ?? "").trim();
  if (apiKey === "") {
    const report: GateReport = {
      passed: options.failOpen,
      probability: 0,
      threshold: options.threshold,
      criteria: options.criteria,
      elapsedMs: 0,
      error: "TYPESAFE_API_KEY is not set",
    };
    process.stdout.write(formatReport(report, options.json) + "\n");
    if (options.failOpen) {
      process.stderr.write("jev-gate: no API key, passing because --fail-open is set\n");
      return EXIT_PASS;
    }
    return EXIT_ERROR;
  }

  const timeoutMs = parseTimeoutMs(process.env.JEV_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
  const config = {
    apiKey,
    baseUrl: (process.env.TYPESAFE_BASE_URL ?? "").trim() || undefined,
    model: options.model ?? ((process.env.TYPESAFE_DEFAULT_MODEL ?? "").trim() || undefined),
    timeoutMs,
  } as { apiKey: string; baseUrl?: string; model?: string; timeoutMs: number };

  const started = Date.now();
  try {
    const response = await askJev(config, state.text, {
      gate_passed: {
        type: "noul",
        instructions:
          "Does the provided code, diff, or output satisfy this acceptance criteria: \"" +
          options.criteria +
          "\"? Judge only what the state shows; missing evidence is not evidence of success.",
      },
    });
    const probability = noul(response, "gate_passed");
    const report: GateReport = {
      passed: exitCodeFor(probability, options.threshold) === EXIT_PASS,
      probability,
      threshold: options.threshold,
      criteria: options.criteria,
      elapsedMs: Date.now() - started,
    };
    process.stdout.write(formatReport(report, options.json) + "\n");
    return report.passed ? EXIT_PASS : EXIT_FAIL;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const report: GateReport = {
      passed: options.failOpen,
      probability: 0,
      threshold: options.threshold,
      criteria: options.criteria,
      elapsedMs: Date.now() - started,
      error: msg,
    };
    process.stdout.write(formatReport(report, options.json) + "\n");
    // A Jev/server error is operational (1); usage errors exit 2 above.
    return options.failOpen ? EXIT_PASS : EXIT_FAIL;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write("jev-gate failed: " + (err instanceof Error ? err.message : String(err)) + "\n");
    process.exit(EXIT_ERROR);
  });
