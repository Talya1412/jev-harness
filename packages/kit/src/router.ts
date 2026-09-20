/**
 * Cheap lexical prefilter for the skill router, shared by the OMP and Pi
 * adapters: score candidate skill names against the message before spending
 * a Jev call, so the choice set stays small.
 *
 * Matches whole name parts (fh6-modding -> "fh6"), weighting longer parts
 * higher. Returns candidate names best-first; an empty result means nothing
 * matched lexically and the caller decides whether to fall back to the full
 * roster.
 */
export interface SkillName {
  name: string;
  description?: string;
}

export function lexicalShortlist(
  text: string,
  roster: SkillName[],
  opts: { limit?: number } = {},
): string[] {
  const limit = Math.max(1, opts.limit ?? 12);
  const lower = text.toLowerCase();
  const scored = roster
    .filter((s) => s.name !== "")
    .map((s) => {
      const parts = s.name.toLowerCase().split(/[-_]/);
      let score = 0;
      for (const part of parts) {
        if (part.length > 3 && lower.includes(part)) score += 2;
        // also match the acronym form: fh6-modding -> "fh6"
        if (part.length <= 4 && lower.includes(part)) score += 1;
      }
      return { name: s.name, score };
    });
  const lexical = scored.filter((x) => x.score > 0).map((x) => x.name);
  return (lexical.length > 0 ? lexical : roster.map((s) => s.name).filter((n) => n !== "")).slice(0, limit);
}
