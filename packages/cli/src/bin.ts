#!/usr/bin/env node
/** Executable entry for the `jev` command (logic lives in ./cli.ts). */
import { runCli } from "./cli.js";

runCli(process.argv.slice(2))
  .then((code) => {
    if (code !== 0) process.exit(code);
  })
  .catch((err) => {
    process.stderr.write(
      "jev failed: " + (err instanceof Error ? err.message : String(err)) + "\n",
    );
    process.exit(1);
  });
