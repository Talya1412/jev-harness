"""Async Jev client + typed accessors. Mirrors ``packages/core/src/client.ts``.

Jev is an HTTP API; this client uses only the Python standard library
(``urllib`` via a thread executor) so the package has zero runtime
dependencies. A transport callable is injectable for tests and non-standard
runtimes.
"""
from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.request
from typing import Any, Awaitable, Dict, Optional, Tuple

from .types import (
    DEFAULT_BASE_URL,
    DEFAULT_MODEL,
    JevConfig,
    JevError,
    JevResponse,
)

DEFAULT_TIMEOUT_MS = 15_000
DEFAULT_MAX_ATTEMPTS = 3


def _resolve_config(config: JevConfig) -> Dict[str, Any]:
    api_key = (config.api_key or "").strip()
    if not api_key:
        raise JevError(
            "TYPESAFE_API_KEY is not set. Add it to your environment or pass JevConfig(api_key=...).",
            retryable=False,
        )
    return {
        "api_key": api_key,
        "base_url": (config.base_url or DEFAULT_BASE_URL).rstrip("/"),
        "model": config.model or DEFAULT_MODEL,
        "timeout_ms": config.timeout_ms if config.timeout_ms is not None else DEFAULT_TIMEOUT_MS,
        "max_attempts": max(1, config.max_attempts if config.max_attempts is not None else DEFAULT_MAX_ATTEMPTS),
        "transport": config.transport,
        "on_retry": config.on_retry,
    }


def _question_to_dict(q: Any) -> Dict[str, Any]:
    if isinstance(q, dict):
        d = dict(q)
        return d
    # dataclass
    import dataclasses as _dc

    if _dc.is_dataclass(q):
        return {k: getattr(q, k) for k in q.__dataclass_fields__}
    raise JevError(f"question must be a dict or dataclass, got {type(q).__name__}", retryable=False)


def validate_questions(questions: Optional[Dict[str, Any]]) -> None:
    """Validate the question map before spending a request."""
    if not questions or not isinstance(questions, dict):
        raise JevError("questions must be a non-empty object", retryable=False)
    for key, q in questions.items():
        qd = _question_to_dict(q)
        if not qd.get("instructions"):
            raise JevError(f'question "{key}" needs a non-empty instructions string', retryable=False)
        qtype = qd.get("type")
        if qtype == "choice":
            n = len(qd.get("criteria") or {})
            if n < 2:
                raise JevError(f'choice "{key}" needs at least 2 criteria', retryable=False)
        elif qtype == "score":
            crit = qd.get("criteria") or []
            n = len(crit) if isinstance(crit, list) else 0
            if n < 2:
                raise JevError(f'score "{key}" needs at least 2 ordered levels', retryable=False)
        elif qtype != "noul":
            raise JevError(f'question "{key}" has unknown type "{qtype}"', retryable=False)


def _is_transient_message(msg: str) -> bool:
    low = msg.lower()
    return any(t in low for t in ("urlopen", "econn", "network", "timeout", "aborted", "reset", "refused", "unreachable"))


async def _default_transport(
    url: str, method: str, headers: Dict[str, str], body: bytes, timeout_ms: int
) -> Tuple[int, bytes]:
    """urllib-based transport run in a thread executor so the client stays async."""

    def _do() -> Tuple[int, bytes]:
        req = urllib.request.Request(url, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout_ms / 1000) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()
        # urllib.error.URLError and anything else bubble up as transient.

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _do)


async def ask_jev(
    config: JevConfig,
    state: Any,
    questions: Dict[str, Any],
    signal: Optional[asyncio.Event] = None,
) -> JevResponse:
    """One System One call. Batches every question into a single request.

    The primitives are evaluated independently against the same state, so this
    is strictly cheaper than one call per question. Retries transient failures
    (429 / 5xx / network) with cubic backoff.
    """
    cfg = _resolve_config(config)
    validate_questions(questions)
    if state is None:
        raise JevError("state is required", retryable=False)

    normalized = {k: _question_to_dict(q) for k, q in questions.items()}
    body = json.dumps({"model": cfg["model"], "state": state, "questions": normalized}).encode()
    headers = {"Authorization": "Bearer " + cfg["api_key"], "Content-Type": "application/json"}
    url = cfg["base_url"] + "/v1/systemone"

    last_error: Optional[BaseException] = None
    for attempt in range(1, cfg["max_attempts"] + 1):
        if signal is not None and signal.is_set():
            raise asyncio.CancelledError("Jev call aborted")
        try:
            if cfg["transport"] is not None:
                status, raw = await cfg["transport"](url, "POST", headers, body, cfg["timeout_ms"])
            else:
                status, raw = await _default_transport(url, "POST", headers, body, cfg["timeout_ms"])
        except asyncio.CancelledError:
            raise
        except BaseException as e:  # network / urlopen errors
            last_error = e
            transient = True
            if attempt == cfg["max_attempts"]:
                raise
            if cfg["on_retry"]:
                try:
                    cfg["on_retry"](attempt, e)
                except Exception:
                    pass
            await asyncio.sleep(0.25 * attempt * attempt)
            continue

        if status == 429 or status >= 500:
            text = raw.decode("utf-8", "replace")
            last_error = JevError(f"Jev HTTP {status}: {text[:300]}", status=status, retryable=True)
            if attempt < cfg["max_attempts"]:
                if cfg["on_retry"]:
                    try:
                        cfg["on_retry"](attempt, last_error)
                    except Exception:
                        pass
                await asyncio.sleep(0.25 * attempt * attempt)
                continue
            raise last_error
        if not (200 <= status < 300):
            text = raw.decode("utf-8", "replace")
            raise JevError(f"Jev HTTP {status}: {text[:500]}", status=status, retryable=False)

        try:
            parsed = json.loads(raw.decode("utf-8", "replace"))
        except Exception:
            raise JevError("Jev returned malformed JSON", retryable=False)
        if not isinstance(parsed, dict) or not isinstance(parsed.get("answers"), dict):
            raise JevError("Jev response is missing `answers`", retryable=False)
        return JevResponse(model=parsed.get("model", ""), answers=parsed["answers"], usage=parsed.get("usage"))

    raise last_error if last_error is not None else JevError("Jev call failed", retryable=False)


def ask_jev_sync(
    config: JevConfig,
    state: Any,
    questions: Dict[str, Any],
    signal: Optional[asyncio.Event] = None,
) -> JevResponse:
    """Synchronous wrapper around :func:`ask_jev` for simple scripts."""
    return asyncio.run(ask_jev(config, state, questions, signal))


async def list_jev_models(config: JevConfig) -> list:
    """List the models available to the configured key."""
    cfg = _resolve_config(config)
    url = cfg["base_url"] + "/v1/models"
    headers = {"Authorization": "Bearer " + cfg["api_key"]}
    if cfg["transport"] is not None:
        status, raw = await cfg["transport"](url, "GET", headers, b"", cfg["timeout_ms"])
    else:
        status, raw = await _default_transport(url, "GET", headers, b"", cfg["timeout_ms"])
    if not (200 <= status < 300):
        raise JevError(f"Jev models HTTP {status}", status=status)
    body = json.loads(raw.decode("utf-8", "replace"))
    return body.get("models", [])


def list_jev_models_sync(config: JevConfig) -> list:
    return asyncio.run(list_jev_models(config))


# --- Typed accessors. Each raises JevError when the answer is missing or
# malformed, so callers never narrow a union by hand. ---


def noul(response: JevResponse, id: str) -> float:
    a = response.answers.get(id)
    if not isinstance(a, dict) or a.get("type") != "noul" or not isinstance(a.get("noul"), (int, float)):
        raise JevError(f'answer "{id}" is not a valid noul', retryable=False)
    return float(a["noul"])


def choice(response: JevResponse, id: str) -> Dict[str, Any]:
    a = response.answers.get(id)
    if not isinstance(a, dict) or a.get("type") != "choice":
        raise JevError(f'answer "{id}" is not a valid choice', retryable=False)
    return {
        "choice": a.get("choice", ""),
        "confidence": float(a.get("confidence") or 0),
        "probabilities": a.get("probabilities") or {},
    }


def score(response: JevResponse, id: str) -> Dict[str, Any]:
    a = response.answers.get(id)
    if not isinstance(a, dict) or a.get("type") != "score":
        raise JevError(f'answer "{id}" is not a valid score', retryable=False)
    return {"score": float(a.get("score") or 0), "confidence": float(a.get("confidence") or 0), "legend": a.get("legend")}


__all__ = [
    "ask_jev",
    "ask_jev_sync",
    "list_jev_models",
    "list_jev_models_sync",
    "noul",
    "choice",
    "score",
    "validate_questions",
    "DEFAULT_TIMEOUT_MS",
    "DEFAULT_MAX_ATTEMPTS",
]
