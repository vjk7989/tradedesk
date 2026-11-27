import json
import math
import threading
from pathlib import Path

import pytest

from bt_service import run_backtest
from bt_service import runner as R

from test_runner import ARGS, GOOD, env  # noqa: F401 - fixture reuse

HEADER = "import pandas as pd\n\n\nclass SignalEngine:\n    def generate(self, data_map):\n"


def strat(body: str) -> str:
    return HEADER + "".join("        " + ln + "\n" for ln in body.splitlines())


@pytest.fixture
def no_spawn(monkeypatch):
    import subprocess

    monkeypatch.setattr(subprocess, "run", lambda *a, **k: pytest.fail("spawned"))


# ---- validation boundaries (no spawn) ----

def test_code_exactly_100kb_passes_validation():
    code = "#" * (100 * 1024)
    assert R._validate(code, ["A"], "2024-01-01", "2024-01-02", 1) is None
    assert R._validate(code + "#", ["A"], "2024-01-01", "2024-01-02", 1) == "code exceeds 100KB"


def test_code_size_is_bytes_not_chars():
    code = "#" + "\u00e9" * (50 * 1024)  # 102401 bytes, 51201 chars
    assert R._validate(code, ["A"], "2024-01-01", "2024-01-02", 1)


@pytest.mark.parametrize(
    "kw",
    [
        {"code": "   \n\t  "},
        {"code": None},
        {"symbols": ["A"] * 21},
        {"symbols": None},
        {"symbols": "AAPL.US"},
        {"symbols": ["AAPL.US", ""]},
        {"symbols": ["AAPL.US", "  "]},
        {"symbols": ["AAPL.US", 1]},
        {"start": "2024-01-02", "end": "2024-01-02"},
        {"start": "2024/01/02"},
        {"start": "02-01-2024"},
        {"end": "2024-13-01"},
        {"end": "2024-02-30"},
        {"start": None},
        {"start": ""},
        {"capital": 0},
        {"capital": -1},
        {"capital": float("nan")},
        {"capital": float("inf")},
        {"capital": float("-inf")},
        {"capital": True},
        {"capital": "1000"},
    ],
)
def test_bad_input_edges(env, no_spawn, kw):  # noqa: F811
    res = run_backtest(**{"code": GOOD, **ARGS, **kw})
    assert res["ok"] is False and res["error"]
    assert res["equity"] == [] and res["trades"] == []
    assert not env.exists() or list(env.iterdir()) == []


def test_symbol_count_boundaries():
    for n, ok in [(1, True), (20, True), (21, False), (0, False)]:
        err = R._validate("x=1", ["A"] * n, "2024-01-01", "2024-01-02", 1)
        assert (err is None) is ok, n


def test_tiny_positive_capital_ok():
    assert R._validate("x=1", ["A"], "2024-01-01", "2024-01-02", 1e-9) is None


# ---- run_dir confinement with hostile symbols ----

@pytest.mark.parametrize("sym", ["../../etc/passwd", "..\\..\\x", "C:\\x", "CON", "NUL", "a/b", "\\\\srv\\share"])
def test_hostile_symbols_do_not_escape_root(env, monkeypatch, tmp_path, sym):  # noqa: F811
    monkeypatch.setenv("BT_KEEP_RUNS", "1")
    before = set(tmp_path.rglob("*"))
    res = run_backtest(GOOD, **{**ARGS, "symbols": [sym]}, timeout_s=60)
    assert isinstance(res["ok"], bool)
    root = env.resolve()
    for p in set(tmp_path.rglob("*")) - before:
        assert p.resolve().is_relative_to(root), p
    dirs = list(env.iterdir())
    assert len(dirs) == 1
    cfg = json.loads((dirs[0] / "config.json").read_text(encoding="utf-8"))
    assert cfg["codes"] == [sym]


def test_duplicate_symbols_do_not_crash(env):  # noqa: F811
    res = run_backtest(GOOD, **{**ARGS, "symbols": ["AAPL.US", "AAPL.US"]})
    assert isinstance(res["ok"], bool)
    assert res["ok"] or res["error"]


# ---- AST sandbox bypass attempts (no spawn) ----

BYPASSES = [
    "import os\nos.system('echo hi > pwned.txt')\nreturn {}",
    "import subprocess\nreturn {}",
    "import socket\nreturn {}",
    "import importlib\nreturn {}",
    "from os import system\nreturn {}",
    "__import__('os').system('echo hi')\nreturn {}",
    "eval('1')\nreturn {}",
    "exec('x=1')\nreturn {}",
    "open('x.txt', 'w').write('pwn')\nreturn {}",
    "f = lambda: __import__('os')\nf()\nreturn {}",
    "(lambda: open('x.txt','w'))()\nreturn {}",
    "().__class__.__base__.__subclasses__()\nreturn {}",
    "compile('1', 'x', 'eval')\nreturn {}",
    "globals()['__builtins__']\nreturn {}",
]


@pytest.mark.parametrize("body", BYPASSES)
def test_ast_bypass_rejected(env, no_spawn, body):  # noqa: F811
    res = run_backtest(strat(body), **ARGS)
    assert res["ok"] is False
    assert "rejected" in res["error"]
    assert list(env.iterdir()) == []


# Tricks that may slip past the AST check: must then be rejected OR harmless at runtime.
SNEAKY = [
    "getattr(__builtins__, 'open')('pwned.txt', 'w').write('x')\nreturn {}",
    "__builtins__['open']('pwned.txt', 'w').write('x')\nreturn {}",
    "__builtins__['__import__']('os').system('echo x > pwned.txt')\nreturn {}",
    "g = getattr\ng(__builtins__, 'open')('pwned.txt', 'w').write('x')\nreturn {}",
    "b = __builtins__\nb['__import__']('pathlib').Path('pwned.txt').write_text('x')\nreturn {}",
    "import os\nreturn {}",
]


@pytest.mark.parametrize("body", SNEAKY)
def test_ast_bypass_rejected_or_harmless(env, monkeypatch, body):  # noqa: F811
    monkeypatch.setenv("BT_KEEP_RUNS", "1")
    res = run_backtest(strat(body), **ARGS)
    if res["ok"] is False and "rejected" in (res["error"] or ""):
        return
    pwned = list(env.rglob("pwned.txt")) + list(Path.cwd().glob("pwned.txt"))
    assert pwned == [], f"sandbox bypass wrote {pwned}; result={res}"


# ---- child failures ----

def test_strategy_exception_reports_tail(env):  # noqa: F811
    res = run_backtest(strat("raise ValueError('boom-marker')"), **ARGS)
    assert res["ok"] is False
    assert "boom-marker" in res["error"]
    assert list(env.iterdir()) == []


def test_huge_output_tail_bounded(env):  # noqa: F811
    body = "for i in range(20000):\n    print('line', i)\nraise ValueError('tail-marker')"
    res = run_backtest(strat(body), **ARGS)
    assert res["ok"] is False
    detail = res["error"].split(": ", 1)[1]
    assert len(detail.splitlines()) <= 20
    assert len(res["error"]) < 20_000


def test_tail_helper_limits_to_20_lines():
    class P:
        stderr = "\n".join(f"l{i}" for i in range(1000))
        stdout = ""

    assert R._tail(P()).splitlines() == [f"l{i}" for i in range(980, 1000)]


def test_nan_weights_do_not_crash(env):  # noqa: F811
    body = "return {c: pd.Series(float('nan'), index=df.index) for c, df in data_map.items()}"
    res = run_backtest(strat(body), **ARGS)
    assert isinstance(res["ok"], bool)
    if res["ok"]:
        for pt in res["equity"]:
            v = pt["value"]
            assert v is None or (isinstance(v, float) and math.isfinite(v))
        json.dumps(res, allow_nan=False)


def test_sleep_timeout_cleans_dir(env):  # noqa: F811
    body = "import time\ntime.sleep(60)\nreturn {}"
    res = run_backtest(strat(body), timeout_s=3, **ARGS)
    assert res["ok"] is False
    assert res["error"] == "timeout" or "rejected" in res["error"]
    assert list(env.iterdir()) == []


# ---- env allowlist ----

def test_child_env_excludes_secrets(monkeypatch):
    monkeypatch.setenv("FAKE_SECRET", "s1")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "s2")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "s3")
    monkeypatch.setenv("OPENALGO_API_KEY", "ok")
    monkeypatch.setenv("BT_LOCAL_DATA_CONFIG", "cfg")
    e = R._child_env()
    assert "FAKE_SECRET" not in e
    assert "ANTHROPIC_API_KEY" not in e
    assert "AWS_SECRET_ACCESS_KEY" not in e
    assert e.get("OPENALGO_API_KEY") == "ok"
    assert e.get("BT_LOCAL_DATA_CONFIG") == "cfg"
    assert "BT_KEEP_RUNS" not in e and "BT_RUNS_DIR" not in e


def test_child_receives_allowlisted_env(env, monkeypatch):  # noqa: F811
    import subprocess

    seen = {}
    real = subprocess.run

    def spy(*a, **k):
        seen.update(k["env"])
        return real(*a, **k)

    monkeypatch.setenv("FAKE_SECRET", "s1")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "s2")
    monkeypatch.setattr(subprocess, "run", spy)
    run_backtest(GOOD, **ARGS)
    assert seen and "FAKE_SECRET" not in seen and "ANTHROPIC_API_KEY" not in seen


# ---- equity downsampling / parsing ----

def _write_equity(run_dir: Path, n: int):
    art = run_dir / "artifacts"
    art.mkdir(parents=True)
    lines = ["timestamp,equity"] + [f"2024-01-01T{i:06d},{1000 + i}" for i in range(n)]
    (art / "equity.csv").write_text("\n".join(lines) + "\n", encoding="utf-8")


@pytest.mark.parametrize("n,expected,warned", [(499, 499, False), (500, 500, False), (501, 500, True), (5000, 500, True)])
def test_equity_downsample_boundary(tmp_path, n, expected, warned):
    _write_equity(tmp_path, n)
    w = []
    out = R._parse(tmp_path, w)
    assert len(out["equity"]) == expected
    assert bool(w) is warned
    assert out["equity"][0]["value"] == 1000.0
    assert out["equity"][-1]["value"] == 1000.0 + n - 1
    dates = [p["date"] for p in out["equity"]]
    assert dates == sorted(dates) and len(set(dates)) == len(dates)


def test_trades_truncated_at_1000(tmp_path):
    art = tmp_path / "artifacts"
    art.mkdir()
    (art / "trades.csv").write_text("a\n" + "".join(f"{i}\n" for i in range(1001)), encoding="utf-8")
    w = []
    out = R._parse(tmp_path, w)
    assert len(out["trades"]) == 1000 and w


def test_parse_nan_inf_become_none(tmp_path):
    art = tmp_path / "artifacts"
    art.mkdir()
    (art / "metrics.csv").write_text("sharpe,dd\nnan,inf\n", encoding="utf-8")
    assert R._parse(tmp_path, [])["metrics"] == {"sharpe": None, "dd": None}


# ---- costs + concurrency + root ----

def test_costs_merged_into_config(env, monkeypatch):  # noqa: F811
    monkeypatch.setenv("BT_KEEP_RUNS", "1")
    run_backtest(GOOD, costs={"commission": 0.001, "slippage": 0.0005}, capital=12345, **ARGS)
    (d,) = list(env.iterdir())
    cfg = json.loads((d / "config.json").read_text(encoding="utf-8"))
    assert cfg["commission"] == 0.001 and cfg["slippage"] == 0.0005
    assert cfg["initial_cash"] == 12345 and cfg["codes"] == ["AAPL.US"]


def test_costs_cannot_override_core_keys(env, monkeypatch):  # noqa: F811
    monkeypatch.setenv("BT_KEEP_RUNS", "1")
    run_backtest(GOOD, costs={"codes": ["EVIL"], "initial_cash": 1}, **ARGS)
    (d,) = list(env.iterdir())
    cfg = json.loads((d / "config.json").read_text(encoding="utf-8"))
    assert cfg["codes"] == ["AAPL.US"] and cfg["initial_cash"] == 1_000_000


def test_concurrent_runs_distinct_dirs(env, monkeypatch):  # noqa: F811
    monkeypatch.setenv("BT_KEEP_RUNS", "1")
    results = []
    ts = [threading.Thread(target=lambda: results.append(run_backtest(GOOD, **ARGS))) for _ in range(2)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert len(results) == 2 and all(r["ok"] for r in results), results
    assert len(list(env.iterdir())) == 2


def test_default_runs_root_under_temp(monkeypatch, tmp_path):
    monkeypatch.delenv("BT_RUNS_DIR", raising=False)
    monkeypatch.setattr(R.tempfile, "gettempdir", lambda: str(tmp_path))
    assert R._runs_root() == (tmp_path / "bt-runs").resolve()
