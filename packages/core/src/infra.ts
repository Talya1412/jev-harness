/**
 * Transport-level infrastructure: caching, batching, audit logging, and a
 * local fallback router. None of these change Jev's decision logic; they make
 * the same decisions cheaper, more observable, and resilient when Jev is down.
 *
 * Everything here wraps `JevConfig.fetchImpl` (or is a pure function), so it
 * composes with every harness adapter without touching decision code — the
 * same separation AGENTS.md enforces for patterns.
 */
import { askJev } from "./client.js";
import type {
  Answer,
  JevConfig,
  JevResponse,
  Question,
  Questions,
} from "./types.js";
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
    const key = String(url) + "\n" + String(init?.body ?? "");
    const hit = cache.get(key);
    if (hit !== undefined) {
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

    const merged: Record<string, Question> = {};
    const maps = snapshot.map((s, i): { prefix: string; orig: string[]; resolve: Pending["resolve"]; reject: Pending["reject"] } => {
      const prefix = `c${i}__`;
      const orig: string[] = [];
      for (const [k, q] of Object.entries(s.questions)) {
        const nk = prefix + k;
        merged[nk] = q as Question;
        orig.push(k);
      }
      return { prefix, orig, resolve: s.resolve, reject: s.reject };
    });

    try {
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
      for (const { reject } of maps) reject(err);
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
      void flush().catch(() => {});
    });
  }

  return {
    add(questions) {
      return new Promise<JevResponse>((resolve, reject) => {
        pending.push({ questions, resolve, reject });
        schedule();
      });
    },
    flush,
  };
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
export function createAuditLog(opts: { sink?: (e: AuditEntry) => void } = {}): AuditLog {
  const entries: AuditEntry[] = [];
  return {
    record(e) {
      entries.push(e);
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
      body = init?.body ? (JSON.parse(String(init.body)) as { state?: unknown; questions?: Questions }) : undefined;
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
export function localRouteSkill(message: string, skills: SkillCandidate[]): { skill: string | null; score: number } {
  const m = tokenize(message);
  let best: { name: string; score: number } | null = null;
  for (const s of skills.slice(0, 50)) {
    const desc = tokenize((s.name + " " + (s.description ?? "")).trim());
    const sc = overlap(m, desc);
    if (!best || sc > best.score) best = { name: s.name, score: sc };
  }
  if (!best || best.score < 0.05) return { skill: null, score: best?.score ?? 0 };
  return { skill: best.name, score: best.score };
}
