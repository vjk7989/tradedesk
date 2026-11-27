"""TM-11: generic-unit pd.Timedelta rewrites must not warn and must keep their values."""
import importlib
import warnings

import pandas as pd
import pytest

_MODULES = [
    "vibe_bt.backtest.engines.options_portfolio",
    "vibe_bt.backtest.loaders.finnhub_loader",
    "vibe_bt.backtest.loaders.india_broker_loader",
    "vibe_bt.backtest.loaders.mootdx_loader",
    "vibe_bt.backtest.loaders.mt5_loader",
    "vibe_bt.backtest.loaders.nobitex",
    "vibe_bt.backtest.loaders.okx",
    "vibe_bt.backtest.loaders.rsshub_events",
    "vibe_bt.backtest.loaders.tencent_loader",
    "vibe_bt.backtest.loaders.tickerall_loader",
    "vibe_bt.backtest.loaders.tushare_fundamentals",
    "vibe_bt.backtest.loaders.wallex",
    "vibe_bt.backtest.loaders.yahoo_loader",
    "vibe_bt.backtest.loaders.yfinance_loader",
    "vibe_bt.backtest.loaders._fundamental_schema",
]


@pytest.mark.parametrize("name", _MODULES)
def test_modules_import_without_deprecation(name):
    with warnings.catch_warnings():
        warnings.simplefilter("error", DeprecationWarning)
        try:
            importlib.import_module(name)
        except ImportError as exc:  # optional third-party dep missing
            pytest.skip(str(exc))


def test_rewritten_values_equal_keyword_form():
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        old = [
            pd.Timedelta(days=365.25), pd.Timedelta(hours=23, minutes=59, seconds=59),
            pd.Timedelta(days=1), pd.Timedelta(seconds=1), pd.Timedelta(days=365),
        ]
    with warnings.catch_warnings():
        warnings.simplefilter("error", DeprecationWarning)
        new = [
            pd.Timedelta(31557600, "s"), pd.Timedelta(86399, "s"),
            pd.Timedelta(1, "D"), pd.Timedelta(1, "s"), pd.Timedelta(365, "D"),
        ]
    assert new == old


def test_yfinance_exclusive_end_no_warning():
    yf = pytest.importorskip("vibe_bt.backtest.loaders.yfinance_loader")
    with warnings.catch_warnings():
        warnings.simplefilter("error", DeprecationWarning)
        assert yf._to_yfinance_exclusive_end("2024-02-28") == "2024-02-29"
