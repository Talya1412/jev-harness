#!/usr/bin/env python3
"""``jev-tune`` entrypoint: read a labeled dataset, sweep thresholds, print the
best one and the calibration metrics, exit. Pure logic lives in :mod:`tune` and
the helpers below; this module wires it to stdin/stdout/exit so the logic is
testable without a process.
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import sys
from typing import List, Optional, Tuple

from .tune import TuneObjective, TuneSummary, tune


def read_prediction(obj: dict):
    for k in ("p", "prediction", "prob", "probability", "score"):
        v = obj.get(k)
        if isinstance(v, (int, float)) and v == v:  # finite
            return float(v)
    return None


def read_outcome(obj: dict):
    raw = None
    for k in ("y", "outcome", "label", "actual", "target"):
        if k in obj:
            raw = obj[k]
            break
    if raw is None:
        return None
    if isinstance(raw, bool):
        return raw
    if raw in (1, "1", "true", "yes", "pos", "positive"):
        return True
    if raw in (0, "0", "false", "no", "neg", "negative"):
        return False
    return None


def load_dataset(text: str) -> Tuple[Optional[List[dict]], Optional[str]]:
    """Load a dataset from text.

    Accepts either a JSON array of objects or JSONL (one object per line, blank
    lines ignored). Each object needs a numeric probability and a boolean-ish
    outcome; the keys are forgiving.
    """
    trimmed = text.strip()
    if not trimmed:
        return None, "no data: stdin/file is empty"
    records: List[dict] = []
    if trimmed.startswith("["):
        try:
            parsed = json.loads(trimmed)
        except Exception as e:
            return None, f"invalid JSON array: {e}"
        if not isinstance(parsed, list):
            return None, "JSON must be an array"
        records = parsed
    else:
        for line in trimmed.splitlines():
            l = line.strip()
            if not l or l.startswith("#"):
                continue
            try:
                records.append(json.loads(l))
            except Exception as e:
                return None, f"invalid JSONL line '{l[:60]}': {e}"
    if not records:
        return None, "no samples found"
    samples = []
    for i, rec in enumerate(records):
        p = read_prediction(rec)
        y = read_outcome(rec)
        if p is None:
            return None, f"sample {i} is missing a numeric probability"
        if y is None:
            return None, f"sample {i} is missing an outcome"
        if p < 0 or p > 1:
            return None, f"sample {i} probability {p} is outside [0,1]"
        samples.append({"p": p, "y": y})
    return samples, None


def _pct(n: int, total: int) -> str:
    if total == 0:
        return "0%"
    return f"{(n / total) * 100:.1f}%"


def format_summary(summary: TuneSummary, as_json: bool) -> str:
    if as_json:
        return json.dumps(dataclasses.asdict(summary), indent=2)
    lines = [
        "jev-tune  threshold sweep",
        "",
        f"data      n={summary.n}  positives={summary.positives}  ({_pct(summary.positives, summary.n)})",
        f"objective {summary.objective}  ->  best threshold = {summary.best_threshold:.3f}",
        "",
        f"at best   precision={summary.precision:.3f}  recall={summary.recall:.3f}  f1={summary.f1:.3f}",
        f"          tp={summary.tp}  fp={summary.fp}  fn={summary.fn}  tn={summary.tn}",
        "",
        "calibration",
        f"  brier   {summary.brier:.4f}    (lower is better; 0 is perfect)",
        f"  ece     {summary.ece:.4f}    (lower is better)",
        f"  rocAuc  {summary.roc_auc:.4f}    (0.5 = chance, 1 = perfect ranking)",
        f"  prAuc   {summary.pr_auc:.4f}    (better than ROC AUC on imbalanced data)",
        "",
        "top thresholds (best-first)",
    ]
    for row in summary.sweep[:5]:
        lines.append(
            f"  t={row['threshold']:.3f}  f1={row['f1']:.3f}"
            f"  p={row['precision']:.3f}  r={row['recall']:.3f}"
        )
    return "\n".join(lines)


HELP = """\
Usage: jev-tune [options]

Tune a Jev decision threshold against a labeled dataset. Reads (p, y) pairs
from stdin or --file, sweeps thresholds, and reports the best one plus
calibration metrics (Brier, ECE, ROC AUC, PR AUC).

Dataset formats:
  JSONL      one object per line: {"p": 0.82, "y": true}
  JSON array [{"p":0.2,"y":false}, {"p":0.9,"y":true}]
Keys: probability is p | prediction | prob | probability | score;
      outcome is y | outcome | label | actual | target (bool or 0/1).

Options:
  -f, --file <path>       Read the dataset from a file (default: stdin)
  -o, --objective <o>     'f1' (default) or 'youden' (TPR-FPR)
      --json              Print the summary as JSON
  -h, --help              Show this message

Examples:
  cat labels.jsonl | jev-tune
  jev-tune -f eval.jsonl --json
  jev-tune -o youden < destructive-labels.jsonl
"""


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="jev-tune",
        add_help=False,
        description="Tune a Jev decision threshold against a labeled dataset.",
    )
    p.add_argument("-f", "--file", default=None)
    p.add_argument("-o", "--objective", default="f1", choices=["f1", "youden"])
    p.add_argument("--json", dest="as_json", action="store_true")
    p.add_argument("-h", "--help", action="store_true")
    return p


def run(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.help:
        sys.stdout.write(HELP)
        return 0
    if args.file is not None:
        try:
            with open(args.file, "r", encoding="utf-8") as fh:
                text = fh.read()
        except OSError as e:
            sys.stderr.write(f"cannot read {args.file}: {e}\n")
            return 2
    else:
        try:
            text = sys.stdin.read()
        except Exception:
            text = ""
    samples, err = load_dataset(text)
    if err is not None:
        sys.stderr.write(err + "\n")
        return 2
    predictions = [s["p"] for s in samples]
    outcomes = [s["y"] for s in samples]
    summary = tune(predictions, outcomes, args.objective)
    sys.stdout.write(format_summary(summary, args.as_json) + "\n")
    return 0


def main() -> None:
    sys.exit(run())


if __name__ == "__main__":  # pragma: no cover
    main()


__all__ = ["build_parser", "run", "format_summary", "load_dataset", "read_prediction", "read_outcome", "HELP"]
