"""Tests for the jev-tune CLI: arg parsing, dataset loading, formatting."""
from __future__ import annotations

import json
import subprocess
import sys

from jev_harness.eval.cli import (
    build_parser,
    format_summary,
    load_dataset,
    read_outcome,
    read_prediction,
    run,
)
from jev_harness.eval.tune import tune


def test_read_prediction_flexible():
    assert read_prediction({"p": 0.3}) == 0.3
    assert read_prediction({"probability": 0.7}) == 0.7
    assert read_prediction({"score": 0.5}) == 0.5
    assert read_prediction({"nope": 1}) is None


def test_read_outcome_flexible():
    assert read_outcome({"y": True}) is True
    assert read_outcome({"outcome": 1}) is True
    assert read_outcome({"label": "positive"}) is True
    assert read_outcome({"target": 0}) is False
    assert read_outcome({"target": "no"}) is False
    assert read_outcome({}) is None


def test_load_dataset_jsonl():
    text = '{"p": 0.1, "y": false}\n{"p": 0.9, "y": true}\n'
    samples, err = load_dataset(text)
    assert err is None
    assert len(samples) == 2
    assert samples[0] == {"p": 0.1, "y": False}
    assert samples[1] == {"p": 0.9, "y": True}


def test_load_dataset_json_array():
    text = json.dumps([{"p": 0.2, "y": False}, {"p": 0.8, "y": True}])
    samples, err = load_dataset(text)
    assert err is None
    assert len(samples) == 2


def test_load_dataset_ignores_blank_and_comment_lines():
    text = '{"p":0.1,"y":false}\n\n# comment\n{"p":0.9,"y":true}\n'
    samples, err = load_dataset(text)
    assert err is None
    assert len(samples) == 2


def test_load_dataset_rejects_empty():
    samples, err = load_dataset("")
    assert err == "no data: stdin/file is empty"


def test_load_dataset_rejects_out_of_range_prob():
    samples, err = load_dataset('{"p": 1.5, "y": true}')
    assert err is not None
    assert "outside" in err


def test_load_dataset_rejects_missing_outcome():
    samples, err = load_dataset('{"p": 0.5}')
    assert err is not None
    assert "outcome" in err


def test_format_summary_human_readable():
    s = tune([0.1, 0.9], [False, True], "f1")
    out = format_summary(s, as_json=False)
    assert "jev-tune" in out
    assert "best threshold" in out
    assert "brier" in out
    assert "prAuc" in out


def test_format_summary_json():
    s = tune([0.1, 0.9], [False, True], "f1")
    out = format_summary(s, as_json=True)
    parsed = json.loads(out)
    assert "best_threshold" in parsed
    assert "sweep" in parsed


def test_run_reads_stdin(monkeypatch, capsys):
    import io

    data = '{"p": 0.1, "y": false}\n{"p": 0.9, "y": true}\n'
    monkeypatch.setattr("sys.stdin", io.StringIO(data))
    code = run([])
    assert code == 0
    out = capsys.readouterr().out
    assert "best threshold" in out


def test_run_file_arg(tmp_path, capsys):
    f = tmp_path / "labels.jsonl"
    f.write_text('{"p":0.2,"y":false}\n{"p":0.8,"y":true}\n')
    code = run(["-f", str(f)])
    assert code == 0
    out = capsys.readouterr().out
    assert "best threshold" in out


def test_run_unknown_objective_rejected(capsys):
    # argparse choices reject invalid values with exit 2
    try:
        run(["-o", "bogus"])
        assert False, "should have exited"
    except SystemExit as e:
        assert e.code == 2


def test_cli_installed_entrypoint_smoke():
    """Run the installed console script end-to-end if available; else via -m."""
    import os
    import shutil

    # Spawned subprocesses don't inherit pytest's pythonpath=src setting.
    src = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
    env = dict(os.environ, PYTHONPATH=src)
    if shutil.which("jev-tune") is None:
        # run as module instead
        out = subprocess.run(
            [sys.executable, "-m", "jev_harness.eval.cli"],
            input='{"p":0.1,"y":false}\n{"p":0.9,"y":true}\n',
            capture_output=True,
            text=True,
            env=env,
        )
        assert out.returncode == 0, out.stderr
        assert "best threshold" in out.stdout
        return
    out = subprocess.run(
        ["jev-tune"],
        input='{"p":0.1,"y":false}\n{"p":0.9,"y":true}\n',
        capture_output=True,
        text=True,
        env=env,
    )
    assert out.returncode == 0, out.stderr
    assert "best threshold" in out.stdout
