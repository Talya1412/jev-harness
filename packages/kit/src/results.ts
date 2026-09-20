/**
 * Tool-result envelope shared by the OMP and Pi adapters: a plain text
 * content block plus an optional details payload, and the standard
 * fail-open error rendering.
 */

export interface TextToolResult {
  content: Array<{ type: "text"; text: string }>;
  /** Hosts (Pi) require the property to be present; may be undefined. */
  details: unknown;
}

export function okResult(text: string, details?: unknown): TextToolResult {
  return { content: [{ type: "text", text }], details };
}

/** Standard fail-open error text: the host agent is never affected. */
export function errorText(tool: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return tool + " failed (fail-open, host unaffected): " + msg.slice(0, 500);
}

export function errorResult(tool: string, err: unknown): TextToolResult {
  return okResult(errorText(tool, err));
}
