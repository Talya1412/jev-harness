# @jev-harness/pi

## 0.4.0

### Minor Changes

- [`2007a3c`](https://github.com/Talya1412/jev-harness/commit/2007a3c47f5bc05a4c3489edd446c233d136b8af) Thanks [@Talya1412](https://github.com/Talya1412)! - Grow the destructive-gate evaluation from a 38-case golden set into a two-split
  benchmark, and add the statistics it needs.

  Datasets (`packages/eval/golden`):

  - `destructive-gate.json` — dev/tuning split, 69 cases over core, obfuscation,
    false-positive-trap and paraphrase slices.
  - `destructive-gate.holdout.json` — holdout split, 74 cases, adding steering
    (text that argues for its own classification) and distractor slices. Never
    used to choose wording. Live recording: AUC 0.996, Brier 0.020, precision
    1.00, recall 0.974.

  Cases may carry `slice`, `pair` and `note`. The report breaks the confusion
  matrix down per slice with Wilson 95% intervals and summarizes paraphrase
  invariance across `pair` groups. New exports: `wilsonInterval`, `mcnemarTest`,
  `invarianceDeltas`, `SliceMetrics`.

  The vitest regression gate now recomputes **both** baselines from their own
  per-case rows and enforces per-slice floors; `check-regression.mjs` fails on
  slice regressions as well as aggregate ones, and the `live-eval` workflow runs
  both splits.

### Patch Changes

- Updated dependencies [[`2007a3c`](https://github.com/Talya1412/jev-harness/commit/2007a3c47f5bc05a4c3489edd446c233d136b8af)]:
  - @jev-harness/core@0.4.0
  - @jev-harness/kit@0.4.0

## 0.3.0

### Minor Changes

- [`35f21a9`](https://github.com/Talya1412/jev-harness/commit/35f21a97b5b4e64de850562e9b9ed5732ab8793f) Thanks [@Talya1412](https://github.com/Talya1412)! - Tune the destructive gate on data: broaden the `judgeDestructive` question to
  name system abuse (disk wipes, broad permission changes, fork bombs, mass
  kills, shutdown) as well as data destruction, and lower the default threshold
  from 0.75 to 0.5.

  On the 38-case golden baseline the old wording at 0.75 scored precision 1.00 /
  recall 0.75 — it missed `chmod -R 777 /` (0.37), a fork bomb (0.17),
  `npm publish` (0.55), `shutdown` (0.51), and an overwrite (0.65). The new
  wording separates the same set perfectly (AUC 1.000, Brier 0.013) with a
  0.4–0.6 plateau, so 0.5 sits mid-plateau for margin against run-to-run
  variance. The golden baseline is re-recorded, and the default changes in
  core, OMP, Claude Code, VS Code, and the GitHub review action; the Python port
  mirrors it. `jev-gate-action`'s diff-level gate keeps its own threshold.

### Patch Changes

- Updated dependencies [[`35f21a9`](https://github.com/Talya1412/jev-harness/commit/35f21a97b5b4e64de850562e9b9ed5732ab8793f)]:
  - @jev-harness/core@0.3.0
  - @jev-harness/kit@0.3.0

## 0.2.2

### Patch Changes

- [`18ac30f`](https://github.com/Talya1412/jev-harness/commit/18ac30f7c6554bb1d9b1e358006284b0d641b728) Thanks [@Talya1412](https://github.com/Talya1412)! - Reformat the sources with Prettier, clear the lint findings, and rebuild the
  committed bundles. No behavior change; also fills in package metadata
  (`keywords`, `publishConfig`).
- Updated dependencies [[`18ac30f`](https://github.com/Talya1412/jev-harness/commit/18ac30f7c6554bb1d9b1e358006284b0d641b728)]:
  - @jev-harness/core@0.2.2
  - @jev-harness/kit@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [[`b25554c`](https://github.com/Talya1412/jev-harness/commit/b25554cb7081763d510293f83053055fd7d55711)]:
  - @jev-harness/core@0.2.1
  - @jev-harness/kit@0.2.1

## 0.2.0

### Patch Changes

- Updated dependencies [[`8601008`](https://github.com/Talya1412/jev-harness/commit/8601008c9409a1e2bd63eb2cc7a4b6f75fdf53d3)]:
  - @jev-harness/core@0.2.0
  - @jev-harness/kit@0.2.0
