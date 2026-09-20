/**
 * State redaction: scrub likely secrets and direct identifiers from `state`
 * before it leaves the machine. State routinely carries tool input, diffs,
 * and file contents — none of which need to leak an AWS key or a user's
 * email to the API for Jev to judge a question.
 *
 * Design constraints mirror the rest of core: pure functions, no framework
 * imports, and fail-open at the call site (redaction is regex over strings;
 * if it ever throws, `askJev` sends the original state rather than breaking
 * the call).
 */

export interface RedactOptions {
  /** Extra regexes to scrub after the built-ins (replaced with [REDACTED]). */
  extra?: RegExp[];
  /** Max traversal depth for structured state. Default 12. */
  maxDepth?: number;
}

export interface RedactPattern {
  label: string;
  pattern: RegExp;
  /** Optional custom replacement (may reference capture groups via $1...). */
  replace?: string;
}

const PLACEHOLDER = "[REDACTED";

/**
 * Built-in high-confidence patterns. Each is deliberately narrow — a false
 * positive costs Jev a bit of context, but a false negative leaks a secret.
 */
export const BUILTIN_REDACT_PATTERNS: RedactPattern[] = [
  { label: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    label: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    label: "private-key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    label: "github-token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g,
  },
  { label: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: "api-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { label: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  {
    label: "auth-header",
    pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]{16,}={0,2}/gi,
    replace: "$1 [REDACTED]",
  },
  {
    label: "secret-assignment",
    pattern:
      /\b([A-Z][A-Z0-9_]{2,}(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_PASSWD|_CREDENTIALS?|APIKEY|API_KEY))\s*[:=]\s*("[^"\n]*"|'[^'\n]*'|[^\s,;)"']+)/g,
    replace: "$1=[REDACTED]",
  },
  {
    label: "url-credential",
    pattern: /\b((?:password|passwd|pwd|pass|token|api_?key)=)([^&;\s"']+)/gi,
    replace: "$1[REDACTED]",
  },
  {
    label: "connection-string",
    pattern:
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|mssql):\/\/[^\s"'@/:]+:[^\s"'@]*@/g,
    replace: "[REDACTED-connstring]@",
  },
  {
    label: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
];

/** Scrub every built-in (plus any extras) pattern from a text blob. */
export function redactText(text: string, opts: RedactOptions = {}): string {
  let out = text;
  const patterns = opts.extra?.length
    ? [...BUILTIN_REDACT_PATTERNS, ...opts.extra.map((p): RedactPattern => ({ label: "custom", pattern: p }))]
    : BUILTIN_REDACT_PATTERNS;
  for (const { label, pattern, replace } of patterns) {
    out = out.replace(pattern, replace ?? `${PLACEHOLDER}:${label}]`);
  }
  return out;
}

/**
 * Redact every string leaf of a structured state. Strings inside arrays and
 * objects (to `maxDepth`) are scrubbed; numbers, booleans, and nulls pass
 * through. Returns a new structure — the input is never mutated.
 */
export function redactState(state: unknown, opts: RedactOptions = {}): unknown {
  return walk(state, 0, opts);
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function walk(value: unknown, depth: number, opts: RedactOptions): unknown {
  if (typeof value === "string") return redactText(value, opts);
  if (value === null || typeof value !== "object") return value;
  if (depth >= (opts.maxDepth ?? 12)) return value;
  if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1, opts));
  // Date/Map/Set/class instances have no own enumerable string-keyed state
  // (Object.entries(new Date()) is {}), so walking them as plain objects
  // would silently corrupt the state. Preserve their content instead — the
  // redacted structure then carries the same information JSON.stringify of
  // the original state would, minus any secrets.
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return redactText(value.toISOString(), opts);
  }
  if (value instanceof Map) {
    return Array.from(value.entries(), ([k, v]) => [walk(k, depth + 1, opts), walk(v, depth + 1, opts)]);
  }
  if (value instanceof Set) {
    return Array.from(value, (v) => walk(v, depth + 1, opts));
  }
  if (!isPlainObject(value)) {
    try {
      return redactText(String(value), opts);
    } catch {
      return PLACEHOLDER + ":opaque]";
    }
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = walk(v, depth + 1, opts);
  }
  return out;
}
