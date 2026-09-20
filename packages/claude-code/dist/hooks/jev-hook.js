/**
 * jev-harness Claude Code hook entrypoint.
 *
 * Two modes, selected by argv[2]:
 *
 * - `pre-tool-use`: reads the PreToolUse JSON payload from stdin
 *   ({ tool_name, tool_input, cwd, ... }), asks Jev (judgeDestructive)
 *   whether the call is destructive, and prints a `deny` decision at or
 *   above the threshold. Anything else — including every error path —
 *   exits 0 with no output, which means "no decision": the normal
 *   permission flow applies. The hook fails OPEN by construction.
 *
 * - `user-prompt-submit`: reads the UserPromptSubmit JSON payload from
 *   stdin ({ prompt, ... }), asks Jev (routeSkill) which known skill fits,
 *   and prints an `additionalContext` advisory line. It APPENDS context;
 *   it never rewrites or blocks the prompt, and exits 0 silently when no
 *   skill clears the confidence bar or when anything fails.
 *
 * Config (env only, never hardcoded, never logged):
 * - TYPESAFE_API_KEY        TypeSafe key (required for any Jev call)
 * - TYPESAFE_BASE_URL       API base override (optional)
 * - TYPESAFE_DEFAULT_MODEL  model override (optional, default jev-latest)
 * - JEV_TIMEOUT_MS          per-request timeout in ms (optional)
 * - JEV_DESTRUCTIVE_THRESHOLD  block threshold (optional, default 0.75)
 * - JEV_SKILL_CONFIDENCE    skill advisory bar (optional, default 0.5)
 * - JEV_SKILLS_JSON         inline JSON array of { name, description }
 * - JEV_SKILLS_FILE         path to a JSON file with the same shape
 */
import { readFileSync, writeSync } from "node:fs";
import { judgeDestructive, routeSkill } from "@jev-harness/core";
const DEFAULT_DESTRUCTIVE_THRESHOLD = 0.75;
const DEFAULT_SKILL_CONFIDENCE = 0.5;
/** Tools whose calls are worth judging. hooks.json matchers pre-filter to
 * this same set; the check here keeps direct invocations honest. */
const GATED_TOOLS = new Set(["Bash", "Write", "Edit", "NotebookEdit"]);
function parseNumber(raw, fallback) {
    if (raw === undefined || raw.trim() === "")
        return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
}
function buildConfig() {
    const apiKey = process.env.TYPESAFE_API_KEY;
    if (!apiKey)
        return null;
    const config = { apiKey };
    if (process.env.TYPESAFE_BASE_URL)
        config.baseUrl = process.env.TYPESAFE_BASE_URL;
    if (process.env.TYPESAFE_DEFAULT_MODEL)
        config.model = process.env.TYPESAFE_DEFAULT_MODEL;
    const timeoutMs = parseNumber(process.env.JEV_TIMEOUT_MS, NaN);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0)
        config.timeoutMs = timeoutMs;
    return config;
}
function readStdin() {
    return new Promise((resolve, reject) => {
        let data = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
            data += chunk;
        });
        process.stdin.on("end", () => resolve(data));
        process.stdin.on("error", reject);
    });
}
function emitDecision(payload) {
    // Synchronous write: process.exit() below must not truncate the decision.
    writeSync(1, JSON.stringify(payload) + "\n");
}
/** Fail open: exit 0 with no output means "no decision" to Claude Code. */
function allow() {
    process.exit(0);
}
async function runPreToolUse(input) {
    try {
        const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
        if (!GATED_TOOLS.has(toolName))
            allow();
        const config = buildConfig();
        if (!config)
            allow();
        const threshold = parseNumber(process.env.JEV_DESTRUCTIVE_THRESHOLD, DEFAULT_DESTRUCTIVE_THRESHOLD);
        const result = await judgeDestructive(config, {
            tool: toolName,
            input: (input.tool_input ?? {}),
            cwd: typeof input.cwd === "string" ? input.cwd : undefined,
        }, { threshold });
        if (result.blocked) {
            emitDecision({
                hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason: `Jev judged this ${toolName} call destructive (p=${result.destructive.toFixed(2)} >= ${threshold}). Review it before retrying.`,
                },
            });
        }
        // Below threshold: stay silent so the normal permission flow applies.
        allow();
    }
    catch {
        // Any failure (no key, timeout, malformed input, Jev down) allows.
        allow();
    }
}
function loadSkills() {
    try {
        const inline = process.env.JEV_SKILLS_JSON;
        if (inline !== undefined && inline.trim() !== "") {
            const parsed = JSON.parse(inline);
            if (Array.isArray(parsed))
                return parsed.filter(isSkill);
            return [];
        }
        const file = process.env.JEV_SKILLS_FILE;
        if (file !== undefined && file.trim() !== "") {
            const parsed = JSON.parse(readFileSync(file, "utf8"));
            if (Array.isArray(parsed))
                return parsed.filter(isSkill);
        }
    }
    catch {
        // Malformed skills config: treat as no skills (fail open).
    }
    return [];
}
function isSkill(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const name = value.name;
    if (typeof name !== "string" || name === "")
        return false;
    const description = value.description;
    return description === undefined || typeof description === "string";
}
async function runUserPromptSubmit(input) {
    try {
        const prompt = typeof input.prompt === "string" ? input.prompt : "";
        if (prompt.trim() === "")
            allow();
        const skills = loadSkills();
        if (skills.length === 0)
            allow();
        const config = buildConfig();
        if (!config)
            allow();
        const minConfidence = parseNumber(process.env.JEV_SKILL_CONFIDENCE, DEFAULT_SKILL_CONFIDENCE);
        const routed = await routeSkill(config, prompt, skills, { minConfidence });
        if (!routed.skill)
            allow();
        // APPEND-only: additionalContext adds to the prompt context without
        // replacing or blocking the user's prompt.
        emitDecision({
            hookSpecificOutput: {
                hookEventName: "UserPromptSubmit",
                additionalContext: `Jev skill suggestion (confidence ${(routed.confidence * 100).toFixed(0)}%): this prompt looks like a job for the "${routed.skill}" skill. Consider loading it if it is available.`,
            },
        });
        allow();
    }
    catch {
        // Any failure exits silently: the prompt proceeds untouched.
        allow();
    }
}
async function main() {
    const mode = process.argv[2];
    let input = {};
    try {
        const raw = await readStdin();
        if (raw.trim() !== "") {
            const parsed = JSON.parse(raw);
            if (typeof parsed === "object" && parsed !== null) {
                input = parsed;
            }
        }
    }
    catch {
        // Unparseable stdin: fail open per mode.
    }
    if (mode === "pre-tool-use") {
        await runPreToolUse(input);
        return;
    }
    if (mode === "user-prompt-submit") {
        await runUserPromptSubmit(input);
        return;
    }
    process.stderr.write(`usage: jev-hook.js <pre-tool-use|user-prompt-submit>\n`);
    process.exit(2);
}
main();
//# sourceMappingURL=jev-hook.js.map