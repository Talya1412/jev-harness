// Bundles the action entrypoint with ./review.js and
// @jev-harness/core inlined, so dist/action.js is fully self-contained.
// GitHub runners execute `node dist/action.js` straight from the repo with
// no npm install, so a bare import would fail at runtime. dist/review.js is
// left tsc-compiled for npm consumers (package main/exports).
// Bundles from TS source so the action entry never depends on tsc ordering.
import { build } from "esbuild";

await build({
  entryPoints: ["src/action.ts"],
  outfile: "dist/action.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  allowOverwrite: true,
  banner: {
    js: "// Bundled by @jev-harness/github — @jev-harness/core is inlined. Do not edit.",
  },
  logLevel: "warning",
});

console.log("bundled -> dist/action.js");
