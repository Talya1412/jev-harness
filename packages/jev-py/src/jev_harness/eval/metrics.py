"""Calibration and ranking metrics for Jev decisions.

Jev emits calibrated probabilities, but calibration is not correctness, and
thresholds are tuned in production — never validated. These functions close that
loop: given predicted probabilities and labeled boolean outcomes from YOUR data,
measure how good the decisions were and pick thresholds that survive contact
with reality.

Pure by design: no Jev calls, no I/O, no globals. Mirrors
``packages/eval/src/metrics.ts``.
"""
from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass
class ConfusionMatrix:
    tp: int = 0  # predicted 1, actual 1
    fp: int = 0  # predicted 1, actual 0
    fn: int = 0  # predicted 0, actual 1
    tn: int = 0  # predicted 0, actual 0


@dataclass
class PrMetrics:
    precision: float = 0.0
    recall: float = 0.0
    f1: float = 0.0


def brier_score(predictions, outcomes) -> float:
    """Mean squared error of the probability against the 0/1 outcome.

    The standard scalar score for probabilistic predictions; lower is better,
    0 is perfect.
    """
    n = min(len(predictions), len(outcomes))
    if n == 0:
        return 0.0
    total = 0.0
    for i in range(n):
        y = 1.0 if outcomes[i] else 0.0
        d = predictions[i] - y
        total += d * d
    return total / n


def ece(predictions, outcomes, bins: int = 10) -> float:
    """Expected Calibration Error.

    Bins predictions into equal-width buckets and sums
    |avg_confidence - observed_positive_rate| weighted by bin size. A
    well-calibrated Jev should have a low ECE on representative data.
    """
    n = min(len(predictions), len(outcomes))
    if n == 0:
        return 0.0
    bin_conf = [0.0] * bins
    bin_acc = [0.0] * bins
    bin_count = [0] * bins
    for i in range(n):
        p = predictions[i]
        idx = int(math.floor(p * bins))
        if idx >= bins:
            idx = bins - 1
        if idx < 0:
            idx = 0
        bin_conf[idx] += p
        bin_acc[idx] += 1.0 if outcomes[i] else 0.0
        bin_count[idx] += 1
    total = 0.0
    for b in range(bins):
        c = bin_count[b]
        if c == 0:
            continue
        total += (c / n) * abs(bin_conf[b] / c - bin_acc[b] / c)
    return total


def confusion_matrix(predictions, outcomes, threshold: float) -> ConfusionMatrix:
    """Build the 2x2 confusion matrix at a threshold (predict 1 when p >= t)."""
    n = min(len(predictions), len(outcomes))
    cm = ConfusionMatrix()
    for i in range(n):
        predicted = predictions[i] >= threshold
        actual = bool(outcomes[i])
        if predicted and actual:
            cm.tp += 1
        elif predicted and not actual:
            cm.fp += 1
        elif not predicted and actual:
            cm.fn += 1
        else:
            cm.tn += 1
    return cm


def precision_recall_f1(cm: ConfusionMatrix) -> PrMetrics:
    """Precision, recall, and F1 from a confusion matrix. Zero-safe."""
    precision = cm.tp / (cm.tp + cm.fp) if (cm.tp + cm.fp) else 0.0
    recall = cm.tp / (cm.tp + cm.fn) if (cm.tp + cm.fn) else 0.0
    denom = precision + recall
    f1 = (2 * precision * recall) / denom if denom else 0.0
    return PrMetrics(precision=precision, recall=recall, f1=f1)


def roc_auc(predictions, outcomes) -> float:
    """ROC AUC via average ranks (Mann-Whitney U). Robust to ties.

    Returns 0.5 when one class is absent (no discriminative power can be measured).
    """
    n = min(len(predictions), len(outcomes))
    outcomes = outcomes[:n]
    pos = sum(1 for o in outcomes if o)
    neg = n - pos
    if pos == 0 or neg == 0:
        return 0.5
    # ascending sort so rank 1 is the smallest prediction
    order = sorted(range(n), key=lambda i: predictions[i])
    ranks = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j < n and predictions[order[j]] == predictions[order[i]]:
            j += 1
        avg = (i + 1 + j) / 2  # average of 1-based ranks i+1 .. j
        for k in range(i, j):
            ranks[order[k]] = avg
        i = j
    sum_pos_ranks = sum(ranks[k] for k in range(n) if outcomes[k])
    return (sum_pos_ranks - (pos * (pos + 1)) / 2) / (pos * neg)


def pr_auc(predictions, outcomes) -> float:
    """Average precision — the area under the precision-recall curve.

    Better than ROC AUC on imbalanced data, which is the common case for Jev
    gates (few destructive calls, few injections). 1 is perfect.
    """
    n = min(len(predictions), len(outcomes))
    outcomes = outcomes[:n]
    total_pos = sum(1 for o in outcomes if o)
    if total_pos == 0:
        return 0.0
    # descending by prediction, stable on ties
    order = sorted(range(n), key=lambda i: -predictions[i])
    hits = 0
    ap = 0.0
    for rank, idx in enumerate(order):
        if outcomes[idx]:
            hits += 1
            ap += hits / (rank + 1)
    return ap / total_pos


__all__ = [
    "ConfusionMatrix",
    "PrMetrics",
    "brier_score",
    "ece",
    "confusion_matrix",
    "precision_recall_f1",
    "roc_auc",
    "pr_auc",
]
