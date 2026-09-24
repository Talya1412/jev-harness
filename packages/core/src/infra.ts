/**
 * Transport-level infrastructure: caching, batching, audit logging, and a
 * local fallback router. None of these change Jev's decision logic; they make
 * the same decisions cheaper, more observable, and resilient when Jev is down.
 *
 * Everything here wraps `JevConfig.fetchImpl` (or is a pure function), so it
 * composes with every harness adapter without touching decision code — the
 * same separation AGENTS.md enforces for patterns.
 */
import { askJev, validateQuestions } from "./client.js";
import type { Answer, JevConfig, JevResponse, Question, Questions } from "./types.js";
import { THRESHOLDS } from "./patterns.js";
import type { SkillCandidate } from "./patterns.js";

// ----------------------------- caching -----------------------------

export interface CacheOptions {
  /** Max entries before LRU-style eviction (oldest first). Default 256. */
  maxEntries?: number;
  /** Called on every cache hit. Useful for tests and metrics. */
  onHit?: (key: string) => void;
}

/**
 * Memoize identical Jev calls by request body. noul/choice answers are
 * deterministic for the same input, so a repeat ask within a run is free. This
 * is the cost lever the README already pulls by refusing mid-stream model
 * switches — caching is the natural complement: never pay twice for the same
 * decision.
 */
export function withCache(config: JevConfig, opts: CacheOptions = {}): JevConfig {
  const max = opts.maxEntries ?? 256;
  const cache = new Map<string, string>();
  const parent = config.fetchImpl ?? fetch;

  const wrapped: typeof fetch = async (url, init) => {
    // The models endpoint is keyed by auth, not body — a shared body-keyed
    // cache would serve one key's model list to another. Pass it through.
    if (String(url).endsWith("/v1/models")) return parent(url, init);
    const key = String(url) + "\n" + String(init?.body ?? "");
    const hit = cache.get(key);
    if (hit !== undefined) {
      // True LRU: refresh recency on hit so hot entries survive.
      cache.delete(key);
      cache.set(key, hit);
      opts.onHit?.(key);
      return new Response(hit, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const res = await parent(url, init);
    if (res.ok) {
      const text = await res.clone().text();
      if (cache.size >= max) {
        const first = cache.keys().next().value;
        if (first !== undefined) cache.delete(first);
      }
      cache.set(key, text);
    }
    return res;
  };

  return { ...config, fetchImpl: wrapped };
}

// ----------------------------- batching -----------------------------

export interface BatchHandle {
  /**
   * Enqueue a question-set against the shared state. Resolves with a response
   * containing ONLY this call's questions (de-namespaced), so callers look
   * identical to a direct `askJev` call.
   */
  add(questions: Questions): Promise<JevResponse>;
  /** Fire everything pending immediately. Returns the merged raw response. */
  flush(): Promise<JevResponse>;
}

/**
 * Batch independent question-sets against ONE shared state into a single Jev
 * call. The README's "batching is nearly free" is exactly this: every question
 * is evaluated independently against the same state, so N callers can share one
 * request when their state happens to coincide.
 *
 * Each caller still writes code as if it made its own call: `add` returns a
 * promise for a response scoped to that caller's keys.
 */
export function jevBatch(config: JevConfig, state: unknown, signal?: AbortSignal): BatchHandle {
  type Pending = {
    questions: Questions;
    resolve: (r: JevResponse) => void;
    reject: (e: unknown) => void;
  };
  const pending: Pending[] = [];
  let scheduled = false;

  async function flush(): Promise<JevResponse> {
    scheduled = false;
    const snapshot = pending.splice(0);
    if (snapshot.length === 0) return { model: "jev-batch", answers: {} };

    try {
      const merged: Record<string, Question> = {};
      const maps = snapshot.map(
        (
          s,
          i,
        ): {
          prefix: string;
          orig: string[];
          resolve: Pending["resolve"];
          reject: Pending["reject"];
        } => {
          const prefix = `c${i}__`;
          const orig: string[] = [];
          for (const [k, q] of Object.entries(s.questions)) {
            const nk = prefix + k;
            merged[nk] = q as Question;
            orig.push(k);
          }
          return { prefix, orig, resolve: s.resolve, reject: s.reject };
        },
      );
      const response = await askJev(config, state, merged as unknown as Questions, signal);
      for (const { prefix, orig, resolve } of maps) {
        const answers: Record<string, Answer> = {};
        for (const k of orig) {
          const a = response.answers[prefix + k];
          if (a !== undefined) answers[k] = a;
        }
        resolve({ model: response.model, answers, usage: response.usage });
      }
      return response;
    } catch (err) {
      // Route the failure to every queued caller so all promises settle;
      // the direct flush() caller still observes it via the rethrow, while
      // the scheduled fire-and-forget path has its own catch below.
      for (const { reject } of snapshot) reject(err);
      throw err;
    }
  }

  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    // Flush on the next microtask so several synchronous `add` calls merge.
    // The flush promise is fire-and-forget here: each caller is rejected (or
    // resolved) directly inside flush, so an unhandled rejection on this path
    // would be noise rather than signal. Callers that want the error must use
    // the returned `flush()` directly.
    queueMicrotask(() => {
      // flush() already rejects every queued caller on failure; this catch
      // only settles the fire-and-forget promise itself (direct flush()
      // callers still receive the error via their own await).
      void flush().catch(() => {});
    });
  }

  return {
    add(questions) {
      return new Promise<JevResponse>((resolve, reject) => {
        // Validate up front so misuse rejects this caller with a typed usage
        // error instead of failing the whole merged batch inside flush.
        try {
          validateQuestions(questions);
        } catch (err) {
          reject(err);
          return;
        }
        pending.push({ questions, resolve, reject });
        schedule();
      });
    },
    flush,
  };
}

// ----------------------------- map-reduce -----------------------------

/** Max per-item digests fed into the reduce state. */
const MAX_REDUCE_ITEMS = 200;
/** Max chars of the reduce state; a huge corpus must not blow the request. */
const MAX_REDUCE_CHARS = 4_000;
/** Default in-flight item judgments. Jev bills per request, not per question. */
const DEFAULT_MAP_CONCURRENCY = 4;

export interface MapReduceOptions {
  /**
   * Optional final judgment over the collected per-item answers. The reduce
   * state is a compact digest of those answers — never the corpus itself.
   */
  reduce?: {
    instructions: string;
    criteria: Record<string, string> | string[];
    /** Defaults to `score` for an array of levels, `choice` for a keyed map. */
    type?: "noul" | "choice" | "score";
  };
  /** Item judgments in flight at once. Default 4. */
  concurrency?: number;
  signal?: AbortSignal;
}

/** One line per answer — a verdict plus a confidence, never the source text. */
function compactAnswer(answer: Answer | undefined): string {
  if (!answer || typeof answer !== "object") return "missing";
  if (answer.type === "noul") return `noul ${answer.noul.toFixed(2)}`;
  if (answer.type === "choice")
    return `choice ${answer.choice} (${(answer.confidence ?? 0).toFixed(2)})`;
  if (answer.type === "score")
    return `score ${answer.score} (${(answer.confidence ?? 0).toFixed(2)})`;
  return "missing";
}

/**
 * Build the reduce state: an index-aligned digest of the per-item answers,
 * capped so a 10k-item corpus cannot blow the request. The corpus and the
 * per-item questions never appear here — the reduce model sees verdicts, which
 * is both cheaper and the only thing it needs to synthesize over.
 */
function buildReduceState(perItem: Array<Record<string, Answer>>): Record<string, unknown> {
  const lines: string[] = [];
  let chars = 0;
  let omitted = 0;
  for (let i = 0; i < perItem.length; i++) {
    if (lines.length >= MAX_REDUCE_ITEMS) {
      omitted = perItem.length - i;
      break;
    }
    const answers = perItem[i] ?? {};
    const ids = Object.keys(answers);
    const digest =
      ids.length === 0
        ? "no answer"
        : ids.map((id) => `${id}: ${compactAnswer(answers[id])}`).join("; ");
    const line = `[${i}] ${digest}`;
    if (chars + line.length > MAX_REDUCE_CHARS) {
      omitted = perItem.length - i;
      break;
    }
    lines.push(line);
    chars += line.length + 1;
  }
  const state: Record<string, unknown> = {
    item_count: perItem.length,
    answers: lines,
  };
  if (omitted > 0) state.omitted_items = omitted;
  return state;
}

/**
 * Run the same questions over every item, then optionally reduce the answers.
 *
 * This is the dominant real-world Jev workload: "the same judgment over a huge
 * corpus" (triage every file, score every doc, classify every log line). The
 * map half is `buildQuestions` per item with bounded concurrency; the reduce
 * half is ONE extra call whose state is the digest of the per-item answers, so
 * the reduce cost stays flat as the corpus grows.
 *
 * `perItem` is index-aligned with `items`. Errors from any item reject the
 * whole call — fail-open belongs at the caller, next to the decision it guards.
 * An empty `items` short-circuits without spending a request.
 */
export async function withMapReduce<T>(
  config: JevConfig,
  items: readonly T[],
  buildQuestions: (item: T, index: number) => Questions,
  options: MapReduceOptions = {},
): Promise<{ perItem: Array<Record<string, Answer>>; reduced: Answer | null }> {
  if (items.length === 0) return { perItem: [], reduced: null };
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_MAP_CONCURRENCY);

  const perItem: Array<Record<string, Answer>> = new Array(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      const response = await askJev(
        config,
        { item: items[index], index, total: items.length },
        buildQuestions(items[index], index),
        options.signal,
      );
      perItem[index] = response.answers ?? {};
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));

  if (!options.reduce) return { perItem, reduced: null };

  const { instructions, criteria, type } = options.reduce;
  const resolvedType = type ?? (Array.isArray(criteria) ? "score" : "choice");
  const question: Question =
    resolvedType === "noul"
      ? {
          type: "noul",
          instructions,
          criteria: Array.isArray(criteria) ? criteria.join("; ") : criteria,
        }
      : resolvedType === "score"
        ? {
            type: "score",
            instructions,
            criteria: Array.isArray(criteria) ? criteria : Object.values(criteria),
          }
        : {
            type: "choice",
            instructions,
            criteria: Array.isArray(criteria)
              ? criteria.reduce<Record<string, string>>((acc, level, i) => {
                  acc[`option_${i}`] = level;
                  return acc;
                }, {})
              : criteria,
          };

  const response = await askJev(
    config,
    buildReduceState(perItem),
    { reduced: question } as Questions,
    options.signal,
  );
  return { perItem, reduced: response.answers?.reduced ?? null };
}

// ----------------------------- audit -----------------------------

export interface AuditEntry {
  ts: number;
  url: string;
  state?: unknown;
  questions?: Questions;
  ok: boolean;
  status?: number;
  answers?: Record<string, Answer>;
  elapsedMs: number;
  error?: string;
}

export interface AuditLog {
  record(entry: AuditEntry): void;
  all(): AuditEntry[];
  drain(): AuditEntry[];
  size(): number;
}

/**
 * Append-only decision log. Provenance for every Jev call — essential when
 * "advisory" outputs feed a process that can be audited. In-memory by default;
 * pass a `sink` to mirror to a file, OTel, or your DB.
 */
export function createAuditLog(
  opts: { sink?: (e: AuditEntry) => void; maxEntries?: number } = {},
): AuditLog {
  const maxEntries = Math.max(1, opts.maxEntries ?? 1000);
  const entries: AuditEntry[] = [];
  return {
    record(e) {
      entries.push(e);
      if (entries.length > maxEntries) entries.splice(0, entries.length - maxEntries);
      opts.sink?.(e);
    },
    all() {
      return [...entries];
    },
    drain() {
      const out = [...entries];
      entries.length = 0;
      return out;
    },
    size() {
      return entries.length;
    },
  };
}

/**
 * Wrap a config so every Jev call is recorded to `log`. Observes at the
 * transport layer, so it captures decisions from ANY pattern or direct
 * `askJev` call — no per-pattern retrofit needed.
 */
export function withAudit(config: JevConfig, log: AuditLog): JevConfig {
  const parent = config.fetchImpl ?? fetch;
  const wrapped: typeof fetch = async (url, init) => {
    const started = Date.now();
    const u = String(url);
    let body: { state?: unknown; questions?: Questions } | undefined;
    try {
      body = init?.body
        ? (JSON.parse(String(init.body)) as { state?: unknown; questions?: Questions })
        : undefined;
    } catch {
      body = undefined;
    }
    try {
      const res = await parent(url, init);
      let answers: Record<string, Answer> | undefined;
      if (res.ok) {
        try {
          const cloned = await res.clone().json();
          answers = (cloned as { answers?: Record<string, Answer> }).answers ?? undefined;
        } catch {
          answers = undefined;
        }
      }
      log.record({
        ts: started,
        url: u,
        state: body?.state,
        questions: body?.questions,
        ok: res.ok,
        status: res.status,
        answers,
        elapsedMs: Date.now() - started,
      });
      return res;
    } catch (err) {
      log.record({
        ts: started,
        url: u,
        state: body?.state,
        questions: body?.questions,
        ok: false,
        elapsedMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };
  return { ...config, fetchImpl: wrapped };
}

// ----------------------------- refusals -----------------------------

export interface RefusalEntry {
  /** What was refused (a tool name, an action, a target path). */
  key: string;
  /** Why, as one fixed sentence per diagnosis. */
  reason: string;
  /** When this refusal was last recorded, in ms since epoch. */
  at: number;
  /** How many times this exact (key, reason) refusal has been recorded. */
  count: number;
}

export interface RefusalLedger {
  /** Record a refusal. Repeats of the same (key, reason) fold into one entry with an incrementing count. */
  record(key: string, reason: string, at?: number): void;
  entries(): readonly RefusalEntry[];
}

/** Distinct refusals retained before the oldest is dropped. */
const DEFAULT_REFUSAL_MAX = 200;

/**
 * Ledger of refused actions, folded by exact `(key, reason)`.
 *
 * A refusal has to explain itself with ONE fixed sentence per diagnosis, and
 * never the same sentence twice: the caller reading the ledger wants the
 * distinct reasons, not 400 repetitions of "cannot resolve target". Repeats
 * therefore coalesce into the original entry and only bump `count` — which
 * keeps the signal (did this keep happening?) without the noise.
 *
 * Retention is capped at `max` distinct entries, newest kept; the oldest are
 * dropped because a frequent schedule would otherwise bury its own real
 * history under routine refusals. `at` is the most recent occurrence, so a
 * folded entry still sorts as current.
 */
export function createRefusalLedger(
  options: { now?: () => number; max?: number } = {},
): RefusalLedger {
  const now = options.now ?? Date.now;
  const max = Math.max(1, options.max ?? DEFAULT_REFUSAL_MAX);
  const entries: RefusalEntry[] = [];
  const byKey = new Map<string, RefusalEntry>();

  return {
    record(key, reason, at) {
      const when = at ?? now();
      const folded = byKey.get(`${key}\u0000${reason}`);
      if (folded) {
        folded.count++;
        folded.at = when;
        return;
      }
      const entry: RefusalEntry = { key, reason, at: when, count: 1 };
      byKey.set(`${key}\u0000${reason}`, entry);
      entries.push(entry);
      while (entries.length > max) {
        const dropped = entries.shift();
        if (dropped) byKey.delete(`${dropped.key}\u0000${dropped.reason}`);
      }
    },
    entries() {
      return entries.map((e) => Object.freeze({ ...e }));
    },
  };
}

// ----------------------------- local fallback -----------------------------

const TOKEN_RE = /[a-z0-9]+/g;

function tokenize(s: string): Set<string> {
  return new Set(s.toLowerCase().match(TOKEN_RE) ?? []);
}

/** Cosine-ish overlap on boolean token vectors, 0..1. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return hit / Math.sqrt(a.size * b.size);
}

/**
 * Local keyword-overlap router. NOT a substitute for Jev — but when Jev is
 * unreachable and a hook must still route (fail-open with a graceful quality
 * floor), this is better than "always pick the first skill". Use it in a catch
 * around `routeSkill`:
 *
 *   try { return await routeSkill(config, msg, skills); }
 *   catch { return localRouteSkill(msg, skills); }
 */
export function localRouteSkill(
  message: string,
  skills: SkillCandidate[],
): { skill: string | null; score: number } {
  const m = tokenize(message);
  let best: { name: string; score: number } | null = null;
  for (const s of skills.slice(0, 50)) {
    const desc = tokenize((s.name + " " + (s.description ?? "")).trim());
    const sc = overlap(m, desc);
    if (!best || sc > best.score) best = { name: s.name, score: sc };
  }
  if (!best || best.score < THRESHOLDS.localRouterFloor)
    return { skill: null, score: best?.score ?? 0 };
  return { skill: best.name, score: best.score };
}
