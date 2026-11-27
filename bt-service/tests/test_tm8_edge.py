"""TM-8 owner-side edge tests: the explicit-unit Timedelta rewrite changed no value.

Every expression TM-8 touched is compared against the OLD construction (the
keyword ``pd.Timedelta(minutes=/hours=/days=/seconds=/weeks=)`` form, evaluated
here with warnings silenced) and, where it matters, against hand-derived
numbers. ``_old_calc`` is a verbatim copy of ``calc_crypto_funding_fee`` from
main before TM-8 (docstring dropped). The two full CryptoEngine runs pin
``final_value`` and ``crypto_funding_pnl`` to the exact floats main produced
for the same scenarios (computed once on an ``origin/main`` export).
"""
import warnings
from pathlib import Path

import pandas as pd
import pytest

from vibe_bt.backtest.engines._market_hooks import (
    FUNDING_HOURS,
    _interval_span_hours,
    calc_crypto_funding_fee,
)
from vibe_bt.backtest.engines.crypto import CryptoEngine
from vibe_bt.backtest.loaders import ccxt_loader
from vibe_bt.backtest.models import Position

T = pd.Timestamp
SWAP = "BTC-USDT-SWAP"
RUNNER_INTERVALS = ("1m", "3m", "5m", "10m", "15m", "30m", "1H", "4H", "1D", "1W", "1M")


def _old_td(**kw) -> pd.Timedelta:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        return pd.Timedelta(**kw)


# ── reference: calc_crypto_funding_fee as on main before TM-8 ──


def _old_calc(symbol, bar, timestamp, positions, funding_rate, applied_set, daily_done_set,
              bar_span_hours=None):
    if not hasattr(timestamp, "date"):
        return 0.0
    current_date = timestamp.date()
    hour = timestamp.hour if hasattr(timestamp, "hour") else 0
    settlements = 1
    if bar_span_hours is not None and bar_span_hours >= 24:
        settlements = max(1, int(bar_span_hours // 8))
        key = (symbol, current_date, hour)
        if key in applied_set:
            return 0.0
        applied_set.add(key)
    elif bar_span_hours is not None:
        start = pd.Timestamp(timestamp)
        if start.tzinfo is not None:
            start = start.tz_convert("UTC")
        end = start + _old_td(seconds=bar_span_hours * 3600)
        step = _old_td(hours=8)
        lo = start
        held = positions.get(symbol)
        if held is not None:
            prev = getattr(held, "_funding_last_ts", None)
            if prev is not None and prev < start:
                lo = prev
            object.__setattr__(held, "_funding_last_ts", start)
            entry = pd.Timestamp(held.entry_time)
            entry = entry.tz_convert("UTC") if entry.tzinfo is not None else entry
            if entry.tzinfo is None and start.tzinfo is not None:
                entry = entry.tz_localize("UTC")
            elif entry.tzinfo is not None and start.tzinfo is None:
                entry = entry.tz_localize(None)
            lo = max(lo, entry)
        slot = lo.ceil("8h")
        settlements = 0
        while slot < end:
            key = (symbol, slot.date(), slot.hour)
            if key not in applied_set:
                applied_set.add(key)
                settlements += 1
            slot += step
        if not settlements:
            return 0.0
    elif hour in FUNDING_HOURS:
        key = (symbol, current_date, hour)
        if key in applied_set:
            return 0.0
        applied_set.add(key)
    else:
        day_key = (symbol, current_date)
        if day_key in daily_done_set:
            return 0.0
        daily_done_set.add(day_key)
    pos = positions.get(symbol)
    if pos is None:
        return 0.0
    mark_price = float(bar.get("close", pos.entry_price))
    notional = pos.size * mark_price
    hist = bar.get("funding_rate")
    if hist is not None and pd.notna(hist):
        funding_rate = float(hist)
    return notional * funding_rate * pos.direction * settlements


def _drive(fn, stamps, span, entry, held=None, rate=0.0001, direction=1, size=1.0, closes=None):
    """Feed one bar per stamp; returns (per-bar fees, applied set, daily set)."""
    pos = Position(SWAP, direction, 100.0, T(entry), size)
    applied, daily, fees = set(), set(), []
    for i, ts in enumerate(stamps):
        px = closes[i] if closes is not None else 100.0
        b = pd.Series({"close": px})
        on = held[i] if held is not None else True
        fees.append(fn(SWAP, b, T(ts), {SWAP: pos} if on else {}, rate, applied, daily, span))
    return fees, applied, daily


def _same(stamps, span, entry, **kw):
    new = _drive(calc_crypto_funding_fee, stamps, span, entry, **kw)
    old = _drive(_old_calc, stamps, span, entry, **kw)
    assert new[0] == old[0]  # exact float equality bar by bar
    assert new[1] == old[1] and new[2] == old[2]
    return new[0]


def _day(day, freq, tz=None):
    return list(pd.date_range(T(day), T(day) + pd.Timedelta(1, "D"), freq=freq, tz=tz,
                              inclusive="left"))


# ── AC: Timedelta values exactly equal (pd.Timedelta equality) ──


OLD_TABLE = {
    "1m": dict(minutes=1), "3m": dict(minutes=3), "5m": dict(minutes=5),
    "15m": dict(minutes=15), "30m": dict(minutes=30), "1h": dict(hours=1),
    "4h": dict(hours=4), "1d": dict(days=1), "1w": dict(weeks=1), "1M": dict(days=31),
}
NS = {"1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400,
      "1d": 86400, "1w": 604800, "1M": 2678400}


def test_timeframe_table_has_exactly_the_old_keys():
    assert set(ccxt_loader._TIMEFRAME_DELTA) == set(OLD_TABLE)


@pytest.mark.parametrize("key", sorted(OLD_TABLE))
def test_timeframe_delta_equals_old_value(key):
    new = ccxt_loader._TIMEFRAME_DELTA[key]
    old = _old_td(**OLD_TABLE[key])
    assert isinstance(new, pd.Timedelta)
    assert new == old
    assert new.value == old.value == NS[key] * 10**9
    # TM2-41 policy: the loader table is pinned to ns. A freshly built Timedelta is
    # ns on pandas 2.x but us on pandas 3, so the old side is compared at ns.
    assert new.unit == "ns"
    assert new == old.as_unit("ns") and new.as_unit("ns").value == new.value


def test_1M_is_31_days_not_minutes_and_1m_is_one_minute():
    d = ccxt_loader._TIMEFRAME_DELTA
    assert d["1M"] == pd.Timedelta(31 * 24 * 3600, "s") and d["1m"] == pd.Timedelta(60, "s")
    assert d["1M"] != d["1m"]


def test_every_ccxt_interval_maps_to_a_known_delta():
    for tf in set(ccxt_loader._INTERVAL_MAP.values()):
        assert tf in ccxt_loader._TIMEFRAME_DELTA, tf


@pytest.mark.parametrize("interval", RUNNER_INTERVALS)
def test_funding_span_delta_equals_old_for_every_runner_interval(interval):
    span = _interval_span_hours(interval)
    assert pd.Timedelta(span * 3600, unit="s") == _old_td(seconds=span * 3600)
    assert pd.Timedelta(8, "h") == _old_td(hours=8) == pd.Timedelta(28800, "s")


@pytest.mark.parametrize("n", [n for n in range(1, 61) if n != 31])  # 31: see the 1 ns finding below
def test_funding_span_delta_equals_old_for_minute_tokens_up_to_1h(n):
    span = _interval_span_hours(f"{n}m")
    assert pd.Timedelta(span * 3600, unit="s") == _old_td(seconds=span * 3600)


# end-of-day boundary: Timestamp(end_date) + one day (ccxt end_ms, local loader end)


@pytest.mark.parametrize("end_date", ["2024-01-01", "2024-02-28", "2024-02-29", "2024-12-31",
                                      "2024-03-10", "2024-11-03", "2024-03-31", "2024-10-27"])
@pytest.mark.parametrize("tz", [None, "UTC", "Asia/Kolkata", "America/New_York", "Europe/London"])
def test_end_plus_one_day_equals_old(end_date, tz):
    base = T(end_date) if tz is None else T(end_date, tz=tz)
    new = base + pd.Timedelta(1, "D")
    old = base + _old_td(days=1)
    assert new == old and str(new) == str(old)
    assert int(new.timestamp() * 1000) == int(old.timestamp() * 1000)


def test_ccxt_end_ms_hand_value():
    # 2024-03-04 + 1 day = 2024-03-05T00:00Z = 1709596800000 ms
    assert int((T("2024-03-04") + pd.Timedelta(1, "D")).timestamp() * 1000) == 1709596800000


# ── funding: settlement counts / fees identical to main ──


@pytest.mark.parametrize("freq", ["1min", "3min", "5min", "10min", "15min", "30min", "1h", "4h"])
@pytest.mark.parametrize("tz", [None, "UTC", "Asia/Kolkata"])
def test_dense_day_three_settlements_and_equal_to_old(freq, tz):
    interval = {"1min": "1m", "3min": "3m", "5min": "5m", "10min": "10m", "15min": "15m",
                "30min": "30m", "1h": "1H", "4h": "4H"}[freq]
    stamps = _day("2024-03-04", freq, tz)
    fees = _same(stamps, _interval_span_hours(interval), "2024-03-04")
    # a local-midnight IST day covers 18:30Z..18:30Z -> still exactly 3 slots
    assert sum(fees) == pytest.approx(3 * 100.0 * 0.0001)
    assert sum(1 for f in fees if f) == 3


@pytest.mark.parametrize("interval,span_bars", [("1D", 1), ("1W", 1), ("1M", 1)])
def test_daily_and_coarser_unchanged(interval, span_bars):
    stamps = list(pd.date_range("2024-01-01", periods=3, freq="7D"))
    fees = _same(stamps, _interval_span_hours(interval), "2024-01-01")
    per_bar = max(1, int(_interval_span_hours(interval) // 8))
    assert fees == [pytest.approx(per_bar * 100.0 * 0.0001)] * 3


def test_unknown_interval_legacy_path_unchanged():
    stamps = [T("2024-03-04 00:00"), T("2024-03-04 03:00"), T("2024-03-04 08:00"),
              T("2024-03-04 09:00"), T("2024-03-05 01:00")]
    fees = _same(stamps, None, "2024-03-04")
    # 00:00 slot; 03:00 first off-slot bar -> daily fallback; 08:00 slot; 09:00 day done;
    # next day 01:00 -> daily fallback again
    assert fees == [pytest.approx(0.01), pytest.approx(0.01), pytest.approx(0.01), 0.0,
                    pytest.approx(0.01)]


SPARSE = [
    # (stamps, entry, expected settlements) -- hand-derived
    (["2024-03-04 07:55", "2024-03-04 08:05"], "2024-03-04 00:01", 1),
    (["2024-03-04 07:00", "2024-03-04 17:00"], "2024-03-04 06:00", 2),
    (["2024-03-04 07:00", "2024-03-04 17:00"], "2024-03-04 10:00", 1),
    (["2024-03-04 23:59", "2024-03-05 00:00"], "2024-03-04 20:00", 1),
    (["2024-03-04 23:58", "2024-03-05 00:01"], "2024-03-04 20:00", 1),
    (["2024-03-04 01:00", "2024-03-06 01:00"], "2024-03-04 00:30", 6),
    (["2024-03-04 07:59", "2024-03-04 08:00"], "2024-03-04 07:00", 1),
    (["2024-03-04 08:00", "2024-03-04 08:01"], "2024-03-04 08:00", 1),
    (["2024-03-04 09:00", "2024-03-04 09:01"], "2024-03-04 09:00", 0),
]


@pytest.mark.parametrize("stamps,entry,n", SPARSE)
def test_sparse_gaps_equal_old_and_hand_counts(stamps, entry, n):
    fees = _same(stamps, _interval_span_hours("1m"), entry)
    assert sum(fees) == pytest.approx(n * 100.0 * 0.0001)


@pytest.mark.parametrize("stamps,entry,n", SPARSE)
def test_sparse_gaps_ist_aware_bars_same_as_utc(stamps, entry, n):
    ist = [T(s, tz="UTC").tz_convert("Asia/Kolkata") for s in stamps]
    fees = _same(ist, _interval_span_hours("1m"), T(entry, tz="UTC"))
    assert sum(fees) == pytest.approx(n * 100.0 * 0.0001)


def test_tz_naive_bars_with_aware_entry_and_vice_versa():
    stamps = ["2024-03-04 07:00", "2024-03-04 17:00"]
    a = _same(stamps, 1 / 60, T("2024-03-04 06:00", tz="Asia/Kolkata"))
    b = _same([T(s, tz="UTC") for s in stamps], 1 / 60, "2024-03-04 06:00")
    assert sum(b) == pytest.approx(2 * 0.01)
    assert sum(a) == pytest.approx(2 * 0.01)


@pytest.mark.parametrize("day", ["2024-03-10", "2024-03-31", "2024-11-03", "2024-10-27"])
def test_dst_dates_irrelevant_for_utc_settlements(day):
    fees = _same(_day(day, "5min", "UTC"), _interval_span_hours("5m"), day)
    assert sum(fees) == pytest.approx(3 * 0.01)
    ny = [ts.tz_convert("America/New_York") for ts in _day(day, "5min", "UTC")]
    assert _same(ny, _interval_span_hours("5m"), day) == fees


@pytest.mark.parametrize("interval", ["1m", "3m", "5m", "1H", "4H"])
def test_bar_ending_exactly_on_slot_does_not_settle_it(interval):
    span = _interval_span_hours(interval)
    start = T("2024-03-04 08:00") - pd.Timedelta(span * 3600, unit="s")
    fees = _same([start], span, start)
    assert fees == [0.0]  # [start, 08:00) excludes 08:00
    fees = _same([start + pd.Timedelta(1, "s")], span, start)
    assert fees == [pytest.approx(0.01)]


def test_short_hist_rate_varying_close_and_flat_bars_equal_old():
    stamps = _day("2024-03-04", "1h")
    closes = [100.0 + 3.7 * i for i in range(len(stamps))]
    held = [i % 5 != 2 for i in range(len(stamps))]
    fees = _same(stamps, 1.0, "2024-03-04", held=held, direction=-1, size=2.5, closes=closes)
    assert sum(1 for f in fees if f) == 3
    assert all(f <= 0 for f in fees)  # shorts receive a positive rate


def test_empty_and_non_timestamp_inputs():
    assert _same([], 1 / 60, "2024-03-04") == []
    assert calc_crypto_funding_fee(SWAP, pd.Series({"close": 1.0}), 123, {}, 0.0001, set(), set(),
                                   1 / 60) == 0.0
    assert _same(["2024-03-04 08:00"], 1 / 60, "2024-03-04", held=[False]) == [0.0]


@pytest.mark.parametrize("span", [0.0, 1e-9, 1 / 3600, 7.999999, 8.0, 23.99, 24.0])
def test_span_boundaries_equal_old(span):
    stamps = ["2024-03-04 00:00", "2024-03-04 07:59:59", "2024-03-04 16:00"]
    _same(stamps, span, "2024-03-04")


def test_non_runner_span_one_ns_rounding_is_documented():
    """Finding, not a regression in any runner interval.

    For spans whose ``hours * 3600`` float falls just below an integer (e.g. a
    ``31m`` token: 1859.9999999999998 s), the old keyword form truncated to
    1859999999999 ns while ``Timedelta(x, unit="s")`` rounds to the exact
    1860 s. Only a bar stamped on an odd nanosecond can observe it. The new
    value is the arithmetically correct one; the runner's valid intervals
    are all exact (see the parametrized tests above).
    """
    span = _interval_span_hours("31m")
    assert pd.Timedelta(span * 3600, unit="s").value == 1_860_000_000_000
    assert _old_td(seconds=span * 3600).value == 1_859_999_999_999
    ts = T("2024-03-04 07:29:00") + pd.Timedelta(1, "ns")
    new = _drive(calc_crypto_funding_fee, [ts], span, ts)[0]
    old = _drive(_old_calc, [ts], span, ts)[0]
    assert new == [pytest.approx(0.01)]  # [07:29:00.000000001, 08:00:00.000000001) holds 08:00
    assert old == [0.0]


# ── full CryptoEngine runs: final value and funding P&L pinned to main ──


class _Loader:
    def __init__(self, df):
        self.df = df

    def fetch(self, codes, start, end, fields=None, interval="1m"):
        return {c: self.df.copy() for c in codes}


class _Signals:
    def __init__(self, sig):
        self.sig = sig

    def generate(self, data_map):
        return {c: self.sig.reindex(data_map[c].index) for c in data_map}


def _frame(idx):
    n = len(idx)
    close = pd.Series([100.0 + 5.0 * ((i * 37) % 101) / 101.0 + 0.01 * i for i in range(n)], index=idx)
    return pd.DataFrame({"open": close.shift(1).fillna(100.0), "high": close + 0.5,
                         "low": close - 0.5, "close": close, "volume": 10.0}, index=idx)


def scenario_dense(tmp_path):
    idx = pd.date_range("2024-03-04", "2024-03-06", freq="1min", inclusive="left")
    w = pd.Series([1.0 if (i // 700) % 2 == 0 else -0.5 for i in range(len(idx))], index=idx)
    return _engine_run(tmp_path, _frame(idx), w, {"leverage": 2.0})


def scenario_sparse(tmp_path):
    full = pd.date_range("2024-03-04", "2024-03-06", freq="1min", inclusive="left", tz="UTC")
    holes = [("2024-03-04 07:50", "2024-03-04 08:10"), ("2024-03-04 14:00", "2024-03-05 01:00"),
             ("2024-03-05 15:59", "2024-03-05 16:01"), ("2024-03-05 23:30", "2024-03-06 00:00")]
    keep = pd.Series(True, index=full)
    for a, b in holes:
        keep &= ~((full >= T(a, tz="UTC")) & (full < T(b, tz="UTC")))
    idx = full[keep.values].tz_convert("Asia/Kolkata")
    w = pd.Series([0.8 if i < 600 else (-1.0 if i < 1500 else 0.6) for i in range(len(idx))], index=idx)
    return _engine_run(tmp_path, _frame(idx), w, {"funding_rate": 0.0003})


def _engine_run(tmp_path, df, weights, extra):
    cfg = {"initial_cash": 10_000.0, "interval": "1m", "codes": [SWAP],
           "position_adjustment": "rebalance", "rebalance_tolerance": 0.05, **extra}
    eng = CryptoEngine(cfg)
    run_dir = Path(tmp_path)
    run_dir.mkdir(parents=True, exist_ok=True)
    eng.run_backtest({"codes": [SWAP], "interval": "1m", "start_date": "2024-03-04",
                      "end_date": "2024-03-05"}, _Loader(df), _Signals(weights), run_dir, None)
    return eng.equity_snapshots[-1].equity, eng.funding_pnl


# Exact floats produced by origin/main (pre-TM-8) for the same scenarios.
MAIN_DENSE_FINAL, MAIN_DENSE_FUNDING = 7829.145627025806, -3.818451639239605
MAIN_SPARSE_FINAL, MAIN_SPARSE_FUNDING = 8657.985090562486, 5.012337020434484


def test_full_dense_1m_backtest_identical_to_main(tmp_path):
    final, funding = scenario_dense(tmp_path)
    assert final == MAIN_DENSE_FINAL
    assert funding == MAIN_DENSE_FUNDING
    assert funding != 0.0


def test_full_sparse_ist_backtest_identical_to_main(tmp_path):
    final, funding = scenario_sparse(tmp_path)
    assert final == MAIN_SPARSE_FINAL
    assert funding == MAIN_SPARSE_FUNDING
    assert funding != 0.0


def test_full_runs_raise_no_deprecation_from_vibe_bt(tmp_path):
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        scenario_dense(tmp_path / "d")
        scenario_sparse(tmp_path / "s")
    ours = [w for w in caught if issubclass(w.category, DeprecationWarning)
            and "vibe_bt" in Path(w.filename).as_posix()]
    assert not ours, [(w.filename, w.lineno, str(w.message)[:80]) for w in ours]
