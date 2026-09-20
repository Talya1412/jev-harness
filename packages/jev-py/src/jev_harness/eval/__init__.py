"""Calibration and ranking metrics + threshold tuning for Jev decisions.

Ports ``packages/eval`` faithfully. Pure by design: no Jev calls, no I/O, no
globals. Every function takes lists of numbers and booleans and returns numbers
or plain objects.
"""
from .metrics import (
    ConfusionMatrix,
    PrMetrics,
    brier_score,
    ece,
    confusion_matrix,
    precision_recall_f1,
    roc_auc,
    pr_auc,
)
from .tune import TuneObjective, TuneSummary, tune

__all__ = [
    "ConfusionMatrix",
    "PrMetrics",
    "brier_score",
    "ece",
    "confusion_matrix",
    "precision_recall_f1",
    "roc_auc",
    "pr_auc",
    "TuneObjective",
    "TuneSummary",
    "tune",
]
