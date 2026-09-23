# jev-harness (Python)

A faithful, **zero-dependency** Python port of [`@jev-harness/core`](../core) — TypeSafe Jev (System One) integrations for the Python ecosystem.

Jev is not a chat model. You send it a `state` plus typed `questions` and it returns **calibrated probabilities** your code acts on directly. This package ports the same async client, the same three primitives (`noul` / `choice` / `score`), the same reusable patterns, and the same transport-level infra (caching, batching, audit, local fallback). The `jev_harness.eval` subpackage ports the eval + tuning tooling and the `jev-tune` CLI.

## Install

```bash
pip install jev-harness            # from source: pip install -e packages/jev-py
```

Zero runtime dependencies — the client uses only the standard library (`urllib` via an `asyncio` thread executor). `pytest` is an optional dev extra (`pip install jev-harness[dev]`).

## Quick start

```python
from jev_harness import JevConfig, judge_destructive_sync

cfg = JevConfig(api_key="ts_...")  # or read os.environ["TYPESAFE_API_KEY"]

r = judge_destructive_sync(cfg, {"tool": "bash", "input": {"cmd": "rm -rf dist"}})
if r.blocked:                       # threshold 0.75 — the one true veto
    raise SystemExit("destructive action blocked")
```

Every pattern has an async form (`judge_destructive`) and a sync wrapper (`judge_destructive_sync`) for simple scripts. The async core is the source of truth; sync wrappers just call `asyncio.run`.

## What's ported

| TS module                | Python module                | Notes                                                                                                                                                      |
| ------------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/client.ts`         | `jev_harness.client`         | `ask_jev`, `list_jev_models`, `noul`/`choice`/`score` accessors, `validate_questions`. Injectable `transport`. Retries 429/5xx/network with cubic backoff. |
| `core/types.ts`          | `jev_harness.types`          | `JevConfig`, `JevError`, `JevResponse`, question/answer dataclasses.                                                                                       |
| `core/patterns.ts`       | `jev_harness.patterns`       | `route_skill`, `judge_destructive` (@ 0.75), `choose_browser_action`, `pick_tool`, `rank_candidates`.                                                      |
| `core/patterns-extra.ts` | `jev_harness.patterns_extra` | `verify_claim` (RAG gate), `detect_prompt_injection`, `needs_more_context`, `judge_regression`, `triage_urgency`, `choose_subagent`, `debate_judge`.       |
| `core/infra.ts`          | `jev_harness.infra`          | `with_cache`, `jev_batch`, `create_audit_log`/`with_audit`, `local_route_skill`.                                                                           |
| `eval/metrics.ts`        | `jev_harness.eval.metrics`   | `brier_score`, `ece`, `confusion_matrix`, `precision_recall_f1`, `roc_auc`, `pr_auc`.                                                                      |
| `eval/tune.ts`           | `jev_harness.eval.tune`      | `tune` (F1 / Youden sweep).                                                                                                                                |
| `eval/cli.ts`            | `jev_harness.eval.cli`       | `jev-tune` console script.                                                                                                                                 |

## Tuning a threshold

```bash
cat labels.jsonl | jev-tune                 # human report
cat labels.jsonl | jev-tune --json          # machine-readable
jev-tune -f eval.jsonl -o youden            # TPR-FPR objective
```

Dataset formats, accepted keys, and the report shape are identical to the TS CLI.

```python
from jev_harness.eval import tune
s = tune([0.1, 0.4, 0.6, 0.9], [False, True, True, False], "f1")
print(s.best_threshold, s.f1, s.brier, s.ece, s.roc_auc, s.pr_auc)
```

## Transport composition

Infra wraps the transport, so it composes with any pattern — no per-pattern retrofit:

```python
from jev_harness import with_cache, with_audit, create_audit_log, verify_claim_sync

log = create_audit_log(sink=lambda e: print("jev:", e.url, e.status, f"{e.elapsed_ms:.0f}ms"))
cfg = with_audit(with_cache(JevConfig(api_key="ts_...")), log)
verify_claim_sync(cfg, {"claim": "...", "source": "..."})
```

- `with_audit(with_cache(cfg), log)` — audit records **every** call (including cache hits).
- `with_cache(with_audit(cfg, log))` — audit records only **network** calls.

Both are valid; pick the one whose semantics you want.

## Testing

```bash
pip install -e packages/jev-py[dev]
cd packages/jev-py && python -m pytest      # 91 tests
```

Tests use a fake async transport (no network), mirroring the TS suite case-for-case.

## License

Apache-2.0, matching the rest of the monorepo.
