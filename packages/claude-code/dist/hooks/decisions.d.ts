/**
 * Pure decision helpers for the Claude Code hook.
 *
 * The hook entrypoint is an I/O shell: it reads stdin, calls Jev, writes a
 * decision. Everything that decides *what* to write — which tools are gated,
 * how the skills config is parsed, and the exact payload shape — lives here so
 * it can be tested without spawning a process.
 */
import type { SkillCandidate } from "@jev-harness/core";
export declare const DEFAULT_DESTRUCTIVE_THRESHOLD = 0.5;
export declare const DEFAULT_SKILL_CONFIDENCE = 0.5;
export declare const MIN_PROMPT_CHARS = 1;
/**
 * Tools whose calls are worth judging. `hooks.json` matchers pre-filter to this
 * same set; the check at runtime keeps a direct invocation honest.
 */
export declare const GATED_TOOLS: ReadonlySet<string>;
/** Parse a numeric env override, falling back on blank or unparseable input. */
export declare function parseNumber(raw: string | undefined, fallback: number): number;
/** A skills entry is usable when it has a name and, optionally, a string description. */
export declare function isSkill(value: unknown): value is SkillCandidate;
/**
 * Read the skills list from a JSON document. Malformed JSON, a non-array
 * document, or partially-invalid entries must never throw: the hook is
 * fail-open, so a bad config means "no skills", not a broken prompt path.
 */
export declare function parseSkills(json: string): SkillCandidate[];
export interface PreToolUseDecision {
    hookSpecificOutput: {
        hookEventName: "PreToolUse";
        permissionDecision: "deny";
        permissionDecisionReason: string;
    };
}
/** The deny payload for a call Jev scored at or above the threshold. */
export declare function denyPayload(toolName: string, probability: number, threshold: number): PreToolUseDecision;
export interface UserPromptSubmitDecision {
    hookSpecificOutput: {
        hookEventName: "UserPromptSubmit";
        additionalContext: string;
    };
}
/**
 * The advisory payload for a routed skill. Append-only by construction: it
 * carries `additionalContext` and never a replacement for the prompt.
 */
export declare function skillPayload(skill: string, confidence: number): UserPromptSubmitDecision;
//# sourceMappingURL=decisions.d.ts.map