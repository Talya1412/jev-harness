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
