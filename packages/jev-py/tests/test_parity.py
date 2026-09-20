"""Cross-language parity: the same fixture is asserted by the TypeScript test
(packages/eval/src/parity.test.ts) and here in Python. Both must reproduce
the embedded expected values to within tolerance, so metric drift on either
side fails CI."""
from __future__ import annotations

import json
import math
import os
from typing import Any, Dict, List

from jev_harness.eval.metrics import brier_score, confusion_matrix, ece, precision_recall_f1, pr_auc, roc_auc
from jev_harness.eval.tune import tune

FIXTURE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "..", "eval", "golden", "parity-metrics.json",
)


def _load() -> Dict[str, Any]:
    with open(FIXTURE, "r", encoding="utf-8") as f:
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
