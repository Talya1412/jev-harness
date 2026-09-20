/**
 * Executor plumbing shared by the OMP and Pi adapters.
 *
 * Both harnesses register the same five tools with host-specific schemas
 * (zod vs typebox) and host-specific failure handling. The kit stays
 * host-agnostic: it owns env config resolution and the core-pattern call
 * plumbing, while each adapter keeps its own schemas, formatting, and
 * failure policy:
 * - OMP (strict): `requireKey: true` — a missing key throws inside execute.
 * - Pi (fail-open): `requireKey: false` — tools catch everything and render
 *   the standard error text from results.ts instead.
 *
 * Config is resolved fresh on every call so env changes between calls are
 * picked up (matches the previous per-adapter behavior).
 */
import {
  askJev,
  chooseBrowserAction,
  listJevModels,
  pickTool,
  routeSkill,
  type JevConfig,
  type JevResponse,
  type Questions,
} from "@jev-harness/core";
import { resolveEnvConfig } from "./config.js";

export type RouteSkillsResult = { skill: string | null; confidence: number; probabilities: Record<string, number> };
export type PickToolResult = { tool: string | null; confidence: number; risky: number; confirmRequired: boolean; act: boolean };
export type BrowseActionResult = { operation: string | null; target: string | null; confidence: number; act: boolean };

export interface JevToolkit {
  /** Fresh config per call. Throws when the toolkit requires a key and none is set. */
  config(modelOverride?: string): JevConfig;
  ask(state: unknown, questions: Questions, opts?: { model?: string; signal?: AbortSignal }): Promise<JevResponse>;
  models(signal?: AbortSignal): Promise<Array<{ name: string; description?: string }>>;
  routeSkills(
    message: string,
    skills: Array<{ name: string; description?: string }>,
    opts?: { minConfidence?: number; maxCandidates?: number; signal?: AbortSignal },
  ): Promise<RouteSkillsResult>;
  pickTool(
    input: { task: string; tools: Array<{ name: string; description: string }>; context?: string },
    opts?: { minConfidence?: number; riskThreshold?: number; signal?: AbortSignal },
  ): Promise<PickToolResult>;
  browseAction(
    input: {
      goal: string;
      page: { url: string; title?: string; text?: string };
      elements: Array<{ index: string; label: string; role?: string; value?: string; operations: string[] }>;
      recentActions?: Array<{ action: string; kind?: string; pageChanged?: boolean }>;
    },
    opts?: { minConfidence?: number; signal?: AbortSignal },
  ): Promise<BrowseActionResult>;
}

export function createJevToolkit(
  opts: { requireKey?: boolean; fetchImpl?: typeof fetch } = {},
): JevToolkit {
  const config = (modelOverride?: string): JevConfig => {
    const cfg = resolveEnvConfig({ requireKey: opts.requireKey, modelOverride });
    if (opts.fetchImpl) cfg.fetchImpl = opts.fetchImpl;
    return cfg;
  };
  return {
    config,
    ask(state, questions, call) {
      return askJev(config(call?.model), state, questions, call?.signal);
    },
    models(signal) {
      return listJevModels(config());
    },
    routeSkills(message, skills, call) {
      return routeSkill(config(), message, skills, call);
    },
    pickTool(input, call) {
      return pickTool(config(), input, call);
    },
    browseAction(input, call) {
      return chooseBrowserAction(config(), input, call);
    },
  };
}
