"""P9.2 edge tests: funding cursor survives scale-in / partial reduce (real CryptoEngine runs).

Every case drives ``CryptoEngine.run_backtest`` end to end on an in-memory bar
fixture with a flat 100.0 price, zero fees and zero slippage, so the only cash
flow is funding. ``rebalance_tolerance`` keeps funding drift from triggering
extra resizes; only the signal steps move the position. A thin subclass records
the funding charged on each bar (it calls the real ``on_bar``).
"""
from pathlib import Path

import pandas as pd
import pytest

from vibe_bt.backtest.engines import base as base_mod
from vibe_bt.backtest.engines.crypto import CryptoEngine

SWAP = "BTC-USDT-SWAP"
PX = 100.0
CASH = 10_000.0
RATE = 0.001
DEFAULT_RATE = 0.0001  # CryptoEngine default for perpetual codes


class _Recorder(CryptoEngine):
    def __init__(self, config):
        super().__init__(config)
        self.log = []

    def on_bar(self, symbol, bar, timestamp):
        before = self.funding_pnl
        super().on_bar(symbol, bar, timestamp)
        pos = self.positions.get(symbol)
        self.log.append({
            "ts": timestamp,
            "fee": before - self.funding_pnl,  # positive = paid
            "size": pos.size if pos else 0.0,
            "direction": pos.direction if pos else 0,
            "entry_time": pos.entry_time if pos else None,
            "cursor": getattr(pos, "_funding_last_ts", None) if pos else None,
        })


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


def _run(tmp_path, stamps, weights, symbol=SWAP, rate=RATE, tz=None):
    """Signal at bar k fills at bar k+1 open (next-bar semantics)."""
    idx = pd.DatetimeIndex(pd.to_datetime(stamps))
    if tz is not None:
        idx = idx.tz_localize(tz)
    df = pd.DataFrame(
        {"open": PX, "high": PX, "low": PX, "close": PX, "volume": 1.0}, index=idx
    )
    sig = pd.Series(weights, index=idx, dtype=float)
    cfg = {
        "initial_cash": CASH, "interval": "1m", "codes": [symbol],
        "position_adjustment": "rebalance", "rebalance_tolerance": 0.05,
        "maker_rate": 0, "taker_rate": 0, "slippage": 0,
    }
    if rate is not None:
        cfg["funding_rate"] = rate
    eng = _Recorder(cfg)
    run_dir = tmp_path / f"run{len(list(tmp_path.iterdir()))}"
    run_dir.mkdir()
    eng.run_backtest(
        {"codes": [symbol], "interval": "1m", "start_date": "2024-03-04", "end_date": "2024-03-05"},
        _Loader(df), _Signals(sig), Path(run_dir), None,
    )
    return eng


def _row(eng, ts):
    want = pd.Timestamp(ts)
    return next(r for r in eng.log if r["ts"] == want or r["ts"].tz_localize(None) == want)


def _paid(eng):
    return -eng.funding_pnl


def _slot(size, rate=RATE):
    return size * PX * rate


@pytest.fixture
def no_carry(monkeypatch):
    """Main's behaviour: rebuilt positions drop the cursor."""
    monkeypatch.setattr(base_mod, "_carry_funding_ts", lambda old, new: None)


# ---- AC: scale-in on the first bar after a gap across 08:00 -> exactly one settlement ----

SCALE_IN = (["2024-03-04 07:50", "2024-03-04 07:55", "2024-03-04 08:05", "2024-03-04 08:06"],
            [0.4, 0.8, 0.8, 0.8])


def test_scale_in_after_gap_charges_0800_once_on_scaled_size(tmp_path):
    eng = _run(tmp_path, *SCALE_IN)
    r = _row(eng, "2024-03-04 08:05")
    assert r["size"] == pytest.approx(80.0)
    assert r["fee"] == pytest.approx(_slot(80.0))
    assert _paid(eng) == pytest.approx(_slot(80.0))
    assert sum(1 for x in eng.log if x["fee"] != 0) == 1


def test_scale_in_entry_time_unchanged(tmp_path):
    eng = _run(tmp_path, *SCALE_IN)
    assert _row(eng, "2024-03-04 07:55")["entry_time"] == pd.Timestamp("2024-03-04 07:55")
    assert _row(eng, "2024-03-04 08:05")["entry_time"] == pd.Timestamp("2024-03-04 07:55")
    assert eng.trades[0].entry_time == pd.Timestamp("2024-03-04 07:55")


def test_scale_in_without_carry_misses_slot(tmp_path, no_carry):
    # Proves the scenario discriminates: main dropped the 08:00 settlement.
    eng = _run(tmp_path, *SCALE_IN)
    assert _paid(eng) == pytest.approx(0.0)


def test_scale_in_sparse_matches_dense_fill_on_settlement_bar(tmp_path):
    # Sparse charges the slot at the size held after the covering bar's fill;
    # the dense equivalent is a scale-in that fills on the 08:00 bar itself.
    sparse = _run(tmp_path, *SCALE_IN)
    stamps = pd.date_range("2024-03-04 07:50", "2024-03-04 08:06", freq="1min")
    w = [0.4 if t < pd.Timestamp("2024-03-04 07:59") else 0.8 for t in stamps]
    dense = _run(tmp_path, stamps, w)
    assert _row(dense, "2024-03-04 08:00")["size"] == pytest.approx(80.0)
    assert _paid(sparse) == pytest.approx(_paid(dense))


# ---- AC: partial reduce on that bar ----

REDUCE = (["2024-03-04 07:50", "2024-03-04 07:55", "2024-03-04 08:05", "2024-03-04 08:06"],
          [0.8, 0.4, 0.4, 0.4])


def test_reduce_after_gap_charges_once_on_reduced_size(tmp_path):
    eng = _run(tmp_path, *REDUCE)
    r = _row(eng, "2024-03-04 08:05")
    assert r["size"] == pytest.approx(40.0)
    assert r["entry_time"] == pd.Timestamp("2024-03-04 07:55")
    assert _paid(eng) == pytest.approx(_slot(40.0))
    assert sum(1 for x in eng.log if x["fee"] != 0) == 1


def test_reduce_sparse_matches_dense_fill_on_settlement_bar(tmp_path):
    sparse = _run(tmp_path, *REDUCE)
    stamps = pd.date_range("2024-03-04 07:50", "2024-03-04 08:06", freq="1min")
    w = [0.8 if t < pd.Timestamp("2024-03-04 07:59") else 0.4 for t in stamps]
    dense = _run(tmp_path, stamps, w)
    assert _paid(sparse) == pytest.approx(_paid(dense)) == pytest.approx(_slot(40.0))


def test_reduce_without_carry_misses_slot(tmp_path, no_carry):
    assert _paid(_run(tmp_path, *REDUCE)) == pytest.approx(0.0)


# ---- multiple scale-ins inside one gap / gap over two slots ----

def test_multiple_scale_ins_then_gap_charges_once(tmp_path):
    stamps = ["2024-03-04 07:30", "2024-03-04 07:40", "2024-03-04 07:50",
              "2024-03-04 08:10", "2024-03-04 08:20"]
    eng = _run(tmp_path, stamps, [0.2, 0.4, 0.6, 0.8, 0.8])
    assert [r["size"] for r in eng.log] == pytest.approx([0.0, 20.0, 40.0, 60.0, 80.0], rel=1e-2)
    assert {r["entry_time"] for r in eng.log if r["size"]} == {pd.Timestamp("2024-03-04 07:40")}
    assert _row(eng, "2024-03-04 08:10")["fee"] == pytest.approx(_slot(60.0))
    assert _paid(eng) == pytest.approx(_slot(60.0))


def test_scale_in_after_gap_over_two_slots_charges_each_once(tmp_path):
    stamps = ["2024-03-04 07:50", "2024-03-04 07:55", "2024-03-04 16:05", "2024-03-04 16:06"]
    eng = _run(tmp_path, stamps, [0.4, 0.8, 0.8, 0.8])
    assert _paid(eng) == pytest.approx(2 * _slot(80.0))


# ---- scale-in then full exit within the gap ----

def test_scale_in_then_full_exit_inside_gap_no_double_count(tmp_path):
    # Opened 07:50, scaled in 07:55, closed on the 08:05 open. on_bar runs after
    # the fill, so the closed position is gone: the 08:00 slot is not charged.
    stamps = ["2024-03-04 07:45", "2024-03-04 07:50", "2024-03-04 07:55",
              "2024-03-04 08:05", "2024-03-04 08:06"]
    eng = _run(tmp_path, stamps, [0.4, 0.8, 0.0, 0.0, 0.0])
    assert _row(eng, "2024-03-04 07:55")["size"] == pytest.approx(80.0)
    assert _row(eng, "2024-03-04 08:05")["size"] == 0.0
    assert _paid(eng) <= _slot(80.0) + 1e-9
    assert _paid(eng) == pytest.approx(0.0)


# ---- short mirror ----

def test_short_scale_in_after_gap_receives_once(tmp_path):
    stamps, w = SCALE_IN
    eng = _run(tmp_path, stamps, [-x for x in w])
    r = _row(eng, "2024-03-04 08:05")
    assert r["direction"] == -1 and r["size"] == pytest.approx(80.0)
    assert r["entry_time"] == pd.Timestamp("2024-03-04 07:55")
    assert eng.funding_pnl == pytest.approx(_slot(80.0))


def test_short_reduce_after_gap_receives_once(tmp_path):
    stamps, w = REDUCE
    eng = _run(tmp_path, stamps, [-x for x in w])
    assert eng.funding_pnl == pytest.approx(_slot(40.0))


# ---- fresh Position: full exit + re-entry ----

def test_reentry_after_flat_gap_no_back_charge(tmp_path):
    stamps = ["2024-03-04 07:40", "2024-03-04 07:45", "2024-03-04 07:50",
              "2024-03-04 08:10", "2024-03-04 08:20"]
    eng = _run(tmp_path, stamps, [0.5, 0.0, 0.5, 0.5, 0.5])
    assert _row(eng, "2024-03-04 07:50")["size"] == 0.0
    r = _row(eng, "2024-03-04 08:10")
    assert r["size"] == pytest.approx(50.0)
    assert r["entry_time"] == pd.Timestamp("2024-03-04 08:10")
    assert r["cursor"] == pd.Timestamp("2024-03-04 08:10")
    assert _paid(eng) == pytest.approx(0.0)


def test_flip_inside_gap_fresh_short_has_no_back_charge(tmp_path):
    # Long held into the gap, flipped to short on the 08:10 open: the new short
    # is a fresh Position and must not be charged/credited for 08:00.
    stamps = ["2024-03-04 07:50", "2024-03-04 07:55", "2024-03-04 08:10", "2024-03-04 08:20"]
    eng = _run(tmp_path, stamps, [0.5, -0.5, -0.5, -0.5])
    r = _row(eng, "2024-03-04 08:10")
    assert r["direction"] == -1
    assert r["entry_time"] == pd.Timestamp("2024-03-04 08:10")
    assert eng.funding_pnl == pytest.approx(0.0)


def test_reentry_before_slot_then_gap_charges_once(tmp_path):
    # Exit fills 07:50, fresh entry fills 07:55, then the gap crosses 08:00.
    stamps = ["2024-03-04 07:40", "2024-03-04 07:45", "2024-03-04 07:50",
              "2024-03-04 07:55", "2024-03-04 08:05"]
    eng = _run(tmp_path, stamps, [0.5, 0.0, 0.5, 0.5, 0.5])
    assert _row(eng, "2024-03-04 07:50")["size"] == 0.0
    assert _row(eng, "2024-03-04 08:05")["entry_time"] == pd.Timestamp("2024-03-04 07:55")
    assert _paid(eng) == pytest.approx(_slot(50.0))


# ---- boundaries around the 08:00 slot ----

def test_gap_ending_just_before_slot_charges_nothing(tmp_path):
    stamps = ["2024-03-04 07:50", "2024-03-04 07:55", "2024-03-04 07:59"]
    assert _paid(_run(tmp_path, stamps, [0.4, 0.8, 0.8])) == pytest.approx(0.0)


def test_scale_in_exactly_on_slot_bar_charges_once(tmp_path):
    stamps = ["2024-03-04 07:50", "2024-03-04 07:55", "2024-03-04 08:00", "2024-03-04 08:01"]
    eng = _run(tmp_path, stamps, [0.4, 0.8, 0.8, 0.8])
    assert _row(eng, "2024-03-04 08:00")["fee"] == pytest.approx(_slot(80.0))
    assert _paid(eng) == pytest.approx(_slot(80.0))


def test_tz_aware_utc_index_scale_in_charges_once(tmp_path):
    stamps, w = SCALE_IN
    eng = _run(tmp_path, stamps, w, tz="UTC")
    assert _paid(eng) == pytest.approx(_slot(80.0))


def test_non_utc_index_scale_in_charges_utc_slot_once(tmp_path):
    # 08:00 UTC is 13:30 Asia/Kolkata.
    stamps = ["2024-03-04 13:20", "2024-03-04 13:25", "2024-03-04 13:35", "2024-03-04 13:36"]
    eng = _run(tmp_path, stamps, [0.4, 0.8, 0.8, 0.8], tz="Asia/Kolkata")
    assert _paid(eng) == pytest.approx(_slot(80.0))


# ---- dense 1m regression: unchanged vs main ----

def _dense_scenario():
    stamps = pd.date_range("2024-03-04 07:00", "2024-03-04 16:30", freq="1min")
    w = []
    for t in stamps:
        if t < pd.Timestamp("2024-03-04 07:30"):
            w.append(0.3)
        elif t < pd.Timestamp("2024-03-04 12:00"):
            w.append(0.6)  # scale-in well before 08:00, held through it
        else:
            w.append(0.2)  # reduce well before 16:00
    return stamps, w


def test_dense_1m_total_funding_unchanged_vs_main(tmp_path, monkeypatch):
    stamps, w = _dense_scenario()
    fixed = _run(tmp_path, stamps, w)
    monkeypatch.setattr(base_mod, "_carry_funding_ts", lambda old, new: None)
    main = _run(tmp_path, stamps, w)
    assert _paid(fixed) == pytest.approx(_paid(main))
    s08 = _row(fixed, "2024-03-04 08:00")["size"]
    s16 = _row(fixed, "2024-03-04 16:00")["size"]
    assert s08 == pytest.approx(60.0, rel=1e-3) and s16 == pytest.approx(20.0, rel=1e-2)
    assert _paid(fixed) == pytest.approx(_slot(s08) + _slot(s16))
    assert sum(1 for r in fixed.log if r["fee"] != 0) == 2


# ---- symbol path: -SWAP / -PERP default rate, spot control ----

@pytest.mark.parametrize("symbol", ["BTC-USDT-SWAP", "ETH-USDT-PERP"])
def test_perp_symbol_default_rate_scale_in_once(tmp_path, symbol):
    eng = _run(tmp_path, *SCALE_IN, symbol=symbol, rate=None)
    assert eng.funding_enabled(symbol)
    assert _paid(eng) == pytest.approx(_slot(80.0, DEFAULT_RATE))


def test_spot_symbol_without_rate_has_no_funding(tmp_path):
    eng = _run(tmp_path, *SCALE_IN, symbol="BTC-USDT", rate=None)
    assert _paid(eng) == 0.0
