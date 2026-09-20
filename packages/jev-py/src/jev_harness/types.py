"""Core transport and primitive types for TypeSafe's Jev (System One) model.

Jev takes a ``state`` (arbitrary JSON) plus typed ``questions`` and returns
calibrated probabilities rather than generated text. Everything in this package
is harness-agnostic: no framework imports, no globals.

This module mirrors ``packages/core/src/types.ts`` field-for-field.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Union

DEFAULT_BASE_URL = "https://api.typesafe.ai"
DEFAULT_MODEL = "jev-latest"

# The three System One primitives.
QuestionType = str  # "noul" | "choice" | "score"


@dataclass
class NoulQuestion:
    type: str = "noul"
    instructions: str = ""
    criteria: Optional[Union[str, Dict[str, str]]] = None


@dataclass
class ChoiceQuestion:
    type: str = "choice"
    instructions: str = ""
    criteria: Dict[str, str] = field(default_factory=dict)


@dataclass
class ScoreQuestion:
    type: str = "score"
    instructions: str = ""
    criteria: List[str] = field(default_factory=list)


Question = Union[NoulQuestion, ChoiceQuestion, ScoreQuestion]
# A question map is a dict of id -> question. We accept either dataclass
# instances or plain dicts (so callers can use whichever they prefer); the
# client normalizes to dict before serializing.
Questions = Dict[str, Any]


@dataclass
class NoulAnswer:
    type: str = "noul"
    noul: float = 0.0


@dataclass
class ChoiceAnswer:
    type: str = "choice"
    choice: str = ""
    probabilities: Dict[str, float] = field(default_factory=dict)
    confidence: float = 0.0


@dataclass
class ScoreAnswer:
    type: str = "score"
    score: float = 0.0
    probabilities: Dict[str, float] = field(default_factory=dict)
    confidence: float = 0.0
    legend: Optional[Dict[str, str]] = None


Answer = Union[NoulAnswer, ChoiceAnswer, ScoreAnswer]


@dataclass
class Usage:
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None


@dataclass
class JevResponse:
    model: str
    answers: Dict[str, Any]
    usage: Optional[Dict[str, Any]] = None


class JevError(Exception):
    """Raised for any Jev transport / protocol / validation error.

    ``status`` is the HTTP status when applicable; ``retryable`` marks
    transient (429/5xx/network) failures so callers can decide to retry.
    """

    def __init__(
        self,
        message: str,
        *,
        status: Optional[int] = None,
        retryable: bool = False,
        cause: Optional[BaseException] = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.retryable = retryable
        self.cause = cause

    def __str__(self) -> str:  # pragma: no cover - cosmetic
        msg = super().__str__()
        bits = []
        if self.status is not None:
            bits.append(f"status={self.status}")
        bits.append(f"retryable={self.retryable}")
        return f"{msg} ({', '.join(bits)})" if bits else msg


# A transport is an async callable: (url, method, headers, body_bytes) ->
# (status, body_bytes). Inject one in tests or for non-standard runtimes;
# the default uses stdlib urllib in a thread executor.
Transport = Any  # Callable[[str, str, Dict[str,str], bytes], Awaitable[Tuple[int,bytes]]]


@dataclass
class JevConfig:
    api_key: str = ""
    base_url: Optional[str] = None
    model: Optional[str] = None
    timeout_ms: Optional[int] = None
    max_attempts: Optional[int] = None
    transport: Optional[Transport] = None
    on_retry: Optional[Any] = None  # Callable[[int, BaseException], None]


__all__ = [
    "DEFAULT_BASE_URL",
    "DEFAULT_MODEL",
    "NoulQuestion",
    "ChoiceQuestion",
    "ScoreQuestion",
    "Question",
    "Questions",
    "NoulAnswer",
    "ChoiceAnswer",
    "ScoreAnswer",
    "Answer",
    "Usage",
    "JevResponse",
    "JevConfig",
    "JevError",
    "Transport",
]
