// Bundles the compiled extension with @jev-harness/core inlined, so the
// installed extension has NO runtime dependencies to resolve. An OMP extension
// is loaded by a source-rewriting loader that does not consult node_modules
// for bare specifiers, so a bare import would fail at load time.
import { build } from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("bundle", { recursive: true });

await build({
  entryPoints: ["dist/extension.js"],
  outfile: "bundle/extension.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  // Keep host-provided modules external — OMP supplies them at runtime.
  external: ["@oh-my-pi/pi-coding-agent"],
  banner: {
    js: "// Bundled by @jev-harness/omp — @jev-harness/core is inlined. Do not edit.",
  },
  logLevel: "warning",
});

console.log("bundled -> bundle/extension.js");
