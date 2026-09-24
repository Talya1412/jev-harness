"""Cross-language parity: the same fixture is asserted by the TypeScript test
(packages/eval/src/parity.test.ts) and here in Python. Both must reproduce
the embedded expected values to within tolerance, so metric drift on either
side fails CI. The THRESHOLDS table is pinned the same way, against
packages/eval/golden/parity-thresholds.json."""
from __future__ import annotations

import json
import math
import os
from typing import Any, Dict, List

from jev_harness import THRESHOLDS
from jev_harness.eval.metrics import brier_score, confusion_matrix, ece, precision_recall_f1, pr_auc, roc_auc
from jev_harness.eval.tune import tune

_GOLDEN = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "..", "eval", "golden",
)
FIXTURE = os.path.join(_GOLDEN, "parity-metrics.json")
THRESHOLDS_FIXTURE = os.path.join(_GOLDEN, "parity-thresholds.json")


def _load(path: str = FIXTURE) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _close(a: float, b: float, tol: float) -> None:
    assert math.isclose(a, b, rel_tol=0, abs_tol=tol), f"{a} != {b} (tol {tol})"


def test_parity_with_typescript_metrics():
    fx = _load()
    tol = fx["tolerance"]
    predictions: List[float] = [row["p"] for row in fx["pairs"]]
    outcomes: List[bool] = [row["y"] == 1 for row in fx["pairs"]]
    expected = fx["expected"]

    _close(brier_score(predictions, outcomes), expected["brier"], tol)
    _close(roc_auc(predictions, outcomes), expected["auc"], tol)

    cm = confusion_matrix(predictions, outcomes, fx["threshold"])
    assert cm.tp == expected["confusion"]["tp"]
    assert cm.fp == expected["confusion"]["fp"]
    assert cm.tn == expected["confusion"]["tn"]
    assert cm.fn == expected["confusion"]["fn"]

    pr = precision_recall_f1(cm)
    _close(pr.precision, expected["precision"], tol)
    _close(pr.recall, expected["recall"], tol)
    _close(pr.f1, expected["f1"], tol)

    _close(ece(predictions, outcomes, fx["bins"]), expected["ece"], tol)
    _close(pr_auc(predictions, outcomes), expected["prAuc"], tol)

    summary = tune(predictions, outcomes)
    _close(summary.best_threshold, expected["tuneBestThreshold"], tol)
    _close(summary.f1, expected["tuneBestF1"], tol)
    assert len(summary.sweep) == expected["tuneSweepLength"]


def test_parity_with_typescript_gate_questions():
    """The dual gate's question objects must equal the ones
    packages/eval/golden/destructive-gate-dual.json was measured on — the same
    check packages/eval/src/regression.test.ts makes against
    packages/core/src/patterns.ts. A measured plateau only describes the wording
    it was measured on, so retyping (or drifting) the strings here fails."""
    import asyncio

    from jev_harness.patterns import judge_destructive_dual
    from jev_harness.types import JevConfig

    dataset = _load(os.path.join(_GOLDEN, "destructive-gate-dual.json"))
    seen: Dict[str, Any] = {}

    async def transport(url, method, headers, body, timeout_ms):
        seen.update(json.loads(body.decode("utf-8")))
        return 200, json.dumps(
            {
                "model": "jev-fake",
                "answers": {
                    "destructive": {"type": "noul", "noul": 0.9},
                    "category": {"type": "choice", "choice": "destructive", "probabilities": {}, "confidence": 0.9},
                },
            }
        ).encode("utf-8")

    asyncio.run(
        judge_destructive_dual(
            JevConfig(api_key="k", transport=transport),
            {"tool": "bash", "input": {"cmd": "rm -rf /"}, "cwd": "/tmp"},
        )
    )
    shipped = seen["questions"]
    for qid in ("destructive", "category"):
        assert shipped[qid]["instructions"] == dataset["questions"][qid]["instructions"], f"{qid} instructions drifted"
    assert shipped["category"]["criteria"] == dataset["questions"]["category"]["criteria"]


def test_parity_with_typescript_thresholds():
    """THRESHOLDS must match @jev-harness/core exactly: same keys, same
    declaration order, same values. The fixture is generated from
    packages/core/src/patterns.ts, so a threshold tuned on either side alone
    fails here."""
    expected = _load(THRESHOLDS_FIXTURE)["thresholds"]
    assert list(THRESHOLDS.keys()) == list(expected.keys()), "THRESHOLDS key set or order drifted from core"
    for key, value in expected.items():
        assert THRESHOLDS[key] == value, f"THRESHOLDS[{key!r}] is {THRESHOLDS[key]}, core says {value}"
