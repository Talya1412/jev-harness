"""Tests for the failure taxonomy: classification, policies, Retry-After."""
from __future__ import annotations

import dataclasses
import email.utils
import time

import pytest

from jev_harness.taxonomy import (
    DEFAULT_RATE_LIMIT_BACKOFF_MS,
    MAX_RATE_LIMIT_BACKOFF_MS,
    classify_jev_failure,
    policy_for_failure,
    retry_after_ms,
)
from jev_harness.types import JevError


def test_maps_a_rejected_key_to_auth():
    assert classify_jev_failure(JevError("Jev HTTP 401: bad key", status=401)) == "auth"
    assert classify_jev_failure(JevError("Jev HTTP 403: forbidden", status=403)) == "auth"


def test_maps_a_missing_model_to_model_even_though_it_arrives_as_a_404():
    assert classify_jev_failure(JevError("Jev HTTP 404: model jev-0.1 not found", status=404)) == "model"
    assert classify_jev_failure(Exception("unknown model: jev-nope")) == "model"


def test_keeps_a_bare_404_as_unknown():
    assert classify_jev_failure(JevError("Jev HTTP 404: no route", status=404)) == "unknown"


def test_maps_429_to_rate_limit():
    assert classify_jev_failure(JevError("Jev HTTP 429: slow down", status=429)) == "rate_limit"


def test_maps_a_5xx_to_server():
    assert classify_jev_failure(JevError("Jev HTTP 503: unavailable", status=500)) == "server"
    assert classify_jev_failure(JevError("Jev HTTP 502: bad gateway", status=502)) == "server"


def test_maps_a_rejected_request_to_network():
    assert classify_jev_failure(TypeError("fetch failed")) == "network"
    assert classify_jev_failure(ConnectionResetError("connection reset")) == "network"
    assert classify_jev_failure(TimeoutError("timed out")) == "network"
    abort = Exception("The operation was aborted.")
    abort.name = "AbortError"  # type: ignore[attr-defined]
    assert classify_jev_failure(abort) == "network"
    assert classify_jev_failure(Exception("request timed out")) == "network"


def test_falls_back_to_unknown_for_anything_unrecognised():
    assert classify_jev_failure(Exception("something odd")) == "unknown"
    assert classify_jev_failure("a bare string") == "unknown"
    assert classify_jev_failure(None) == "unknown"


def test_reads_a_status_nested_on_an_axios_style_error():
    assert classify_jev_failure({"response": {"status": 401}}) == "auth"


def test_disables_the_session_for_auth_and_model_failures():
    for kind in ("auth", "model"):
        p = policy_for_failure(kind)
        assert p.disable_session is True
        assert p.retryable is False
        assert p.backoff_ms == 0
        assert p.silent is False


def test_retries_rate_limits_and_network_blips_silently_for_network():
    rl = policy_for_failure("rate_limit")
    assert rl.retryable is True
    assert rl.backoff_ms == 30_000
    net = policy_for_failure("network")
    assert net.retryable is True
    assert net.silent is True


def test_retries_5xx_and_never_disables_the_session_for_it():
    p = policy_for_failure("server")
    assert p.retryable is True
    assert p.disable_session is False


def test_covers_every_kind():
    for kind in ("auth", "model", "rate_limit", "network", "server", "unknown"):
        assert policy_for_failure(kind).kind == kind


def test_honours_retry_after_in_seconds():
    err = JevError("429", status=429, retryable=True)
    err.headers = {"retry-after": "12"}  # type: ignore[attr-defined]
    assert policy_for_failure("rate_limit", err).backoff_ms == 12_000
    assert retry_after_ms(err) == 12_000


def test_honours_retry_after_as_a_plain_header_object_and_as_an_http_date():
    assert retry_after_ms({"headers": {"Retry-After": "5"}}) == 5_000
    future = email.utils.formatdate(time.time() + 20, usegmt=True)
    ms = retry_after_ms({"headers": {"retry-after": future}})
    assert ms is not None
    assert ms > 15_000
    assert ms <= 20_000


def test_reads_retry_after_from_a_header_like_object():
    class Headers:
        def get(self, name):
            return "7" if name == "retry-after" else None

    assert retry_after_ms({"headers": Headers()}) == 7_000


def test_ignores_an_unreadable_retry_after_and_keeps_the_default():
    assert retry_after_ms({"headers": {"retry-after": "soon"}}) is None
    assert policy_for_failure("rate_limit", {"headers": {}}).backoff_ms == DEFAULT_RATE_LIMIT_BACKOFF_MS
    assert policy_for_failure("rate_limit").backoff_ms == DEFAULT_RATE_LIMIT_BACKOFF_MS


def test_clamps_an_absurd_retry_after():
    assert retry_after_ms({"headers": {"retry-after": "999999"}}) == MAX_RATE_LIMIT_BACKOFF_MS


def test_never_reports_a_jev_error_with_retryable_false_as_retryable():
    p = policy_for_failure("rate_limit", JevError("429", status=429, retryable=False))
    assert p.retryable is False
    assert p.backoff_ms == 0
    assert policy_for_failure("network", JevError("down", retryable=False)).retryable is False


def test_returns_frozen_policies_so_a_caller_cannot_mutate_the_table():
    p = policy_for_failure("server")
    with pytest.raises(dataclasses.FrozenInstanceError):
        p.retryable = False  # type: ignore[misc]
    assert policy_for_failure("server").retryable is True
