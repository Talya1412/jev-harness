/**
 * Resolve the Jev client config from the environment.
 *
 * The rule itself lives in \`@jev-harness/kit\` (\`resolveEnvConfig\`); this module
 * supplies only the MCP-specific piece: an error message that names the MCP
 * client config, because a server started by a client has no obvious shell to
 * export from. The API key is never hardcoded and never logged.
 */
import type { JevConfig } from "@jev-harness/core";
import { resolveEnvConfig, type Env } from "@jev-harness/kit";

/**
 * Build a JevConfig from env + optional explicit overrides.
 * Throws a clear error naming TYPESAFE_API_KEY when no key is available.
 */
export function resolveJevConfig(
  overrides: Partial<JevConfig> = {},
  env: Env = process.env,
): JevConfig {
  try {
    // A tool call sends the state the caller deliberately submitted, so MCP
    // keeps full fidelity: redaction is off by policy and JEV_REDACT is
    // deliberately ignored here.
    return resolveEnvConfig({ env, overrides, requireKey: true, redact: false });
  } catch (err) {
    if (err instanceof Error && err.message.includes("TYPESAFE_API_KEY is not set")) {
      throw new Error(
        "TYPESAFE_API_KEY is not set. Export it in your environment " +
          "(e.g. export TYPESAFE_API_KEY=...) or add it to the MCP client " +
          "config under env, then restart the server.",
        { cause: err },
      );
    }
    throw err;
  }
}
