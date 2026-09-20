/**
 * Pure helpers for the Pi adapter.
 *
 * Kept free of ExtensionAPI and network access so the pairing and truncation
 * logic — the part that decides what the model actually sees after a
 * compaction — can be tested directly.
 */
import type { JevConfig } from "@jev-harness/core";

/** Shared with the OMP adapter: pairs below this keep-score are stale. */
export const DEFAULT_KEEP_THRESHOLD = 0.2;

/** Upper bound on pairs judged in one compaction pass. */
export const MAX_COMPACTION_PAIRS = 40;

/** Per-field cap on the text handed to the judge. */
export const FIELD_LIMIT = 500;

export interface ToolPair {
  key: string;
  tool: string;
  argsText: string;
  resultText: string;
}

/** Read the Jev client config from `process.env`, leaving defaults unset. */
export function resolveJevConfig(env: Record<string, string | undefined>): JevConfig {
  const timeoutRaw = Number(env.JEV_TIMEOUT_MS ?? "");
  const config: JevConfig = { apiKey: env.TYPESAFE_API_KEY ?? "" };
  const baseUrl = (env.TYPESAFE_BASE_URL ?? "").trim();
  if (baseUrl) config.baseUrl = baseUrl;
  const model = (env.TYPESAFE_DEFAULT_MODEL ?? "").trim();
  if (model) config.model = model;
  if (Number.isFinite(timeoutRaw) && timeoutRaw > 0) config.timeoutMs = timeoutRaw;
  return config;
}

/**
 * Keep-score cutoff, clamped to a probability.
 *
 * An unset or blank variable must fall back rather than coerce to 0: `Number("")`
 * is 0, which would keep every pair and silently disable the hook.
 */
export function keepThreshold(raw: string | undefined): number {
  const text = (raw ?? "").trim();
  if (text === "") return DEFAULT_KEEP_THRESHOLD;
  const n = Number(text);
  if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  return DEFAULT_KEEP_THRESHOLD;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + " [truncated]" : text;
}

/** Plain-text head of a tool-result content payload. */
export function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("\n");
}

/**
 * Pair assistant tool calls with their results by toolCallId.
 * Only complete pairs are eligible for keep/drop judgments: an unanswered call
 * carries no output to drop, so it is skipped rather than scored.
 */
export function collectToolPairs(entries: readonly unknown[]): ToolPair[] {
  const calls = new Map<string, { tool: string; argsText: string }>();
  const results = new Map<string, string>();
  for (const entry of entries as Array<any>) {
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (!message) continue;
    if (message.role === "assistant") {
      for (const block of message.content ?? []) {
        if (block?.type === "toolCall") {
          calls.set(String(block.id), {
            tool: String(block.name),
            argsText: truncate(JSON.stringify(block.arguments ?? {}), FIELD_LIMIT),
          });
        }
      }
    } else if (message.role === "toolResult") {
      results.set(String(message.toolCallId), truncate(blockText(message.content), FIELD_LIMIT));
    }
  }
  const pairs: ToolPair[] = [];
  for (const [id, call] of calls) {
    const resultText = results.get(id);
    if (resultText === undefined) continue;
    pairs.push({ key: id, tool: call.tool, argsText: call.argsText, resultText });
    if (pairs.length >= MAX_COMPACTION_PAIRS) break;
  }
  return pairs;
}
