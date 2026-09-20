"""Threshold tuning. Mirrors ``packages/eval/src/tune.ts``.

Sweep candidate thresholds across a labeled set and pick the one that
optimizes an objective (F1 by default). Pure: takes lists, returns a summary
object — the CLI (``./cli.py``) handles I/O around this.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List

from .metrics import (
    ConfusionMatrix,
    PrMetrics,
    brier_score,
    confusion_matrix,
    ece,
    precision_recall_f1,
    pr_auc,
    roc_auc,
)

TuneObjective = str  # "f1" | "youden"


@dataclass
class TuneSummary:
    n: int
    positives: int
    objective: TuneObjective
    best_threshold: float
    # at-best metrics
    precision: float
    recall: float
    f1: float
    tp: int
    fp: int
    fn: int
    tn: int
    brier: float
    ece: float
    roc_auc: float
    pr_auc: float
    # candidates examined, best-first by objective
    sweep: List[dict] = field(default_factory=list)


def _candidate_thresholds(predictions):
    s = set(predictions)
    s.add(0.5)
    return sorted(t for t in s if isinstance(t, (int, float)) and t == t)  # finite


def _youden(cm: ConfusionMatrix) -> float:
    """TPR - FPR; higher is better. Both zero-safe."""
    tpr = cm.tp / (cm.tp + cm.fn) if (cm.tp + cm.fn) else 0.0
    fpr = cm.fp / (cm.fp + cm.tn) if (cm.fp + cm.tn) else 0.0
    return tpr - fpr


def tune(predictions, outcomes, objective: TuneObjective = "f1") -> TuneSummary:
    """Find the best threshold for a labeled set.

    ``predictions`` are the probabilities Jev returned; ``outcomes`` are the
    ground-truth booleans from your labeled data.
    """
    n = min(len(predictions), len(outcomes))
    outcomes = outcomes[:n]
    positives = sum(1 for o in outcomes if o)
    candidates = _candidate_thresholds(predictions[:n])

    sweep = []
    for t in candidates:
        cm = confusion_matrix(predictions, outcomes, t)
        pr = precision_recall_f1(cm)
        sweep.append({"threshold": t, "precision": pr.precision, "recall": pr.recall, "f1": pr.f1, "cm": cm})

    def value_of(row):
        return _youden(row["cm"]) if objective == "youden" else row["f1"]

    sweep.sort(key=value_of, reverse=True)
    best = sweep[0]
    return TuneSummary(
        n=n,
        positives=positives,
        objective=objective,
        best_threshold=best["threshold"],
        precision=best["precision"],
        recall=best["recall"],
        f1=best["f1"],
        tp=best["cm"].tp,
        fp=best["cm"].fp,
        fn=best["cm"].fn,
        tn=best["cm"].tn,
        brier=brier_score(predictions, outcomes),
        ece=ece(predictions, outcomes),
        roc_auc=roc_auc(predictions, outcomes),
        pr_auc=pr_auc(predictions, outcomes),
        sweep=[{"threshold": r["threshold"], "precision": r["precision"], "recall": r["recall"], "f1": r["f1"]} for r in sweep],
    )


__all__ = ["TuneObjective", "TuneSummary", "tune"]
