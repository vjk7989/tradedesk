"""TM-8: crypto funding path must not raise NumPy/pandas DeprecationWarnings."""
import warnings

import pandas as pd
import pytest

from tests.test_intraday_edge import SWAP, _funding_total
from vibe_bt.backtest.loaders import ccxt_loader


def test_crypto_funding_no_deprecation_warning():
    stamps = pd.date_range("2024-03-04", "2024-03-05", freq="1min", inclusive="left")
    with warnings.catch_warnings():
        warnings.simplefilter("error", DeprecationWarning)
        total = _funding_total(stamps, "1m")
    assert total == pytest.approx(3 * 100.0 * 0.0001)
    assert SWAP


def test_ccxt_timeframe_deltas_values():
    d = ccxt_loader._TIMEFRAME_DELTA
    assert d["1m"] == pd.Timedelta(60, "s") and d["1w"] == pd.Timedelta(7, "D")
    assert d["4h"] == pd.Timedelta(4, "h") and d["1M"] == pd.Timedelta(31, "D")
