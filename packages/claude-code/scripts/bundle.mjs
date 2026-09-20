// Bundles the hook with @jev-harness/core inlined, so the installed
// plugin has NO runtime dependencies to resolve. A Claude Code marketplace
// install copies files WITHOUT npm install, so a bare import would fail at
// hook runtime. Bundles from TS source; tsc still emits dist for types.
import { build } from "esbuild";

await build({
  entryPoints: ["hooks/jev-hook.ts"],
  outfile: "dist/hooks/jev-hook.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  allowOverwrite: true,
  banner: {
    js: "// Bundled by @jev-harness/claude-code — @jev-harness/core is inlined. Do not edit.",
  },
  logLevel: "warning",
});

console.log("bundled -> dist/hooks/jev-hook.js");
