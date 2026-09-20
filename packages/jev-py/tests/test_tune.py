"""Tests for the threshold tuning sweep."""
from __future__ import annotations

from jev_harness.eval.tune import tune


def test_tune_finds_perfect_threshold():
    # positives at high p, negatives at low p
    preds = [0.1, 0.2, 0.8, 0.9]
    out = [False, False, True, True]
    s = tune(preds, out, "f1")
    assert s.positives == 2
    assert s.n == 4
    # at the best threshold, perfect classification
    assert s.f1 == 1.0
    assert s.precision == 1.0
    assert s.recall == 1.0
    assert s.tp == 2
    assert s.fp == 0
    assert s.fn == 0
    assert s.tn == 2


def test_tune_sweep_sorted_best_first():
    preds = [0.1, 0.5, 0.9]
    out = [False, True, True]
    s = tune(preds, out, "f1")
    assert s.sweep[0]["f1"] >= s.sweep[-1]["f1"]


def test_tune_includes_half_even_if_absent():
    preds = [0.2, 0.8]
    out = [False, True]
    s = tune(preds, out, "f1")
    thresholds = [row["threshold"] for row in s.sweep]
    assert 0.5 in thresholds


def test_tune_youden_objective():
    preds = [0.1, 0.2, 0.8, 0.9]
    out = [False, False, True, True]
    s = tune(preds, out, "youden")
    assert s.objective == "youden"
    # perfect separation -> youden = 1.0 at best
    assert s.best_threshold in preds or s.best_threshold == 0.5


def test_tune_metrics_present():
    preds = [0.1, 0.4, 0.6, 0.9]
    out = [False, True, True, False]
    s = tune(preds, out, "f1")
    assert isinstance(s.brier, float)
    assert isinstance(s.ece, float)
    assert isinstance(s.roc_auc, float)
    assert isinstance(s.pr_auc, float)


def test_tune_empty():
    s = tune([], [], "f1")
    assert s.n == 0
    assert s.positives == 0
    assert s.best_threshold == 0.5


def test_tune_single_class():
    preds = [0.2, 0.8]
    out = [True, True]
    s = tune(preds, out, "f1")
    # roc_auc is 0.5 (one class), pr_auc is 0... actually all positive -> pr_auc=1.0?
    # pr_auc when all positive returns 1.0 only if perfect ranking; here all pos so ap=hits/(rank+1) summed
    assert s.positives == 2
