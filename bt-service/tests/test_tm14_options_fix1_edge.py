"""TM-14 fix round 1, items 5-6: independent edge tests (test writer).

Item 5: expiry settlement when no underlying series is available must use the
last VALID option close at or before the expiry, else settle at 0 with a
warning; nothing NaN may reach capital, commission or margin.

Item 6: weekly DDMONYY symbols must be real calendar dates (else None, no
monthly fallback); monthly YYMON symbols expire on the last Tuesday of the month.
"""
import logging
import math
from datetime import date

import numpy as np
import pandas as pd
import pytest

from vibe_bt.backtest.engines.india_options import IndiaOptionsEngine, parse_option
from tests.test_tm14_options_edge import CAP, CE, EXPIRY, NO_COST, PE, drive, frame

LOG = "vibe_bt.backtest.engines.india_options"
WEEK = pd.bdate_range("2025-11-20", "2025-11-27")  # 20 21 24 [25 = expiry] 26 27


def run_no_underlying(sym, weight, closes, dates=WEEK, opens=None, cfg=None):
    """Hold ``sym`` at ``weight`` with no underlying configured; option closes as given."""
    n = len(dates)
    df = pd.DataFrame(
        {"open": opens or [100.0] * n, "high": 100.0, "low": 100.0,
         "close": closes, "volume": 1000},
        index=pd.DatetimeIndex(dates),
    )
    e = IndiaOptionsEngine({"initial_cash": CAP, **NO_COST, **(cfg or {})})
    drive(e, {sym: df}, {sym: [weight] * n}, [sym])
    return e


def assert_all_finite(e):
    assert math.isfinite(e.capital)
    for t in e.trades:
        for v in (t.entry_price, t.exit_price, t.pnl, t.pnl_pct, t.commission,
                  t.entry_margin, t.exit_margin):
            assert math.isfinite(v), t
    for f in e.fill_records:
        for v in (f.execution_price, f.fee, f.margin, f.notional):
            assert math.isfinite(v), f


def expiry_trade(e):
    ts = [t for t in e.trades if t.exit_reason == "expiry"]
    assert len(ts) == 1, e.trades
    return ts[0]


# ── item 5: settlement without an underlying ─────────────────────────────────

def test_nan_on_expiry_bar_only_uses_last_valid_earlier_close():
    e = run_no_underlying(CE, 0.1, [100.0, 100.0, 83.0, np.nan, 50.0, 50.0])
    t = expiry_trade(e)
    assert t.exit_time == EXPIRY
    assert t.exit_price == 83.0
    assert t.pnl == pytest.approx((83.0 - 100.0) * 65 * t.size)
    assert_all_finite(e)
    assert not e.positions


def test_several_trailing_nans_skip_back_to_last_valid():
    e = run_no_underlying(CE, 0.1, [100.0, 91.0, np.nan, np.nan, 50.0, 50.0])
    assert expiry_trade(e).exit_price == 91.0
    assert_all_finite(e)


def test_all_nan_closes_settle_at_zero_with_warning(caplog):
    # opens are valid (entry possible), every close up to expiry is NaN
    with caplog.at_level(logging.WARNING, logger=LOG):
        e = run_no_underlying(CE, 0.1, [np.nan] * 6)
    t = expiry_trade(e)
    assert t.exit_price == 0.0
    assert t.pnl == pytest.approx(-100.0 * 65 * t.size)
    assert any("settling at 0" in r.getMessage() and r.levelno == logging.WARNING
               for r in caplog.records)
    assert_all_finite(e)


def test_valid_close_after_expiry_not_used_when_expiry_bar_nan(caplog):
    # NaN on and before expiry, valid closes only AFTER expiry: must settle at 0, not 50
    with caplog.at_level(logging.WARNING, logger=LOG):
        e = run_no_underlying(CE, 0.1, [np.nan, np.nan, np.nan, np.nan, 50.0, 60.0])
    t = expiry_trade(e)
    assert t.exit_time == EXPIRY
    assert t.exit_price == 0.0
    assert "settling at 0" in caplog.text
    assert_all_finite(e)


def test_expiry_holiday_no_underlying_does_not_use_post_expiry_close():
    # REAL BUG (expected to fail until fixed): india_options.py _settlement_price
    # fallback slices data_map[code].loc[:timestamp] with the SETTLEMENT bar's
    # timestamp, not the expiry date, so a post-expiry close is used.
    # No bar on the expiry date. Settlement happens on the first bar after it
    # (11-26). Per the plan the price must be the last valid close UP TO THE
    # EXPIRY (11-24: 77), not the 11-26 close (99), which is post-expiry data.
    # (The underlying path already cuts off at the expiry date; see
    # test_position_open_across_expiry_holiday_closes_on_next_bar.)
    dates = pd.DatetimeIndex(["2025-11-20", "2025-11-21", "2025-11-24", "2025-11-26", "2025-11-27"])
    e = run_no_underlying(CE, 0.1, [100.0, 100.0, 77.0, 99.0, 99.0], dates=dates)
    t = expiry_trade(e)
    assert t.exit_time == pd.Timestamp("2025-11-26")
    assert t.exit_price == 77.0


def test_data_ends_before_expiry_closes_at_end_of_backtest_not_expiry():
    # Documented behaviour: the series stops before the expiry, so no bar
    # on/after expiry is seen and settle_expired never fires. The base engine
    # closes the position at the last bar's close with reason end_of_backtest.
    dates = pd.bdate_range("2025-11-18", "2025-11-24")
    e = run_no_underlying(CE, 0.1, [100.0, 100.0, 100.0, 100.0, 90.0], dates=dates)
    assert len(e.trades) == 1 and not e.positions
    t = e.trades[0]
    assert t.exit_reason == "end_of_backtest"
    assert t.exit_time == pd.Timestamp("2025-11-24") and t.exit_price == 90.0
    assert_all_finite(e)


def test_data_ends_before_expiry_with_nan_last_close_stays_finite():
    dates = pd.bdate_range("2025-11-18", "2025-11-24")
    e = run_no_underlying(CE, 0.1, [100.0, 100.0, 100.0, 95.0, np.nan], dates=dates)
    assert all(t.exit_reason != "expiry" for t in e.trades)
    assert_all_finite(e)


def test_settlement_price_coerces_string_and_none_closes():
    # Direct call: object-dtype close column with strings and None.
    e = IndiaOptionsEngine({"initial_cash": CAP, **NO_COST})
    spec = parse_option(CE)
    df = pd.DataFrame({"close": ["100", "88.5", None, "n/a", "42"]},
                      index=pd.DatetimeIndex(["2025-11-20", "2025-11-21", "2025-11-24",
                                              "2025-11-25", "2025-11-26"]))
    assert e._settlement_price(CE, spec, {CE: df}, EXPIRY) == 88.5
    df2 = pd.DataFrame({"close": [None, "abc"]},
                       index=pd.DatetimeIndex(["2025-11-24", "2025-11-25"]))
    assert e._settlement_price(CE, spec, {CE: df2}, EXPIRY) == 0.0


def test_settlement_price_direct_no_lookahead():
    e = IndiaOptionsEngine({})
    spec = parse_option(CE)
    df = pd.DataFrame({"close": [70.0, np.nan, 55.0]},
                      index=pd.DatetimeIndex(["2025-11-24", "2025-11-25", "2025-11-26"]))
    assert e._settlement_price(CE, spec, {CE: df}, EXPIRY) == 70.0


@pytest.mark.parametrize("sym, weight", [(CE, 0.1), (CE, -0.1), (PE, 0.1), (PE, -0.1)])
def test_zero_settlement_pnl_sign_long_and_short(sym, weight, caplog):
    with caplog.at_level(logging.WARNING, logger=LOG):
        e = run_no_underlying(sym, weight, [np.nan] * 6)
    t = expiry_trade(e)
    direction = 1 if weight > 0 else -1
    assert t.direction == direction and t.size > 0
    assert t.exit_price == 0.0
    expected = direction * (0.0 - 100.0) * 65 * t.size
    assert t.pnl == pytest.approx(expected)
    assert (t.pnl < 0) if direction > 0 else (t.pnl > 0)  # long loses premium, short keeps it
    assert_all_finite(e)
    # cash conservation with zero costs: capital moves by exactly the P&L
    assert e.capital == pytest.approx(CAP + t.pnl)


def test_zero_settlement_with_costs_commission_finite():
    cfg = {"slippage": 0.0005, "in_opt_brokerage": 20, "in_opt_stt": 0.0015,
           "in_opt_exchange_txn": 0.0003503, "in_opt_sebi_fee": 0.000001,
           "in_opt_stamp_duty": 0.00003}
    e = IndiaOptionsEngine({"initial_cash": CAP, **cfg})
    df = pd.DataFrame({"open": 100.0, "high": 100.0, "low": 100.0, "close": [np.nan] * 6,
                       "volume": 1000}, index=WEEK)
    drive(e, {PE: df}, {PE: [-0.1] * 6}, [PE])
    t = expiry_trade(e)
    assert t.exit_price == 0.0
    # exit on zero premium pays brokerage + GST only
    assert t.commission > 20 * 1.18
    assert_all_finite(e)


# ── item 6: parsing ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("bad", [
    "NIFTY31NOV2524000CE",
    "NIFTY30FEB2624000PE",
    "BANKNIFTY29FEB2550000CE",  # 2025 is not a leap year
    "NIFTY00JAN2624000CE",
    "NIFTY31NOV2524000CE@NFO",
    "NIFTY31APR2624000CE",
    "NIFTY32JAN2624000CE",
])
def test_impossible_weekly_dates_return_none(bad):
    assert parse_option(bad) is None


def test_real_weekly_dates_parse():
    s = parse_option("NIFTY29FEB2824000CE")  # 2028 is a leap year
    assert (s.root, s.expiry, s.strike, s.kind) == ("NIFTY", date(2028, 2, 29), 24000.0, "CE")
    s = parse_option("NIFTY25NOV2524000CE")
    assert (s.root, s.expiry, s.strike, s.kind) == ("NIFTY", date(2025, 11, 25), 24000.0, "CE")


@pytest.mark.parametrize("sym, root, expiry, strike, kind", [
    ("NIFTY25NOV24000CE", "NIFTY", date(2025, 11, 25), 24000.0, "CE"),       # last Tue Nov 2025
    ("BANKNIFTY25DEC50000PE", "BANKNIFTY", date(2025, 12, 30), 50000.0, "PE"),  # last Tue Dec 2025
    ("NIFTY26FEB25000CE", "NIFTY", date(2026, 2, 24), 25000.0, "CE"),
    ("NIFTY28FEB25000CE", "NIFTY", date(2028, 2, 29), 25000.0, "CE"),       # leap-year Feb 29 is a Tue
])
def test_monthly_forms_last_tuesday(sym, root, expiry, strike, kind):
    s = parse_option(sym)
    assert (s.root, s.expiry, s.strike, s.kind) == (root, expiry, strike, kind)
    assert s.expiry.weekday() == 1  # Tuesday


def test_ambiguity_weekly_reading_wins_when_valid():
    # "NIFTY25NOV2524000CE": weekly = 25 NOV 2025 strike 24000; monthly could be
    # yy=25 NOV strike 2524000. Documented precedence: DDMONYY if valid date and
    # strike >= 4 digits.
    s = parse_option("NIFTY25NOV2524000CE")
    assert s.expiry == date(2025, 11, 25) and s.strike == 24000.0
    # "NIFTY25NOV24000CE": weekly would be 25 NOV 2024 strike 000 (< 4 digits) -> monthly
    s = parse_option("NIFTY25NOV24000CE")
    assert s.expiry == date(2025, 11, 25) and s.strike == 24000.0
    # weekly reading with an invalid date returns None even though the monthly
    # regex would also match (31NOV + strike 2524000) -> no monthly fallback
    assert parse_option("NIFTY31NOV2524000CE") is None


def test_ambiguity_monthly_with_long_strike_looks_weekly():
    # "NIFTY26JAN250000CE": monthly yy=26 JAN strike 250000 is also a valid
    # weekly 26 JAN 2025 strike 0000 (4 digits). Precedence: weekly.
    s = parse_option("NIFTY26JAN250000CE")
    assert s.expiry == date(2025, 1, 26) and s.strike == 0.0


@pytest.mark.parametrize("sym", [
    "nifty25nov2524000ce", "  NIFTY25NOV2524000CE  ", "NIFTY25NOV2524000CE\n",
    "nifty25nov2524000ce@nfo",
])
def test_lowercase_and_whitespace(sym):
    s = parse_option(sym.strip())
    assert s.expiry == date(2025, 11, 25) and s.strike == 24000.0
    if sym != sym.strip():
        # raw input with surrounding whitespace: either parsed identically or rejected, never a wrong date
        r = parse_option(sym)
        assert r is None or (r.expiry, r.strike, r.kind) == (date(2025, 11, 25), 24000.0, "CE")


def test_lowercase_invalid_weekly_also_none():
    assert parse_option("nifty31nov2524000ce@nfo") is None


@pytest.mark.parametrize("sym, root", [
    ("SENSEX25DEC80000CE@BFO", "SENSEX"),
    ("QQQQ28NOV251500CE@NFO", "QQQQ"),
    ("FOOBAR25DEC1000PE@NFO", "FOOBAR"),
])
def test_unknown_root_lot_one_and_warning(sym, root, caplog):
    e = IndiaOptionsEngine({})
    with caplog.at_level(logging.WARNING, logger=LOG):
        assert e.get_contract_multiplier(sym) == 1.0
    assert any(root in r.getMessage() and "lot 1" in r.getMessage() for r in caplog.records)
    assert {"product": root, "field": "lot_size", "value": 1} in e._engine_diagnostics()["pricing_assumptions"]
