// Stamps .claude-plugin/plugin.json and .claude-plugin/marketplace.json versions
// from package.json so they never drift again. Runs as part of `npm run build`.
import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = pkg.version;

const pluginPath = ".claude-plugin/plugin.json";
const plugin = JSON.parse(readFileSync(pluginPath, "utf8"));
if (plugin.version !== version) {
  plugin.version = version;
  writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + "\n");
}

const marketPath = ".claude-plugin/marketplace.json";
const market = JSON.parse(readFileSync(marketPath, "utf8"));
const entry = market.plugins.find((p) => p.name === plugin.name) ?? market.plugins[0];
if (entry && entry.version !== version) {
  entry.version = version;
  writeFileSync(marketPath, JSON.stringify(market, null, 2) + "\n");
}

console.log(`stamped plugin version ${version}`);
