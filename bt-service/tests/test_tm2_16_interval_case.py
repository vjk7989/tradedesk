"""TM2-16: interval names are case-insensitive where unambiguous.

Rule (vibe_bt.backtest.runner.BacktestConfigSchema.valid_interval): an exact
match on the canonical set always wins; otherwise a lowercase ``h``/``d``/``w``
suffix is mapped to its canonical uppercase form (``1h`` -> ``1H``).

Ambiguity documented here: ``m`` (minute) and ``M`` (month) are both canonical
(``1m`` / ``1M``) and case-distinct, so they are NEVER folded. ``5M`` (5 months)
is not a supported interval and must not be silently read as ``5m``.
"""
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from bt_service import run_backtest
from vibe_bt.backtest.runner import _VALID_INTERVALS, BacktestConfigSchema

FIXTURES = Path(__file__).parent / "fixtures"
CODE = (
    "import pandas as pd\n"
    "class SignalEngine:\n"
    "    def generate(self, data_map):\n"
    "        return {c: pd.Series(0.5, index=df.index) for c, df in data_map.items()}\n"
)
ARGS = dict(symbols=["RELIANCE.NS"], start="2024-03-04", end="2024-03-06",
            source="local", capital=1_000_000, costs={"slippage": 0})


@pytest.fixture
def local_env(tmp_path, monkeypatch):
    cfg = tmp_path / "config.yaml"
    cfg.write_text(
        "sources:\n"
        '  - symbol: "RELIANCE.NS"\n'
        "    type: csv\n"
        f'    path: "{(FIXTURES / "reliance_5m.csv").as_posix()}"\n'
        "    columns:\n      date: timestamp\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("BT_LOCAL_DATA_CONFIG", str(cfg))
    monkeypatch.setenv("BT_RUNS_DIR", str(tmp_path / "runs"))
    monkeypatch.setenv("VIBE_TRADING_DATA_CACHE", "false")


def _schema(interval):
    return BacktestConfigSchema(codes=["X"], start_date="2024-01-01", end_date="2024-02-01",
                                interval=interval)


@pytest.mark.parametrize("lower,canon", [("1h", "1H"), ("4h", "4H"), ("1d", "1D"), ("1w", "1W")])
def test_lowercase_maps_to_canonical(lower, canon):
    assert _schema(lower).interval == canon


@pytest.mark.parametrize("interval", sorted(_VALID_INTERVALS))
def test_every_accepted_interval_unchanged(interval):
    assert _schema(interval).interval == interval


def test_m_and_M_stay_distinct():
    assert _schema("1m").interval == "1m"
    assert _schema("1M").interval == "1M"


def test_run_backtest_1h_identical_to_1H(local_env):
    a = run_backtest(CODE, interval="1H", **ARGS)
    b = run_backtest(CODE, interval="1h", **ARGS)
    assert a["ok"], a.get("error")
    assert b["ok"], b.get("error")
    assert json.dumps(a, sort_keys=True, default=str) == json.dumps(b, sort_keys=True, default=str)
    assert a["metrics"] and a["equity"]


@pytest.mark.parametrize("interval", ["5m", "15m", "30m", "1H", "4H", "1D"])
def test_accepted_intervals_still_run(local_env, interval):
    r = run_backtest(CODE, interval=interval, **ARGS)
    assert r["ok"], r.get("error")


@pytest.mark.parametrize("bad", ["5M", "1Hr", "2h", "1y", "", "1 h", "H", "1MIN"])
def test_unknown_or_ambiguous_still_rejected_with_same_message(bad):
    with pytest.raises(ValidationError) as ei:
        _schema(bad)
    msg = str(ei.value)
    assert f"unsupported interval {bad!r}, must be one of" in msg


def test_run_backtest_rejects_ambiguous(local_env):
    r = run_backtest(CODE, interval="5M", **ARGS)
    assert not r["ok"]
    assert "unsupported interval '5M'" in r["error"]
