/**
 * Pure helpers for the advisory skill router.
 *
 * The lexical prefilter exists to keep the choice set small (and the Jev call
 * cheap) before spending a request. It must never be so strict that a relevant
 * skill is excluded: when nothing matches lexically we still hand Jev the whole
 * roster, and only abstain if even that is too large to be a valid choice.
 */

export interface SkillCandidate {
  name: string;
  description: string;
}

/** Upper bound on choice options; core defaults to the same limit. */
export const MAX_CANDIDATES = 12;

/** Prompts shorter than this are not worth a routing call. */
export const MIN_PROMPT_CHARS = 12;

/**
 * A name part counts as a lexical hit when it appears in the prompt: longer
 * parts score 2 (a real word like "modding"), short ones 1 (an acronym like
 * "fh6"). Disjoint parts let both "fh6" and "modding" match "fh6-modding".
 */
export function lexicalScores(text: string, roster: readonly SkillCandidate[]): Array<{ name: string; score: number }> {
  const lower = text.toLowerCase();
  return roster.map((s) => {
    const parts = s.name.toLowerCase().split(/[-_]/);
    let score = 0;
    for (const part of parts) {
      if (part.length > 3 && lower.includes(part)) score += 2;
      else if (part.length <= 4 && lower.includes(part)) score += 1;
    }
    return { name: s.name, score };
  });
}

/**
 * Narrow the roster to the candidates sent to Jev. Falls back to the full
 * roster (truncated) when nothing matches lexically, so a task phrased without
 * any name token still gets routed instead of silently abstaining.
 */
export function shortlistSkills(text: string, roster: readonly SkillCandidate[]): SkillCandidate[] {
  const scored = lexicalScores(text, roster);
  const lexical = new Set(scored.filter((x) => x.score > 0).map((x) => x.name));
  const names = lexical.size > 0 ? roster.filter((s) => lexical.has(s.name)) : roster;
  return names.slice(0, MAX_CANDIDATES);
}

/**
 * One-line descriptions per candidate. Names alone are ambiguous — with names
 * only, "test the login page in a browser" routes to a desktop-automation
 * skill instead of the browser-testing one.
 */
export function candidatePayload(
  roster: readonly SkillCandidate[],
  shortlist: readonly SkillCandidate[]
): Array<{ name: string; description: string }> {
  const byName = new Map(roster.map((s) => [s.name, s.description.replace(/\s+/g, " ").slice(0, 180)]));
  return shortlist.map((s) => ({ name: s.name, description: byName.get(s.name) ?? "" }));
}
