"""Every numeric decision threshold in one frozen table.

Mirrors ``THRESHOLDS`` in ``packages/core/src/patterns.ts`` (the ``Object.freeze``
literal, lines 27-85). The same literals used to be copied per adapter and the
copies drifted, so adapters SHOULD read this mapping instead of hardcoding a
number; each pattern still takes an explicit per-call override.

Keys keep the TypeScript spelling on purpose: the shared parity fixture
``packages/eval/golden/parity-thresholds.json`` is asserted by the TypeScript
suite (packages/eval) and by ``packages/jev-py/tests/test_parity.py``, so a
threshold drifting between the two languages fails CI. Declaration order is
asserted too — do not reorder or rename a key.

The mapping is read-only (``MappingProxyType``, the Python equivalent of
``Object.freeze``): mutating it raises ``TypeError`` instead of silently
re-tuning every pattern in the process.
"""
from __future__ import annotations

from types import MappingProxyType
from typing import Mapping

THRESHOLDS: Mapping[str, float] = MappingProxyType(
    {
        # Destructive tool_call gate. Measured on `golden/destructive-gate-dual.json`
        # (104 cases, live recording 2026-09-24): AUC 1.000, Brier 0.0165, and a
        # noiseless plateau of [0.40, 0.56] — the noisiest negative at 0.40 and the
        # quietest positive at 0.56. 0.5 sits inside it with margin on both sides.
        "destructiveGate": 0.5,
        # Minimum confidence before a skill suggestion is worth injecting.
        "skillRouting": 0.5,
        "gateInjection": 0.7,
        "detectPromptInjection": 0.6,
        # Dedup / same-underlying-fact cutoff.
        "duplicate": 0.5,
        # Escalate when a choice/score gate falls BELOW this. PROVISIONAL: vendor
        # confidence-routing maps "<0.6 confidence -> human"; coco-research's
        # jev-use treats sub-0.70 decisions as guesses. No local labeled data.
        "escalateBelow": 0.6,
        # Noul uncertainty band: a p inside [low, high] is uncertain, outside is
        # determined. PROVISIONAL but vendor-cited: the consistency-noul cookbook
        # maps [0.30, 0.70] to uncertain. Noul answers carry no confidence field,
        # so distance from 0.5 is the only uncertainty signal they give.
        "uncertainBandLow": 0.3,
        "uncertainBandHigh": 0.7,
        # Prune keep bar: at or above this a context item stays. MEASURED as a
        # cross-repo consensus (codex-context-diet keepThreshold 0.5, jev-pruner
        # keepThreshold 0.5) — not a locally measured plateau.
        "pruneKeep": 0.5,
        # Prune drop bar: at or below this the item may be dropped. MEASURED
        # cross-repo (codex-context-diet dropThreshold 0.25; band between keeps).
        "pruneDrop": 0.25,
        # Drop bar for error/diagnostic output — far stricter, because a dropped
        # error is how bugs hide. MEASURED cross-repo (codex-context-diet needs
        # <=0.1 on failure-looking output; jev-pruner <=0.1 in every segment).
        "pruneErrorDrop": 0.1,
        # Refute (delete) a review finding only at or above this. PROVISIONAL and
        # deliberately high: no published measurement exists and the loss is
        # asymmetric — false removal >> false keep (open-code-review filter prose).
        "refute": 0.75,
        # Report a finding as a real defect at or above this. PROVISIONAL:
        # upstream has no threshold at all (bare severity enum, unknown values
        # silently coerced to "low"); coin-flip boundary until calibrated.
        "findingReal": 0.5,
        # Minimum confidence in the dual gate's category choice. Below this the
        # category is treated as unproven and the verdict becomes `confirm` rather
        # than a hard block, so a genuine-but-uncertain case always has a way
        # forward.
        "categoryConfidence": 0.5,
        # --- the remaining public defaults, same values every pattern already used ---
        # Post-hoc verification that a finished step actually satisfied the task.
        "verifyStep": 0.6,
        # Genuine ambiguity fork worth one clarifying question.
        "clarification": 0.5,
        # Cheap-vs-expensive model routing for a task.
        "effortRouting": 0.5,
        # Browser-action selection confidence floor.
        "browserAction": 0.4,
        # Tool selection confidence floor.
        "toolPick": 0.4,
        # Tool side-effect risk floor that demands explicit confirmation.
        "toolRisk": 0.5,
        # RAG claim-support floor before a generated statement is trusted.
        "claimSupport": 0.5,
        # Context-sufficiency floor before asking the user for more.
        "contextSufficiency": 0.5,
        # Regression-detection floor.
        "regression": 0.5,
        # Subagent selection confidence floor.
        "subagentPick": 0.4,
        # Subagent delegation floor.
        "delegation": 0.5,
        # Commit-safety floor for `commitGate`.
        "commitSafe": 0.8,
        # Secret-leak flag floor.
        "secretLeak": 0.6,
        # Token-overlap floor for `infra.local_route_skill`. Not a Jev probability —
        # it is a different scale, so it is tuned separately from the rest.
        "localRouterFloor": 0.05,
    }
)

__all__ = ["THRESHOLDS"]
