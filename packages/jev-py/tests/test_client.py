"""Client tests: validation, transport wiring, retries, accessors."""
from __future__ import annotations

import json

import pytest

from jev_harness import JevConfig, JevError, ask_jev, noul, choice, score, validate_questions
from jev_harness.client import _resolve_config


def test_resolve_config_requires_api_key():
    with pytest.raises(JevError) as ei:
        _resolve_config(JevConfig(api_key=""))
    assert not ei.value.retryable


def test_resolve_config_strips_trailing_slash():
    cfg = _resolve_config(JevConfig(api_key="k", base_url="https://x.example/"))
    assert cfg["base_url"] == "https://x.example"


def test_validate_questions_rejects_empty():
    with pytest.raises(JevError):
        validate_questions({})
    with pytest.raises(JevError):
        validate_questions(None)


def test_validate_questions_requires_instructions():
    with pytest.raises(JevError):
        validate_questions({"q": {"type": "noul", "instructions": ""}})


def test_validate_questions_choice_needs_two_criteria():
    with pytest.raises(JevError):
        validate_questions({"q": {"type": "choice", "instructions": "x", "criteria": {"a": "b"}}})


def test_validate_questions_score_needs_two_levels():
    with pytest.raises(JevError):
        validate_questions({"q": {"type": "score", "instructions": "x", "criteria": ["only"]}})


def test_validate_questions_accepts_good_map():
    validate_questions({
        "a": {"type": "noul", "instructions": "x"},
        "b": {"type": "choice", "instructions": "x", "criteria": {"a": "1", "b": "2"}},
        "c": {"type": "score", "instructions": "x", "criteria": ["low", "high"]},
    })


def test_ask_jev_requires_state(fake_jev):
    with pytest.raises(JevError):
        run(ask_jev(fake_jev.config(), None, {"a": {"type": "noul", "instructions": "x"}}))


def test_ask_jev_sends_bearer_and_model(fake_jev):
    cfg = fake_jev.config(model="jev-custom")
    run(ask_jev(cfg, {"x": 1}, {"q": {"type": "noul", "instructions": "y"}}))
    req = fake_jev.calls[0]
    assert req["model"] == "jev-custom"
    assert req["state"] == {"x": 1}
    assert "q" in req["questions"]


def test_ask_jev_returns_answers(fake_jev):
    fake_jev.handler = lambda r: {"q": {"type": "noul", "noul": 0.9}}
    resp = run(ask_jev(fake_jev.config(), {"s": 1}, {"q": {"type": "noul", "instructions": "y"}}))
    assert resp.model == "jev-fake"
    assert resp.answers["q"]["noul"] == 0.9


def test_ask_jev_retries_5xx_then_succeeds(make_jev):
    call_count = {"n": 0}

    async def transport(url, method, headers, body, timeout_ms):
        call_count["n"] += 1
        if call_count["n"] < 3:
            return 503, b"overloaded"
        return 200, json.dumps({"model": "m", "answers": {"q": {"type": "noul", "noul": 0.1}}}).encode()

    cfg = JevConfig(api_key="k", transport=transport, max_attempts=3)
    resp = run(ask_jev(cfg, {"s": 1}, {"q": {"type": "noul", "instructions": "y"}}))
    assert call_count["n"] == 3
    assert resp.answers["q"]["noul"] == 0.1


def test_ask_jev_429_is_retryable(make_jev):
    import asyncio

    async def transport(url, method, headers, body, timeout_ms):
        return 429, b"slow down"

    cfg = JevConfig(api_key="k", transport=transport, max_attempts=2)
    with pytest.raises(JevError) as ei:
        run(ask_jev(cfg, {"s": 1}, {"q": {"type": "noul", "instructions": "y"}}))
    assert ei.value.retryable
    assert ei.value.status == 429


def test_ask_jev_4xx_is_not_retryable(make_jev):
    async def transport(url, method, headers, body, timeout_ms):
        return 400, b"bad request"

    cfg = JevConfig(api_key="k", transport=transport, max_attempts=5)
    with pytest.raises(JevError) as ei:
        run(ask_jev(cfg, {"s": 1}, {"q": {"type": "noul", "instructions": "y"}}))
    assert not ei.value.retryable


def test_noul_accessor_raises_on_wrong_type():
    from jev_harness.types import JevResponse

    resp = JevResponse(model="m", answers={"q": {"type": "choice", "choice": "a"}})
    with pytest.raises(JevError):
        noul(resp, "q")


def test_choice_accessor_returns_probabilities():
    from jev_harness.types import JevResponse

    resp = JevResponse(model="m", answers={"q": {"type": "choice", "choice": "a", "probabilities": {"a": 0.8, "b": 0.2}, "confidence": 0.8}})
    r = choice(resp, "q")
    assert r["choice"] == "a"
    assert r["confidence"] == 0.8
    assert r["probabilities"]["a"] == 0.8


def test_score_accessor_returns_legend():
    from jev_harness.types import JevResponse

    resp = JevResponse(model="m", answers={"q": {"type": "score", "score": 2.5, "confidence": 0.9, "legend": {"0": "low"}}})
    r = score(resp, "q")
    assert r["score"] == 2.5
    assert r["legend"] == {"0": "low"}


def test_on_retry_callback_invoked(make_jev):
    seen = []

    async def transport(url, method, headers, body, timeout_ms):
        return 502, b"bad gateway"

    def on_retry(attempt, err):
        seen.append((attempt, str(err)))

    cfg = JevConfig(api_key="k", transport=transport, max_attempts=2, on_retry=on_retry)
    with pytest.raises(JevError):
        run(ask_jev(cfg, {"s": 1}, {"q": {"type": "noul", "instructions": "y"}}))
    assert len(seen) == 1  # one retry between the two attempts


def run(coro):
    import asyncio

    return asyncio.run(coro)
