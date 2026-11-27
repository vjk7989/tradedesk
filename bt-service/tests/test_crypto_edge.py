"""Edge tests for P3.2: child bytecode flag, env allowlist, crypto fees/funding/routing (offline)."""
import math
import re
from pathlib import Path

import pandas as pd
import pytest

import bt_service._child as child_mod
from bt_service import run_backtest
from bt_service.runner import _child_env
from vibe_bt.backtest.engines._market_hooks import _detect_market

FIX = Path(__file__).parent / "fixtures" / "btc_1d.csv"
START, END = "2024-01-01", "2024-08-01"
CAPITAL = 100_000.0
ZERO = {"maker_rate": 0, "taker_rate": 0, "slippage": 0}

HOLD = '''
import pandas as pd


class SignalEngine:
    def generate(self, data_map):
        return {c: pd.Series(1.0, index=df.index) for c, df in data_map.items()}
'''

SHORT = HOLD.replace("1.0", "-1.0")

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


@pytest.fixture
def env(tmp_path, monkeypatch):
    def cfg(symbol, path=FIX):
        p = tmp_path / "config.yaml"
        p.write_text(
            "sources:\n"
            f'  - symbol: "{symbol}"\n'
            "    type: csv\n"
            f'    path: "{Path(path).as_posix()}"\n'
            '    date_format: "%Y-%m-%d"\n',
            encoding="utf-8",
        )
        monkeypatch.setenv("BT_LOCAL_DATA_CONFIG", str(p))

    cfg("BTC-USDT")
    monkeypatch.setenv("BT_RUNS_DIR", str(tmp_path / "runs"))
    monkeypatch.setenv("VIBE_TRADING_DATA_CACHE", "false")
    for var in ("HTTP_PROXY", "HTTPS_PROXY"):
        monkeypatch.setenv(var, "http://127.0.0.1:9")
    for var in ("OPENALGO_URL", "OPENALGO_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    return cfg


def run(code, symbol="BTC-USDT", costs=None):
    return run_backtest(code, [symbol], START, END, capital=CAPITAL, costs=costs, source="local")


def final(res):
    return res["equity"][-1]["value"]


# ---- AC1: bytecode flag ordering in _child.py ----

def _main_block():
    src = Path(child_mod.__file__).read_text(encoding="utf-8")
    return src[src.index('if __name__ == "__main__":'):]


def test_dont_write_bytecode_set_before_audit_hook_and_cache_setup():
    block = _main_block()
    flag = block.index("sys.dont_write_bytecode = True")
    assert flag < block.index("_install_audit_hook(")
    assert flag < block.index("_setup_cache(")  # _setup_cache lazily imports yfinance (a loader)
    assert flag < block.index("main(run_dir)")  # data loaders import lazily inside main


def test_no_loader_import_before_bytecode_flag_in_main():
    block = _main_block()
    head = block[: block.index("sys.dont_write_bytecode = True")]
    assert not re.search(r"import\s+(yfinance|ccxt)|loaders", head)


# ---- AC2: env allowlist ----

def test_child_env_passes_market_data_order_and_excludes_secrets(monkeypatch, tmp_path):
    monkeypatch.setenv("MARKET_DATA_ORDER_CRYPTO", "local,okx")
    monkeypatch.setenv("VIBE_TRADING_SOURCE_ORDER", "okx")
    monkeypatch.setenv("XMARKET_DATA_ORDER_X", "1")
    monkeypatch.setenv("MARKET_DATA_ORDERX", "1")
    monkeypatch.setenv("MARKET_DATA_ORDER", "1")
    for s in ("ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "MCP_TOKEN", "BT_TOKEN"):
        monkeypatch.setenv(s, "secret")
    e = {k.upper(): v for k, v in _child_env(tmp_path).items()}
    assert e["MARKET_DATA_ORDER_CRYPTO"] == "local,okx"
    for k in ("VIBE_TRADING_SOURCE_ORDER", "XMARKET_DATA_ORDER_X", "MARKET_DATA_ORDERX", "MARKET_DATA_ORDER",
              "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "MCP_TOKEN", "BT_TOKEN"):
        assert k not in e, k
    assert "secret" not in e.values()
    assert e["XDG_CACHE_HOME"] == str(tmp_path / ".cache")


def test_child_env_without_run_dir_has_no_xdg(monkeypatch):
    monkeypatch.delenv("XDG_CACHE_HOME", raising=False)
    assert "XDG_CACHE_HOME" not in _child_env(None)


# ---- AC3: routing ----

@pytest.mark.parametrize("sym", ["BTC-USDT", "BTC/USDT", "BTCUSDT", "BTCUSD@CRYPTO", "btc-usdt",
                                 "BTC-USDT-PERP", "btcusd@crypto"])
def test_crypto_routing(sym):
    assert _detect_market(sym) == "crypto"


@pytest.mark.parametrize("sym", ["", "BTC", "1234USDT"])
def test_non_crypto_routing(sym):
    assert _detect_market(sym) != "crypto"


# ---- AC3: fees ----

def test_commission_only_sets_both_sides(env):
    res = run(SMA, costs={"commission": 0.001, "slippage": 0})
    assert res["ok"], res.get("error")
    assert res["metrics"]["crypto_taker_rate"] == 0.001
    assert res["metrics"]["crypto_maker_rate"] == 0.001
    assert final(res) < final(run(SMA, costs=ZERO))


def test_explicit_rates_win_over_commission(env):
    res = run(SMA, costs={"commission": 0.01, "taker_rate": 0.0007, "maker_rate": 0.0001})
    assert res["metrics"]["crypto_taker_rate"] == 0.0007
    assert res["metrics"]["crypto_maker_rate"] == 0.0001


def test_huge_taker_fee_finite_equity(env):
    res = run(SMA, costs={"taker_rate": 0.5, "maker_rate": 0, "slippage": 0})
    assert res["ok"], res.get("error")
    assert all(math.isfinite(p["value"]) for p in res["equity"])
    assert final(res) < final(run(SMA, costs=ZERO))


def test_negative_fee_rejected(env):
    res = run(SMA, costs={"taker_rate": -0.01, "maker_rate": -0.01, "slippage": 0})
    assert not res["ok"], "negative fee accepted (acts as a rebate that inflates equity)"


# ---- AC3: funding ----

def test_swap_symbol_is_charged_funding(env):
    env("BTC-USDT-SWAP")
    res = run(HOLD, symbol="BTC-USDT-SWAP", costs=ZERO)
    assert res["ok"], res.get("error")
    assert res["metrics"]["crypto_funding_pnl"] < 0


def test_short_receives_positive_funding(env):
    env("BTC-USDT-PERP")
    res = run(SHORT, symbol="BTC-USDT-PERP", costs=ZERO)
    assert res["ok"], res.get("error")
    assert res["metrics"]["crypto_funding_pnl"] > 0


def test_perp_with_zero_funding_rate_has_no_funding(env):
    env("BTC-USDT-PERP")
    res = run(HOLD, symbol="BTC-USDT-PERP", costs={**ZERO, "funding_rate": 0})
    assert res["ok"], res.get("error")
    assert res["metrics"].get("crypto_funding_pnl", 0) == 0


# ---- leverage validation ----

@pytest.mark.parametrize("lev", [0, -1])
def test_nonpositive_leverage_rejected(env, lev):
    res = run(HOLD, costs={**ZERO, "leverage": lev})
    assert not res["ok"], f"leverage={lev} accepted; final equity {res['equity'][-1:]}"


# ---- NaN rows ----

def test_nan_price_rows_handled(env, tmp_path):
    df = pd.read_csv(FIX)
    df.loc[[10, 50, 51, 120], ["open", "high", "low", "close"]] = float("nan")
    p = tmp_path / "nan.csv"
    df.to_csv(p, index=False)
    env("BTC-USDT", p)
    res = run(HOLD, costs=ZERO)
    assert res["ok"], res.get("error")
    assert all(math.isfinite(pt["value"]) for pt in res["equity"])
    for k in ("final_value", "total_return"):
        v = res["metrics"].get(k)
        assert v is not None and math.isfinite(v), k
