"""TypeSafe Jev (System One) integrations for Python.

Jev is not a chat model. You send it a ``state`` plus typed ``questions`` and it
returns **calibrated probabilities** your code acts on directly. This package is
a faithful, zero-dependency port of ``@jev-harness/core`` (TypeScript): the same
async client, the same three primitives (``noul`` / ``choice`` / ``score``), the
same reusable patterns, and the same transport-level infra (caching, batching,
audit, local fallback). The :mod:`jev_harness.eval` subpackage ports the eval +
tuning tooling (Brier, ECE, ROC/PR AUC, threshold sweep) and the ``jev-tune``
CLI.
"""
from .types import (
    DEFAULT_BASE_URL,
    DEFAULT_MODEL,
    Answer,
    ChoiceAnswer,
    ChoiceQuestion,
    JevConfig,
    JevError,
    JevResponse,
    NoulAnswer,
    NoulQuestion,
    Question,
    Questions,
    ScoreAnswer,
    ScoreQuestion,
)
from .client import (
    ask_jev,
    ask_jev_sync,
    list_jev_models,
    list_jev_models_sync,
    noul,
    choice,
    score,
    validate_questions,
)
from .patterns import (
    SkillCandidate,
    RouteSkillResult,
    route_skill,
    route_skill_sync,
    judge_destructive,
    judge_destructive_sync,
    choose_browser_action,
    choose_browser_action_sync,
    pick_tool,
    pick_tool_sync,
    rank_candidates,
    rank_candidates_sync,
)
from .patterns_extra import (
    VerifyClaimResult,
    detect_prompt_injection,
    detect_prompt_injection_sync,
    needs_more_context,
    needs_more_context_sync,
    verify_claim,
    verify_claim_sync,
    judge_regression,
    judge_regression_sync,
    triage_urgency,
    triage_urgency_sync,
    choose_subagent,
    choose_subagent_sync,
    debate_judge,
    debate_judge_sync,
)
from .infra import (
    AuditEntry,
    AuditLog,
    BatchHandle,
    CacheOptions,
    create_audit_log,
    jev_batch,
    local_route_skill,
    with_audit,
    with_cache,
)

__version__ = "0.1.0"

__all__ = [
    # types
    "DEFAULT_BASE_URL",
    "DEFAULT_MODEL",
    "Answer",
    "ChoiceAnswer",
    "ChoiceQuestion",
    "JevConfig",
    "JevError",
    "JevResponse",
    "NoulAnswer",
    "NoulQuestion",
    "Question",
    "Questions",
    "ScoreAnswer",
    "ScoreQuestion",
    # client
    "ask_jev",
    "ask_jev_sync",
    "list_jev_models",
    "list_jev_models_sync",
    "noul",
    "choice",
    "score",
    "validate_questions",
    # patterns
    "SkillCandidate",
    "RouteSkillResult",
    "route_skill",
    "route_skill_sync",
    "judge_destructive",
    "judge_destructive_sync",
    "choose_browser_action",
    "choose_browser_action_sync",
    "pick_tool",
    "pick_tool_sync",
    "rank_candidates",
    "rank_candidates_sync",
    # patterns_extra
    "VerifyClaimResult",
    "verify_claim",
    "verify_claim_sync",
    "detect_prompt_injection",
    "detect_prompt_injection_sync",
    "needs_more_context",
    "needs_more_context_sync",
    "judge_regression",
    "judge_regression_sync",
    "triage_urgency",
    "triage_urgency_sync",
    "choose_subagent",
    "choose_subagent_sync",
    "debate_judge",
    "debate_judge_sync",
    # infra
    "AuditEntry",
    "AuditLog",
    "BatchHandle",
    "CacheOptions",
    "create_audit_log",
    "jev_batch",
    "local_route_skill",
    "with_audit",
    "with_cache",
    "__version__",
]
