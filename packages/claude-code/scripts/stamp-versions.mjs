// Stamps .claude-plugin/plugin.json and .claude-plugin/marketplace.json versions
// from package.json so they never drift again. Runs as part of `npm run build`.
// Paths resolve from this file, so it also works when invoked from the repo root
// (the release `version-script` calls it after `changeset version`).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const version = pkg.version;

const pluginPath = join(pkgDir, ".claude-plugin", "plugin.json");
const plugin = JSON.parse(readFileSync(pluginPath, "utf8"));
if (plugin.version !== version) {
  plugin.version = version;
  writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + "\n");
}

const marketPath = join(pkgDir, ".claude-plugin", "marketplace.json");
const market = JSON.parse(readFileSync(marketPath, "utf8"));
const entry = market.plugins.find((p) => p.name === plugin.name) ?? market.plugins[0];
if (entry && entry.version !== version) {
  entry.version = version;
  writeFileSync(marketPath, JSON.stringify(market, null, 2) + "\n");
}

console.log(`stamped plugin version ${version}`);
