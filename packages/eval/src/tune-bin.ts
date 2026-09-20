#!/usr/bin/env node
/** Executable entry for jev-tune (the logic lives in ./tune.ts + ./tune-cli.ts). */
import { readFileSync } from "node:fs";
import { parseArgs, loadDataset, formatSummary, HELP } from "./tune-cli.js";
import { tune } from "./tune.js";

const parsed = parseArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error("jev-tune: " + parsed.error + " (try --help)");
  process.exit(2);
}
if (parsed.options.help) {
  console.log(HELP);
  process.exit(0);
}

let text: string;
try {
  text = parsed.options.file ? readFileSync(parsed.options.file, "utf8") : readFileSync(0, "utf8");
} catch (err: unknown) {
  console.error("jev-tune: cannot read input: " + (err instanceof Error ? err.message : String(err)));
  process.exit(2);
}

const dataset = loadDataset(text);
if (!dataset.ok) {
  console.error("jev-tune: " + dataset.error);
  process.exit(2);
}

const pairs = dataset.samples.map(({ p, y }) => ({ p, y: y ? (1 as const) : (0 as const) }));
console.log(formatSummary(tune(pairs, parsed.options.objective), parsed.options.json));
