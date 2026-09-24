"""Failure taxonomy for Jev transport errors.

Mirrors ``packages/core/src/taxonomy.ts``. Blanket fail-open treats every
failure the same, which is wrong in both directions: a bad API key keeps
spending calls that can never succeed, and a transient network blip gets logged
as if it were an outage. Classify the failure once, then apply the policy —
retry the retryable, disable the session on ``auth``/``model``, stay silent on
``network``.

Nothing here raises: classification has to work on whatever the caller caught,
including a bare ``TypeError`` or a plain string.
"""
from __future__ import annotations

import datetime as dt
import email.utils
import re
from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional

from .types import JevError

JevFailureKind = str  # "auth" | "model" | "rate_limit" | "network" | "server" | "unknown"


@dataclass(frozen=True)
class JevFailurePolicy:
    kind: str
    retryable: bool
    backoff_ms: float
    """Suggested wait before the next attempt; 0 when not retryable."""
    disable_session: bool
    """Stop spending calls this session (key invalid / model unknown)."""
    silent: bool
    """Stay silent in logs (transient network blips are noise)."""


# Wait before retrying a 429 that carries no `Retry-After`. Rate limits are
# per-minute windows, so a sub-second retry only burns attempts.
DEFAULT_RATE_LIMIT_BACKOFF_MS = 30_000
# Ceiling on an honoured `Retry-After`, so a bad header cannot stall a session
# for hours.
MAX_RATE_LIMIT_BACKOFF_MS = 300_000

_POLICIES: Dict[str, JevFailurePolicy] = {
    # The key is missing, rejected, or lacks access: every later call fails too.
    "auth": JevFailurePolicy(kind="auth", retryable=False, backoff_ms=0, disable_session=True, silent=False),
    # The model name is withdrawn or unavailable to this key: retrying re-fails.
    "model": JevFailurePolicy(kind="model", retryable=False, backoff_ms=0, disable_session=True, silent=False),
    # Throttled. Retryable, but only after the advertised window.
    "rate_limit": JevFailurePolicy(kind="rate_limit", retryable=True, backoff_ms=DEFAULT_RATE_LIMIT_BACKOFF_MS, disable_session=False, silent=False),
    # DNS/TLS/socket/abort failures. Retryable and deliberately quiet.
    "network": JevFailurePolicy(kind="network", retryable=True, backoff_ms=1_000, disable_session=False, silent=True),
    # Upstream 5xx. Retryable, worth logging.
    "server": JevFailurePolicy(kind="server", retryable=True, backoff_ms=2_000, disable_session=False, silent=False),
    # Anything unrecognised: do not retry, do not disable, do not hide it.
    "unknown": JevFailurePolicy(kind="unknown", retryable=False, backoff_ms=0, disable_session=False, silent=False),
}

# Upstream has no dedicated status for a model the key cannot use, so the model
# shows up in the message of an otherwise generic error. A 404 that mentions a
# model is that case; the narrower phrasings cover the responses that arrive
# without a status at all.
MODEL_MENTION_RE = re.compile(r"\bmodel\b", re.I)
MODEL_MESSAGE_RE = re.compile(
    r"unknown model|no such model|invalid model|unsupported model|model[^.]{0,40}(?:not found|not supported|unavailable|does not exist)",
    re.I,
)
NETWORK_MESSAGE_RE = re.compile(
    r"fetch failed|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ETIMEDOUT|EPIPE|socket hang up|network|timed? ?out|abort",
    re.I,
)


def _field(error: Any, name: str) -> Any:
    """Read one field from a mapping-shaped or attribute-shaped error."""
    if isinstance(error, Mapping):
        return error.get(name)
    return getattr(error, name, None)


def read_message(error: Any) -> str:
    if isinstance(error, BaseException):
        return str(error)
    if isinstance(error, str):
        return error
    return str(_field(error, "message") or "")


def read_name(error: Any) -> str:
    name = _field(error, "name")
    return name if isinstance(name, str) else ""


def read_status(error: Any) -> Optional[int]:
    """Status from a :class:`JevError`, or from any error-shaped object an
    adapter might catch instead (an axios-style ``{"response": {"status": n}}``)."""
    if isinstance(error, JevError):
        return error.status
    direct = _field(error, "status")
    if isinstance(direct, int) and not isinstance(direct, bool):
        return direct
    nested = _field(_field(error, "response"), "status")
    if isinstance(nested, int) and not isinstance(nested, bool):
        return nested
    return None


def _read_header(error: Any, name: str) -> Optional[str]:
    """Read one header out of a mapping or header-like object, wherever it hangs."""
    nested = _field(error, "headers")
    container = nested if nested is not None else error
    if container is None:
        return None
    if isinstance(container, Mapping):
        wanted = name.lower()
        for k, v in container.items():
            if str(k).lower() == wanted and v is not None:
                return str(v)
        return None
    get = getattr(container, "get", None)
    if callable(get):
        try:
            value = get(name)
        except Exception:
            return None
        return None if value is None else str(value)
    return None


def _clamp_backoff(ms: float) -> float:
    return min(max(0.0, ms), MAX_RATE_LIMIT_BACKOFF_MS)


def _parse_http_date(value: str) -> Optional[dt.datetime]:
    """Parse an HTTP-date (RFC 5322, optionally ISO) into an aware UTC datetime."""
    try:
        parsed = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        parsed = None
    if parsed is None:
        try:
            parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except (TypeError, ValueError):
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed


def retry_after_ms(error: Any) -> Optional[float]:
    """``Retry-After`` in milliseconds, in either of its two legal forms (delta
    seconds or an HTTP date). ``None`` when the header is absent or unreadable,
    so the caller falls back to the kind's default backoff."""
    raw = _read_header(error, "retry-after")
    if raw is None:
        return None
    trimmed = raw.strip()
    if not trimmed:
        return None
    if re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", trimmed):
        seconds = float(trimmed)
        return _clamp_backoff(seconds * 1_000)
    # Either an RFC 5322 HTTP date or the ISO form a proxy may pass through —
    # the same spread the JS ``Date.parse`` accepts.
    parsed = _parse_http_date(trimmed)
    if parsed is None:
        return None
    now = dt.datetime.now(dt.timezone.utc)
    return _clamp_backoff((parsed - now).total_seconds() * 1_000)


def classify_jev_failure(error: Any) -> str:
    """Map a caught error onto the framework's failure kinds.

    Observed upstream behaviour drives the status mapping: 401/403 mean the key
    is dead (retrying never helps), 429 and 5xx are transient, and a missing
    model shows up as a 404 whose body names the model rather than as its own
    status code.
    """
    status = read_status(error)
    message = read_message(error)
    if status is not None:
        if status == 401 or status == 403:
            return "auth"
        if status == 404 and MODEL_MENTION_RE.search(message):
            return "model"
        if status == 429:
            return "rate_limit"
        if status >= 500:
            return "server"
        return "unknown"
    if MODEL_MESSAGE_RE.search(message):
        return "model"
    # A rejected request surfaces as a ``TypeError`` in JS; the Python sockets
    # raise ``ConnectionError``/``TimeoutError`` instead, and an aborted or
    # timed-out request lands here too — quiet rather than terminal.
    if isinstance(error, TypeError) or isinstance(error, (ConnectionError, TimeoutError)):
        return "network"
    if read_name(error) == "AbortError":
        return "network"
    if NETWORK_MESSAGE_RE.search(message):
        return "network"
    return "unknown"


def policy_for_failure(kind: str, error: Any = None) -> JevFailurePolicy:
    """Policy for a kind, optionally tightened by the error itself: a
    :class:`JevError` carrying ``retryable=False`` has already been through the
    client's attempt loop, so the caller must not put it back on a backoff."""
    base = _POLICIES.get(kind) or _POLICIES["unknown"]
    if isinstance(error, JevError) and error.retryable is False and base.retryable:
        return JevFailurePolicy(
            kind=base.kind, retryable=False, backoff_ms=0, disable_session=base.disable_session, silent=base.silent
        )
    if base.kind == "rate_limit" and base.retryable:
        honoured = retry_after_ms(error)
        if honoured is not None and honoured != base.backoff_ms:
            return JevFailurePolicy(
                kind=base.kind,
                retryable=base.retryable,
                backoff_ms=honoured,
                disable_session=base.disable_session,
                silent=base.silent,
            )
    return base


__all__ = [
    "JevFailureKind",
    "JevFailurePolicy",
    "DEFAULT_RATE_LIMIT_BACKOFF_MS",
    "MAX_RATE_LIMIT_BACKOFF_MS",
    "retry_after_ms",
    "classify_jev_failure",
    "policy_for_failure",
]
