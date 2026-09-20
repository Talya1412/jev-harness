"""Shared test fixtures: a fake async transport for the Jev client.

The transport signature matches what the client passes:
``async (url, method, headers, body, timeout_ms) -> (status, body_bytes)``.
Each test builds a :class:`FakeJev` whose handler receives the parsed request
and returns a canned answers dict, so tests never hit the network.
"""
from __future__ import annotations

import json
from typing import Any, Callable, Dict, Optional, Tuple

import pytest

from jev_harness import JevConfig


class FakeJev:
    """A configurable fake Jev endpoint.

    ``handler(parsed_request) -> answers_dict``. ``parsed_request`` has
    ``state`` and ``questions``. If ``handler`` is None, every question id in
    the request gets a default answer.
    """

    def __init__(
        self,
        handler: Optional[Callable[[dict], Dict[str, Any]]] = None,
        status: int = 200,
        body_override: Optional[bytes] = None,
        api_key: str = "test-key",
    ) -> None:
        self.handler = handler
        self.status = status
        self.body_override = body_override
        self.calls = []  # list of parsed request bodies
        self.api_key = api_key

    def default_answers(self, questions: Dict[str, Any]) -> Dict[str, Any]:
        answers: Dict[str, Any] = {}
        for k, q in questions.items():
            qtype = q.get("type")
            if qtype == "noul":
                answers[k] = {"type": "noul", "noul": 0.5}
            elif qtype == "choice":
                criteria = q.get("criteria") or {}
                first_key = next(iter(criteria), "a")
                answers[k] = {"type": "choice", "choice": first_key, "probabilities": {first_key: 1.0}, "confidence": 0.7}
            elif qtype == "score":
                answers[k] = {"type": "score", "score": 1.0, "probabilities": {}, "confidence": 0.6}
        return answers

    async def transport(self, url: str, method: str, headers: Dict[str, str], body: bytes, timeout_ms: int) -> Tuple[int, bytes]:
        parsed = json.loads(body.decode("utf-8")) if body else {}
        self.calls.append(parsed)
        if self.body_override is not None:
            return self.status, self.body_override
        answers = self.handler(parsed) if self.handler else self.default_answers(parsed.get("questions", {}))
        resp = {"model": "jev-fake", "answers": answers}
        return self.status, json.dumps(resp).encode("utf-8")

    def config(self, **overrides) -> JevConfig:
        return JevConfig(api_key=self.api_key, transport=self.transport, **overrides)


@pytest.fixture
def fake_jev():
    return FakeJev()


@pytest.fixture
def make_jev():
    return FakeJev


def run(coro):
    import asyncio

    return asyncio.run(coro)
