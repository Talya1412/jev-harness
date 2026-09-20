#!/usr/bin/env node
/**
 * `jev-tune` entrypoint: read a labeled dataset, sweep thresholds, print the
 * best one and the calibration metrics, exit. Pure logic lives in ./tune-cli.js.
 */
import { readFileSync } from "node:fs";
import { tune } from "./tune.js";
import {
  HELP,
  loadDataset,
  parseArgs,
  formatSummary,
} from "./tune-cli.js";

const EXIT_OK = 0;
const EXIT_ERROR = 2;

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(parsed.error + "\n\n" + HELP);
    return EXIT_ERROR;
  }
  const { options } = parsed;

  if (options.help) {
    process.stdout.write(HELP);
    return EXIT_OK;
  }

  let text: string;
  if (options.file !== undefined) {
    try {
      text = readFileSync(options.file, "utf8");
    } catch (err) {
      process.stderr.write("cannot read " + options.file + ": " + (err instanceof Error ? err.message : String(err)) + "\n");
      return EXIT_ERROR;
    }
  } else {
    try {
      text = readFileSync(0, "utf8");
    } catch {
      text = "";
    }
  }

  const dataset = loadDataset(text);
  if (!dataset.ok) {
    process.stderr.write(dataset.error + "\n");
    return EXIT_ERROR;
  }

  const predictions = dataset.samples.map((s) => s.p);
  const outcomes = dataset.samples.map((s) => s.y);
  const summary = tune(predictions, outcomes, options.objective);
  process.stdout.write(formatSummary(summary, options.json) + "\n");
  return EXIT_OK;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write("jev-tune failed: " + (err instanceof Error ? err.message : String(err)) + "\n");
    process.exit(EXIT_ERROR);
  });
