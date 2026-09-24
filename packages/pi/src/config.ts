/**
 * Pi adapter configuration policy.
 *
 * The env-to-JevConfig rule is the kit's (`@jev-harness/kit`); Pi supplies only
 * its own two decisions:
 * - fail open: `requireKey: false` — a missing key is not an error until a call
 *   is actually made, and the tools render the failure as advisory text.
 * - full fidelity: `redact: false` — a tool's state is exactly what the host
 *   model chose to submit, so it is sent unredacted (`JEV_REDACT` does not
 *   apply to Pi's tool calls).
 */
import { createJevToolkit, type JevToolkit } from "@jev-harness/kit";

/** Build the Pi toolkit. Config is re-read per call, so env changes are picked up. */
export function createPiToolkit(): JevToolkit {
  return createJevToolkit({ requireKey: false });
}
