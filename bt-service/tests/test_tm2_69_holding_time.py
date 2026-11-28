"""TM2-69: ``avg_holding_days`` is calendar days from trade timestamps.

Before the fix ``calc_metrics`` reported ``avg_holding_days`` as the mean
number of BARS held, so on 1h bars it was hours and on 1m bars minutes.
All fixtures are synthetic and deterministic (no network).
"""

import pandas as pd
import numpy as np
import pytest

from vibe_bt.backtest.engines.crypto import CryptoEngine
from vibe_bt.backtest.metrics import calc_metrics, win_rate_and_stats
from vibe_bt.backtest.models import TradeRecord
from tests.test_intraday_edge import Loader, Signal, flat_frame

CASH = 100_000


def equity(idx) -> pd.Series:
    n = len(idx)
    return pd.Series(100000 + np.arange(n) * 3.0 + 50 * np.sin(np.arange(n) / 7), index=idx)


def trade(entry, exit_, pnl=1.0, bars=None, direction=1) -> TradeRecord:
    return TradeRecord(symbol="X", direction=direction, entry_price=100, exit_price=101,
                       entry_time=entry, exit_time=exit_, size=1, leverage=1, pnl=pnl,
                       pnl_pct=pnl / 10, exit_reason="signal",
                       holding_bars=float(bars if bars is not None else 0), commission=0.1)


def fixture(freq, specs, n, tz=None, start="2026-01-01"):
    """specs: (entry_bar, exit_bar, pnl) on a regular ``freq`` index."""
    idx = pd.date_range(start, periods=n, freq=freq, tz=tz)
    return equity(idx), [trade(idx[e], idx[x], p, bars=x - e) for e, x, p in specs]


# 40 round trips of 2-23 hours inside 1440 hourly bars (60 days); 501 h held in total.
REAL_LIKE = [
    (5, 18, 0.8216), (21, 41, 0.9054), (58, 69, -0.537), (76, 92, 0.2941),
    (105, 123, 0.5467), (134, 145, -0.4821), (155, 166, 0.0397), (174, 195, -0.2572),
    (198, 216, -0.2756), (226, 230, -2.7112), (240, 257, -0.1748), (269, 286, 0.2173),
    (291, 295, -1.112), (307, 316, 0.6467), (326, 328, -0.514), (341, 351, 0.109),
    (359, 379, -0.6832), (390, 399, -0.0983), (414, 427, 0.0356), (430, 443, 0.8912),
    (458, 477, -0.8182), (490, 499, 0.8792), (503, 523, 0.9145), (539, 547, -0.3139),
    (561, 563, 0.2728), (573, 584, 0.1996), (597, 603, 0.2355), (619, 642, 0.2544),
    (652, 664, -0.2975), (676, 690, 0.2534), (701, 717, -0.3452), (734, 746, -0.4458),
    (757, 764, 0.1936), (774, 795, 0.8838), (810, 830, -0.6402), (836, 854, 0.4684),
    (864, 869, 0.2565), (875, 890, 1.0557), (899, 903, -0.1387), (914, 916, 0.3328),
]

FIXTURES = {
    # name: (freq, specs, n_bars, expected avg_holding_days, expected avg_holding_bars)
    "1h_3h_5h_2d": ("1h", [(0, 3, 5), (10, 15, -3), (30, 78, 2)], 200, 0.7778, 18.7),
    "1D_1_2_3d": ("1D", [(0, 1, 5), (5, 7, -3), (10, 13, 2)], 40, 2.0, 2.0),
    "1m_30m_90m": ("1min", [(0, 30, 5), (100, 190, -3)], 400, 0.0417, 60.0),
    "crypto_24x7_1h_24h": ("1h", [(0, 24, 5)], 400, 1.0, 24.0),
    "real_like_40rt_60d": ("1h", REAL_LIKE, 1440, 0.5219, 12.5),
}


@pytest.mark.parametrize("name", list(FIXTURES))
def test_avg_holding_days_exact_via_calc_metrics(name):
    freq, specs, n, days, _ = FIXTURES[name]
    eq, trades = fixture(freq, specs, n)
    m = calc_metrics(eq, trades, CASH)
    assert m["avg_holding_days"] == days
    assert m["trade_count"] == len(specs)


@pytest.mark.parametrize("name", list(FIXTURES))
def test_avg_holding_days_exact_via_win_rate_and_stats(name):
    freq, specs, n, days, bars = FIXTURES[name]
    _, trades = fixture(freq, specs, n)
    s = win_rate_and_stats(trades)
    assert s["avg_holding_days"] == days
    assert s["avg_holding_bars"] == bars


@pytest.mark.parametrize("name", list(FIXTURES))
def test_avg_holding_bars_unchanged(name):
    freq, specs, n, _, bars = FIXTURES[name]
    _, trades = fixture(freq, specs, n)
    assert win_rate_and_stats(trades)["avg_holding_bars"] == bars


def test_real_like_case_is_plausible():
    # The reported bug: 40 trades in 60 days on 1h bars showed ~16 "days".
    eq, trades = fixture("1h", REAL_LIKE, 1440)
    days = calc_metrics(eq, trades, CASH)["avg_holding_days"]
    assert days == 0.5219
    assert days < 1.5
    assert days == round(501 / 40 / 24, 4)


def test_crypto_24x7_spans_weekend():
    # Starts Friday 2026-01-02 12:00, held 48h straight through the weekend.
    idx = pd.date_range("2026-01-02 12:00", periods=100, freq="1h", tz="UTC")
    m = calc_metrics(equity(idx), [trade(idx[0], idx[48], 1.0, bars=48)], CASH)
    assert m["avg_holding_days"] == 2.0


# ── all other metric keys pinned (identical on origin/main before the fix) ──

PINNED = {
    "1h_3h_5h_2d": {
        "annual_return": 0.007431095621074579, "avg_turnover": 0.0, "benchmark_beta": 0.0,
        "benchmark_return": 0.0, "calmar": 17.3039, "excess_return": 0.0,
        "final_value": 100589.31866292964, "information_ratio": 0.0,
        "max_consecutive_loss": 1, "max_drawdown": -0.0004294465706778139,
        "omega_ratio": 3.9791399775687566, "profit_factor": 2.3333,
        "profit_loss_ratio": 1.1667, "return_kurtosis": -1.5071690414571572,
        "return_skew": 0.015849055824328353, "sharpe": 9.237341914452548,
        "sortino": 25.9278, "tail_ratio": 2.505218204237813,
        "total_return": 0.0058931866292963875, "total_turnover": 0.0,
        "tracking_error": 0.0, "trade_count": 3, "win_rate": 0.6666666666666666,
    },
    "1D_1_2_3d": {
        "annual_return": 0.005325420637790401, "avg_turnover": 0.0, "benchmark_beta": 0.0,
        "benchmark_return": 0.0, "calmar": 12.4007, "excess_return": 0.0,
        "final_value": 100084.34174970312, "information_ratio": 0.0,
        "max_consecutive_loss": 1, "max_drawdown": -0.0004294465706778139,
        "omega_ratio": 2.962869776239308, "profit_factor": 2.3333,
        "profit_loss_ratio": 1.1667, "return_kurtosis": -1.3473872158849507,
        "return_skew": 0.23436659941157753, "sharpe": 7.039422352729609,
        "sortino": 17.8556, "tail_ratio": 2.437117293438631,
        "total_return": 0.0008434174970310959, "total_turnover": 0.0,
        "tracking_error": 0.0, "trade_count": 3, "win_rate": 0.6666666666666666,
    },
}


@pytest.mark.parametrize("name", list(PINNED))
def test_other_metrics_pinned(name):
    freq, specs, n, _, _ = FIXTURES[name]
    eq, trades = fixture(freq, specs, n)
    m = calc_metrics(eq, trades, CASH)
    assert set(m) == set(PINNED[name]) | {"avg_holding_days"}
    others = {k: v for k, v in m.items() if k != "avg_holding_days"}
    assert others == PINNED[name]


# ── edge cases ──


def test_same_bar_zero_span_counts_as_zero():
    idx = pd.date_range("2026-01-01", periods=10, freq="1h")
    s = win_rate_and_stats([trade(idx[2], idx[2], 1.0, bars=0),
                            trade(idx[0], idx[6], 1.0, bars=6)])
    assert s["avg_holding_days"] == 0.125  # (0h + 6h) / 2
    assert s["avg_holding_bars"] == 3.0


def test_negative_span_skipped():
    idx = pd.date_range("2026-01-01", periods=10, freq="1h")
    s = win_rate_and_stats([trade(idx[0], idx[6], 1.0, bars=6),
                            trade(idx[5], idx[1], 1.0, bars=-1)])
    assert s["avg_holding_days"] == 0.25


@pytest.mark.parametrize("tz", [None, "UTC", "Asia/Kolkata"])
@pytest.mark.parametrize("unit", ["ns", "us", "s"])
def test_timezone_and_unit_invariant(tz, unit):
    idx = pd.date_range("2026-01-01", periods=200, freq="1h", tz=tz).as_unit(unit)
    trades = [trade(idx[0], idx[3], 5, bars=3), trade(idx[10], idx[15], -3, bars=5),
              trade(idx[30], idx[78], 2, bars=48), trade(idx[90], idx[90], 1, bars=0)]
    m = calc_metrics(equity(idx), trades, CASH)
    assert m["avg_holding_days"] == 0.5833  # 56h / 4 trades
    assert win_rate_and_stats(trades)["avg_holding_days"] == 0.5833


def _run_crypto(fn, idx, tmp_path):
    frames = {"BTC-USDT": flat_frame(idx)}
    cfg = {"codes": ["BTC-USDT"], "interval": "1h", "initial_cash": CASH,
           "commission": 0, "slippage": 0}
    eng = CryptoEngine(cfg)
    metrics = eng.run_backtest(cfg, Loader(frames), Signal(fn), tmp_path, bars_per_year=None)
    return eng, metrics


def test_force_closed_at_end_of_backtest_included(tmp_path):
    idx = pd.date_range("2024-01-01", periods=240, freq="1h")
    eng, metrics = _run_crypto(lambda ts, i: 1.0, idx, tmp_path)
    assert len(eng.trades) == 1
    t = eng.trades[0]
    assert t.exit_reason == "end_of_backtest"
    span_days = (t.exit_time - t.entry_time).total_seconds() / 86400
    assert span_days == pytest.approx(238 / 24)
    assert metrics["avg_holding_days"] == round(span_days, 4) == 9.9167


def test_long_short_reversal_spans_non_overlapping(tmp_path):
    idx = pd.date_range("2024-01-01", periods=240, freq="1h")
    pos = {ts: k for k, ts in enumerate(idx)}
    eng, metrics = _run_crypto(lambda ts, i: 1.0 if (pos[ts] // 10) % 2 == 0 else -1.0,
                               idx, tmp_path)
    trades = sorted(eng.trades, key=lambda t: t.entry_time)
    assert len(trades) == 24
    assert {t.direction for t in trades} == {1, -1}
    for t in trades:
        assert t.exit_time >= t.entry_time
    for prev, nxt in zip(trades, trades[1:]):
        assert nxt.direction == -prev.direction
        assert nxt.entry_time >= prev.exit_time  # no overlap
    spans = [(t.exit_time - t.entry_time).total_seconds() / 86400 for t in trades]
    assert metrics["avg_holding_days"] == round(float(np.mean(spans)), 4) == 0.4132
    assert metrics["avg_holding_days"] < 1


def test_empty_trades_returns_zero():
    assert win_rate_and_stats([])["avg_holding_days"] == 0.0
    idx = pd.date_range("2026-01-01", periods=50, freq="1h")
    assert calc_metrics(equity(idx), [], CASH)["avg_holding_days"] == 0.0
