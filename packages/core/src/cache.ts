/**
 * Response caching and request coalescing for repeated Jev judgments.
 *
 * Hooks like the destructive gate fire on every tool call and often see the
 * same state over and over; a short-lived cache turns repeats into free hits.
 * The coalescer merges concurrent `ask` calls that share the same state into
 * ONE HTTP request — Jev evaluates each question independently against the
 * same state, so a merged request answers all of them at batch pricing.
 *
 * Both are process-local, advisory, and purely an optimization: clearing them
 * at any time never changes correctness, only cost and latency.
 */
import {
  askJev,
  validateQuestions,
  type JevConfig,
  type JevResponse,
  type Questions,
} from "./client.js";

/** Deterministic JSON stringify (object keys sorted) so equal states hash equal. */
export function stableStringify(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) out[k] = walk(obj[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

/** FNV-1a 32-bit hash as hex. Not cryptographic — identity only, never security. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function clone<T>(value: T): T {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : (JSON.parse(JSON.stringify(value)) as T);
}

export interface JevCache {
  get(key: string): JevResponse | undefined;
  set(key: string, response: JevResponse): void;
  delete(key: string): void;
  clear(): void;
  readonly size: number;
}

/** Bounded, TTL-expiring response cache. Oldest entry is evicted when full. */
export function createJevCache(opts: { ttlMs?: number; maxEntries?: number } = {}): JevCache {
  const ttlMs = Math.max(0, opts.ttlMs ?? 300_000);
  const maxEntries = Math.max(1, opts.maxEntries ?? 500);
  const map = new Map<string, { response: JevResponse; expiresAt: number }>();
  return {
    get(key) {
      const entry = map.get(key);
      if (!entry) return undefined;
      if (Date.now() > entry.expiresAt) {
        map.delete(key);
        return undefined;
      }
      return entry.response;
    },
    set(key, response) {
      if (map.size >= maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
      map.set(key, { response, expiresAt: Date.now() + ttlMs });
    },
    delete(key) {
      map.delete(key);
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    },
  };
}

export interface CachedClient {
  ask(state: unknown, questions: Questions, signal?: AbortSignal): Promise<JevResponse>;
  cache: JevCache;
}

/**
 * Wrap a config so identical (model, state, questions) calls within the TTL
 * return the cached response instead of spending another request.
 */
export function createCachedClient(
  config: JevConfig,
  opts: { cache?: JevCache; ttlMs?: number; maxEntries?: number } = {},
): CachedClient {
  const cache = opts.cache ?? createJevCache({ ttlMs: opts.ttlMs, maxEntries: opts.maxEntries });
  return {
    cache,
    async ask(state, questions, signal) {
      const key = stableStringify({ base: config.baseUrl, model: config.model, state, questions });
      const hit = cache.get(key);
      if (hit) return clone(hit);
      const response = await askJev(config, state, questions, signal);
      cache.set(key, clone(response));
      return clone(response);
    },
  };
}

export interface CoalescingClient {
  ask(state: unknown, questions: Questions, signal?: AbortSignal): Promise<JevResponse>;
  /** HTTP requests actually issued — useful for tests and cost dashboards. */
  requestCount(): number;
}

/**
 * Merge concurrent `ask` calls that share the same state into one request.
 *
 * Calls arriving within `windowMs` of the first (default 10) are batched:
 * their question maps are keyed `"<callerIndex>:<questionId>"` under the
 * hood, sent as a single request against the shared state, and each caller
 * gets its own answers back unprefixed. Jev evaluates questions
 * independently, so the merged answer is identical to separate calls — just
 * one round trip and one input payload.
 *
 * Per-call `signal`s are intentionally NOT forwarded: a merged request
 * serves several callers, and aborting it for one would kill the rest.
 */
export function createCoalescer(
  config: JevConfig,
  opts: { windowMs?: number } = {},
): CoalescingClient {
  const windowMs = Math.max(0, opts.windowMs ?? 10);
  type Item = {
    stateKey: string;
    state: unknown;
    questions: Questions;
    resolve: (r: JevResponse) => void;
    reject: (e: unknown) => void;
  };
  let queue: Item[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let requests = 0;

  async function flush(): Promise<void> {
    timer = null;
    const batch = queue;
    queue = [];
    try {
      const groups = new Map<string, Item[]>();
      for (const item of batch) {
        const group = groups.get(item.stateKey);
        if (group) group.push(item);
        else groups.set(item.stateKey, [item]);
      }
      for (const group of groups.values()) {
        if (group.length === 1) {
          const only = group[0]!;
          requests++;
          try {
            only.resolve(await askJev(config, only.state, only.questions));
          } catch (err) {
            only.reject(err);
          }
          continue;
        }
        requests++;
        try {
          const merged: Questions = {};
          for (let i = 0; i < group.length; i++) {
            for (const [id, q] of Object.entries(group[i]!.questions)) merged[`${i}:${id}`] = q;
          }
          const full = await askJev(config, group[0]!.state, merged);
          for (let i = 0; i < group.length; i++) {
            const prefix = `${i}:`;
            const answers: JevResponse["answers"] = {};
            for (const [id, answer] of Object.entries(full.answers)) {
              if (id.startsWith(prefix)) answers[id.slice(prefix.length)] = answer;
            }
            group[i]!.resolve({ model: full.model, answers, usage: full.usage });
          }
        } catch (err) {
          for (const item of group) item.reject(err);
        }
      }
    } catch (err) {
      // Catch-all: no queued caller may ever be left unsettled. Double
      // rejects/resolves on already-settled items are harmless no-ops.
      for (const item of batch) item.reject(err);
    }
  }

  return {
    ask(state, questions) {
      return new Promise<JevResponse>((resolve, reject) => {
        // Validate up front so misuse rejects this caller with a typed usage
        // error instead of blowing up async flush for the whole batch.
        try {
          validateQuestions(questions);
        } catch (err) {
          reject(err);
          return;
        }
        let stateKey: string;
        try {
          stateKey = stableStringify(state);
        } catch (err) {
          reject(err);
          return;
        }
        queue.push({ stateKey, state, questions, resolve, reject });
        if (timer === null) timer = setTimeout(() => void flush().catch(() => {}), windowMs);
      });
    },
    requestCount() {
      return requests;
    },
  };
}
