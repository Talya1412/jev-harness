"""Tests for with_map_reduce: one call per item, then an optional capped reduce."""
from __future__ import annotations

import asyncio
import json

import pytest

from jev_harness.infra import (
    DEFAULT_MAP_CONCURRENCY,
    MAX_REDUCE_CHARS,
    MAX_REDUCE_ITEMS,
    MapReduceOptions,
    with_map_reduce,
    with_map_reduce_sync,
)
from jev_harness.types import JevConfig, JevError

ITEMS = ["alpha", "beta", "gamma"]


def build_questions(item, index):
    return {
        "relevant": {"type": "noul", "instructions": f"Is this item relevant? ITEM: {item}"},
        "label": {
            "type": "choice",
            "instructions": f"Pick a label. ITEM: {item}",
            "criteria": {"keep": "Keep it.", "drop": "Drop it."},
        },
    }


def _map_handler(answers_by_index, reduce_answers=None):
    """Answer the map calls positionally; answer the reduce call from a canned dict."""

    def handler(req):
        state = req["state"]
        if "reduced" in req["questions"]:
            return reduce_answers or {"reduced": {"type": "score", "score": 2.0, "confidence": 0.9, "probabilities": {}}}
        return answers_by_index.get(state["index"], {})

    return handler


def test_runs_one_call_per_item_and_returns_index_aligned_answers(fake_jev):
    fake_jev.handler = _map_handler(
        {
            0: {"relevant": {"type": "noul", "noul": 0.9}, "label": {"type": "choice", "choice": "keep", "confidence": 0.8, "probabilities": {}}},
            1: {"relevant": {"type": "noul", "noul": 0.4}, "label": {"type": "choice", "choice": "drop", "confidence": 0.6, "probabilities": {}}},
            2: {"relevant": {"type": "noul", "noul": 0.7}, "label": {"type": "choice", "choice": "keep", "confidence": 0.7, "probabilities": {}}},
        }
    )
    r = run(with_map_reduce(fake_jev.config(), ITEMS, build_questions))
    assert len(fake_jev.calls) == 3
    assert r["reduced"] is None
    assert [a["relevant"]["noul"] for a in r["per_item"]] == [0.9, 0.4, 0.7]
    assert r["per_item"][1]["label"]["choice"] == "drop"


def test_passes_the_items_own_index_to_build_questions(fake_jev):
    seen = []

    def capturing(item, index):
        seen.append((item, index))
        return {"relevant": {"type": "noul", "instructions": "x"}}

    fake_jev.handler = _map_handler({i: {"relevant": {"type": "noul", "noul": 0.5}} for i in range(3)})
    run(with_map_reduce(fake_jev.config(), ITEMS, capturing))
    assert sorted(seen) == [("alpha", 0), ("beta", 1), ("gamma", 2)]


def test_spends_no_request_on_an_empty_item_list(fake_jev):
    r = run(with_map_reduce(fake_jev.config(), [], build_questions))
    assert r == {"per_item": [], "reduced": None}
    assert fake_jev.calls == []


def test_short_circuits_the_empty_case_even_when_a_reduce_is_configured(fake_jev):
    opts = MapReduceOptions(reduce={"instructions": "Summarize.", "criteria": ["none", "all"]})
    r = run(with_map_reduce(fake_jev.config(), [], build_questions, opts))
    assert r["reduced"] is None
    assert fake_jev.calls == []


def test_runs_one_extra_reduce_call_over_the_collected_answers(fake_jev):
    fake_jev.handler = _map_handler(
        {i: {"relevant": {"type": "noul", "noul": 0.5}} for i in range(3)},
        {"reduced": {"type": "score", "score": 2.0, "confidence": 0.9, "probabilities": {}}},
    )
    opts = MapReduceOptions(reduce={"instructions": "How many items are relevant?", "criteria": ["none", "some", "most", "all"]})
    r = run(with_map_reduce(fake_jev.config(), ITEMS, build_questions, opts))
    assert len(fake_jev.calls) == 4
    assert fake_jev.calls[3]["questions"]["reduced"]["criteria"] == ["none", "some", "most", "all"]
    assert fake_jev.calls[3]["questions"]["reduced"]["type"] == "score"
    assert fake_jev.calls[3]["state"]["item_count"] == 3
    assert r["reduced"]["score"] == 2.0


def test_infers_a_choice_reduce_from_a_keyed_criteria_map(fake_jev):
    fake_jev.handler = _map_handler(
        {i: {"relevant": {"type": "noul", "noul": 0.5}} for i in range(3)},
        {"reduced": {"type": "choice", "choice": "ship", "confidence": 0.9, "probabilities": {}}},
    )
    opts = MapReduceOptions(reduce={"instructions": "Ship?", "criteria": {"ship": "Yes.", "hold": "No."}})
    r = run(with_map_reduce(fake_jev.config(), ITEMS, build_questions, opts))
    assert fake_jev.calls[3]["questions"]["reduced"]["type"] == "choice"
    assert fake_jev.calls[3]["questions"]["reduced"]["criteria"] == {"ship": "Yes.", "hold": "No."}
    assert r["reduced"]["choice"] == "ship"


def test_a_noul_reduce_joins_the_levels_into_one_instruction_adjacent_criterion(fake_jev):
    fake_jev.handler = _map_handler({i: {"relevant": {"type": "noul", "noul": 0.5}} for i in range(3)})
    opts = MapReduceOptions(reduce={"type": "noul", "instructions": "x", "criteria": ["no", "yes"]})
    run(with_map_reduce(fake_jev.config(), ITEMS, build_questions, opts))
    assert fake_jev.calls[3]["questions"]["reduced"]["criteria"] == "no; yes"


def test_turns_an_array_criteria_into_keyed_options_when_the_reduce_type_is_choice(fake_jev):
    fake_jev.handler = _map_handler({i: {"relevant": {"type": "noul", "noul": 0.5}} for i in range(3)})
    opts = MapReduceOptions(reduce={"type": "choice", "instructions": "Pick.", "criteria": ["low", "high"]})
    run(with_map_reduce(fake_jev.config(), ITEMS, build_questions, opts))
    assert fake_jev.calls[3]["questions"]["reduced"]["criteria"] == {"option_0": "low", "option_1": "high"}


def test_sends_a_digest_of_the_answers_to_the_reduce_call_never_the_corpus(fake_jev):
    secret = "TOP-SECRET-CORPUS-MARKER"
    fake_jev.handler = _map_handler({i: {"relevant": {"type": "noul", "noul": 0.42}} for i in range(3)})
    opts = MapReduceOptions(reduce={"instructions": "Summarize.", "criteria": ["none", "all"]})
    run(with_map_reduce(fake_jev.config(), [f"{secret} {i}" for i in range(3)], build_questions, opts))
    reduce_state = json.dumps(fake_jev.calls[3]["state"])
    assert secret not in reduce_state
    assert "Is this item relevant" not in reduce_state
    assert "noul 0.42" in reduce_state


def test_caps_the_reduce_state_so_a_huge_corpus_cannot_blow_the_request(fake_jev):
    n = 500
    fake_jev.handler = _map_handler({i: {"relevant": {"type": "noul", "noul": 0.5}} for i in range(n)})
    opts = MapReduceOptions(reduce={"instructions": "Summarize.", "criteria": ["none", "all"]}, concurrency=64)
    run(with_map_reduce(fake_jev.config(), list(range(n)), build_questions, opts))
    state = fake_jev.calls[-1]["state"]
    assert state["item_count"] == n
    assert len(state["answers"]) <= MAX_REDUCE_ITEMS
    assert state["omitted_items"] == n - len(state["answers"])
    assert len(json.dumps(state)) <= 6_000


def test_leaves_omitted_items_off_a_digest_that_fits(fake_jev):
    fake_jev.handler = _map_handler({i: {"relevant": {"type": "noul", "noul": 0.5}} for i in range(3)})
    opts = MapReduceOptions(reduce={"instructions": "Summarize.", "criteria": ["none", "all"]})
    run(with_map_reduce(fake_jev.config(), ITEMS, build_questions, opts))
    assert "omitted_items" not in fake_jev.calls[-1]["state"]
    assert MAX_REDUCE_CHARS == 4_000


def test_bounds_concurrency_to_the_configured_limit(make_jev):
    inflight = {"peak": 0, "now": 0}

    async def transport(url, method, headers, body, timeout_ms):
        parsed = json.loads(body.decode("utf-8"))
        inflight["now"] += 1
        inflight["peak"] = max(inflight["peak"], inflight["now"])
        await asyncio.sleep(0.01)
        inflight["now"] -= 1
        answers = {k: {"type": "noul", "noul": 0.5} for k in parsed["questions"]}
        return 200, json.dumps({"model": "m", "answers": answers}).encode("utf-8")

    cfg = JevConfig(api_key="k", transport=transport)
    run(with_map_reduce(cfg, list(range(12)), lambda item, index: {"relevant": {"type": "noul", "instructions": "x"}}, MapReduceOptions(concurrency=3)))
    assert inflight["peak"] == 3
    assert DEFAULT_MAP_CONCURRENCY == 4


def test_propagates_a_transport_failure_rather_than_swallowing_it(make_jev):

    async def transport(url, method, headers, body, timeout_ms):
        raise JevError("boom", status=500, retryable=True)

    cfg = JevConfig(api_key="k", transport=transport, max_attempts=1)
    with pytest.raises(JevError):
        run(with_map_reduce(cfg, ITEMS, build_questions))


def test_sync_wrapper_matches_the_async_form(fake_jev):
    fake_jev.handler = _map_handler({i: {"relevant": {"type": "noul", "noul": 0.5}} for i in range(3)})
    r = with_map_reduce_sync(fake_jev.config(), ITEMS, build_questions)
    assert len(r["per_item"]) == 3


def test_accepts_a_raw_dict_for_options(fake_jev):
    fake_jev.handler = _map_handler({i: {"relevant": {"type": "noul", "noul": 0.5}} for i in range(3)})
    r = run(with_map_reduce(fake_jev.config(), ITEMS, build_questions, MapReduceOptions(reduce=None)))
    assert r["reduced"] is None
    assert len(r["per_item"]) == 3


def run(coro):
    return asyncio.run(coro)
