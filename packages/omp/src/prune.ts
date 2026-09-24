/**
 * `tool_result` pruning: shrink a bulky tool result BEFORE the model reads it.
 *
 * Why this event: the host fires `tool_result` after a tool executes and lets
 * a handler REPLACE the content array (`ToolResultEventResult.content`) — it
 * is the last hook that sees the text before the message is built, so a
 * replacement returned here is exactly what the model reads. Nothing
 * downstream can un-read a result, and no other event re-fires for it.
 *
 * Why the hook is default-OFF (`OMP_JEV_PRUNE=1`, deliberately NOT
 * `autoOn`/`OMP_JEV_AUTO`): every replacement rewrites that tool result from
 * the point it appears, invalidating the provider's prompt-cache prefix from
 * there on — each scored result then costs +200-400 ms to re-cache on every
 * later turn that re-sends it, and the hook itself spends a Jev call per bulky
 * result. That per-turn tax is real even when Jev answers "keep", so the user
 * opts in explicitly instead of inheriting it from the master switch.
 *
 * Fail-open contract (plan Task 6), in order:
 * 1. Armed ONLY by `OMP_JEV_PRUNE === "1"` — anything else is zero work.
 * 2. A result already carrying the prune marker (`omitted by jev prune`) was
 *    pruned before: return undefined (idempotent, never double-prunes).
 * 3. Text over `PRUNE_HARD_CAP_CHARS` never reaches Jev — oversize requests
 *    HTTP 400 (Astro-Han fed 39.5M chars, got a 400, and the fail-open path
 *    shipped 15.8M tokens onward anyway). It is capped locally, head + tail
 *    with a note, and returned as replacement content.
 * 4. Text under `PRUNE_MIN_CHARS` is not worth a call — a bounded preview
 *    already suffices.
 * 5. Otherwise `pruneContext` decides keep/drop under an 8 s self-deadline
 *    (`GATE_DEADLINE_MS`) combined with the host signal — far below the
 *    host's 30 s `tool_result` handler budget. Keep/deferred → undefined;
 *    drop → replacement content (verbatim head + provenance note).
 * 6. ANY throw → undefined (fail-open) plus a refusal-ledger record, so a
 *    Jev outage degrades to "no pruning" instead of breaking the host.
 *
 * Never deletes: the host keeps the original content, we only return a
 * replacement string, and non-text blocks (images) pass through untouched.
 */
import { pruneContext, type JevConfig } from "@jev-harness/core";
import { GATE_DEADLINE_MS, withDeadline, type Env } from "./config.js";
import { decideOnFailure } from "./failure.js";

/**
 * Marker every prune-produced replacement carries (core's drop note and this
 * module's local cap both embed it). A result that already contains it is
 * done — returning undefined keeps the hook idempotent.
 */
export const PRUNE_MARKER = "omitted by jev prune";

/**
 * Text over this many chars is capped locally and never sent to Jev: the
 * oversize state makes Jev answer HTTP 400 (Astro-Han's closed negative A/B —
 * 39.5M chars in, 400 out, 15.8M tokens shipped onward by the fail-open path).
 * 200k chars ≈ 50k tokens, comfortably inside one request's state budget.
 */
export const PRUNE_HARD_CAP_CHARS = 200_000;

/**
 * Below this a bounded preview already suffices. Local mirror of core's
 * `DEFAULT_MIN_CHARS = 2000` (patterns-prune.ts) — core keeps it private, so
 * the adapter carries its own copy and pins `minChars` to it on the call.
 */
export const PRUNE_MIN_CHARS = 2000;

/**
 * Local-cap split: head 150k + tail 40k + note stays under the 200k hard cap,
 * and the tail keeps the end of the output (exit status, final error) where
 * failure output usually lands. PROVISIONAL — the evidence-backed number is
 * the cap itself; the split is only required to bound the result, never tuned.
 */
const LOCAL_CAP_HEAD_CHARS = 150_000;
const LOCAL_CAP_TAIL_CHARS = 40_000;

/** One content block of a tool result, matching the host's `ToolResultEvent.content`. */
export type PruneContentBlock =
  { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** Minimal `tool_result` event surface — the fields this hook reads (host: `ToolResultEventBase`). */
export interface PruneToolResultEvent {
  toolCallId: string;
  content: readonly PruneContentBlock[];
  isError: boolean;
}

/** The refusal ledger's surface, injected from extension.ts (one ledger for the adapter). */
export interface PruneRefusalSink {
  record(key: string, reason: string): void;
}

export interface PruneDeps {
  /** `process.env` as the extension sees it — read here, never at module load. */
  env: Env;
  /** Shared refusals ledger (extension.ts owns it; no second ledger is created). */
  refusals: PruneRefusalSink;
  /** Built lazily, only when step 5 actually runs: disabled/small paths touch no config. */
  config: () => JevConfig;
}

const isText = (block: PruneContentBlock): block is { type: "text"; text: string } =>
  block.type === "text";

/** Replacement content: the new text first, every non-text block (images) kept as-is. */
function replacement(text: string, original: readonly PruneContentBlock[]): PruneContentBlock[] {
  return [{ type: "text", text }, ...original.filter((block) => block.type !== "text")];
}

/**
 * Local head+tail cap for oversize text (step 3) — no Jev call. The note
 * embeds `PRUNE_MARKER`, so a capped result is also idempotent if it ever
 * comes back through this hook.
 */
function localCap(text: string, id: string): string {
  const omitted = text.length - LOCAL_CAP_HEAD_CHARS - LOCAL_CAP_TAIL_CHARS;
  return (
    text.slice(0, LOCAL_CAP_HEAD_CHARS) +
    `\n[locally capped: ${omitted} of ${text.length} chars ${PRUNE_MARKER} ` +
    `(oversize; no Jev call); id=${id} — original retained by host]` +
    text.slice(text.length - LOCAL_CAP_TAIL_CHARS)
  );
}
/**
 * The `tool_result` hook body (extension.ts registers it). Returns replacement
 * content when a bulky result should be dropped, `undefined` in every other
 * case — including every failure — so the host keeps the original.
 */
export async function pruneToolResult(
  event: PruneToolResultEvent,
  ctx: { signal?: AbortSignal } | undefined,
  deps: PruneDeps,
): Promise<{ content: PruneContentBlock[] } | undefined> {
  // Computed before the gate: the refusal key must name the result's kind
  // even when the failure happens before anything else runs.
  const kind: "error" | "output" = event?.isError ? "error" : "output";
  try {
    // 1. Default-off: ONLY an explicit OMP_JEV_PRUNE=1 arms the hook. Not
    // autoOn/OMP_JEV_AUTO — see the file header for the cache-invalidation
    // reason this one stays out of the master switch.
    if ((deps.env.OMP_JEV_PRUNE ?? "").trim() !== "1") return;

    const text = (event.content ?? [])
      .filter(isText)
      .map((block) => block.text)
      .join("\n");

    // 2. Idempotency: this text already went through prune (core's note or
    // our local cap embeds the marker) — nothing left to do.
    if (text.includes(PRUNE_MARKER)) return;

    // 3. Hard cap: oversize state 400s at Jev, so cap locally, no fetch.
    if (text.length > PRUNE_HARD_CAP_CHARS) {
      return {
        content: replacement(localCap(text, String(event.toolCallId)), event.content),
      };
    }

    // 4. Too small to matter: a bounded preview already suffices.
    if (text.length < PRUNE_MIN_CHARS) return;

    // 5. Ask Jev. kind = error for a failed tool (stricter drop bar inside
    // pruneContext); the signal is the host's, bounded by our 8 s deadline
    // so the handler always settles under the host's 30 s budget.
    const outcome = await pruneContext(
      deps.config(),
      [{ id: String(event.toolCallId), text, kind }],
      {
        minChars: PRUNE_MIN_CHARS,
        signal: withDeadline(ctx?.signal, GATE_DEADLINE_MS),
      },
    );
    if (outcome.deferred) return;
    const decision = outcome.decisions[0];
    if (!decision || decision.keep || !decision.replacement) return;
    return { content: replacement(decision.replacement, event.content) };
  } catch (err) {
    // 6. Fail-open, but not silent: the original content stands (the host
    // never lost it) and the refusal ledger records prune:error / prune:output
    // with the classified failure kind.
    deps.refusals.record("prune:" + kind, decideOnFailure(err, "prune").kind);
    return;
  }
}
