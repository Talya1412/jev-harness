"""Tests for the refusal ledger: folding, retention, snapshots."""
from __future__ import annotations

import dataclasses

import pytest

from jev_harness.infra import DEFAULT_REFUSAL_MAX, create_refusal_ledger


def test_folds_repeats_of_the_same_key_and_reason_into_one_entry():
    led = create_refusal_ledger(now=lambda: 1_000)
    led.record("bash", "destructive command needs confirmation")
    led.record("bash", "destructive command needs confirmation")
    led.record("bash", "destructive command needs confirmation")
    entries = led.entries()
    assert len(entries) == 1
    assert entries[0].count == 3
    assert entries[0].key == "bash"
    assert entries[0].reason == "destructive command needs confirmation"


def test_keeps_the_most_recent_occurrence_time_on_a_folded_entry():
    clock = {"t": 100}
    led = create_refusal_ledger(now=lambda: clock["t"])
    led.record("write", "path outside the workspace")
    clock["t"] = 900
    led.record("write", "path outside the workspace")
    assert led.entries()[0].at == 900


def test_keeps_a_different_key_or_a_different_reason_as_a_distinct_entry():
    led = create_refusal_ledger()
    led.record("bash", "needs confirmation")
    led.record("web", "needs confirmation")
    led.record("bash", "target not resolvable")
    assert [e.count for e in led.entries()] == [1, 1, 1]


def test_does_not_confuse_keys_that_would_collide_under_a_naive_join():
    led = create_refusal_ledger()
    led.record("a", "b|c")
    led.record("a|b", "c")
    assert len(led.entries()) == 2


def test_caps_retained_distinct_entries_at_max_newest_kept():
    led = create_refusal_ledger(max_entries=3, now=lambda: 5)
    for i in range(5):
        led.record(f"tool{i}", f"reason {i}")
    assert [e.key for e in led.entries()] == ["tool2", "tool3", "tool4"]


def test_keeps_folding_a_surviving_entry_and_readds_an_evicted_one_as_new():
    led = create_refusal_ledger(max_entries=2)
    led.record("a", "r")
    led.record("b", "r")
    led.record("c", "r")  # evicts "a"
    led.record("b", "r")  # still folds
    led.record("a", "r")  # "b" is evicted, "a" is fresh
    entries = led.entries()
    assert [e.key for e in entries] == ["c", "a"]
    assert [e.count for e in entries] == [1, 1]


def test_uses_a_caller_supplied_timestamp_when_given():
    led = create_refusal_ledger(now=lambda: 1)
    led.record("k", "r", 42)
    assert led.entries()[0].at == 42


def test_returns_frozen_copies_so_a_caller_cannot_mutate_ledger_state():
    led = create_refusal_ledger()
    led.record("k", "r")
    snap = led.entries()
    with pytest.raises(dataclasses.FrozenInstanceError):
        snap[0].count = 99  # type: ignore[misc]
    snap.append(object())  # mutating the returned list must not touch the ledger
    assert led.entries()[0].count == 1
    assert led.entries() is not led.entries()


def test_clamps_a_nonsensical_max_instead_of_discarding_everything():
    led = create_refusal_ledger(max_entries=0)
    led.record("k", "r")
    assert len(led.entries()) == 1


def test_default_retention_is_the_ts_constant():
    assert DEFAULT_REFUSAL_MAX == 200
    led = create_refusal_ledger(now=lambda: 0)
    for i in range(205):
        led.record(f"t{i}", "r")
    assert len(led.entries()) == DEFAULT_REFUSAL_MAX
    assert led.entries()[0].key == "t5"
