"""Edge cases for the intraday India session / MIS / crypto-funding rules."""

from datetime import date
from pathlib import Path

import pandas as pd
import pytest

from vibe_bt.backtest.engines._market_hooks import _interval_span_hours, calc_crypto_funding_fee
from vibe_bt.backtest.engines.composite import CompositeEngine
from vibe_bt.backtest.engines.india_equity import IndiaEquityEngine
from vibe_bt.backtest.engines.india_fno import IndiaFnoEngine
from vibe_bt.backtest.engines.india_session import (
    after_squareoff,
    in_session,
    is_intraday,
    squareoff_bars,
)
from vibe_bt.backtest.models import Position

FIXTURES = Path(__file__).parent / "fixtures"
EQ, FNO, BFO, MCX = "RELIANCE.NS", "NIFTY25DECFUT@NFO", "SENSEX25DECFUT@BFO", "CRUDEOIL25DECFUT@MCX"
ZERO_EQ = {"in_brokerage": 0, "in_stt": 0, "in_mis_stt": 0, "in_exchange_txn": 0,
           "in_sebi_fee": 0, "in_stamp_duty": 0, "slippage": 0, "price_limit": None}
ZERO_FNO = {"in_fno_brokerage": 0, "in_fno_stt": 0, "in_fno_exchange_txn": 0,
            "in_fno_sebi_fee": 0, "in_fno_stamp_duty": 0, "slippage": 0,
            "lot_sizes": {"NIFTY": 1, "CRUDEOIL": 1}}
T = pd.Timestamp


# ── helpers ──


def fixture_frame() -> pd.DataFrame:
    return pd.read_csv(FIXTURES / "reliance_5m.csv", index_col="timestamp", parse_dates=True)


def flat_frame(index, price: float = 100.0) -> pd.DataFrame:
    idx = pd.DatetimeIndex(index)
    return pd.DataFrame({"open": price, "high": price, "low": price, "close": price,
                         "volume": 1000.0}, index=idx)


def day_bars(day: str, start: str, end: str, freq: str = "5min") -> list:
    return list(pd.date_range(f"{day} {start}", f"{day} {end}", freq=freq))


class Loader:
    def __init__(self, frames: dict):
        self.frames = frames

    def fetch(self, codes, *a, **k):
        return {c: self.frames[c].copy() for c in codes}


class Signal:
    """weight(ts, i) per bar; i = bar position within its (index-local) day."""

    def __init__(self, fn):
        self.fn = fn

    def generate(self, data_map):
        out = {}
        for c, df in data_map.items():
            day_pos = df.groupby(df.index.date).cumcount()
            out[c] = pd.Series([self.fn(ts, i) for ts, i in zip(df.index, day_pos)],
                               index=df.index, dtype=float)
        return out


def run(engine_cls, frames: dict, fn, tmp_path, interval="5m", **cfg):
    codes = list(frames)
    config = {"codes": codes, "interval": interval, "initial_cash": 10_000_000, **cfg}
    eng = engine_cls(config, codes) if engine_cls is CompositeEngine else engine_cls(config)
    eng.run_backtest(eng.config if hasattr(eng, "config") else config, Loader(frames),
                     Signal(fn), tmp_path, bars_per_year=None)
    return eng


def bar(ts, close=100.0):
    return pd.Series({"close": close}, name=T(ts))


def ist(ts) -> pd.Timestamp:
    t = T(ts)
    return t.tz_convert("Asia/Kolkata") if t.tzinfo is not None else t


def flat_at_every_day_end(eng) -> bool:
    """Post-fill book is empty on the last snapshot of every (IST) day."""
    last = {}
    for ts, weights in eng.actual_position_snapshots:
        last[ist(ts).date()] = weights
    return all(all(abs(w) < 1e-12 for w in weights.values()) for weights in last.values())


ALWAYS_LONG = lambda ts, i: 1.0  # noqa: E731
ALWAYS_SHORT = lambda ts, i: -1.0  # noqa: E731


# ── AC: intraday interval detection ──


@pytest.mark.parametrize("interval", ["1m", "5m", "15m", "60m", "1H", "4H", "1h", " 5m "])
def test_is_intraday_true(interval):
    assert is_intraday(interval)


@pytest.mark.parametrize("interval", ["1D", "1W", "1M", "1d", "D", "m", "H", "", None, "5min", "1.5m"])
def test_is_intraday_false(interval):
    assert not is_intraday(interval)


# ── AC: session edges (NSE/BFO 09:15-15:30, MCX 09:00-23:30) ──


@pytest.mark.parametrize("symbol", [EQ, FNO, BFO])
def test_nse_bfo_open_edge(symbol):
    assert not in_session(T("2024-03-04 09:14:59"), symbol)
    assert in_session(T("2024-03-04 09:15:00"), symbol)


@pytest.mark.parametrize("symbol", [EQ, FNO, BFO])
def test_nse_bfo_close_edge_1530_is_inclusive(symbol):
    assert in_session(T("2024-03-04 15:29:59"), symbol)
    assert in_session(T("2024-03-04 15:30:00"), symbol)   # 15:30 itself is IN session
    assert not in_session(T("2024-03-04 15:30:01"), symbol)


def test_mcx_session_edges():
    assert not in_session(T("2024-03-04 08:59:59"), MCX)
    assert in_session(T("2024-03-04 09:00:00"), MCX)
    assert in_session(T("2024-03-04 23:30:00"), MCX)
    assert not in_session(T("2024-03-04 23:30:01"), MCX)
    # the MCX window must not leak onto NSE symbols
    assert not in_session(T("2024-03-04 09:00:00"), FNO)


def test_can_execute_session_edges_equity_and_fno():
    eq = IndiaEquityEngine({"interval": "5m", "price_limit": None})
    fno = IndiaFnoEngine({"interval": "5m"})
    for eng, sym in ((eq, EQ), (fno, FNO), (fno, BFO)):
        assert not eng.can_execute(sym, 1, bar("2024-03-04 09:14:59"))
        assert eng.can_execute(sym, 1, bar("2024-03-04 09:15:00"))
        assert eng.can_execute(sym, 1, bar("2024-03-04 15:30:00"))
        assert not eng.can_execute(sym, 1, bar("2024-03-04 15:30:01"))
    assert not fno.can_execute(MCX, 1, bar("2024-03-04 08:59:59"))
    assert fno.can_execute(MCX, 1, bar("2024-03-04 09:00:00"))


def test_out_of_session_close_also_blocked():
    eng = IndiaEquityEngine({"interval": "5m", "price_limit": None, "product": "MIS"})
    assert not eng.can_execute(EQ, 0, bar("2024-03-04 15:40"))
    assert eng.can_execute(EQ, 0, bar("2024-03-04 15:25"))   # exits allowed after 15:20


# ── AC: bars read as IST (naive = IST, tz-aware converted) ──


def test_utc_bars_converted_to_ist():
    assert not in_session(T("2024-03-04 03:44:59Z"), EQ)
    assert in_session(T("2024-03-04 03:45:00Z"), EQ)          # 09:15 IST
    assert in_session(T("2024-03-04 10:00:00Z"), EQ)          # 15:30 IST
    assert not in_session(T("2024-03-04 10:00:01Z"), EQ)
    assert not after_squareoff(T("2024-03-04 09:49:59Z"), EQ)
    assert after_squareoff(T("2024-03-04 09:50:00Z"), EQ)     # 15:20 IST
    # a naive 03:45 is IST 03:45 -> out of session
    assert not in_session(T("2024-03-04 03:45:00"), EQ)


def test_plus_0530_strings():
    assert in_session(T("2024-03-04 09:15:00+05:30"), EQ)
    assert not in_session(T("2024-03-04 09:14:59+05:30"), EQ)
    assert after_squareoff(T("2024-03-04 15:20:00+05:30"), EQ)


@pytest.mark.parametrize("day", ["2024-01-15", "2024-07-15"])  # winter vs summer
def test_dst_irrelevant(day):
    # IST has no DST: 03:45Z is 09:15 IST all year, whatever the source zone.
    assert in_session(T(f"{day} 03:45:00Z"), EQ)
    london = T(f"{day} 03:45:00Z").tz_convert("Europe/London")
    ny = T(f"{day} 03:45:00Z").tz_convert("America/New_York")
    assert in_session(london, EQ) and in_session(ny, EQ)
    assert not in_session(T(f"{day} 03:44:00Z").tz_convert("America/New_York"), EQ)


def test_utc_indexed_run_squares_off_at_1520_ist(tmp_path):
    df = fixture_frame()
    df.index = df.index.tz_localize("Asia/Kolkata").tz_convert("UTC")
    eng = run(IndiaEquityEngine, {EQ: df}, ALWAYS_LONG, tmp_path, product="MIS", **ZERO_EQ)
    sq = [t for t in eng.trades if t.exit_reason == "mis_squareoff"]
    assert {ist(t.exit_time).strftime("%Y-%m-%d %H:%M") for t in sq} == {
        f"2024-03-0{d} 15:20" for d in (4, 5, 6)}
    assert ist(eng.trades[0].entry_time) == T("2024-03-04 09:15", tz="Asia/Kolkata")
    assert flat_at_every_day_end(eng)


def test_plus_0530_indexed_run(tmp_path):
    df = fixture_frame()
    raw = [ts.strftime("%Y-%m-%d %H:%M:%S") + "+05:30" for ts in df.index]
    df.index = pd.DatetimeIndex(pd.to_datetime(raw))
    eng = run(IndiaEquityEngine, {EQ: df}, ALWAYS_LONG, tmp_path, product="MIS", **ZERO_EQ)
    assert ist(eng.trades[0].entry_time).strftime("%H:%M") == "09:15"
    sq = [t for t in eng.trades if t.exit_reason == "mis_squareoff"]
    assert len(sq) == 3
    assert all(ist(t.exit_time).strftime("%H:%M") == "15:20" for t in sq)


# ── AC: MIS square-off placement ──


def test_squareoff_bars_gap_picks_last_bar_before_1520():
    idx = pd.DatetimeIndex(day_bars("2024-03-04", "09:15", "15:00") + [T("2024-03-04 15:25")])
    assert squareoff_bars(idx, EQ) == {T("2024-03-04 15:00")}


def test_gap_day_squared_off_on_1500_bar_and_not_carried(tmp_path):
    idx = (day_bars("2024-03-04", "09:15", "15:00") + [T("2024-03-04 15:25"), T("2024-03-04 15:30")]
           + day_bars("2024-03-05", "09:15", "15:30"))
    eng = run(IndiaEquityEngine, {EQ: flat_frame(idx)}, ALWAYS_LONG, tmp_path,
              product="MIS", **ZERO_EQ)
    day1 = [t for t in eng.trades if t.entry_time.date() == date(2024, 3, 4)]
    assert [t.exit_reason for t in day1] == ["mis_squareoff"]
    assert day1[0].exit_time == T("2024-03-04 15:00")
    # no re-entry on the 15:25 / 15:30 bars and nothing carried into day 2
    assert not [t for t in eng.trades if T("2024-03-04 15:00") < t.entry_time < T("2024-03-05")]
    assert all(t.entry_time.date() == t.exit_time.date() for t in eng.trades)
    assert flat_at_every_day_end(eng)


def test_last_bar_of_day_is_1520_exactly(tmp_path):
    idx = day_bars("2024-03-04", "09:15", "15:20") + day_bars("2024-03-05", "09:15", "15:20")
    eng = run(IndiaEquityEngine, {EQ: flat_frame(idx)}, ALWAYS_LONG, tmp_path,
              product="MIS", **ZERO_EQ)
    assert [(t.exit_time, t.exit_reason) for t in eng.trades] == [
        (T("2024-03-04 15:20"), "mis_squareoff"), (T("2024-03-05 15:20"), "mis_squareoff")]


def test_half_day_session_ends_1300(tmp_path):
    idx = (day_bars("2024-03-04", "09:15", "15:30") + day_bars("2024-03-05", "09:15", "13:00")
           + day_bars("2024-03-06", "09:15", "15:30"))
    eng = run(IndiaEquityEngine, {EQ: flat_frame(idx)}, ALWAYS_LONG, tmp_path,
              product="MIS", **ZERO_EQ)
    half = [t for t in eng.trades if t.entry_time.date() == date(2024, 3, 5)]
    assert [(t.exit_time, t.exit_reason) for t in half] == [(T("2024-03-05 13:00"), "mis_squareoff")]
    assert all(t.entry_time.date() == t.exit_time.date() for t in eng.trades)
    assert flat_at_every_day_end(eng)


def test_multi_day_mis_flat_at_every_day_boundary(tmp_path):
    eng = run(IndiaEquityEngine, {EQ: fixture_frame()}, ALWAYS_LONG, tmp_path,
              product="MIS", **ZERO_EQ)
    assert flat_at_every_day_end(eng)
    assert all(t.entry_time.date() == t.exit_time.date() for t in eng.trades)
    assert not any(t.exit_reason == "end_of_backtest" for t in eng.trades)


def test_mis_short_squared_off(tmp_path):
    eng = run(IndiaEquityEngine, {EQ: fixture_frame()}, ALWAYS_SHORT, tmp_path,
              product="MIS", **ZERO_EQ)
    sq = [t for t in eng.trades if t.exit_reason == "mis_squareoff"]
    assert len(sq) == 3 and all(t.direction == -1 for t in sq)
    assert all(t.exit_time.strftime("%H:%M") == "15:20" for t in sq)
    assert flat_at_every_day_end(eng)


def test_entry_signal_at_or_after_1520_ignored(tmp_path):
    # Signals from 15:15 on execute at 15:20 or later (next bar open): all blocked.
    late = lambda ts, i: 1.0 if ts.strftime("%H:%M") >= "15:15" else 0.0  # noqa: E731
    eng = run(IndiaEquityEngine, {EQ: fixture_frame()}, late, tmp_path, product="MIS", **ZERO_EQ)
    assert eng.trades == []


def test_entry_at_1515_allowed_then_squared_off_at_1520(tmp_path):
    # target long on the 15:15 and 15:20 bars (signals lag one bar)
    sig = lambda ts, i: 1.0 if ts.strftime("%H:%M") in ("15:10", "15:15") else 0.0  # noqa: E731
    eng = run(IndiaEquityEngine, {EQ: fixture_frame()}, sig, tmp_path, product="MIS", **ZERO_EQ)
    assert eng.trades
    for t in eng.trades:
        assert t.entry_time.strftime("%H:%M") == "15:15"
        assert t.exit_time.strftime("%H:%M") == "15:20"
        assert t.exit_reason == "mis_squareoff"


def test_mis_entry_block_unit_edge():
    eng = IndiaEquityEngine({"interval": "5m", "price_limit": None, "product": "MIS"})
    assert eng.can_execute(EQ, 1, bar("2024-03-04 15:19:59"))
    assert not eng.can_execute(EQ, 1, bar("2024-03-04 15:20:00"))
    assert not eng.can_execute(EQ, -1, bar("2024-03-04 15:20:00"))
    cnc = IndiaEquityEngine({"interval": "5m", "price_limit": None})
    assert cnc.can_execute(EQ, 1, bar("2024-03-04 15:25"))   # CNC has no 15:20 cut-off


# ── AC: CNC (T+1, no short) ──


def test_cnc_same_day_sell_blocked_next_day_allowed(tmp_path):
    # long for the first 10 bars of day 1, then flat
    sig = lambda ts, i: 1.0 if ts.date() == date(2024, 3, 4) and i < 10 else 0.0  # noqa: E731
    eng = run(IndiaEquityEngine, {EQ: fixture_frame()}, sig, tmp_path, **ZERO_EQ)
    assert len(eng.trades) == 1
    t = eng.trades[0]
    assert t.entry_time.date() == date(2024, 3, 4)
    assert t.exit_time == T("2024-03-05 09:15")   # first in-session bar of the next day
    assert t.exit_reason == "signal"


def test_cnc_explicit_product_same_as_default(tmp_path):
    a = run(IndiaEquityEngine, {EQ: fixture_frame()}, ALWAYS_LONG, tmp_path, **ZERO_EQ)
    b = run(IndiaEquityEngine, {EQ: fixture_frame()}, ALWAYS_LONG, tmp_path, product="CNC", **ZERO_EQ)
    assert [(t.entry_time, t.exit_time, t.exit_reason) for t in a.trades] == \
           [(t.entry_time, t.exit_time, t.exit_reason) for t in b.trades]


# ── product parsing ──


def test_product_lowercase_mis_accepted(tmp_path):
    eng = run(IndiaEquityEngine, {EQ: fixture_frame()}, ALWAYS_LONG, tmp_path,
              product="mis", **ZERO_EQ)
    assert eng.mis
    assert len([t for t in eng.trades if t.exit_reason == "mis_squareoff"]) == 3


def test_unknown_product_rejected():
    with pytest.raises(ValueError, match="XYZ"):
        IndiaEquityEngine({"interval": "5m", "product": "XYZ"})


def test_mis_at_daily_interval_behaves_like_cnc(tmp_path):
    eng = IndiaEquityEngine({"interval": "1D", "product": "MIS"})
    assert not eng.mis and not eng.intraday and not eng.allow_short
    # bilateral delivery STT, not MIS sell-only
    assert eng.calc_commission(100, 100.0, 1, True) == pytest.approx(
        IndiaEquityEngine({"interval": "1D"}).calc_commission(100, 100.0, 1, True))
    idx = pd.date_range("2024-03-04", periods=5, freq="B")
    short = run(IndiaEquityEngine, {EQ: flat_frame(idx)}, ALWAYS_SHORT, tmp_path,
                interval="1D", product="MIS", **ZERO_EQ)
    assert short.trades == []


def test_daily_unchanged_mis_equals_cnc(tmp_path):
    df = flat_frame(pd.date_range("2024-03-04", periods=6, freq="B"))
    df["close"] = df["open"] = [100, 101, 102, 101, 103, 104]
    sig = lambda ts, i: 1.0 if ts.day in (4, 5) else 0.0  # noqa: E731
    a = run(IndiaEquityEngine, {EQ: df}, sig, tmp_path, interval="1D", price_limit=None)
    b = run(IndiaEquityEngine, {EQ: df}, sig, tmp_path, interval="1D", price_limit=None, product="MIS")
    assert [(t.entry_time, t.exit_time, t.commission) for t in a.trades] == \
           [(t.entry_time, t.exit_time, t.commission) for t in b.trades]
    # daily: the session clock is ignored (midnight timestamps trade)
    assert a.trades and a.trades[0].entry_time.hour == 0


# ── AC: MIS STT (sell side, default 0.00025) and stamp duty ──


def test_mis_stt_hand_computed_round_trip_defaults():
    e = IndiaEquityEngine({"interval": "5m", "product": "MIS"})   # all default rates
    # buy 100 @ 100 -> notional 10_000
    exch, sebi = 10_000 * 0.0000297, 10_000 * 0.000001        # 0.297, 0.01
    gst = (exch + sebi) * 0.18                                  # 0.05526
    buy = exch + sebi + gst + 10_000 * 0.00003                  # 0.66226, no STT, MIS stamp
    sell = exch + sebi + gst + 10_000 * 0.00025                 # 2.86226, STT 2.5
    assert e.calc_commission(100, 100.0, 1, True) == pytest.approx(0.66226)
    assert e.calc_commission(100, 100.0, 1, True) == pytest.approx(buy)
    assert e.calc_commission(100, 100.0, 1, False) == pytest.approx(sell)
    assert buy + sell == pytest.approx(3.52452)


def test_mis_no_stt_on_buy_short_cover():
    e = IndiaEquityEngine({"interval": "5m", "product": "MIS", "in_exchange_txn": 0,
                           "in_sebi_fee": 0, "in_stamp_duty": 0, "in_mis_stamp_duty": 0})
    assert e.calc_commission(100, 100.0, -1, False) == 0.0     # cover = buy: no STT


def test_mis_stamp_uses_intraday_rate():
    kw = {"in_exchange_txn": 0, "in_sebi_fee": 0, "in_stt": 0, "in_mis_stt": 0}
    mis = IndiaEquityEngine({"interval": "5m", "product": "MIS", **kw})
    cnc = IndiaEquityEngine({"interval": "5m", **kw})
    for eng, buy_stamp in ((mis, 10_000 * 0.00003), (cnc, 10_000 * 0.00015)):  # 0.3 / 1.5
        assert eng.calc_commission(100, 100.0, 1, True) == pytest.approx(buy_stamp)   # buy
        assert eng.calc_commission(100, 100.0, 1, False) == 0.0                       # sell
        assert eng.calc_commission(100, 100.0, -1, False) == pytest.approx(buy_stamp)  # cover


def test_mis_run_commission_matches_hand_rates(tmp_path):
    idx = day_bars("2024-03-04", "09:15", "15:30")
    eng = run(IndiaEquityEngine, {EQ: flat_frame(idx)}, ALWAYS_LONG, tmp_path, product="MIS",
              slippage=0, price_limit=None, initial_cash=1_000_000)
    assert len(eng.trades) == 1 and eng.trades[0].exit_reason == "mis_squareoff"
    t = eng.trades[0]
    base = (0.0000297 + 0.000001) * 1.18
    expected = t.size * 100.0 * ((base + 0.00003) + (base + 0.00025))
    assert t.commission == pytest.approx(expected)


# ── AC: MCX ──


def test_mcx_mis_squares_off_2320_and_opens_0900(tmp_path):
    idx = (day_bars("2024-03-04", "08:50", "23:40", "10min")
           + day_bars("2024-03-05", "08:50", "23:40", "10min"))
    eng = run(IndiaFnoEngine, {MCX: flat_frame(idx)}, ALWAYS_LONG, tmp_path,
              product="MIS", **ZERO_FNO)
    assert [(t.entry_time, t.exit_time, t.exit_reason) for t in eng.trades] == [
        (T("2024-03-04 09:00"), T("2024-03-04 23:20"), "mis_squareoff"),
        (T("2024-03-05 09:00"), T("2024-03-05 23:20"), "mis_squareoff")]


def test_mcx_squareoff_edge_unit():
    assert not after_squareoff(T("2024-03-04 23:19:59"), MCX)
    assert after_squareoff(T("2024-03-04 23:20:00"), MCX)
    assert not after_squareoff(T("2024-03-04 22:00:00"), MCX)
    assert after_squareoff(T("2024-03-04 15:20:00"), FNO)


def test_mcx_nrml_holds_overnight(tmp_path):
    idx = (day_bars("2024-03-04", "09:00", "23:30", "10min")
           + day_bars("2024-03-05", "09:00", "23:30", "10min"))
    eng = run(IndiaFnoEngine, {MCX: flat_frame(idx)}, ALWAYS_LONG, tmp_path, **ZERO_FNO)
    assert [t.exit_reason for t in eng.trades] == ["end_of_backtest"]


# ── AC: india_fno NRML vs MIS ──


def test_fno_mis_short_squared_off_and_flat_overnight(tmp_path):
    eng = run(IndiaFnoEngine, {FNO: fixture_frame()}, ALWAYS_SHORT, tmp_path,
              product="MIS", **ZERO_FNO)
    sq = [t for t in eng.trades if t.exit_reason == "mis_squareoff"]
    assert len(sq) == 3 and all(t.direction == -1 for t in sq)
    assert flat_at_every_day_end(eng)


def test_fno_nrml_not_flat_overnight(tmp_path):
    eng = run(IndiaFnoEngine, {FNO: fixture_frame()}, ALWAYS_LONG, tmp_path, **ZERO_FNO)
    assert not flat_at_every_day_end(eng)
    assert not any(t.exit_reason == "mis_squareoff" for t in eng.trades)


def test_fno_lowercase_nrml_and_daily_mis():
    assert not IndiaFnoEngine({"interval": "5m", "product": "nrml"}).mis
    assert IndiaFnoEngine({"interval": "5m", "product": "mis"}).mis
    assert not IndiaFnoEngine({"interval": "1D", "product": "MIS"}).mis


# ── composite basket: MIS equity + future ──


def test_composite_mis_squares_off_equity_and_future(tmp_path):
    # NB: ``product`` is one run-level key, so a composite cannot hold an MIS
    # equity next to an NRML future; with product=MIS both legs are MIS.
    frames = {EQ: fixture_frame(), FNO: fixture_frame()}
    eng = run(CompositeEngine, frames, lambda ts, i: 0.5, tmp_path,
              product="MIS", **{**ZERO_EQ, **ZERO_FNO})
    for sym in (EQ, FNO):
        sq = [t for t in eng.trades if t.symbol == sym and t.exit_reason == "mis_squareoff"]
        assert len(sq) == 3, sym
    assert flat_at_every_day_end(eng)


def test_composite_default_cnc_equity_nrml_future_hold_overnight(tmp_path):
    frames = {EQ: fixture_frame(), FNO: fixture_frame()}
    eng = run(CompositeEngine, frames, lambda ts, i: 0.5, tmp_path, **{**ZERO_EQ, **ZERO_FNO})
    assert {t.symbol for t in eng.trades} == {EQ, FNO}
    assert all(t.exit_reason == "end_of_backtest" for t in eng.trades)
    # session filter still applies inside the composite
    assert all(T("09:15").time() <= t.entry_time.time() <= T("15:30").time() for t in eng.trades)


# ── AC: crypto funding 3 settlements/day regardless of bar size ──


SWAP = "BTC-USDT-SWAP"


def _funding_total(stamps, interval, rate=0.0001):
    span = _interval_span_hours(interval)
    pos = {SWAP: Position(SWAP, 1, 100.0, T("2024-03-04"), 1.0)}
    applied, daily = set(), set()
    b = pd.Series({"close": 100.0})
    return sum(calc_crypto_funding_fee(SWAP, b, ts, pos, rate, applied, daily, span) for ts in stamps)


def test_crypto_1m_dense_day_three_settlements():
    stamps = pd.date_range("2024-03-04", "2024-03-05", freq="1min", inclusive="left")
    assert _funding_total(stamps, "1m") == pytest.approx(3 * 100.0 * 0.0001)


def test_crypto_repeated_bar_settled_once():
    stamps = [T("2024-03-04 08:00")] * 3 + [T("2024-03-04 00:00"), T("2024-03-04 16:00")]
    assert _funding_total(stamps, "1m") == pytest.approx(3 * 100.0 * 0.0001)


def test_crypto_1m_sparse_gap_across_settlement_settled_once():
    # 1m bars with a hole 07:55-08:05 UTC: the 08:00 settlement still happened
    # while the position was held, so the day must still pay 3 settlements.
    stamps = [ts for ts in pd.date_range("2024-03-04", "2024-03-05", freq="1min", inclusive="left")
              if not (T("2024-03-04 07:55") <= ts < T("2024-03-04 08:05"))]
    assert _funding_total(stamps, "1m") == pytest.approx(3 * 100.0 * 0.0001)


def test_crypto_tz_aware_ist_bars_settle_on_utc_clock():
    stamps = pd.date_range("2024-03-04", "2024-03-05", freq="1min", inclusive="left", tz="UTC")
    stamps = stamps.tz_convert("Asia/Kolkata")
    assert _funding_total(stamps, "1m") == pytest.approx(3 * 100.0 * 0.0001)


def test_crypto_daily_unchanged():
    stamps = pd.date_range("2024-03-04", periods=2, freq="D")
    assert _funding_total(stamps, "1D") == pytest.approx(2 * 3 * 100.0 * 0.0001)


# ── P7.2-f1: product validation and product_by_market ──


@pytest.mark.parametrize("cls,product", [
    (IndiaEquityEngine, "XYZ"), (IndiaEquityEngine, "NRML"), (IndiaEquityEngine, ""),
    (IndiaFnoEngine, "XYZ"), (IndiaFnoEngine, "CNCX"),
])
@pytest.mark.parametrize("interval", ["5m", "1D"])   # validated even at daily
def test_invalid_product_raises(cls, product, interval):
    with pytest.raises(ValueError):
        cls({"interval": interval, "product": product})


def test_invalid_product_by_market_raises():
    with pytest.raises(ValueError):
        IndiaEquityEngine({"interval": "5m", "product_by_market": {"india_equity": "NRML"}})
    with pytest.raises(ValueError):
        IndiaFnoEngine({"interval": "5m", "product_by_market": {"india_fno": "XYZ"}})


def test_fno_accepts_cnc_as_non_mis():
    eng = IndiaFnoEngine({"interval": "5m", "product": "CNC"})
    assert eng.product == "CNC" and not eng.mis
    assert IndiaFnoEngine({"interval": "5m", "product": " cnc "}).mis is False


def test_product_by_market_overrides_run_level_product():
    eq = IndiaEquityEngine({"interval": "5m", "product": "CNC",
                            "product_by_market": {"india_equity": "MIS"}})
    assert eq.mis and eq.allow_short
    fno = IndiaFnoEngine({"interval": "5m", "product": "MIS",
                          "product_by_market": {"india_fno": "NRML"}})
    assert not fno.mis
    # a market missing from the map falls back to the run-level product
    assert IndiaFnoEngine({"interval": "5m", "product": "MIS",
                           "product_by_market": {"india_equity": "CNC"}}).mis
    # the map wins even when the run-level value would be invalid for that market
    assert IndiaEquityEngine({"interval": "5m", "product": "NRML",
                              "product_by_market": {"india_equity": "CNC"}}).product == "CNC"


def _by_symbol(trades):
    out = {}
    for t in trades:
        out.setdefault(t.symbol, []).append(t)
    return out


def test_composite_product_by_market_mis_equity_nrml_future(tmp_path):
    frames = {EQ: fixture_frame(), FNO: fixture_frame()}
    eng = run(CompositeEngine, frames, lambda ts, i: 0.5, tmp_path,
              product_by_market={"india_equity": "MIS", "india_fno": "NRML"},
              **{**ZERO_EQ, **ZERO_FNO})
    by = _by_symbol(eng.trades)
    eq_sq = [t for t in by[EQ] if t.exit_reason == "mis_squareoff"]
    assert {t.exit_time for t in eq_sq} == {T(f"2024-03-0{d} 15:20") for d in (4, 5, 6)}
    assert all(t.entry_time.date() == t.exit_time.date() for t in by[EQ])
    assert [t.exit_reason for t in by[FNO]] == ["end_of_backtest"]
    assert by[FNO][0].exit_time.date() > by[FNO][0].entry_time.date()


def test_composite_run_level_mis_overridden_for_future(tmp_path):
    frames = {EQ: fixture_frame(), FNO: fixture_frame()}
    eng = run(CompositeEngine, frames, lambda ts, i: 0.5, tmp_path, product="MIS",
              product_by_market={"india_fno": "NRML"}, **{**ZERO_EQ, **ZERO_FNO})
    by = _by_symbol(eng.trades)
    assert len([t for t in by[EQ] if t.exit_reason == "mis_squareoff"]) == 3
    assert [t.exit_reason for t in by[FNO]] == ["end_of_backtest"]


def test_composite_invalid_product_raises():
    with pytest.raises(ValueError):
        CompositeEngine({"interval": "5m", "product_by_market": {"india_equity": "NRML"}}, [EQ, FNO])


# ── service path: bt_service.run_backtest(costs=...) ──


def _service_code(weight):
    return (
        "import pandas as pd\n"
        "class SignalEngine:\n"
        "    def generate(self, data_map):\n"
        f"        return {{c: pd.Series({weight}, index=df.index) for c, df in data_map.items()}}\n"
    )


@pytest.fixture
def svc(tmp_path, monkeypatch):
    def setup(csv_path: Path):
        cfg = tmp_path / "config.yaml"
        cfg.write_text("sources:\n" + "".join(
            f'  - symbol: "{s}"\n    type: csv\n    path: "{csv_path.as_posix()}"\n'
            '    columns:\n      date: timestamp\n'
            for s in (EQ, FNO)), encoding="utf-8")
        monkeypatch.setenv("BT_LOCAL_DATA_CONFIG", str(cfg))
        monkeypatch.setenv("BT_RUNS_DIR", str(tmp_path / "runs"))
        monkeypatch.setenv("VIBE_TRADING_DATA_CACHE", "false")
    return setup


def _svc_run(symbols, costs, weight=0.5):
    from bt_service import run_backtest
    return run_backtest(_service_code(weight), symbols, "2024-03-04", "2024-03-06", interval="5m",
                        capital=10_000_000, source="local", costs=costs)


def _hm(v) -> str:
    return str(v)[11:16]


def _exits(r, code=None):
    """Exit rows of the service trade log (one entry + one exit row per trade)."""
    return [t for t in r["trades"] if t["event"] == "exit" and (code is None or t["code"] == code)]


def test_service_product_by_market_composite(svc):
    svc(FIXTURES / "reliance_5m.csv")
    r = _svc_run([EQ, FNO], {**ZERO_EQ, **ZERO_FNO,
                             "product_by_market": {"india_equity": "MIS", "india_fno": "NRML"}})
    assert r["ok"], r.get("error")
    eq_sq = [t for t in _exits(r, EQ) if t["reason"] == "mis_squareoff"]
    assert len(eq_sq) == 3 and all(_hm(t["timestamp"]) == "15:20" for t in eq_sq)
    assert [t["reason"] for t in _exits(r, FNO)] == ["end_of_backtest"]


@pytest.mark.parametrize("costs", [
    {"product": "XYZ"},
    {"product_by_market": {"india_equity": "NRML"}},
])
def test_service_invalid_product_not_ok(svc, costs):
    svc(FIXTURES / "reliance_5m.csv")
    r = _svc_run([EQ], {**ZERO_EQ, **costs})
    assert r["ok"] is False
    assert "product" in (r.get("error") or "")


def test_service_fno_cnc_accepted(svc):
    svc(FIXTURES / "reliance_5m.csv")
    r = _svc_run([FNO], {**ZERO_FNO, "product": "CNC"}, weight=1.0)
    assert r["ok"], r.get("error")
    assert [t["reason"] for t in _exits(r)] == ["end_of_backtest"]


def test_service_plus0530_csv_read_as_ist(svc, tmp_path):
    # AC: tz-aware bars are converted to IST. A +05:30 CSV must trade 09:15-15:20 IST.
    df = fixture_frame()
    df.index = pd.Index([ts.strftime("%Y-%m-%d %H:%M:%S") + "+05:30" for ts in df.index],
                        name="timestamp")
    path = tmp_path / "reliance_5m_ist.csv"
    df.to_csv(path)
    svc(path)
    r = _svc_run([EQ], {**ZERO_EQ, "product": "MIS"}, weight=1.0)
    assert r["ok"], r.get("error")
    sq = [t for t in _exits(r) if t["reason"] == "mis_squareoff"]
    log = [(t["timestamp"], t["event"], t["reason"]) for t in r["trades"]]
    assert len(sq) == 3, log
    # the IST wall clock must survive the load: first entry 09:15, square-off 15:20
    assert _hm(r["trades"][0]["timestamp"]) == "09:15", log
    assert all(_hm(t["timestamp"]) == "15:20" for t in sq), log


# ── P7.2-f1: sparse crypto funding ──


def _funding(calls, entry, interval="1m", rate=0.0001):
    """calls: (ts, held) per bar; held=False means no open position. Returns settlements."""
    span = _interval_span_hours(interval)
    applied, daily = set(), set()
    b = pd.Series({"close": 100.0})
    pos = Position(SWAP, 1, 100.0, T(entry), 1.0)
    total = 0.0
    for ts, held in calls:
        total += calc_crypto_funding_fee(SWAP, b, T(ts), {SWAP: pos} if held else {},
                                         rate, applied, daily, span)
    return total / (100.0 * rate)


def test_crypto_entry_after_slot_not_charged_for_earlier_slots():
    # flat at 07:00, enter at 09:00 (after the 08:00 slot), next bar 17:00 spans 16:00
    calls = [("2024-03-04 07:00", False), ("2024-03-04 09:00", True), ("2024-03-04 17:00", True)]
    assert _funding(calls, "2024-03-04 09:00") == pytest.approx(1)


def test_crypto_first_bar_after_slots_not_backcharged():
    calls = [("2024-03-04 09:00", True), ("2024-03-04 09:01", True)]
    assert _funding(calls, "2024-03-04 09:00") == pytest.approx(0)


def test_crypto_long_gap_spanning_two_settlements_charged_once_each():
    calls = [("2024-03-04 07:00", True), ("2024-03-04 17:00", True),
             ("2024-03-04 17:00", True), ("2024-03-04 17:01", True)]
    assert _funding(calls, "2024-03-04 06:00") == pytest.approx(2)


def test_crypto_gap_spanning_two_settlements_entry_between_them():
    # last bar 07:00, entry stamped 10:00, next bar 17:00: only 16:00 is owed
    calls = [("2024-03-04 07:00", True), ("2024-03-04 17:00", True)]
    assert _funding(calls, "2024-03-04 10:00") == pytest.approx(1)


def test_crypto_tz_aware_sparse_gap():
    calls = [("2024-03-04 12:30+05:30", True), ("2024-03-04 22:30+05:30", True)]  # 07:00Z, 17:00Z
    assert _funding(calls, "2024-03-04 06:00Z") == pytest.approx(2)
