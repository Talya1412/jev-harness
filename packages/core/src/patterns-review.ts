/**
 * Review-flow patterns: is a finding real enough to report, and does the
 * evidence refute it?
 *
 * Both functions exist because upstream (open-code-review) mishandles the two
 * soft spots of a review filter, and BOTH BARS ARE PROVISIONAL in
 * THRESHOLDS (`findingReal`, `refute`) until someone records a labeled
 * dataset and re-measures:
 *
 * - The filter's loss function lives in prose (`review_filter_task_system.md`):
 *   removing a true finding costs far more than keeping a false one, so both
 *   gates fail toward KEEP and never invent a verdict.
 * - `code_comment.go:184-190` silently coerces an unknown severity to "low".
 *   We never coerce: an unreadable answer means "unjudged" (-1, or the
 *   caller's own value), never a fabricated number or label.
 */
import {
  askJev,
  choice,
  noul,
  type JevConfig,
  type JevResponse,
  type Questions,
} from "./client.js";
import { THRESHOLDS } from "./patterns.js";

/** Max chars of a finding path forwarded (mirrors core's small field caps). */
const PATH_CHARS = 500;
/** Max chars of content/patched-code blobs forwarded — code rides in the 4000–8000 band core uses elsewhere, picked mid-band. */
const CONTENT_CHARS = 6_000;
/** Max chars of the referenced diff forwarded (same band as content). */
const DIFF_CHARS = 6_000;
/** Max chars of surrounding context forwarded — context is auxiliary, so it gets the smallest of the prose caps. */
const CONTEXT_CHARS = 2_000;
/** Max findings per request: 32 findings × 2 questions = 64, the same per-request question budget rankCandidates caps at. */
const MAX_BATCH = 32;

/** The five severity labels. Surfaced verbatim — never coerced, never invented. */
const SEVERITY_LABELS: Record<string, string> = {
  critical: "Data loss, security, or core functionality broken; must fix before merge.",
  high: "Significant defect a user will hit, no easy workaround.",
  medium: "Real defect with a workaround, or a notable robustness gap.",
  low: "Minor defect worth fixing but not blocking.",
  "not-an-issue": "Not a defect: a style nit, an already-fixed issue, or a false premise.",
};

/**
 * The closed class taxonomy. The first five are protected subjects — they
 * survive even a high refutation (open-code-review filter prose); only
 * `ordinary` findings are droppable.
 */
const PROTECTED_CLASSES = [
  "memory-safety",
  "concurrency",
  "linkage",
  "behavioural-change",
  "unused-param",
] as const;
const CLASS_LABELS: Record<string, string> = {
  "memory-safety": "Memory corruption, bounds, lifetime, or unsafe-code hazards.",
  concurrency: "Races, deadlocks, and unsynchronised shared state.",
  linkage: "Build, import, manifest, or dependency breakage.",
  "behavioural-change": "Changes what the code does: semantics, output, or public API.",
  "unused-param": "A parameter or field accepted but never used.",
  ordinary: "An ordinary defect with no special protection.",
};
const PROTECTED_SET: ReadonlySet<string> = new Set<string>(PROTECTED_CLASSES);
const CLASS_KEYS: ReadonlySet<string> = new Set(Object.keys(CLASS_LABELS));

/** One fixed sentence per diagnosis (repo refusal-ledger convention: debuggable, coalescable, never templated per row). */
const REFUTED_REASON = "Disproved above bar and classed ordinary, not a protected subject.";

/** The realness judgment, verbatim from the plan. */
const REALNESS_TEXT =
  "does this finding describe a real problem a reviewer should see — not a style nit or already-fixed issue?";
const SEVERITY_TEXT = "If this finding is real, which severity would a reviewer assign it?";
/** The refutation judgment, verbatim from the plan (prefixed with the finding index — state is shared across the batch). */
const REFUTE_TEXT =
  "is this finding disproven by the evidence/diff — would a careful reviewer conclude it does not apply?";
const CLASS_TEXT = "classify its category for the review filter.";

/**
 * Read a noul answer tolerantly: `noul()` throws on a missing or malformed
 * answer, and both patterns here need "unjudged" to stay a value instead of
 * failing the call.
 */
function readNoul(response: JevResponse, id: string): number | null {
  try {
    const v = noul(response, id);
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** Read a choice answer tolerantly; any unreadable answer is `null`, never a label we made up. */
function readChoice(response: JevResponse, id: string): string | null {
  try {
    const v = choice(response, id).choice;
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Serialize one finding for state, capping every field (path 500, content/code 6000, diff 6000, context 2000). */
function serializeFinding(finding: ReviewFinding, index?: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (index !== undefined) out.index = index;
  out.path = finding.path.slice(0, PATH_CHARS);
  out.content = finding.content.slice(0, CONTENT_CHARS);
  if (finding.existingCode !== undefined)
    out.existingCode = finding.existingCode.slice(0, CONTENT_CHARS);
  if (finding.suggestionCode !== undefined)
    out.suggestionCode = finding.suggestionCode.slice(0, CONTENT_CHARS);
  if (finding.diff !== undefined) out.diff = finding.diff.slice(0, DIFF_CHARS);
  if (finding.context !== undefined) out.context = finding.context.slice(0, CONTEXT_CHARS);
  return out;
}

/** One finding as review input. `severity`/`category` are caller-side metadata: never sent — we re-judge them instead of anchoring on them. */
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

/**
 * Is this finding real enough for a reviewer to see? ONE request, TWO
 * questions (noul `realness` + choice `severity`).
 *
 * Fail-open on unreadable judgments: missing/malformed `realness` returns
 * `realness:-1, report:false` — -1 is an unjudged marker, never a
 * probability — and `severity` stays untouched (the caller's own value or
 * ""), while `severityProvided` records whether the caller supplied one.
 * Upstream coerces unknown severities to "low" (code_comment.go:184-190);
 * we pass the model's label through verbatim instead.
 */
export async function findingRealness(
  config: JevConfig,
  finding: ReviewFinding,
  options?: { threshold?: number; signal?: AbortSignal },
): Promise<{ realness: number; report: boolean; severity: string; severityProvided: boolean }> {
  const threshold = options?.threshold ?? THRESHOLDS.findingReal;
  const severityProvided = typeof finding.severity === "string" && finding.severity.length > 0;
  const severityFallback = severityProvided ? String(finding.severity) : "";

  const response = await askJev(
    config,
    serializeFinding(finding),
    {
      realness: { type: "noul", instructions: REALNESS_TEXT },
      severity: { type: "choice", instructions: SEVERITY_TEXT, criteria: SEVERITY_LABELS },
    },
    options?.signal,
  );

  const realness = readNoul(response, "realness");
  if (realness === null) {
    return { realness: -1, report: false, severity: severityFallback, severityProvided };
  }
  const severity = readChoice(response, "severity") ?? severityFallback;
  return { realness, report: realness >= threshold, severity, severityProvided };
}

/** Internal row shape behind the public `scores` array. */
type RefuteScore = {
  index: number;
  probability: number;
  cls: string | null;
  protectedSubject: boolean;
};

/**
 * Drop refuted findings, keep everything else — conservatively.
 *
 * Batched: ≤32 findings per request (≤64 questions), index-aligned via
 * `refute_i`/`class_i` ids and an `index` field in each state row.
 * DROP iff `refute_i >= refutedThreshold` (default `THRESHOLDS.refute`,
 * PROVISIONAL) AND the class is proven unprotected — and otherwise:
 *
 * - missing/malformed `refute_i` → keep (unjudged is not a verdict);
 * - high refute + missing/malformed `class_i` → keep (the veto is
 *   unproven, per the prose loss function in review_filter_task_system.md —
 *   a class outside the closed taxonomy counts as malformed, not "not
 *   protected");
 * - `evidence` rides ONCE at the top of the shared state, never copied
 *   into each finding row.
 *
 * `reason` is one fixed sentence per diagnosis (refusal-ledger convention).
 */
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
}> {
  const threshold = options?.refutedThreshold ?? THRESHOLDS.refute;
  if (findings.length === 0) return { refuted: [], kept: [], scores: [] };

  const baseState: Record<string, unknown> = {};
  if (options?.evidence) baseState.evidence = options.evidence;

  const scores: RefuteScore[] = [];
  for (let start = 0; start < findings.length; start += MAX_BATCH) {
    const end = Math.min(start + MAX_BATCH, findings.length);
    const questions: Questions = {};
    for (let i = start; i < end; i++) {
      questions[`refute_${i}`] = { type: "noul", instructions: `Finding ${i}: ${REFUTE_TEXT}` };
      questions[`class_${i}`] = {
        type: "choice",
        instructions: `Finding ${i}: ${CLASS_TEXT}`,
        criteria: CLASS_LABELS,
      };
    }
    const state = {
      ...baseState,
      findings: findings
        .slice(start, end)
        .map((finding, j) => serializeFinding(finding, start + j)),
    };
    const response = await askJev(config, state, questions, options?.signal);
    for (let i = start; i < end; i++) {
      const refute = readNoul(response, `refute_${i}`);
      const rawClass = readChoice(response, `class_${i}`);
      const cls = rawClass !== null && CLASS_KEYS.has(rawClass) ? rawClass : null;
      scores.push({
        index: i,
        probability: refute ?? -1,
        cls,
        protectedSubject: cls !== null && PROTECTED_SET.has(cls),
      });
    }
  }

  const refuted: Array<{ index: number; score: number; reason: string }> = [];
  const kept: Array<{ index: number; score: number; protectedSubject: boolean }> = [];
  for (const s of scores) {
    // Drop rule: judged at/above the refutation bar AND class proven unprotected.
    const disproven = s.probability >= 0 && s.probability >= threshold;
    if (disproven && s.cls !== null && !s.protectedSubject) {
      refuted.push({ index: s.index, score: s.probability, reason: REFUTED_REASON });
    } else {
      kept.push({ index: s.index, score: s.probability, protectedSubject: s.protectedSubject });
    }
  }
  return { refuted, kept, scores };
}
