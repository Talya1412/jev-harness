#!/usr/bin/env node
/** Entry point for the jev-harness-mcp binary: start the MCP server on stdio. */
import { main } from "./server.js";

main().catch((err) => {
  console.error(
    "jev-harness-mcp failed to start: " + (err instanceof Error ? err.message : String(err)),
  );
  process.exit(1);
});
