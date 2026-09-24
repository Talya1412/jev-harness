/**
 * Pure decision helpers for the Claude Code hook.
 *
 * The hook entrypoint is an I/O shell: it reads stdin, calls Jev, writes a
 * decision. Everything that decides *what* to write — which tools are gated,
 * how the skills config is parsed, and the exact payload shape — lives here so
 * it can be tested without spawning a process.
 */
import { THRESHOLDS } from "@jev-harness/core";
/**
 * Both cutoffs come from core's single tuned table rather than a local copy:
 * a second literal here is exactly how this file once compared the wrong way
 * round against core's default while every test still passed.
 */
export const DEFAULT_DESTRUCTIVE_THRESHOLD = THRESHOLDS.destructiveGate;
export const DEFAULT_SKILL_CONFIDENCE = THRESHOLDS.skillRouting;
export const MIN_PROMPT_CHARS = 1;
/**
 * Tools whose calls are worth judging. `hooks.json` matchers pre-filter to this
 * same set; the check at runtime keeps a direct invocation honest.
 */
export const GATED_TOOLS = new Set(["Bash", "Write", "Edit", "NotebookEdit"]);
/** Parse a numeric env override, falling back on blank or unparseable input. */
export function parseNumber(raw, fallback) {
    if (raw === undefined || raw.trim() === "")
        return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
}
/** A skills entry is usable when it has a name and, optionally, a string description. */
export function isSkill(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const name = value.name;
    if (typeof name !== "string" || name === "")
        return false;
    const description = value.description;
    return description === undefined || typeof description === "string";
}
/**
 * Read the skills list from a JSON document. Malformed JSON, a non-array
 * document, or partially-invalid entries must never throw: the hook is
 * fail-open, so a bad config means "no skills", not a broken prompt path.
 */
export function parseSkills(json) {
    try {
        const parsed = JSON.parse(json);
        if (!Array.isArray(parsed))
            return [];
        return parsed.filter(isSkill);
    }
    catch {
        return [];
    }
}
/** The deny payload for a call Jev scored at or above the threshold. */
export function denyPayload(toolName, probability, threshold) {
    return {
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: "Jev judged this " +
                toolName +
                " call destructive (p=" +
                probability.toFixed(2) +
                " >= " +
                threshold +
                "). Review it before retrying.",
        },
    };
}
/**
 * The advisory payload for a routed skill. Append-only by construction: it
 * carries `additionalContext` and never a replacement for the prompt.
 */
export function skillPayload(skill, confidence) {
    return {
        hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: "Jev skill suggestion (confidence " +
                (confidence * 100).toFixed(0) +
                '%): this prompt looks like a job for the "' +
                skill +
                '" skill. Consider loading it if it is available.',
        },
    };
}
//# sourceMappingURL=decisions.js.map