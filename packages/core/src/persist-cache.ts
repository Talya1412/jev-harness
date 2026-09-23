/**
 * Disk-backed JevCache for processes that outlive a single run: hooks and
 * CLIs run fresh on every invocation, so an in-memory cache never sees its
 * own hits. Entries are stored as one JSON document and pruned by TTL, so
 * repeat judgments (the destructive gate seeing the same command twice)
 * stay free across restarts.
 *
 * Advisory only, like the in-memory cache: corrupt or missing files simply
 * start a new cache. Never load-bearing for correctness.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JevConfig } from "./types.js";
import type { JevResponse } from "./client.js";
import type { JevCache } from "./cache.js";

export interface PersistentCacheOptions {
  /** Directory for the cache file (created on first write). */
  dir: string;
  /** Entry lifetime in ms. Default 24h — Jev answers are deterministic per model. */
  ttlMs?: number;
  /** Max entries; oldest-written are evicted first. Default 512. */
  maxEntries?: number;
  /** Cache file name. Default "jev-cache.json". */
  file?: string;
}

export interface PersistentCacheStats {
  hits: number;
  misses: number;
  /** Hits / (hits + misses), or 0 when nothing has been requested yet. */
  hitRate: number;
}

export type PersistentJevCache = JevCache & { stats(): PersistentCacheStats; flush(): void };

interface StoredEntry {
  response: JevResponse;
  expiresAt: number;
  /** Insertion order for eviction, monotonic per process lifetime of the file. */
  seq: number;
}

interface CacheDoc {
  version: 1;
  entries: Record<string, StoredEntry>;
  nextSeq: number;
}

export function createPersistentCache(opts: PersistentCacheOptions): PersistentJevCache {
  const ttlMs = Math.max(0, opts.ttlMs ?? 24 * 60 * 60 * 1000);
  const maxEntries = Math.max(1, opts.maxEntries ?? 512);
  const path = join(opts.dir, opts.file ?? "jev-cache.json");

  let entries = new Map<string, StoredEntry>();
  let nextSeq = 1;
  let loaded = false;
  const hits = { hits: 0, misses: 0 };

  function load(): void {
    if (loaded) return;
    loaded = true;
    if (!existsSync(path)) return;
    try {
      const doc = JSON.parse(readFileSync(path, "utf8")) as CacheDoc;
      if (!doc || doc.version !== 1 || typeof doc.entries !== "object") return;
      const now = Date.now();
      const rows = Object.entries(doc.entries);
      rows.sort((a, b) => a[1].seq - b[1].seq);
      for (const [key, entry] of rows) {
        if (typeof entry?.expiresAt === "number" && entry.expiresAt > now && entry.response) {
          entries.set(key, {
            response: entry.response,
            expiresAt: entry.expiresAt,
            seq: entry.seq,
          });
          nextSeq = Math.max(nextSeq, entry.seq + 1);
        }
      }
    } catch {
      // Corrupt cache: start fresh rather than fail the caller.
      entries = new Map();
    }
  }

  function flush(): void {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const doc: CacheDoc = { version: 1, nextSeq, entries: Object.fromEntries(entries) };
      const tmp = path + ".tmp";
      writeFileSync(tmp, JSON.stringify(doc), "utf8");
      renameSync(tmp, path);
    } catch {
      // Unwritable dir: the cache degrades to in-memory for this process.
    }
  }

  function evictIfNeeded(): void {
    while (entries.size >= maxEntries) {
      let oldestKey: string | null = null;
      let oldestSeq = Number.POSITIVE_INFINITY;
      for (const [key, entry] of entries) {
        if (entry.seq < oldestSeq) {
          oldestSeq = entry.seq;
          oldestKey = key;
        }
      }
      if (oldestKey === null) break;
      entries.delete(oldestKey);
    }
  }

  return {
    get(key) {
      load();
      const entry = entries.get(key);
      if (!entry) {
        hits.misses++;
        return undefined;
      }
      if (Date.now() >= entry.expiresAt) {
        entries.delete(key);
        hits.misses++;
        return undefined;
      }
      hits.hits++;
      return entry.response;
    },
    set(key, response) {
      load();
      evictIfNeeded();
      entries.set(key, { response, expiresAt: Date.now() + ttlMs, seq: nextSeq++ });
      flush();
    },
    delete(key) {
      load();
      entries.delete(key);
      flush();
    },
    clear() {
      load();
      entries = new Map();
      nextSeq = 1;
      flush();
    },
    get size() {
      load();
      return entries.size;
    },
    stats() {
      const total = hits.hits + hits.misses;
      return { ...hits, hitRate: total === 0 ? 0 : hits.hits / total };
    },
    flush,
  };
}

/**
 * Wrap a config so `/v1/systemone` responses are served from `cache` when the
 * exact request body was seen before. Models endpoint and non-OK responses
 * pass through uncached. Fail-open: any cache error falls back to transport.
 */
export function withPersistentCache(config: JevConfig, cache: JevCache): JevConfig {
  const parent = config.fetchImpl ?? fetch;
  const wrapped: typeof fetch = async (url, init) => {
    const target = String(url);
    if (!target.endsWith("/v1/systemone") || init?.method?.toUpperCase() !== "POST") {
      return parent(url, init);
    }
    // Only string bodies are cacheable: String() would collapse every
    // non-string body (ReadableStream, FormData, ...) to the same
    // "[object ...]" text and serve one caller's response to another.
    if (init?.body !== undefined && typeof init.body !== "string") {
      return parent(url, init);
    }
    const key = target + "\n" + String(init.body ?? "");
    try {
      const hit = cache.get(key);
      if (hit) {
        return new Response(JSON.stringify(hit), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    } catch {
      return parent(url, init);
    }
    const res = await parent(url, init);
    if (res.ok) {
      try {
        cache.set(key, (await res.clone().json()) as JevResponse);
      } catch {
        // Non-JSON or unreadable: skip caching, return the response as-is.
      }
    }
    return res;
  };
  return { ...config, fetchImpl: wrapped };
}
