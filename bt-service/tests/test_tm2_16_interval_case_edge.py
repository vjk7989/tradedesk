"""TM2-16 edge tests (independent test writer).

Rule under test (vibe_bt.backtest.runner.BacktestConfigSchema.valid_interval):
exact canonical match wins; otherwise a trailing lowercase ``h``/``d``/``w`` is
upper-cased and accepted only when the result is canonical. ``m``/``M`` are
never folded. Every reject keeps the message
``unsupported interval <repr>, must be one of {...}``.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from bt_service import app as app_mod
from bt_service import run_backtest
from bt_service.walkforward import walk_forward
from vibe_bt.backtest import runner as vbt_runner
from vibe_bt.backtest.engines.india_session import is_intraday
from vibe_bt.backtest.runner import _VALID_INTERVALS, BacktestConfigSchema

FIXTURES = Path(__file__).parent / "fixtures"
TOKEN = "t" * 32
HDR = {"Authorization": f"Bearer {TOKEN}"}

# Holds/flat in blocks of n bars so a run produces real trades.
CODE = (
    "import pandas as pd\n"
    "class SignalEngine:\n"
    "    def __init__(self, n=5):\n"
    "        self.n = n\n"
    "    def generate(self, data_map):\n"
    "        return {c: pd.Series([1.0 if (i // self.n) % 2 == 0 else 0.0 for i in range(len(df))],\n"
    "                             index=df.index) for c, df in data_map.items()}\n"
)
INTRA_ARGS = dict(symbols=["RELIANCE.NS"], start="2024-03-04", end="2024-03-06",
                  source="local", capital=1_000_000, costs={"slippage": 0})
DAILY_ARGS = dict(symbols=["AAPL.US"], start="2024-01-02", end="2024-06-14",
                  source="local", capital=1_000_000)

LOWER_MAP = {"1h": "1H", "4h": "4H", "1d": "1D", "1w": "1W"}


def _schema(interval):
    return BacktestConfigSchema(codes=["X"], start_date="2024-01-01", end_date="2024-02-01",
                                interval=interval)


def _canon(res: dict) -> str:
    return json.dumps(res, sort_keys=True, default=str)


@pytest.fixture
def local_env(tmp_path, monkeypatch):
    cfg = tmp_path / "config.yaml"
    cfg.write_text(
        "sources:\n"
        '  - symbol: "RELIANCE.NS"\n'
        "    type: csv\n"
        f'    path: "{(FIXTURES / "reliance_5m.csv").as_posix()}"\n'
        "    columns:\n      date: timestamp\n"
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
    return runs


# ---------------------------------------------------------------- validator


@pytest.mark.parametrize("interval", sorted(_VALID_INTERVALS))
def test_canonical_identity(interval):
    assert _schema(interval).interval == interval


@pytest.mark.parametrize("lower,canon", sorted(LOWER_MAP.items()))
def test_lowercase_hdw_mapped(lower, canon):
    out = _schema(lower).interval
    assert out == canon
    assert out in _VALID_INTERVALS


def test_lowercase_map_is_complete():
    # Every canonical h/d/w interval has its lowercase twin accepted; nothing else is folded.
    expected = {i[:-1] + i[-1].lower(): i for i in _VALID_INTERVALS if i[-1] in "HDW"}
    assert expected == LOWER_MAP


@pytest.mark.parametrize("bad", [
    "1H ", " 1h", " 1H", "1h ", "\t1h", "1h\n",       # whitespace is not stripped
    "01h", "01H", "1hh", "1HH", "h", "H", "d", "w", "",
    "1Hd", "1hd", "1Dh",
    "2h", "2w", "2d", "4d", "4w", "3h",
    "5M", "3M", "15M", "1mo", "1Mo", "1Min", "1MIN", "1min", "1MO",
    "1y", "1Y", "1s", "1S",
    "１h", "1ｈ", "1һ", "１H", "1Н", "1С",  # fullwidth/Cyrillic lookalikes
    "١h", "١H",                             # Arabic-Indic digit one
    "1ħ", "1ḥ",                             # h with stroke / dot below
])
def test_rejects_with_same_message(bad):
    with pytest.raises(ValidationError) as ei:
        _schema(bad)
    assert f"unsupported interval {bad!r}, must be one of" in str(ei.value)


@pytest.mark.parametrize("val", [None, 1, 1.0, ["1h"], {"i": "1h"}])
def test_non_string_rejected(val):
    with pytest.raises(ValidationError):
        _schema(val)


def test_m_and_M_never_folded():
    assert _schema("1m").interval == "1m"
    assert _schema("5m").interval == "5m"
    assert _schema("1M").interval == "1M"
    with pytest.raises(ValidationError):
        _schema("5M")


def test_default_interval_unchanged():
    assert BacktestConfigSchema(codes=["X"], start_date="2024-01-01",
                                end_date="2024-02-01").interval == "1D"


def test_validated_object_carries_canonical_for_downstream():
    cfg = _schema("1h")
    assert cfg.interval == "1H"
    assert cfg.model_dump()["interval"] == "1H"
    assert is_intraday(cfg.interval) is True
    assert is_intraday(_schema("1d").interval) is False
    assert _schema("1w").model_dump(mode="json")["interval"] == "1W"


def test_runner_main_hands_canonical_interval_downstream(tmp_path, monkeypatch):
    """The CLI entry (vibe_bt.backtest.runner.main) validates config.json, then must
    run on the canonical form so loaders keyed only on ``1H`` (mootdx, futu, tushare,
    eastmoney, ...) and artifacts see ``1H``, not the raw ``1h``."""
    run_dir = tmp_path / "run"
    (run_dir / "code").mkdir(parents=True)
    (run_dir / "code" / "signal_engine.py").write_text(CODE, encoding="utf-8")
    (run_dir / "config.json").write_text(json.dumps({
        "codes": ["RELIANCE.NS"], "start_date": "2024-03-04", "end_date": "2024-03-06",
        "source": "local", "interval": "1h", "initial_cash": 1_000_000,
    }), encoding="utf-8")
    seen = {}

    class _Stop(Exception):
        pass

    def fake_fetch(config):
        seen["interval"] = config.get("interval")
        raise _Stop

    monkeypatch.setattr(vbt_runner, "fetch_data_map", fake_fetch)
    with pytest.raises(_Stop):
        vbt_runner.main(run_dir)
    assert seen["interval"] == "1H"


def test_run_card_records_canonical_interval(local_env, monkeypatch):
    monkeypatch.setenv("BT_KEEP_RUNS", "1")
    res = run_backtest(CODE, interval="1h", **INTRA_ARGS)
    assert res["ok"], res.get("error")
    cards = list(local_env.glob("*/run_card.json"))
    assert len(cards) == 1
    card = json.loads(cards[0].read_text(encoding="utf-8"))
    found = []

    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if k == "interval":
                    found.append(v)
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(card)
    assert found and set(found) == {"1H"}, found


# ---------------------------------------------------------------- end to end


def test_1d_equals_1D_end_to_end(local_env):
    a = run_backtest(CODE, interval="1D", **DAILY_ARGS)
    b = run_backtest(CODE, interval="1d", **DAILY_ARGS)
    assert a["ok"], a.get("error")
    assert b["ok"], b.get("error")
    assert a["trades"], "fixture strategy should trade"
    assert a["trades"] == b["trades"]
    assert a["metrics"] == b["metrics"]
    assert _canon(a) == _canon(b)


def test_4h_rejected_or_equal_to_4H(local_env):
    a = run_backtest(CODE, interval="4H", **INTRA_ARGS)
    b = run_backtest(CODE, interval="4h", **INTRA_ARGS)
    assert a["ok"] == b["ok"]
    if a["ok"]:
        assert _canon(a) == _canon(b)


@pytest.mark.parametrize("bad", ["5M", "1H ", "2h", "1Min"])
def test_run_backtest_rejects_bad_with_validator_message(local_env, bad):
    r = run_backtest(CODE, interval=bad, **INTRA_ARGS)
    assert not r["ok"]
    assert f"unsupported interval {bad!r}" in r["error"]


# ---------------------------------------------------------------- HTTP API


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("BT_TOKEN", TOKEN)
    monkeypatch.delenv("BT_MAX_CONCURRENCY", raising=False)
    monkeypatch.setattr(app_mod, "_sem", None)
    with TestClient(app_mod.app) as c:
        yield c


@pytest.mark.parametrize("iv", ["1h", "1d", "4h", "1w"])
def test_api_backtest_passes_lowercase_through(client, monkeypatch, iv):
    calls = []
    monkeypatch.setattr(app_mod, "run_backtest",
                        lambda **kw: calls.append(kw) or {"ok": True, "metrics": {}, "equity": [],
                                                          "trades": [], "warnings": []})
    body = {"code": "x", "symbols": ["A"], "start": "2024-01-01", "end": "2024-02-01", "interval": iv}
    r = client.post("/backtest", json=body, headers=HDR)
    assert r.status_code == 200, r.text
    assert calls and calls[0]["interval"].upper() == LOWER_MAP[iv].upper()


def test_api_backtest_1h_real_run_equals_1H(client, local_env):
    body = {"code": CODE, "symbols": INTRA_ARGS["symbols"], "start": INTRA_ARGS["start"],
            "end": INTRA_ARGS["end"], "source": "local", "costs": {"slippage": 0}}
    a = client.post("/backtest", json={**body, "interval": "1H"}, headers=HDR)
    b = client.post("/backtest", json={**body, "interval": "1h"}, headers=HDR)
    assert a.status_code == b.status_code == 200
    assert a.json()["ok"], a.json().get("error")
    assert b.json()["ok"], b.json().get("error")
    assert _canon(a.json()) == _canon(b.json())


def test_api_walkforward_passes_lowercase_through(client, monkeypatch):
    calls = []
    monkeypatch.setattr(app_mod, "walk_forward", lambda **kw: calls.append(kw) or {"ok": True})
    body = {"code": "x", "symbols": ["A"], "start": "2024-01-01", "end": "2024-03-01",
            "train_days": 20, "test_days": 5, "candidates": [{}], "interval": "1h"}
    r = client.post("/walkforward", json=body, headers=HDR)
    assert r.status_code == 200, r.text
    assert calls[0]["interval"] in {"1h", "1H"}


# ---------------------------------------------------------------- walk-forward


def test_walkforward_forwards_interval_unchanged_to_every_run():
    calls = []

    def run(**kw):
        calls.append(kw)
        return {"ok": True, "metrics": {"sharpe": 1.0}, "equity": [], "trades": [], "warnings": []}

    res = walk_forward("x", ["A"], "2024-01-01", "2024-02-20", train_days=20, test_days=5,
                       candidates=[{"n": 1}], interval="1h", run=run)
    assert res["ok"] is True, res
    assert calls and {c["interval"] for c in calls} == {"1h"}


def test_walkforward_1d_equals_1D_real(local_env):
    kw = dict(code=CODE, symbols=DAILY_ARGS["symbols"], start="2024-01-02", end="2024-04-30",
              train_days=40, test_days=20, candidates=[{"n": 3}, {"n": 5}], metric="total_return",
              capital=1_000_000, source="local")
    a = walk_forward(interval="1D", **kw)
    b = walk_forward(interval="1d", **kw)
    assert a["ok"], a.get("error")
    assert b["ok"], b.get("error")
    assert _canon(a) == _canon(b)
