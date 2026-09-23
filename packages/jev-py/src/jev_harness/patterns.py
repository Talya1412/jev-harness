"""Reusable Jev patterns — the original five. Mirrors ``packages/core/src/patterns.ts``.

Each pattern is a thin async function over :func:`ask_jev`, so the same logic
backs every harness adapter. Results are dataclasses for type safety and easy
(serializable) inspection.
"""
from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .client import ask_jev, choice, noul, score
from .types import JevConfig


@dataclass
class SkillCandidate:
    name: str
    description: Optional[str] = None


def _shortlist(items: List[SkillCandidate], limit: int) -> List[SkillCandidate]:
    return items[:limit]


@dataclass
class RouteSkillResult:
    skill: Optional[str]
    confidence: float
    probabilities: Dict[str, float] = field(default_factory=dict)


async def route_skill(
    config: JevConfig,
    message: str,
    skills: List[SkillCandidate],
    *,
    min_confidence: float = 0.5,
    max_candidates: int = 12,
    signal: Optional[asyncio.Event] = None,
) -> RouteSkillResult:
    """Route a request to one skill (or None). Sending DESCRIPTIONS matters.

    With names alone, "test the login page in a browser" routes to a
    desktop-automation skill instead of the browser-testing one.
    """
    shortlist = _shortlist(skills, max_candidates)
    if not shortlist:
        return RouteSkillResult(skill=None, confidence=0.0)
    criteria: Dict[str, str] = {"none": "No listed skill is relevant to this request"}
    state: Dict[str, str] = {}
    for s in shortlist:
        desc = re.sub(r"\s+", " ", s.description or "").strip()[:180]
        criteria[s.name] = f"{s.name}: {desc}" if desc else f"Skill named {s.name}"
        state[s.name] = desc
    response = await ask_jev(
        config,
        {"message": message[:3000], "skills": state},
        {"best": {"type": "choice", "instructions": "Which listed skill, if any, is the right tool for this request? Judge by what the skill actually does, not by surface word overlap.", "criteria": criteria}},
        signal,
    )
    r = choice(response, "best")
    picked = r["choice"] if r["choice"] and r["choice"] != "none" and r["confidence"] >= min_confidence else None
    return RouteSkillResult(skill=picked, confidence=r["confidence"], probabilities=r["probabilities"])


def route_skill_sync(*args, **kwargs) -> RouteSkillResult:
    return asyncio.run(route_skill(*args, **kwargs))


@dataclass
class JudgeDestructiveResult:
    destructive: float
    blocked: bool


async def judge_destructive(
    config: JevConfig,
    call: Dict[str, Any],
    *,
    threshold: float = 0.5,
    signal: Optional[asyncio.Event] = None,
) -> JudgeDestructiveResult:
    """Decide whether a tool call is destructive enough to warrant confirmation.

    Threshold 0.5 is tuned on the labeled golden dataset (a 0.4-0.6 plateau with
    no false positives and no false negatives) — this is the only pattern whose
    ``blocked`` should hard-stop an action by default.
    """
    response = await ask_jev(
        config,
        {"tool": call.get("tool", ""), "input": json.dumps(call.get("input") or {})[0:4000], "cwd": call.get("cwd")},
        {"destructive": {"type": "noul", "instructions": "Running this exact tool call would destroy or irreversibly change data, history, or system state. That includes: recursive or bulk deletion; overwriting or truncating existing files without backup; git history rewrite, force-push, or discarding uncommitted work; dropping tables or deleting namespaces/volumes; formatting, wiping, or overwriting a disk or device; changing permissions or ownership across a broad path; exhausting, killing, or shutting down the machine (fork bombs, mass process kill, shutdown/reboot); publishing a package or spending money; or sending secrets to an external endpoint. Reading, searching, listing, creating a brand-new file, building, running tests, or editing a file in place with a normal edit tool is NOT destructive."}},
        signal,
    )
    p = noul(response, "destructive")
    return JudgeDestructiveResult(destructive=p, blocked=p >= threshold)


def judge_destructive_sync(*args, **kwargs) -> JudgeDestructiveResult:
    return asyncio.run(judge_destructive(*args, **kwargs))


@dataclass
class ChooseBrowserActionResult:
    operation: Optional[str]
    target: Optional[str]
    confidence: float
    act: bool


async def choose_browser_action(
    config: JevConfig,
    input_: Dict[str, Any],
    *,
    min_confidence: float = 0.4,
    signal: Optional[asyncio.Event] = None,
) -> ChooseBrowserActionResult:
    """Pick one browser action from a snapshot. Does not execute anything."""
    operations: set = set()
    for el in input_["elements"]:
        for op in el["operations"]:
            operations.add(str(op).upper())
    criteria = {
        "CLICK": "Click an element, button, menu option, autocomplete suggestion, or calendar day.",
        "TYPE_TEXT": "Enter or replace text in an editable field. The value is supplied by code, not by you.",
        "SELECT": "Select an observed dropdown value.",
        "SCROLL_DOWN": "Scroll down to reveal more content.",
        "SCROLL_UP": "Scroll up.",
        "WAIT": "Wait for the page to update.",
        "DONE": "Every requirement is visibly satisfied.",
        "BLOCKED": "No supported operation can progress.",
    }
    questions: Dict[str, Any] = {
        "operation": {"type": "choice", "instructions": f"Pick the single next browser operation that best advances the goal.\n\nGOAL: {str(input_['goal'])[:1000]}", "criteria": criteria},
    }
    for op in operations:
        if op not in ("CLICK", "TYPE_TEXT", "SELECT"):
            continue
        eligible = [e for e in input_["elements"] if op in [str(o).upper() for o in e["operations"]]]
        if not eligible:
            continue
        target_criteria: Dict[str, str] = {"none": "Do not target any element for this operation."}
        for e in eligible:
            target_criteria[e["index"]] = " | ".join([f for f in [e.get("label"), e.get("role"), e.get("value")] if f])
        questions[op.lower() + "_target"] = {"type": "choice", "instructions": f"Which element should receive the {op} operation to advance the goal?", "criteria": target_criteria}
    response = await ask_jev(config, {"goal": input_["goal"], "page": input_["page"], "elements": input_["elements"], "recent_actions": input_.get("recentActions", [])}, questions, signal)
    op = choice(response, "operation")
    target_key = (op["choice"].lower() + "_target") if op["choice"] else None
    target: Optional[str] = None
    if target_key and target_key in response.answers:
        try:
            t = choice(response, target_key)["choice"]
            target = None if t == "none" else t
        except Exception:
            target = None
    act = bool(op["choice"]) and op["choice"] != "BLOCKED" and op["confidence"] >= min_confidence
    return ChooseBrowserActionResult(operation=op["choice"] or None, target=target, confidence=op["confidence"], act=act)


def choose_browser_action_sync(*args, **kwargs) -> ChooseBrowserActionResult:
    return asyncio.run(choose_browser_action(*args, **kwargs))


@dataclass
class PickToolResult:
    tool: Optional[str]
    confidence: float
    risky: float
    confirm_required: bool
    act: bool


async def pick_tool(
    config: JevConfig,
    input_: Dict[str, Any],
    *,
    min_confidence: float = 0.4,
    risk_threshold: float = 0.5,
    signal: Optional[asyncio.Event] = None,
) -> PickToolResult:
    """Select one tool (or None) and flag whether it needs confirmation."""
    tools = input_["tools"]
    if not tools:
        return PickToolResult(tool=None, confidence=0.0, risky=0.0, confirm_required=False, act=False)
    criteria: Dict[str, str] = {"none": "No listed tool is appropriate; answer or ask the user instead."}
    for t in tools:
        criteria[t["name"]] = t["description"]
    response = await ask_jev(config, {"task": input_["task"], "context": input_.get("context", ""), "tools": tools}, {
        "tool": {"type": "choice", "instructions": "Which single tool best accomplishes the task?", "criteria": criteria},
        "risky": {"type": "noul", "instructions": "Does invoking the chosen tool carry side effects that warrant explicit user confirmation (writes, deletes, network mutations, spending)?"},
    }, signal)
    picked = choice(response, "tool")
    risky = noul(response, "risky")
    act = bool(picked["choice"]) and picked["choice"] != "none" and picked["confidence"] >= min_confidence
    return PickToolResult(tool=picked["choice"] or None, confidence=picked["confidence"], risky=risky, confirm_required=risky >= risk_threshold, act=act)


def pick_tool_sync(*args, **kwargs) -> PickToolResult:
    return asyncio.run(pick_tool(*args, **kwargs))


async def rank_candidates(
    config: JevConfig,
    task: str,
    candidates: List[str],
    *,
    signal: Optional[asyncio.Event] = None,
) -> List[Dict[str, Any]]:
    """Rank a list of strings against a task; returns best-first with scores."""
    if not candidates:
        return []
    questions: Dict[str, Any] = {}
    criteria = ["Irrelevant", "Weakly related", "Relevant", "Directly on point"]
    for i, c in enumerate(candidates):
        questions[f"fit_{i}"] = {"type": "score", "instructions": f"How well does this candidate serve the task?\n\nTASK: {task[:1000]}\n\nCANDIDATE: {c[:1000]}", "criteria": criteria}
    response = await ask_jev(config, {"task": task[:2000]}, questions, signal)
    scored = []
    for i, c in enumerate(candidates):
        a = response.answers.get(f"fit_{i}")
        fitness = float(a.get("score")) if isinstance(a, dict) and a.get("type") == "score" and isinstance(a.get("score"), (int, float)) else 0.0
        scored.append({"candidate": c, "fitness": fitness})
    scored.sort(key=lambda x: x["fitness"], reverse=True)
    return scored


def rank_candidates_sync(*args, **kwargs):
    return asyncio.run(rank_candidates(*args, **kwargs))


__all__ = [
    "SkillCandidate",
    "RouteSkillResult",
    "route_skill",
    "route_skill_sync",
    "JudgeDestructiveResult",
    "judge_destructive",
    "judge_destructive_sync",
    "ChooseBrowserActionResult",
    "choose_browser_action",
    "choose_browser_action_sync",
    "PickToolResult",
    "pick_tool",
    "pick_tool_sync",
    "rank_candidates",
    "rank_candidates_sync",
]
