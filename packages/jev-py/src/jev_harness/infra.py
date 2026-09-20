"""Transport-level infrastructure: caching, batching, audit logging, local fallback.

Mirrors ``packages/core/src/infra.ts``. None of these change Jev's decision
logic; they make the same decisions cheaper, more observable, and resilient when
Jev is down. Everything here wraps the transport callable (or is a pure
function), so it composes with every harness adapter without touching decision
code.
"""
from __future__ import annotations

import asyncio
import math
import re
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

from .client import ask_jev
from .types import JevConfig
from .patterns import SkillCandidate


# ----------------------------- caching -----------------------------


@dataclass
class CacheOptions:
    max_entries: int = 256
    on_hit: Optional[Callable[[str], None]] = None


def with_cache(config: JevConfig, opts: Optional[CacheOptions] = None) -> JevConfig:
    """Memoize identical Jev calls by request body.

    noul/choice answers are deterministic for the same input, so a repeat ask
    within a run is free. This is the cost lever the README already pulls by
    refusing mid-stream model switches — caching is the natural complement:
    never pay twice for the same decision.
    """
    opts = opts or CacheOptions()
    cache: Dict[str, str] = {}
    parent = config.transport

    async def wrapped(url: str, method: str, headers: Dict[str, str], body: bytes, timeout_ms: int) -> Tuple[int, bytes]:
        key = url + "\n" + body.decode("utf-8", "replace")
        hit = cache.get(key)
        if hit is not None:
            if opts.on_hit:
                try:
                    opts.on_hit(key)
                except Exception:
                    pass
            return 200, hit.encode("utf-8")
        if parent is not None:
            status, raw = await parent(url, method, headers, body, timeout_ms)
        else:
            from .client import _default_transport

            status, raw = await _default_transport(url, method, headers, body, timeout_ms)
        if 200 <= status < 300:
            if len(cache) >= opts.max_entries:
                # evict oldest insertion
                first = next(iter(cache))
                del cache[first]
            cache[key] = raw.decode("utf-8", "replace")
        return status, raw

    return JevConfig(
        api_key=config.api_key,
        base_url=config.base_url,
        model=config.model,
        timeout_ms=config.timeout_ms,
        max_attempts=config.max_attempts,
        transport=wrapped,
        on_retry=config.on_retry,
    )


# ----------------------------- batching -----------------------------


class BatchHandle:
    """Batch independent question-sets against ONE shared state into a single call.

    The README's "batching is nearly free" is exactly this: every question is
    evaluated independently against the same state, so N callers can share one
    request when their state coincides. Each caller still writes code as if it
    made its own call: :meth:`add` returns a future-like resolved to a response
    scoped to that caller's keys.
    """

    def __init__(self, config: JevConfig, state: Any, signal: Optional[asyncio.Event] = None) -> None:
        self._config = config
        self._state = state
        self._signal = signal
        self._pending: List[Tuple[Dict[str, Any], "asyncio.Future", List[str]]] = []
        self._scheduled = False

    async def add(self, questions: Dict[str, Any]):
        loop = asyncio.get_running_loop()
        fut: "asyncio.Future" = loop.create_future()
        orig_keys = list(questions.keys())
        self._pending.append((questions, fut, orig_keys))
        self._schedule()
        return await fut

    async def flush(self):
        """Fire everything pending immediately. Returns the merged raw response."""
        from .types import JevResponse

        self._scheduled = False
        if not self._pending:
            return JevResponse(model="jev-batch", answers={})
        snapshot = self._pending[:]
        self._pending.clear()
        merged: Dict[str, Any] = {}
        maps = []
        for i, (qs, fut, orig) in enumerate(snapshot):
            prefix = f"c{i}__"
            for k, q in qs.items():
                merged[prefix + k] = q
            maps.append((prefix, orig, fut))
        try:
            response = await ask_jev(self._config, self._state, merged, self._signal)
            for prefix, orig, fut in maps:
                answers: Dict[str, Any] = {}
                for k in orig:
                    a = response.answers.get(prefix + k)
                    if a is not None:
                        answers[k] = a
                if not fut.done():
                    fut.set_result(JevResponse(model=response.model, answers=answers, usage=response.usage))
            return response
        except BaseException as err:
            for _prefix, _orig, fut in maps:
                if not fut.done():
                    fut.set_exception(err)
            raise

    def _schedule(self) -> None:
        if self._scheduled:
            return
        self._scheduled = True
        # Flush on the next loop tick so several synchronous `add` calls merge.
        loop = asyncio.get_running_loop()
        loop.call_soon(self._fire_and_forget)

    def _fire_and_forget(self) -> None:
        # Each caller is resolved/rejected directly inside flush, so an unhandled
        # rejection here is noise rather than signal. Callers wanting the error
        # must use flush() directly.
        task = asyncio.ensure_future(self.flush())
        task.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)


def jev_batch(config: JevConfig, state: Any, signal: Optional[asyncio.Event] = None) -> BatchHandle:
    return BatchHandle(config, state, signal)


# ----------------------------- audit -----------------------------


@dataclass
class AuditEntry:
    ts: float
    url: str
    state: Any = None
    questions: Optional[Dict[str, Any]] = None
    ok: bool = False
    status: Optional[int] = None
    answers: Optional[Dict[str, Any]] = None
    elapsed_ms: float = 0.0
    error: Optional[str] = None


class AuditLog:
    """Append-only decision log. Provenance for every Jev call.

    Essential when "advisory" outputs feed a process that can be audited.
    In-memory by default; pass a ``sink`` to mirror to a file, OTel, or a DB.
    """

    def __init__(self, sink: Optional[Callable[[AuditEntry], None]] = None) -> None:
        self._entries: List[AuditEntry] = []
        self._sink = sink

    def record(self, entry: AuditEntry) -> None:
        self._entries.append(entry)
        if self._sink:
            try:
                self._sink(entry)
            except Exception:
                pass

    def all(self) -> List[AuditEntry]:
        return list(self._entries)

    def drain(self) -> List[AuditEntry]:
        out = list(self._entries)
        self._entries.clear()
        return out

    def size(self) -> int:
        return len(self._entries)


def create_audit_log(sink: Optional[Callable[[AuditEntry], None]] = None) -> AuditLog:
    return AuditLog(sink=sink)


def with_audit(config: JevConfig, log: AuditLog) -> JevConfig:
    """Wrap a config so every Jev call is recorded to ``log``.

    Observes at the transport layer, so it captures decisions from ANY pattern
    or direct :func:`ask_jev` call — no per-pattern retrofit needed.
    """
    parent = config.transport
    import json as _json

    async def wrapped(url: str, method: str, headers: Dict[str, str], body: bytes, timeout_ms: int) -> Tuple[int, bytes]:
        started = time.time() * 1000
        body_state = None
        body_questions = None
        try:
            parsed = _json.loads(body.decode("utf-8", "replace")) if body else {}
            body_state = parsed.get("state")
            body_questions = parsed.get("questions")
        except Exception:
            pass
        try:
            if parent is not None:
                status, raw = await parent(url, method, headers, body, timeout_ms)
            else:
                from .client import _default_transport

                status, raw = await _default_transport(url, method, headers, body, timeout_ms)
            answers = None
            if 200 <= status < 300:
                try:
                    cloned = _json.loads(raw.decode("utf-8", "replace"))
                    answers = cloned.get("answers")
                except Exception:
                    answers = None
            log.record(AuditEntry(
                ts=started, url=url, state=body_state, questions=body_questions,
                ok=(200 <= status < 300), status=status, answers=answers,
                elapsed_ms=time.time() * 1000 - started,
            ))
            return status, raw
        except BaseException as err:
            log.record(AuditEntry(
                ts=started, url=url, state=body_state, questions=body_questions,
                ok=False, elapsed_ms=time.time() * 1000 - started,
                error=str(err),
            ))
            raise

    return JevConfig(
        api_key=config.api_key,
        base_url=config.base_url,
        model=config.model,
        timeout_ms=config.timeout_ms,
        max_attempts=config.max_attempts,
        transport=wrapped,
        on_retry=config.on_retry,
    )


# ----------------------------- local fallback -----------------------------

_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _tokenize(s: str) -> set:
    return set(m.group(0) for m in _TOKEN_RE.finditer(s.lower()))


def _overlap(a: set, b: set) -> float:
    """Cosine-ish overlap on boolean token vectors, 0..1."""
    if not a or not b:
        return 0.0
    hit = sum(1 for t in a if t in b)
    return hit / math.sqrt(len(a) * len(b))


def local_route_skill(message: str, skills: List[SkillCandidate]) -> Dict[str, Any]:
    """Local keyword-overlap router.

    NOT a substitute for Jev — but when Jev is unreachable and a hook must still
    route (fail-open with a graceful quality floor), this is better than "always
    pick the first skill". Use it in a catch around :func:`route_skill`::

        try:
            return await route_skill(config, msg, skills)
        except Exception:
            return local_route_skill(msg, skills)
    """
    m = _tokenize(message)
    best_name: Optional[str] = None
    best_score = 0.0
    for s in skills[:50]:
        desc = _tokenize((s.name + " " + (s.description or "")).strip())
        sc = _overlap(m, desc)
        if sc > best_score:
            best_score = sc
            best_name = s.name
    if best_name is None or best_score < 0.05:
        return {"skill": None, "score": best_score}
    return {"skill": best_name, "score": best_score}


__all__ = [
    "CacheOptions",
    "with_cache",
    "BatchHandle",
    "jev_batch",
    "AuditEntry",
    "AuditLog",
    "create_audit_log",
    "with_audit",
    "local_route_skill",
]
