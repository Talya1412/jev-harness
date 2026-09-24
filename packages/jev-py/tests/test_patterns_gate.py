"""Tests for judge_destructive_dual: the two-question destructive gate."""
from __future__ import annotations

import json

from jev_harness import THRESHOLDS
from jev_harness.patterns import DESTRUCTIVE_CATEGORIES, judge_destructive_dual, judge_destructive_dual_sync

CALL = {"tool": "bash", "input": {"cmd": "rm -rf /"}, "cwd": "/tmp"}


def _dual(destructive, category, confidence):
    return lambda r: {
        "destructive": {"type": "noul", "noul": destructive},
        "category": {
            "type": "choice",
            "choice": category,
            "probabilities": {category: confidence},
            "confidence": confidence,
        },
    }


def test_blocks_when_the_noul_is_high_and_the_category_agrees_with_usable_confidence(fake_jev):
    fake_jev.handler = _dual(0.9, "destructive", 0.9)
    v = run(judge_destructive_dual(fake_jev.config(), CALL))
    assert v.decision == "block"
    assert v.category == "destructive"
    assert v.destructive == 0.9


def test_confirms_when_the_category_disagrees_with_the_noul(fake_jev):
    fake_jev.handler = _dual(0.9, "read-only", 0.95)
    v = run(judge_destructive_dual(fake_jev.config(), CALL))
    assert v.decision == "confirm"
    assert v.category == "read-only"


def test_confirms_rather_than_blocks_when_the_category_confidence_is_low(fake_jev):
    fake_jev.handler = _dual(0.9, "destructive", THRESHOLDS["categoryConfidence"] - 0.01)
    assert run(judge_destructive_dual(fake_jev.config(), CALL)).decision == "confirm"


def test_treats_the_category_confidence_boundary_as_proven(fake_jev):
    fake_jev.handler = _dual(0.9, "destructive", THRESHOLDS["categoryConfidence"])
    assert run(judge_destructive_dual(fake_jev.config(), CALL)).decision == "block"


def test_allows_a_low_probability_call_regardless_of_the_category(fake_jev):
    fake_jev.handler = _dual(0.1, "destructive", 0.99)
    v = run(judge_destructive_dual(fake_jev.config(), CALL))
    assert v.decision == "allow"
    assert v.category == "destructive"


def test_confirms_on_abstain_an_unknown_category_with_a_high_noul_is_not_a_silent_block(fake_jev):
    fake_jev.handler = _dual(0.9, "unknown", 0.9)
    v = run(judge_destructive_dual(fake_jev.config(), CALL))
    assert v.decision == "confirm"
    assert v.category == "unknown"


def test_reads_an_unrecognised_category_label_as_an_abstain(fake_jev):
    fake_jev.handler = _dual(0.9, "  DESTRUCTIVE-ISH ", 0.99)
    v = run(judge_destructive_dual(fake_jev.config(), CALL))
    assert v.category == "unknown"
    assert v.decision == "confirm"
    assert set(DESTRUCTIVE_CATEGORIES) == {"destructive", "reversible-mutation", "read-only", "unknown"}


def test_normalises_a_recognised_label_case_and_whitespace(fake_jev):
    fake_jev.handler = _dual(0.9, "  Destructive ", 0.9)
    v = run(judge_destructive_dual(fake_jev.config(), CALL))
    assert v.category == "destructive"
    assert v.decision == "block"


def test_honours_a_custom_threshold(fake_jev):
    fake_jev.handler = _dual(0.6, "destructive", 0.9)
    assert run(judge_destructive_dual(fake_jev.config(), CALL)).decision == "block"
    assert run(judge_destructive_dual(fake_jev.config(), CALL, threshold=0.9)).decision == "allow"


def test_allows_a_malformed_response_instead_of_throwing(fake_jev):
    fake_jev.handler = lambda r: {}
    v = run(judge_destructive_dual(fake_jev.config(), CALL))
    assert v.decision == "allow"
    assert v.category == "unknown"
    assert v.destructive == 0.0
    assert v.confidence == 0.0


def test_allows_an_unparseable_noul_value_instead_of_throwing(fake_jev):
    fake_jev.handler = lambda r: {
        "destructive": {"type": "noul", "noul": "yes"},
        "category": {"type": "choice", "choice": "destructive", "probabilities": {}, "confidence": 0.9},
    }
    v = run(judge_destructive_dual(fake_jev.config(), CALL))
    assert v.decision == "allow"
    assert v.destructive == 0.0
    assert v.category == "destructive"


def test_caps_the_forwarded_input_so_a_huge_payload_cannot_bloat_the_request(fake_jev):
    fake_jev.handler = _dual(0.9, "destructive", 0.9)
    run(judge_destructive_dual(fake_jev.config(), {"tool": "bash", "input": {"data": "x" * 100_000}}))
    forwarded = fake_jev.calls[0]["state"]["input"]
    assert isinstance(forwarded, str)
    assert len(forwarded) <= 4000


def test_sends_both_questions_in_one_request(fake_jev):
    fake_jev.handler = _dual(0.9, "destructive", 0.9)
    run(judge_destructive_dual(fake_jev.config(), CALL))
    assert len(fake_jev.calls) == 1
    questions = fake_jev.calls[0]["questions"]
    assert set(questions) == {"destructive", "category"}
    assert questions["destructive"]["type"] == "noul"
    assert questions["category"]["type"] == "choice"
    assert set(questions["category"]["criteria"]) == set(DESTRUCTIVE_CATEGORIES)


def test_sync_wrapper_matches_the_async_form(fake_jev):
    fake_jev.handler = _dual(0.9, "destructive", 0.9)
    assert judge_destructive_dual_sync(fake_jev.config(), CALL).decision == "block"


def run(coro):
    import asyncio

    return asyncio.run(coro)
