---
"@jev-harness/eval": minor
---

Port the canonical core surfaces to the Python package, and pin the values across
languages.

`packages/jev-py` had none of the capabilities TypeScript core gained, so the
dual gate, the failure taxonomy, the refusal ledger, the map-reduce helper and
the tuned `THRESHOLDS` table existed on one side only. Ported all five with the
usual async + `_sync` split, and added `packages/eval/golden/parity-thresholds.json`
as a shared fixture asserted by BOTH sides — `test_parity.py` checks
`jev_harness.THRESHOLDS` and `parity.test.ts` checks core's `THRESHOLDS`,
including key order. A retune that lands on only one language now fails CI;
verified non-vacuous by perturbing a value and watching the TS assertion fail.
