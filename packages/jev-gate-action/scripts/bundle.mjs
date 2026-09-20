// Bundles the compiled action with @jev-harness/core inlined, so the
// committed dist/index.js has NO runtime dependencies — GitHub runners just
// execute `node dist/index.js` straight from the repo.
import { build } from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });

await build({
  entryPoints: ["dist/main.js"],
  outfile: "dist/index.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  banner: {
    js: "// Bundled by @jev-harness/jev-gate-action — @jev-harness/core is inlined. Do not edit.",
  },
  logLevel: "warning",
});

console.log("bundled -> dist/index.js");
