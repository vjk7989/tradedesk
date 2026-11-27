from pathlib import Path

import pytest

from bt_service import run_backtest

FIXTURES = Path(__file__).parent / "fixtures"

GOOD = '''
import pandas as pd


class SignalEngine:
    def generate(self, data_map):
        return {code: pd.Series(1.0, index=df.index) for code, df in data_map.items()}
'''

LOOP = '''
import pandas as pd


class SignalEngine:
    def generate(self, data_map):
        while True:
            pass
'''

ARGS = dict(symbols=["AAPL.US"], start="2024-01-02", end="2024-06-14", source="local")


@pytest.fixture
def env(tmp_path, monkeypatch):
    cfg = tmp_path / "config.yaml"
    cfg.write_text(
        "sources:\n"
        '  - symbol: "AAPL.US"\n'
        "    type: csv\n"
        f'    path: "{(FIXTURES / "aapl.csv").as_posix()}"\n'
        '    date_format: "%Y-%m-%d"\n',
        encoding="utf-8",
    )
    runs = tmp_path / "runs"
    monkeypatch.setenv("BT_LOCAL_DATA_CONFIG", str(cfg))
    monkeypatch.setenv("BT_RUNS_DIR", str(runs))
    monkeypatch.setenv("VIBE_TRADING_DATA_CACHE", "false")
    monkeypatch.delenv("BT_KEEP_RUNS", raising=False)
    monkeypatch.setenv("SECRET_TOKEN_XYZ", "x")
    return runs


def test_happy_path(env):
    res = run_backtest(GOOD, **ARGS)
    assert res["ok"], res.get("error")
    assert res["metrics"]
    assert 0 < len(res["equity"]) <= 500
    assert set(res["equity"][0]) == {"date", "value"}
    assert isinstance(res["warnings"], list)
    assert list(env.iterdir()) == []  # run_dir cleaned up


def test_keep_runs(env, monkeypatch):
    monkeypatch.setenv("BT_KEEP_RUNS", "1")
    assert run_backtest(GOOD, **ARGS)["ok"]
    assert len(list(env.iterdir())) == 1


def test_ast_rejection_no_subprocess(env, monkeypatch):
    import subprocess

    def boom(*a, **k):
        raise AssertionError("subprocess spawned")

    monkeypatch.setattr(subprocess, "run", boom)
    bad = GOOD + "\nimport os\nos.system('echo hi')\n"
    res = run_backtest(bad, **ARGS)
    assert res["ok"] is False and "rejected" in res["error"]


def test_timeout(env):
    res = run_backtest(LOOP, timeout_s=3, **ARGS)
    assert res["ok"] is False and res["error"] == "timeout"
    assert list(env.iterdir()) == []


@pytest.mark.parametrize(
    "kw",
    [
        {"code": ""},
        {"code": "x" * 100_001},
        {"symbols": []},
        {"symbols": ["A"] * 21},
        {"start": "2024-06-14", "end": "2024-01-02"},
        {"start": "nope"},
        {"capital": 0},
    ],
)
def test_bad_input(env, monkeypatch, kw):
    import subprocess

    monkeypatch.setattr(subprocess, "run", lambda *a, **k: pytest.fail("spawned"))
    args = {"code": GOOD, **ARGS, **kw}
    res = run_backtest(**args)
    assert res["ok"] is False and res["error"]
