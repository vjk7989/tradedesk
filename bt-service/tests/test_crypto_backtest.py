import math
from pathlib import Path

import pandas as pd
import pytest

from bt_service import run_backtest

FIX = Path(__file__).parent / "fixtures" / "btc_1d.csv"
START, END = "2024-01-01", "2024-08-01"
CAPITAL = 100_000.0

HOLD = '''
import pandas as pd


class SignalEngine:
    def generate(self, data_map):
        return {c: pd.Series(1.0, index=df.index) for c, df in data_map.items()}
'''

SMA = '''
import pandas as pd


class SignalEngine:
    def generate(self, data_map):
        out = {}
        for c, df in data_map.items():
            fast = df["close"].rolling(20).mean()
            slow = df["close"].rolling(50).mean()
            out[c] = (fast > slow).astype(float)
        return out
'''

FLIP = '''
import pandas as pd


class SignalEngine:
    def generate(self, data_map):
        out = {}
        for c, df in data_map.items():
            sma = df["close"].rolling(10).mean()
            out[c] = (df["close"] > sma).astype(float) * 2 - 1
        return out
'''


@pytest.fixture
def env(tmp_path, monkeypatch):
    def cfg(symbol):
        p = tmp_path / "config.yaml"
        p.write_text(
            "sources:\n"
            f'  - symbol: "{symbol}"\n'
            "    type: csv\n"
            f'    path: "{FIX.as_posix()}"\n'
            '    date_format: "%Y-%m-%d"\n',
            encoding="utf-8",
        )
        monkeypatch.setenv("BT_LOCAL_DATA_CONFIG", str(p))

    cfg("BTC-USDT")
    cfg.set = cfg
    monkeypatch.setenv("BT_RUNS_DIR", str(tmp_path / "runs"))
    monkeypatch.setenv("VIBE_TRADING_DATA_CACHE", "false")
    for var in ("HTTP_PROXY", "HTTPS_PROXY"):
        monkeypatch.setenv(var, "http://127.0.0.1:9")
    for var in ("OPENALGO_URL", "OPENALGO_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    return cfg


def run(code, symbol="BTC-USDT", costs=None, **kw):
    return run_backtest(code, [symbol], START, END, capital=CAPITAL, costs=costs, source="local", **kw)


def finite_metrics(res):
    for k, v in res["metrics"].items():
        assert v is None or not (isinstance(v, float) and math.isnan(v)), k
    assert all(v is not None for k, v in res["metrics"].items() if k in ("final_value", "total_return"))


def test_buy_and_hold(env):
    res = run(HOLD)
    assert res["ok"], res.get("error")
    assert res["equity"][0]["value"] == pytest.approx(CAPITAL, rel=0.02)
    assert len(res["equity"]) >= 200
    finite_metrics(res)


def test_24x7_weekend_bars_present_and_traded(env):
    res = run(SMA)
    assert res["ok"], res.get("error")
    days = pd.to_datetime([p["date"] for p in res["equity"]])
    assert (days.day_of_week >= 5).sum() > 40  # weekends are in the equity curve
    assert res["trades"], "crossover should trade"
    trade_days = pd.to_datetime([str(t["timestamp"])[:10] for t in res["trades"]])
    assert (trade_days.day_of_week >= 5).any()  # at least one fill on a weekend
    finite_metrics(res)


def test_sma_crossover_trades(env):
    res = run(SMA)
    assert res["ok"] and len(res["trades"]) > 0


def test_long_short_flip(env):
    res = run(FLIP)
    assert res["ok"], res.get("error")
    assert len(res["trades"]) > 4
    finite_metrics(res)


def test_fees_lower_final_equity(env):
    free = run(SMA, costs={"maker_rate": 0, "taker_rate": 0, "slippage": 0})
    paid = run(SMA)
    assert free["ok"] and paid["ok"]
    assert paid["equity"][-1]["value"] < free["equity"][-1]["value"]
    assert paid["metrics"].get("crypto_taker_rate") == 0.0005
    assert free["metrics"].get("crypto_taker_rate") == 0


def test_spot_pair_has_no_funding_by_default(env):
    res = run(HOLD)
    assert res["metrics"].get("crypto_funding_pnl", 0) == 0


def test_funding_applies_to_perp_and_explicit_rate(env):
    env.set("BTC-USDT-PERP")
    perp = run(HOLD, symbol="BTC-USDT-PERP", costs={"maker_rate": 0, "taker_rate": 0, "slippage": 0})
    assert perp["ok"], perp.get("error")
    assert perp["metrics"]["crypto_funding_pnl"] < 0  # longs pay the default positive rate
    env.set("BTC-USDT")
    zero = run(HOLD, costs={"maker_rate": 0, "taker_rate": 0, "slippage": 0})
    explicit = run(HOLD, costs={"maker_rate": 0, "taker_rate": 0, "slippage": 0, "funding_rate": 0.0003})
    assert explicit["metrics"]["crypto_funding_pnl"] < 0
    assert explicit["equity"][-1]["value"] < zero["equity"][-1]["value"]


def test_at_crypto_symbol_auto_falls_back_to_local_without_network(env):
    env.set("BTCUSD@CRYPTO")
    # openalgo is unavailable (env unset); okx/binance/ccxt/yfinance hit the dead proxy and fail; local serves
    # the symbol. Slow (~1 min) because every dead network source retries before the chain reaches local.
    res = run_backtest(HOLD, ["BTCUSD@CRYPTO"], START, END, capital=CAPITAL, source="auto", timeout_s=240)
    assert res["ok"], res.get("error")
    assert len(res["equity"]) >= 200
