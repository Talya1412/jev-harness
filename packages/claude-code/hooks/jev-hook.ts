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
import { judgeDestructive, routeSkill, type JevConfig, type SkillCandidate } from "@jev-harness/core";
import {
  DEFAULT_DESTRUCTIVE_THRESHOLD,
  DEFAULT_SKILL_CONFIDENCE,
  GATED_TOOLS,
  denyPayload,
  parseNumber,
  parseSkills,
  skillPayload,
} from "./decisions.js";

function buildConfig(): JevConfig | null {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) return null;
  const config: JevConfig = { apiKey };
  if (process.env.TYPESAFE_BASE_URL) config.baseUrl = process.env.TYPESAFE_BASE_URL;
  if (process.env.TYPESAFE_DEFAULT_MODEL) config.model = process.env.TYPESAFE_DEFAULT_MODEL;
  const timeoutMs = parseNumber(process.env.JEV_TIMEOUT_MS, NaN);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) config.timeoutMs = timeoutMs;
  return config;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function emitDecision(payload: unknown): void {
  // Synchronous write: process.exit() below must not truncate the decision.
  writeSync(1, JSON.stringify(payload) + "\n");
}

/** Fail open: exit 0 with no output means "no decision" to Claude Code. */
function allow(): never {
  process.exit(0);
}

async function runPreToolUse(input: Record<string, unknown>): Promise<void> {
  try {
    const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
    if (!GATED_TOOLS.has(toolName)) allow();
    const config = buildConfig();
    if (!config) allow();
    const threshold = parseNumber(process.env.JEV_DESTRUCTIVE_THRESHOLD, DEFAULT_DESTRUCTIVE_THRESHOLD);
    const result = await judgeDestructive(
      config as JevConfig,
      {
        tool: toolName,
        input: (input.tool_input ?? {}) as unknown,
        cwd: typeof input.cwd === "string" ? (input.cwd as string) : undefined,
      },
      { threshold },
    );
    if (result.blocked) {
      emitDecision(denyPayload(toolName, result.destructive, threshold));
    }
    // Below threshold: stay silent so the normal permission flow applies.
    allow();
  } catch {
    // Any failure (no key, timeout, malformed input, Jev down) allows.
    allow();
  }
}

/** Skills come from `JEV_SKILLS_JSON` inline, else `JEV_SKILLS_FILE`. */
function loadSkills(): SkillCandidate[] {
  const inline = process.env.JEV_SKILLS_JSON;
  if (inline !== undefined && inline.trim() !== "") return parseSkills(inline);
  const file = process.env.JEV_SKILLS_FILE;
  if (file !== undefined && file.trim() !== "") {
    try {
      return parseSkills(readFileSync(file, "utf8"));
    } catch {
      // Unreadable path: no skills, same as a malformed document.
      return [];
    }
  }
  return [];
}

async function runUserPromptSubmit(input: Record<string, unknown>): Promise<void> {
  try {
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    if (prompt.trim() === "") allow();
    const skills = loadSkills();
    if (skills.length === 0) allow();
    const config = buildConfig();
    if (!config) allow();
    const minConfidence = parseNumber(process.env.JEV_SKILL_CONFIDENCE, DEFAULT_SKILL_CONFIDENCE);
    const routed = await routeSkill(config as JevConfig, prompt, skills, { minConfidence });
    if (!routed.skill) allow();
    // APPEND-only: additionalContext adds to the prompt context without
    // replacing or blocking the user's prompt.
    emitDecision(skillPayload(routed.skill, routed.confidence));
    allow();
  } catch {
    // Any failure exits silently: the prompt proceeds untouched.
    allow();
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  let input: Record<string, unknown> = {};
  try {
    const raw = await readStdin();
    if (raw.trim() !== "") {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        input = parsed as Record<string, unknown>;
      }
    }
  } catch {
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
