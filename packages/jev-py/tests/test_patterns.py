"""Tests for the original five patterns."""
from __future__ import annotations

from jev_harness import (
    JevConfig,
    SkillCandidate,
    route_skill,
    judge_destructive,
    choose_browser_action,
    pick_tool,
    rank_candidates,
)
from jev_harness.types import JevResponse


def test_route_skill_empty_returns_none():
    cfg = JevConfig(api_key="k", transport=lambda *a: None)
    r = run(route_skill(cfg, "hi", []))
    assert r.skill is None
    assert r.confidence == 0.0


def test_route_skill_picks_by_confidence(fake_jev):
    fake_jev.handler = lambda r: {"best": {"type": "choice", "choice": "browser-test", "probabilities": {"browser-test": 0.9, "none": 0.1}, "confidence": 0.9}}
    r = run(route_skill(fake_jev.config(), "test the login page in a browser", [SkillCandidate("browser-test", description="drive a real browser"), SkillCandidate("desktop", description="automate desktop apps")]))
    assert r.skill == "browser-test"
    assert r.confidence == 0.9


def test_route_skill_none_when_low_confidence(fake_jev):
    fake_jev.handler = lambda r: {"best": {"type": "choice", "choice": "browser-test", "probabilities": {"browser-test": 0.3, "none": 0.7}, "confidence": 0.3}}
    r = run(route_skill(fake_jev.config(), "x", [SkillCandidate("browser-test", description="b")], min_confidence=0.5))
    assert r.skill is None


def test_route_skill_none_choice_means_no_skill(fake_jev):
    fake_jev.handler = lambda r: {"best": {"type": "choice", "choice": "none", "probabilities": {"none": 1.0}, "confidence": 0.99}}
    r = run(route_skill(fake_jev.config(), "x", [SkillCandidate("a", description="a")]))
    assert r.skill is None


def test_judge_destructive_blocks_above_threshold(fake_jev):
    fake_jev.handler = lambda r: {"destructive": {"type": "noul", "noul": 0.9}}
    r = run(judge_destructive(fake_jev.config(), {"tool": "bash", "input": {"cmd": "rm -rf /"}}))
    assert r.destructive == 0.9
    assert r.blocked is True


def test_judge_destructive_allows_below_threshold(fake_jev):
    fake_jev.handler = lambda r: {"destructive": {"type": "noul", "noul": 0.2}}
    r = run(judge_destructive(fake_jev.config(), {"tool": "read_file", "input": {"path": "a.txt"}}))
    assert r.blocked is False


def test_judge_destructive_threshold_is_configurable(fake_jev):
    fake_jev.handler = lambda r: {"destructive": {"type": "noul", "noul": 0.6}}
    r = run(judge_destructive(fake_jev.config(), {"tool": "x", "input": {}}, threshold=0.5))
    assert r.blocked is True
    r2 = run(judge_destructive(fake_jev.config(), {"tool": "x", "input": {}}, threshold=0.8))
    assert r2.blocked is False


def test_choose_browser_action_returns_target(fake_jev):
    fake_jev.handler = lambda r: {
        "operation": {"type": "choice", "choice": "CLICK", "probabilities": {"CLICK": 0.9}, "confidence": 0.9},
        "click_target": {"type": "choice", "choice": "2", "probabilities": {"2": 0.9, "none": 0.1}, "confidence": 0.9},
    }
    elements = [{"index": "1", "label": "Search", "operations": ["CLICK"]}, {"index": "2", "label": "Sign in", "operations": ["CLICK"]}]
    r = run(choose_browser_action(fake_jev.config(), {"goal": "sign in", "page": {"url": "http://x"}, "elements": elements}))
    assert r.operation == "CLICK"
    assert r.target == "2"
    assert r.act is True


def test_choose_browser_action_blocked_no_act(fake_jev):
    fake_jev.handler = lambda r: {"operation": {"type": "choice", "choice": "BLOCKED", "probabilities": {"BLOCKED": 1.0}, "confidence": 0.9}}
    r = run(choose_browser_action(fake_jev.config(), {"goal": "x", "page": {"url": "y"}, "elements": [{"index": "1", "label": "a", "operations": ["CLICK"]}]}))
    assert r.operation == "BLOCKED"
    assert r.act is False


def test_pick_tool_selects_and_flags_risk(fake_jev):
    fake_jev.handler = lambda r: {
        "tool": {"type": "choice", "choice": "deploy", "probabilities": {"deploy": 0.8, "none": 0.2}, "confidence": 0.8},
        "risky": {"type": "noul", "noul": 0.7},
    }
    r = run(pick_tool(fake_jev.config(), {"task": "ship it", "tools": [{"name": "deploy", "description": "push to prod"}]}))
    assert r.tool == "deploy"
    assert r.confirm_required is True
    assert r.act is True


def test_pick_tool_empty_returns_none():
    cfg = JevConfig(api_key="k", transport=lambda *a: None)
    r = run(pick_tool(cfg, {"task": "x", "tools": []}))
    assert r.tool is None
    assert r.act is False


def test_rank_candidates_orders_best_first(fake_jev):
    fake_jev.handler = lambda r: {
        "fit_0": {"type": "score", "score": 1.0, "probabilities": {}, "confidence": 0.5},
        "fit_1": {"type": "score", "score": 3.0, "probabilities": {}, "confidence": 0.5},
        "fit_2": {"type": "score", "score": 2.0, "probabilities": {}, "confidence": 0.5},
    }
    r = run(rank_candidates(fake_jev.config(), "task", ["a", "b", "c"]))
    assert [x["candidate"] for x in r] == ["b", "c", "a"]
    assert r[0]["fitness"] == 3.0


def test_rank_candidates_empty():
    cfg = JevConfig(api_key="k", transport=lambda *a: None)
    assert run(rank_candidates(cfg, "task", [])) == []


def run(coro):
    import asyncio

    return asyncio.run(coro)
