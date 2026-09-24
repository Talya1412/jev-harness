/**
 * Skill routing for the OMP adapter: where the roster comes from, when a
 * suggestion is promoted, and the scheduling that keeps a burst of prompts
 * from spending one Jev call each.
 *
 * Why this file exists at all: the shipped router read `ctx.skills`, a member
 * that does not exist on OMP's `ExtensionContext` (verified against
 * `dist/types/extensibility/extensions/types.d.ts`: 25 members, none named
 * `skills`), and returned `{ additionalContext }`, which is not a field of
 * `InputEventResult` (its only fields are `handled`, `text`, `images`).
 * Both halves were dead, so the hook could never do anything.
 *
 * The roster is therefore read from the filesystem — the same directories OMP's
 * own discovery scans — and the suggestion travels on a channel the host really
 * delivers (`before_agent_start` -> `message`).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { lexicalShortlist } from "@jev-harness/kit";

export interface RosterSkill {
  name: string;
  description: string;
}

/** Upper bound on choice options; core's `routeSkill` defaults to the same. */
export const MAX_CANDIDATES = 12;

/** Prompts shorter than this are not worth a routing call. */
export const MIN_PROMPT_CHARS = 12;

/**
 * Collapse a burst of prompts into one routing decision. A user who types two
 * messages in quick succession wants one answer, not two Jev calls.
 */
export const ROUTE_DEBOUNCE_MS = 250;

/** How long a routing answer stays cacheable for the same prompt text. */
export const ROUTE_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Pull `name` and `description` out of a `SKILL.md` frontmatter block.
 *
 * Deliberately a small reader rather than a YAML dependency: the two fields we
 * need are flat scalars, and OMP writes long descriptions as `>-` folded
 * blocks (see `~/.omp/agent/skills/fh6-modding/SKILL.md`), which this joins
 * back into one line. A file without frontmatter, or without a name, is
 * skipped by the caller.
 */
export function parseSkillFrontmatter(text: string): { name: string; description: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;
  const out: Record<string, string> = {};
  let key: string | null = null;
  for (const raw of match[1]!.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    const head = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (head) {
      key = head[1]!.toLowerCase();
      out[key] = head[2]!.replace(/^[>|][-+]?\s*/, "").trim();
      continue;
    }
    // Continuation of a folded/literal block: indented, no key of its own.
    if (key && /^\s+\S/.test(line)) {
      const part = line.trim();
      out[key] = out[key] ? out[key] + " " + part : part;
    }
  }
  const name = (out.name ?? "").trim();
  if (!name) return null;
  return { name, description: (out.description ?? "").replace(/\s+/g, " ").trim() };
}

/** Read one `skills/` root; a missing or unreadable directory yields nothing. */
export function readSkillDir(root: string): RosterSkill[] {
  const out: RosterSkill[] = [];
  try {
    if (!existsSync(root)) return out;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const text = readFileSync(join(root, entry.name, "SKILL.md"), "utf8");
        const parsed = parseSkillFrontmatter(text);
        if (parsed) out.push({ ...parsed, description: parsed.description.slice(0, 400) });
      } catch {
        // No SKILL.md here — not a skill directory.
      }
    }
  } catch {
    // Unreadable root: behave as if empty rather than throwing mid-turn.
  }
  return out;
}

/**
 * The directories OMP itself loads skills from: the user's agent dir, the
 * shared `~/.agents` tree, and the project-local `.omp/skills`. Later roots
 * lose to earlier ones on a name collision, so a project can shadow a user
 * skill of the same name.
 */
export function defaultSkillDirs(cwd: string, home?: string): string[] {
  // Honour HOME / USERPROFILE before os.homedir(): the env form is what a test
  // can redirect, so an ambient skill tree on the developer's machine can never
  // decide whether a test passes. CI has no ~/.agents/skills, and a test that
  // silently depended on it failed there while passing locally.
  const resolved = home ?? process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  return [
    join(cwd, ".omp", "skills"),
    join(resolved, ".omp", "agent", "skills"),
    join(resolved, ".agents", "skills"),
  ];
}

/** Load and de-duplicate the roster, best-root-first. */
export function loadSkillRoster(dirs: readonly string[]): RosterSkill[] {
  const byName = new Map<string, RosterSkill>();
  for (const dir of dirs) {
    for (const skill of readSkillDir(dir)) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()];
}

/** A routing answer, cached or freshly judged. */
export interface RouteAnswer {
  skill: string | null;
  confidence: number;
}

/**
 * True when the prompt already names a skill the user chose explicitly — a
 * `/skill:<name>` token or a bare skill name. Promotion is pointless then:
 * the user has made the choice, and re-deciding it can only override them.
 */
export function userAlreadyChose(text: string, roster: readonly RosterSkill[]): boolean {
  const lower = text.toLowerCase();
  if (/\/skill:[a-z0-9_-]+/i.test(text)) return true;
  return roster.some((s) => s.name.length > 3 && lower.includes(s.name.toLowerCase()));
}

export interface SkillRouterOptions {
  /** Injected for tests; defaults to the real timers. */
  now?: () => number;
  debounceMs?: number;
  cacheTtlMs?: number;
  /** The expensive judgment. Rejects on transport failure. */
  judge: (text: string, candidates: RosterSkill[]) => Promise<RouteAnswer>;
}

export interface SkillRouter {
  /**
   * Decide whether the prompt warrants a skill suggestion. Returns null when
   * superseded, cached-negative, or below the caller's promotion bar.
   */
  route(text: string, roster: readonly RosterSkill[]): Promise<RouteAnswer | null>;
  /** Exposed for tests and diagnostics. */
  stats(): { cached: number; superseded: number; judged: number };
}

/**
 * Ranked-merge router with one request in flight.
 *
 * The local lexical shortlist is the candidate set, Jev ranks within it, and a
 * hit is promoted only at or above `minConfidence` — a low-probability guess
 * merges into the candidate list rather than being injected blindly.
 *
 * Scheduling, all of which the shipped code lacked:
 * - debounce: a prompt arriving inside the window supersedes the earlier one,
 *   which returns null instead of spending a call;
 * - single flight: a second prompt waits for the first judgment rather than
 *   stacking a parallel request;
 * - stale discard: an answer whose request was superseded before it settled is
 *   dropped, never delivered late;
 * - per-query cache: the same prompt text reuses the earlier answer.
 */
export function createSkillRouter(options: SkillRouterOptions): SkillRouter {
  const now = options.now ?? Date.now;
  const debounceMs = options.debounceMs ?? ROUTE_DEBOUNCE_MS;
  const ttl = options.cacheTtlMs ?? ROUTE_CACHE_TTL_MS;
  const cache = new Map<string, { answer: RouteAnswer; at: number }>();
  const counters = { cached: 0, superseded: 0, judged: 0 };
  let seq = 0;
  let inFlight: Promise<RouteAnswer> | null = null;

  const key = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 2000);
  let lastArrival: number | null = null;

  return {
    async route(text, roster) {
      const cacheKey = key(text);
      const hit = cache.get(cacheKey);
      if (hit && now() - hit.at < ttl) {
        counters.cached++;
        return hit.answer;
      }
      if (hit) cache.delete(cacheKey);

      const mine = ++seq;
      const arrivedAt = now();
      // Trailing debounce: only a prompt that lands inside the window of a
      // previous one waits. The caller here is OMP's input hook, which AWAITS
      // this — a lone prompt must not pay a fixed delay before the user's
      // message is submitted, so the common case proceeds immediately and only
      // a genuine burst is coalesced.
      const inBurst =
        debounceMs > 0 && lastArrival !== null && arrivedAt - lastArrival < debounceMs;
      lastArrival = arrivedAt;
      if (inBurst) {
        await new Promise((r) => setTimeout(r, debounceMs));
        // A newer prompt arrived: this one is stale before it ever asked.
        if (mine !== seq) {
          counters.superseded++;
          return null;
        }
      }
      // One request in flight; a later prompt waits for the incumbent.
      while (inFlight) {
        await inFlight.catch(() => undefined);
        if (mine !== seq) {
          counters.superseded++;
          return null;
        }
      }

      const candidates = shortlist(text, roster);
      if (candidates.length === 0) return null;
      const mineStill = () => mine === seq;
      const pending = options.judge(text, candidates);
      inFlight = pending;
      let answer: RouteAnswer;
      try {
        answer = await pending;
      } finally {
        if (inFlight === pending) inFlight = null;
      }
      counters.judged++;
      // Discard an answer that a newer prompt already obsoleted.
      if (!mineStill()) {
        counters.superseded++;
        return null;
      }
      cache.set(cacheKey, { answer, at: now() });
      return answer;
    },
    stats: () => ({ ...counters }),
  };
}

/**
 * Candidate set for one Jev call: the shared lexical prefilter, falling back to
 * the whole roster when nothing matches by name — a task phrased without any
 * name token is *unknown*, not irrelevant.
 *
 * `lexicalShortlist` returns names (kit's contract today); descriptions are
 * looked up from our own roster, because a description is what stops
 * "test the login page in a browser" from routing to a desktop-automation
 * skill.
 */
export function shortlist(text: string, roster: readonly RosterSkill[]): RosterSkill[] {
  // kit's contract is a mutable array; copy rather than widen our own signature.
  const picked = lexicalShortlist(text, [...roster], { limit: MAX_CANDIDATES }) as Array<
    string | RosterSkill
  >;
  const byName = new Map(roster.map((s) => [s.name, s]));
  const out: RosterSkill[] = [];
  for (const entry of picked) {
    const name = typeof entry === "string" ? entry : entry.name;
    const found = byName.get(name);
    if (found) out.push(found);
  }
  if (out.length > 0) return out;
  return roster.slice(0, MAX_CANDIDATES);
}

/** One advisory line: the skill, and how sure Jev was. */
export function skillHint(answer: RouteAnswer): string | null {
  if (!answer.skill) return null;
  return (
    "[jev] Consider loading skill: " +
    answer.skill +
    " (" +
    Math.round(answer.confidence * 100) +
    "% from the installed roster)"
  );
}
