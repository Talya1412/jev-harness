"""Tests for the eval metrics: Brier, ECE, confusion, precision/recall/F1, ROC/PR AUC."""
from __future__ import annotations

import math

from jev_harness.eval.metrics import (
    brier_score,
    confusion_matrix,
    ece,
    precision_recall_f1,
    pr_auc,
    roc_auc,
)


def test_brier_score_perfect_is_zero():
    assert brier_score([0.0, 1.0, 0.0], [False, True, False]) == 0.0


def test_brier_score_worst_is_one():
    assert brier_score([1.0, 0.0], [False, True]) == 1.0


def test_brier_score_empty():
    assert brier_score([], []) == 0.0


def test_brier_score_partial():
    # (0.5-0)^2 + (0.5-1)^2 = 0.25 + 0.25 = 0.5 / 2 = 0.25
    assert abs(brier_score([0.5, 0.5], [False, True]) - 0.25) < 1e-9


def test_ece_well_calibrated_is_low():
    # 10 samples, each at p=0.5, 5 positive -> avg conf 0.5, acc 0.5 -> ECE 0
    preds = [0.5] * 10
    out = [True] * 5 + [False] * 5
    assert ece(preds, out) == 0.0


def test_ece_miscalibrated():
    # all predict 0.9, half positive -> |0.9-0.5|=0.4
    preds = [0.9] * 10
    out = [True] * 5 + [False] * 5
    assert abs(ece(preds, out) - 0.4) < 1e-9


def test_confusion_matrix_threshold():
    cm = confusion_matrix([0.9, 0.1, 0.6, 0.4], [True, False, True, False], threshold=0.5)
    assert cm.tp == 2  # 0.9 and 0.6 predicted positive, both actual positive... wait
    # predictions >=0.5: idx0(0.9,T), idx2(0.6,T) -> tp=2; idx1(0.1,F),idx3(0.4,F) -> tn=2
    assert cm.tp == 2
    assert cm.fp == 0
    assert cm.fn == 0
    assert cm.tn == 2


def test_precision_recall_f1():
    cm = confusion_matrix([0.9, 0.8, 0.4, 0.3], [True, False, True, False], threshold=0.5)
    # predicted positive: idx0(TP), idx1(FP); actual positive predicted neg: idx2(FN)
    assert cm.tp == 1
    assert cm.fp == 1
    assert cm.fn == 1
    pr = precision_recall_f1(cm)
    assert abs(pr.precision - 0.5) < 1e-9
    assert abs(pr.recall - 0.5) < 1e-9
    assert abs(pr.f1 - 0.5) < 1e-9


def test_precision_recall_f1_zero_safe():
    from jev_harness.eval.metrics import ConfusionMatrix

    pr = precision_recall_f1(ConfusionMatrix())  # all zero
    assert pr.precision == 0.0
    assert pr.recall == 0.0
    assert pr.f1 == 0.0


def test_roc_auc_perfect_separation():
    assert roc_auc([0.1, 0.2, 0.8, 0.9], [False, False, True, True]) == 1.0


def test_roc_auc_inverted():
    assert roc_auc([0.9, 0.8, 0.2, 0.1], [False, False, True, True]) == 0.0


def test_roc_auc_random_is_half():
    assert roc_auc([0.5, 0.5, 0.5, 0.5], [True, False, True, False]) == 0.5


def test_roc_auc_one_class_absent():
    assert roc_auc([0.1, 0.9], [False, False]) == 0.5
    assert roc_auc([0.1, 0.9], [True, True]) == 0.5


def test_pr_auc_perfect():
    assert pr_auc([0.9, 0.8, 0.1, 0.05], [True, True, False, False]) == 1.0


def test_pr_auc_no_positives():
    assert pr_auc([0.9, 0.1], [False, False]) == 0.0


def test_pr_auc_handles_ties():
    # two positives tied at top with a negative. The implementation uses a
    # stable descending sort, so the tie keeps insertion order (pos, pos, neg)
    # and AP = (1/1 + 2/2) / 2 = 1.0. This matches the TypeScript port.
    r = pr_auc([0.9, 0.9, 0.9], [True, True, False])
    assert abs(r - 1.0) < 1e-9
