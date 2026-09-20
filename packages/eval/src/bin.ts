#!/usr/bin/env node
/** Executable entry for jev-eval (the logic lives in ./cli.ts). */
import { runEvalCli } from "./cli.js";

runEvalCli(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
