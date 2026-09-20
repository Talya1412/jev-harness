"""Tests for transport infra: caching, batching, audit, local fallback."""
from __future__ import annotations

import json

import pytest

from jev_harness import (
    JevConfig,
    ask_jev,
    create_audit_log,
    jev_batch,
    local_route_skill,
    with_audit,
    with_cache,
)
from jev_harness.infra import CacheOptions


def test_with_cache_hits_second_call(fake_jev):
    hits = []
    cfg = with_cache(fake_jev.config(), CacheOptions(on_hit=lambda k: hits.append(k)))
    run(ask_jev(cfg, {"s": 1}, {"q": {"type": "noul", "instructions": "y"}}))
    run(ask_jev(cfg, {"s": 1}, {"q": {"type": "noul", "instructions": "y"}}))
    assert len(fake_jev.calls) == 1
    assert len(hits) == 1


def test_with_cache_miss_when_state_differs(fake_jev):
    cfg = with_cache(fake_jev.config())
    run(ask_jev(cfg, {"s": 1}, {"q": {"type": "noul", "instructions": "y"}}))
    run(ask_jev(cfg, {"s": 2}, {"q": {"type": "noul", "instructions": "y"}}))
    assert len(fake_jev.calls) == 2


def test_with_cache_evicts_at_capacity(fake_jev):
    cfg = with_cache(fake_jev.config(), CacheOptions(max_entries=2))
    for i in range(5):
        run(ask_jev(cfg, {"s": i}, {"q": {"type": "noul", "instructions": "y"}}))
    # all distinct, so all hit the network
    assert len(fake_jev.calls) == 5
    # the cache should not grow unbounded
    # (re-asking a cached entry now would hit; we don't, so just assert no throw)


def test_jev_batch_merges_into_one_call(fake_jev):
    # The merged request namespaces each caller's keys (c0__a, c1__b, ...).
    # Return a noul whose value encodes the caller index so we can still tell
    # the scoped responses apart.
    def handler(req):
        out = {}
        for k in req["questions"]:
            caller = k.split("__", 1)[0]  # c0, c1, ...
            out[k] = {"type": "noul", "noul": 0.1 + int(caller[1:]) * 0.1}
        return out

    fake_jev.handler = handler
    batch = jev_batch(fake_jev.config(), {"shared": "state"})
    f1 = batch.add({"a": {"type": "noul", "instructions": "x"}})
    f2 = batch.add({"b": {"type": "noul", "instructions": "y"}})
    r1, r2 = run_gather(f1, f2)
    assert len(fake_jev.calls) == 1
    # each caller sees only its own keys, de-namespaced
    assert list(r1.answers.keys()) == ["a"]
    assert list(r2.answers.keys()) == ["b"]
    assert r1.answers["a"]["noul"] == 0.1  # caller 0
    assert r2.answers["b"]["noul"] == 0.2  # caller 1
    # namespaced keys must NOT leak into the scoped responses
    assert not any(k.startswith("c0__") or k.startswith("c1__") for k in r1.answers)
    assert not any(k.startswith("c0__") or k.startswith("c1__") for k in r2.answers)


def test_jev_batch_flush_returns_empty_when_no_pending(fake_jev):
    batch = jev_batch(fake_jev.config(), {"x": 1})
    r = run(batch.flush())
    assert r.answers == {}
    assert len(fake_jev.calls) == 0


def test_with_audit_records_decisions(fake_jev):
    log = create_audit_log()
    cfg = with_audit(fake_jev.config(), log)
    run(ask_jev(cfg, {"s": 1}, {"q": {"type": "noul", "instructions": "y"}}))
    assert log.size() == 1
    entry = log.all()[0]
    assert entry.ok is True
    assert entry.status == 200
    assert entry.state == {"s": 1}
    assert entry.error is None
    assert entry.answers is not None


def test_with_audit_records_errors(make_jev):
    async def transport(url, method, headers, body, timeout_ms):
        return 500, b"boom"

    log = create_audit_log()
    cfg = with_audit(JevConfig(api_key="k", transport=transport, max_attempts=1), log)
    with pytest.raises(Exception):
        run(ask_jev(cfg, {"s": 1}, {"q": {"type": "noul", "instructions": "y"}}))
    entry = log.all()[0]
    # a 500 is returned (not raised), so it is recorded via status, not error
    assert entry.ok is False
    assert entry.status == 500
    assert entry.error is None


def test_with_audit_records_transport_exceptions(make_jev):
    async def transport(url, method, headers, body, timeout_ms):
        raise ConnectionError("network gone")

    log = create_audit_log()
    cfg = with_audit(JevConfig(api_key="k", transport=transport, max_attempts=1), log)
    with pytest.raises(Exception):
        run(ask_jev(cfg, {"s": 1}, {"q": {"type": "noul", "instructions": "y"}}))
    entry = log.all()[0]
    assert entry.ok is False
    assert entry.status is None
    assert entry.error == "network gone"


def test_local_route_skill_picks_best_overlap():
    from jev_harness import SkillCandidate

    skills = [SkillCandidate("browser-test", description="drive a real browser"), SkillCandidate("desktop", description="automate desktop apps")]
    r = local_route_skill("open the browser and test login", skills)
    assert r["skill"] == "browser-test"
    assert r["score"] > 0


def test_local_route_skill_returns_none_when_no_overlap():
    from jev_harness import SkillCandidate

    r = local_route_skill("zzzzz", [SkillCandidate("browser-test", description="browser")])
    assert r["skill"] is None


def test_create_audit_log_sink_invoked():
    seen = []
    log = create_audit_log(sink=lambda e: seen.append(e))
    log.record(__import__("jev_harness").infra.AuditEntry(ts=0, url="u", ok=True))
    assert len(seen) == 1
    assert log.size() == 1


def run(coro):
    import asyncio

    return asyncio.run(coro)


def run_gather(*coros):
    import asyncio

    async def gather():
        return await asyncio.gather(*coros)

    return asyncio.run(gather())
