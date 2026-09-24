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
from dataclasses import dataclass, field, replace
from typing import Any, Awaitable, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from .client import ask_jev
from .patterns import SkillCandidate
from .thresholds import THRESHOLDS
from .types import JevConfig


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


# ----------------------------- refusals -----------------------------


@dataclass(frozen=True)
class RefusalEntry:
    key: str
    """What was refused (a tool name, an action, a target path)."""
    reason: str
    """Why, as one fixed sentence per diagnosis."""
    at: float
    """When this refusal was last recorded, in ms since epoch."""
    count: int
    """How many times this exact (key, reason) refusal has been recorded."""


DEFAULT_REFUSAL_MAX = 200
"""Distinct refusals retained before the oldest is dropped."""


class RefusalLedger:
    """Ledger of refused actions, folded by exact ``(key, reason)``.

    A refusal has to explain itself with ONE fixed sentence per diagnosis, and
    never the same sentence twice: the caller reading the ledger wants the
    distinct reasons, not 400 repetitions of "cannot resolve target". Repeats
    therefore coalesce into the original entry and only bump ``count`` — which
    keeps the signal (did this keep happening?) without the noise.

    Retention is capped at ``max`` distinct entries, newest kept; the oldest are
    dropped because a frequent schedule would otherwise bury its own real
    history under routine refusals. ``at`` is the most recent occurrence, so a
    folded entry still sorts as current.
    """

    def __init__(self, now: Optional[Callable[[], float]] = None, max_entries: int = DEFAULT_REFUSAL_MAX) -> None:
        self._now = now or (lambda: time.time() * 1000)
        self._max = max(1, max_entries)
        # Insertion-ordered, one entry per distinct (key, reason) — the exact
        # analogue of the TS array + Map pair, and of its ``\\u0000`` join.
        self._entries: Dict[Tuple[str, str], RefusalEntry] = {}

    def record(self, key: str, reason: str, at: Optional[float] = None) -> None:
        """Record a refusal. Repeats of the same (key, reason) fold into one
        entry with an incrementing count."""
        when = self._now() if at is None else at
        folded = self._entries.get((key, reason))
        if folded is not None:
            self._entries[(key, reason)] = replace(folded, count=folded.count + 1, at=when)
            return
        self._entries[(key, reason)] = RefusalEntry(key=key, reason=reason, at=when, count=1)
        while len(self._entries) > self._max:
            self._entries.pop(next(iter(self._entries)))

    def entries(self) -> List[RefusalEntry]:
        """A fresh list of the immutable entries, so a caller cannot mutate ledger
        state through the snapshot."""
        return list(self._entries.values())


def create_refusal_ledger(
    now: Optional[Callable[[], float]] = None, max_entries: int = DEFAULT_REFUSAL_MAX
) -> RefusalLedger:
    return RefusalLedger(now=now, max_entries=max_entries)


# ----------------------------- map-reduce -----------------------------

MAX_REDUCE_ITEMS = 200
"""Max per-item digests fed into the reduce state."""
MAX_REDUCE_CHARS = 4_000
"""Max chars of the reduce state; a huge corpus must not blow the request."""
DEFAULT_MAP_CONCURRENCY = 4
"""Default in-flight item judgments. Jev bills per request, not per question."""


@dataclass
class MapReduceOptions:
    """Options for :func:`with_map_reduce`."""

    reduce: Optional[Mapping[str, Any]] = None
    """Optional final judgment over the collected per-item answers. The reduce
    state is a compact digest of those answers — never the corpus itself."""
    concurrency: int = DEFAULT_MAP_CONCURRENCY
    """Item judgments in flight at once."""
    signal: Optional[asyncio.Event] = None


def _compact_answer(answer: Any) -> str:
    """One line per answer — a verdict plus a confidence, never the source text."""
    if not isinstance(answer, dict):
        return "missing"
    atype = answer.get("type")
    if atype == "noul" and isinstance(answer.get("noul"), (int, float)):
        return f"noul {float(answer['noul']):.2f}"
    if atype == "choice":
        return f"choice {answer.get('choice')} ({float(answer.get('confidence') or 0):.2f})"
    if atype == "score" and isinstance(answer.get("score"), (int, float)):
        return f"score {float(answer['score'])} ({float(answer.get('confidence') or 0):.2f})"
    return "missing"


def _build_reduce_state(per_item: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Build the reduce state: an index-aligned digest of the per-item answers,
    capped so a 10k-item corpus cannot blow the request. The corpus and the
    per-item questions never appear here — the reduce model sees verdicts, which
    is both cheaper and the only thing it needs to synthesize over."""
    lines: List[str] = []
    chars = 0
    omitted = 0
    for i, answers in enumerate(per_item):
        if len(lines) >= MAX_REDUCE_ITEMS:
            omitted = len(per_item) - i
            break
        answers = answers or {}
        ids = list(answers.keys())
        digest = "no answer" if not ids else "; ".join(f"{k}: {_compact_answer(answers[k])}" for k in ids)
        line = f"[{i}] {digest}"
        if chars + len(line) > MAX_REDUCE_CHARS:
            omitted = len(per_item) - i
            break
        lines.append(line)
        chars += len(line) + 1
    state: Dict[str, Any] = {"item_count": len(per_item), "answers": lines}
    if omitted > 0:
        state["omitted_items"] = omitted
    return state


async def with_map_reduce(
    config: JevConfig,
    items: Sequence[Any],
    build_questions: Callable[[Any, int], Dict[str, Any]],
    options: Optional[MapReduceOptions] = None,
) -> Dict[str, Any]:
    """Run the same questions over every item, then optionally reduce the answers.

    This is the dominant real-world Jev workload: "the same judgment over a huge
    corpus" (triage every file, score every doc, classify every log line). The
    map half is ``build_questions`` per item with bounded concurrency; the reduce
    half is ONE extra call whose state is the digest of the per-item answers, so
    the reduce cost stays flat as the corpus grows.

    ``per_item`` is index-aligned with ``items``. Errors from any item reject the
    whole call — fail-open belongs at the caller, next to the decision it guards.
    An empty ``items`` short-circuits without spending a request.

    Returns ``{"per_item": [...], "reduced": Answer | None}``.
    """
    opts = options or MapReduceOptions()
    if not items:
        return {"per_item": [], "reduced": None}
    concurrency = max(1, opts.concurrency or DEFAULT_MAP_CONCURRENCY)

    per_item: List[Dict[str, Any]] = [{} for _ in items]
    cursor = 0

    async def worker() -> None:
        nonlocal cursor
        while True:
            index = cursor
            cursor += 1
            if index >= len(items):
                return
            response = await ask_jev(
                config,
                {"item": items[index], "index": index, "total": len(items)},
                build_questions(items[index], index),
                opts.signal,
            )
            per_item[index] = response.answers or {}

    await asyncio.gather(*(worker() for _ in range(min(concurrency, len(items)))))

    if not opts.reduce:
        return {"per_item": per_item, "reduced": None}

    instructions = opts.reduce["instructions"]
    criteria = opts.reduce["criteria"]
    rtype = opts.reduce.get("type") or ("score" if isinstance(criteria, list) else "choice")
    if rtype == "noul":
        question = {"type": "noul", "instructions": instructions, "criteria": "; ".join(criteria) if isinstance(criteria, list) else criteria}
    elif rtype == "score":
        question = {"type": "score", "instructions": instructions, "criteria": criteria if isinstance(criteria, list) else list(criteria.values())}
    else:
        question = {
            "type": "choice",
            "instructions": instructions,
            "criteria": {f"option_{i}": level for i, level in enumerate(criteria)} if isinstance(criteria, list) else criteria,
        }

    response = await ask_jev(config, _build_reduce_state(per_item), {"reduced": question}, opts.signal)
    return {"per_item": per_item, "reduced": (response.answers or {}).get("reduced")}


def with_map_reduce_sync(*args, **kwargs) -> Dict[str, Any]:
    return asyncio.run(with_map_reduce(*args, **kwargs))


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
    if best_name is None or best_score < THRESHOLDS["localRouterFloor"]:
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
    "RefusalEntry",
    "RefusalLedger",
    "DEFAULT_REFUSAL_MAX",
    "create_refusal_ledger",
    "MapReduceOptions",
    "MAX_REDUCE_ITEMS",
    "MAX_REDUCE_CHARS",
    "DEFAULT_MAP_CONCURRENCY",
    "with_map_reduce",
    "with_map_reduce_sync",
    "local_route_skill",
]
