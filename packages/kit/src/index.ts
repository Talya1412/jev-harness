/**
 * @jev-harness/kit — the shared foundation for writing Jev harness adapters.
 *
 * What every adapter needs, independent of host:
 * - `resolveEnvConfig` / `createJevToolkit` — env credentials + core-pattern
 *   call plumbing with the adapter's failure policy (strict or fail-open).
 * - `okResult` / `errorResult` — the standard tool-result envelope and
 *   fail-open error rendering.
 * - `lexicalShortlist` — cheap lexical prefilter for skill routing, so the
 *   expensive Jev choice sees a small candidate set.
 *
 * No host imports: schemas and hook wiring stay in each adapter.
 */
export * from "./config.js";
export * from "./results.js";
export * from "./toolkit.js";
export * from "./router.js";
