# Escalate / Prune / Review Patterns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the three evidence-backed backlog items — confidence escalation, context pruning, and the two review-judgment patterns — as core patterns with OMP + MCP wiring.

**Architecture:** Three new `packages/core/src/patterns-*.ts` files (disjoint, one per feature), one additive `THRESHOLDS` block, wiring into the OMP adapter's `tool_result` event and the MCP server. Every pattern is fail-open at the adapter boundary and non-destructive by contract (pruning returns replacement text; the original stays with the caller).

**Tech Stack:** TypeScript ESM, strict tsc, vitest, `askJev` transport from `client.ts`.

**Spec:** This file. Research evidence: `docs/research-2026-09-24.md` + the 2026-09-25 design-constraint summaries (vendor confidence-routing/SDE-cascade cookbooks, madewithjev 685-build corpus, five cloned prune implementations incl. Astro-Han's closed negative A/B, alibaba/open-code-review prompt files).

## Global Constraints

- Decision logic ONLY in `packages/core/src/`; adapters stay thin (AGENTS.md).
- Every tuned number lives in `THRESHOLDS` (`packages/core/src/patterns.ts`); provenance comment required — MEASURED (cite) or PROVISIONAL (cite why + "tune before relying").
- Fail-open at adapter level; a Jev outage never blocks. Patterns throw only on FIRST-pass transport failure; a failed escalation/prune pass returns an honest `unresolved`/`deferred`/keep result — never a silent default.
- Never delete content: prune returns a replacement string (head + note); caller keeps the original.
- Missing/malformed answers: escalate → `unresolved`; prune → keep; refute → keep; realness → `realness:-1` + `report:false` (unjudged marker, severity untouched).
- No literal attack payloads in any shipped file.
- Gates per task: `npx vitest run packages/core/src/<file>.test.ts` + eslint + prettier on touched files. Main runs full `npm run build && npm run typecheck && npx eslint . && npx prettier --check . && npm test` at integration.
- Agents DO NOT commit; main commits at phase boundaries.

---

### Task 0: THRESHOLDS additions (main, solo, first)

**Files:** Modify `packages/core/src/patterns.ts` (THRESHOLDS block only).

| key                 | value | provenance comment                                                                                                                                |
| ------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `escalateBelow`     | 0.6   | PROVISIONAL — vendor confidence-routing: "<0.6 → human"; jev-use treats <0.70 as a guess. No local labeled data.                                  |
| `uncertainBandLow`  | 0.3   | PROVISIONAL, vendor-cited — consistency-noul cookbook maps [0.30, 0.70] → uncertain.                                                              |
| `uncertainBandHigh` | 0.7   | as above                                                                                                                                          |
| `pruneKeep`         | 0.5   | MEASURED cross-repo consensus (codex-context-diet + jev-pruner keepThreshold 0.5) — not a local plateau.                                          |
| `pruneDrop`         | 0.25  | MEASURED cross-repo (codex-context-diet dropThreshold 0.25, band-between-keeps).                                                                  |
| `pruneErrorDrop`    | 0.1   | MEASURED cross-repo (codex-context-diet error-shaped ≤0.1 to drop; jev-pruner ≤0.1 per segment).                                                  |
| `refute`            | 0.75  | PROVISIONAL conservative — no published measurement; false-removal >> false-keep loss (open-code-review filter prose). Calibrate before lowering. |
| `findingReal`       | 0.5   | PROVISIONAL — upstream has no threshold at all (severity enum only); coin-flip boundary until calibrated.                                         |

Test: extend the THRESHOLDS test in `packages/core/src/patterns.test.ts` — 8 keys present, exact values, `Object.isFrozen`.

### Task 1: `escalateOnLowConfidence` (core)

**Files:** Create `packages/core/src/patterns-escalate.ts` + `patterns-escalate.test.ts`.

**Interface (locked):**

```ts
export type EscalationOutcome = "accepted" | "escalated" | "unresolved";
export interface EscalationResult {
  outcome: EscalationOutcome;
  answers: Record<string, Answer>; // what the caller should act on (second's when escalated)
  first: Record<string, Answer>; // preserved first pass
  second?: Record<string, Answer>;
  gateScore: number;
  threshold: number;
  target: "second-config" | "fallback" | "none";
  escalated: boolean;
  error?: string;
}
export async function escalateOnLowConfidence(
  config: JevConfig,
  state: unknown,
  questions: Questions,
  options: {
    gateQuestionId: string;
    threshold?: number; // choice/score gate; default THRESHOLDS.escalateBelow
    band?: [number, number]; // noul gate; default [THRESHOLDS.uncertainBandLow, THRESHOLDS.uncertainBandHigh]
    secondConfig?: JevConfig;
    fallback?: (first: Record<string, Answer>) => Promise<Record<string, Answer>>;
    signal?: AbortSignal;
  },
): Promise<EscalationResult>;
```

**Decision table:**

- ONE batched first `askJev` (state + questions; the gate question is one of `questions`).
- Gate read: `noul` → `gateScore = p`, uncertain iff `band[0] <= p <= band[1]`; `choice`/`score` → `gateScore = confidence`, uncertain iff `< threshold`. Gate id absent → `unresolved`, `error:"gate-question-missing"`, first answers still returned.
- Not uncertain → `accepted`.
- Uncertain → target priority: `secondConfig` (re-asks SAME questions, anchor-free: NO first answers passed — SDE recipe re-extracts from original input), else `fallback(first)`, else `unresolved`/`error:"no-escalation-target"`.
- Second pass transport error → `unresolved` with `error`, `first` preserved (escalation failure never loses the first result).
- Exactly one escalation attempt (no loops).
  **Named tests:** accepted-confident-choice; accepted-noul-outside-band; escalated-secondConfig (assert second request carried same questions and NOT first answers); escalated-fallback; unresolved-missing-gate; unresolved-no-target; unresolved-second-throws-first-survives; threshold/band-override; single-request-when-accepted.

### Task 2: `pruneContext` (core)

**Files:** Create `packages/core/src/patterns-prune.ts` + `patterns-prune.test.ts`.

**Interface (locked):**

```ts
export interface PruneCandidate {
  id: string;
  text: string;
  kind?: "output" | "error" | "diagnostic";
}
export interface PruneDecision {
  id: string;
  keep: boolean;
  score: number;
  chars: number;
  replacement?: string; // present iff keep === false
  omittedChars?: number;
}
export async function pruneContext(
  config: JevConfig,
  items: readonly PruneCandidate[],
  options?: {
    keepThreshold?: number;
    dropThreshold?: number;
    errorDropThreshold?: number;
    headChars?: number;
    minChars?: number;
    protect?: (item: PruneCandidate) => boolean;
    maxItemsPerRequest?: number;
    maxStateTokens?: number;
    signal?: AbortSignal;
  },
): Promise<{ decisions: PruneDecision[]; deferred: boolean; reason?: string }>;
```

**Defaults:** keep/drop/errorDrop = `THRESHOLDS.prune*`; headChars=300; minChars=2000; maxItemsPerRequest=64; maxStateTokens=25000.
**Semantics:**

- Guard first: `JSON.stringify(items).length / 4 > maxStateTokens` → all-keep `deferred:true, reason:"state-too-large"`, ZERO requests (Astro-Han failure: 39.5M chars → Jev HTTP 400 → fail-open shipped 15.8M tokens onward).
- `protect(item)` or `text.length < minChars` → keep, `score: 1`, NO question asked.
- Rest: one noul per id, batched ≤ maxItemsPerRequest; question: does the model still need this item's CONTENTS to continue, or can the turn proceed with a bounded preview? Stricter wording for `error`/`diagnostic` kinds.
- Missing/malformed answer → KEEP (local read helper; do NOT reuse `scoreQuestions` "zero" — zero means drop here).
- Drop iff `score < keepThreshold && score <= (errorLike ? errorDropThreshold : dropThreshold)`.
- Drop → `replacement = text.slice(0, headChars) + "\n[... N chars omitted by jev prune; id=<id> — original retained by caller]"`.
- Never mutate input; band failures keep.
  **Named tests:** drop+replacement-exact; keep-in-band; error-kind-needs-errorDrop; minChars-no-request; protect-veto; missing-keeps; oversized-defers-zero-requests; batching-70→2-requests index-aligned; input-unchanged.

### Task 3: `findingRealness` + `refutationFilter` (core)

**Files:** Create `packages/core/src/patterns-review.ts` + `patterns-review.test.ts`.

**Interfaces (locked):**

```ts
export interface ReviewFinding {
  path: string;
  content: string;
  existingCode?: string;
  suggestionCode?: string;
  severity?: string;
  category?: string;
  diff?: string;
  context?: string;
}
export async function findingRealness(
  config: JevConfig,
  finding: ReviewFinding,
  options?: { threshold?: number; signal?: AbortSignal },
): Promise<{ realness: number; report: boolean; severity: string; severityProvided: boolean }>;
export async function refutationFilter(
  config: JevConfig,
  findings: readonly ReviewFinding[],
  options?: { refutedThreshold?: number; evidence?: string; signal?: AbortSignal },
): Promise<{
  refuted: Array<{ index: number; score: number; reason: string }>;
  kept: Array<{ index: number; score: number; protectedSubject: boolean }>;
  scores: Array<{
    index: number;
    probability: number;
    cls: string | null;
    protectedSubject: boolean;
  }>;
}>;
```

**findingRealness:** ONE request, TWO questions — noul `realness` ("does this finding describe a real problem a reviewer should see — not a style nit or already-fixed issue?"; state = path/content/existingCode/suggestionCode/diff/context) + choice `severity` over `{critical, high, medium, low, not-an-issue}`. `report = realness >= threshold` (default `THRESHOLDS.findingReal`). Missing/malformed `realness` → `realness:-1`, `report:false`, severity untouched (unjudged marker). `severityProvided` reflects whether the caller supplied one — upstream silently coerces unknown→`low` (`code_comment.go:184-190`); we never do.
**refutationFilter:** batched ≤32/request. Per finding: noul `refute_i` ("is this finding disproven by the evidence/diff — would a careful reviewer conclude it does not apply?") + choice `class_i` over `{memory-safety, concurrency, linkage, behavioural-change, unused-param, ordinary}` (first five = protected, from open-code-review filter prose). **Drop iff `refute_i >= refutedThreshold` (default `THRESHOLDS.refute`) AND NOT protected.** Missing/malformed `refute_i` → keep. High refute + missing/malformed `class_i` → keep (veto unproven ⇒ conservative). `evidence` appended to state once.
**Named tests:** realness-below/above; missing-realness→-1+false+severity-untouched; severity-choice-incl-not-an-issue; refute-below/above; protected-survives; missing-refute-keeps; high-refute-missing-class-keeps; batching>32; input-unchanged.

### Task 4: index exports + full core gate (main, after Tasks 1-3)

`packages/core/src/index.ts` += `export * from "./patterns-escalate.js";` `...-prune` `...-review`. Full build/typecheck/test. Commit Tasks 0-4 as one commit.

### Task 5: MCP exposure (wave 2)

**Files:** `packages/mcp/src/server.ts`, `server.test.ts`, `README.md`.
Four tools following the `jev_classify` precedent exactly (schema style, envelope, `handleTool` case): `jev_escalate` (state, questions, gateQuestionId, threshold?, secondModel? → result; secondModel resolved to a JevConfig via existing config plumbing — unresolvable → `target:"none"` reported honestly), `jev_prune`, `jev_finding_realness`, `jev_refute`. Injected-fetch tests: happy path each + fail-open cases (prune oversized defer, refute missing keeps). README: 4 rows + sections with defaults + PROVISIONAL warnings.

### Task 6: OMP `tool_result` prune hook (wave 2, batched with Task 5)

**Files:** `packages/omp/src/prune.ts` (new) + `prune.test.ts`; register in `extension.ts`; `README.md`; rebuild `bundle/extension.js`.

- Host shape (verified in `dist/types/extensibility/extensions/types.d.ts`): `ToolResultEventBase {type:"tool_result", toolCallId, input, content, isError}` → result `{content?, details?, isError?}`.
- Enable: `OMP_JEV_PRUNE=1` EXPLICIT — NOT under the `OMP_JEV_AUTO` master (default off; docs: cache invalidation + per-result latency).
- Flow: (1) idempotency — text contains `omitted by jev prune` → undefined; (2) HARD CAP text > 200_000 chars → do NOT call Jev (HTTP 400 risk); local head+tail cap with `[locally capped …]` note; (3) < minChars → undefined; (4) else `pruneContext` with `kind = isError ? "error" : "output"`, signal = `withDeadline(ctx.signal, GATE_DEADLINE_MS)`; deferred/keep → undefined; drop → `{content:[{type:"text", text: replacement}]}`.
- Fail-open: any throw → undefined (host keeps original). Refusal ledger key `prune:*`.
- README: opt-in, +200-400ms/result, provider prompt-cache invalidation warning, recovery contract (original retained; marker id = toolCallId).
- Rebuild bundle; assert 0 bare imports.

### Task 7: Docs + changeset + integration (main)

- `packages/core/README.md`: 4 rows + sections (escalate tri-state; prune non-destructive + PROVISIONAL flags; review loss asymmetry).
- `AGENTS.md`: one-liners in the `@packages/core` / `@packages/omp` bullets; note Python port lacks these four (parity follow-up).
- Changeset: core minor, omp minor, mcp minor.
- Full gates + bundle self-containment + pytest. Commit, push, CI watch.

## Self-Review

1. **Spec coverage:** escalate T1 ✓ prune T2 ✓ review T3 ✓ OMP prune T6 ✓ MCP T5 ✓ docs T7 ✓ thresholds T0 ✓. Escalate host wiring intentionally absent: gate `confirm` already exists; a second host model target is a recorded follow-up, not fabricated.
2. **Placeholder scan:** every task carries signatures, defaults, decision tables, named tests — no TBDs.
3. **Type consistency:** `EscalationResult` fields match T1 tests; `PruneDecision.replacement` only on drop; `findingRealness.severityProvided` in return + tests.
