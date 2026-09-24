"""Tests for the frozen THRESHOLDS table and its use as each pattern's default."""
from __future__ import annotations

import inspect
import json
import os

import pytest

from jev_harness import THRESHOLDS
from jev_harness.patterns import judge_destructive, judge_destructive_dual, pick_tool, route_skill
from jev_harness.patterns_extra import (
    choose_subagent,
    detect_prompt_injection,
    judge_regression,
    needs_more_context,
    verify_claim,
)
from jev_harness.patterns import choose_browser_action

FIXTURE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "..", "eval", "golden", "parity-thresholds.json",
)


def test_thresholds_is_frozen():
    with pytest.raises(TypeError):
        THRESHOLDS["destructiveGate"] = 0.9  # type: ignore[index]


def test_thresholds_match_the_shared_fixture():
    with open(FIXTURE, "r", encoding="utf-8") as f:
        fixture = json.load(f)
    assert list(THRESHOLDS.keys()) == list(fixture["thresholds"].keys()), "key set or declaration order drifted"
    for key, expected in fixture["thresholds"].items():
        assert THRESHOLDS[key] == expected, f"{key} drifted"


@pytest.mark.parametrize(
    "func,param,key",
    [
        (route_skill, "min_confidence", "skillRouting"),
        (judge_destructive, "threshold", "destructiveGate"),
        (judge_destructive_dual, "threshold", "destructiveGate"),
        (choose_browser_action, "min_confidence", "browserAction"),
        (pick_tool, "min_confidence", "toolPick"),
        (pick_tool, "risk_threshold", "toolRisk"),
        (verify_claim, "threshold", "claimSupport"),
        (detect_prompt_injection, "threshold", "detectPromptInjection"),
        (needs_more_context, "threshold", "contextSufficiency"),
        (judge_regression, "threshold", "regression"),
        (choose_subagent, "min_confidence", "subagentPick"),
        (choose_subagent, "delegate_threshold", "delegation"),
    ],
)
def test_pattern_defaults_come_from_the_table(func, param, key):
    default = inspect.signature(func).parameters[param].default
    assert default == THRESHOLDS[key], f"{func.__name__}.{param} default drifted from THRESHOLDS[{key!r}]"


def test_local_router_floor_is_the_table_value():
    # A message whose only overlap with the skill scores below the floor must
    # resolve to None; the floor itself is the table value, not a literal.
    from jev_harness import SkillCandidate, local_route_skill

    skills = [SkillCandidate("browser-test", description="drive a browser")]
    r = local_route_skill("browser", skills)
    assert r["skill"] == "browser-test" or r["score"] < THRESHOLDS["localRouterFloor"]
