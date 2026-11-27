from pathlib import Path

import pandas as pd
import pytest

from vibe_bt.backtest.engines._market_hooks import calc_crypto_funding_fee, _interval_span_hours
from vibe_bt.backtest.engines.india_equity import IndiaEquityEngine
from vibe_bt.backtest.engines.india_fno import IndiaFnoEngine
from vibe_bt.backtest.metrics import calc_bars_per_year
from vibe_bt.backtest.models import Position

FIXTURES = Path(__file__).parent / "fixtures"
EQ, FNO = "RELIANCE.NS", "NIFTY25DECFUT@NFO"
ZERO_EQ = {"in_brokerage": 0, "in_stt": 0, "in_mis_stt": 0, "in_exchange_txn": 0,
           "in_sebi_fee": 0, "in_stamp_duty": 0, "slippage": 0, "price_limit": None}
ZERO_FNO = {"in_fno_brokerage": 0, "in_fno_stt": 0, "in_fno_exchange_txn": 0,
            "in_fno_sebi_fee": 0, "in_fno_stamp_duty": 0, "slippage": 0, "lot_sizes": {"NIFTY": 1}}


def frame() -> pd.DataFrame:
    return pd.read_csv(FIXTURES / "reliance_5m.csv", index_col="timestamp", parse_dates=True)


class Loader:
    def __init__(self, code):
        self.code = code

    def fetch(self, codes, *a, **k):
        return {self.code: frame()}


class Signal:
    """weight(ts, i) per bar; i = bar position within its day."""

    def __init__(self, fn):
        self.fn = fn

    def generate(self, data_map):
        out = {}
        for c, df in data_map.items():
            day_pos = df.groupby(df.index.date).cumcount()
            out[c] = pd.Series([self.fn(ts, i) for ts, i in zip(df.index, day_pos)], index=df.index, dtype=float)
        return out


def run(engine_cls, code, fn, tmp_path, **cfg):
    eng = engine_cls({"codes": [code], "interval": "5m", "initial_cash": 10_000_000, **cfg})
    eng.run_backtest(eng.config, Loader(code), Signal(fn), tmp_path, bars_per_year=None)
    return eng


def hold_day1(ts, i):  # long on day 1 only, flat afterwards
    return 1.0 if ts.date() == pd.Timestamp("2024-03-04").date() else 0.0


def test_session_filter_blocks_out_of_session_bars():
    eng = IndiaEquityEngine({"interval": "5m", "price_limit": None})
    bar = lambda s: pd.Series({"close": 100.0}, name=pd.Timestamp(s))  # noqa: E731
    assert not eng.can_execute(EQ, 1, bar("2024-03-04 09:10"))
    assert eng.can_execute(EQ, 1, bar("2024-03-04 09:15"))
    assert eng.can_execute(EQ, 1, bar("2024-03-04 15:30"))
    assert not eng.can_execute(EQ, 1, bar("2024-03-04 15:40"))
    # daily mode ignores the clock
    assert IndiaEquityEngine({"price_limit": None}).can_execute(EQ, 1, bar("2024-03-04 00:00"))
    fno = IndiaFnoEngine({"interval": "15m"})
    assert not fno.can_execute(FNO, 1, bar("2024-03-04 16:00"))
    assert fno.can_execute("CRUDEOIL25DECFUT@MCX", 1, bar("2024-03-04 22:00"))
    assert not fno.can_execute("CRUDEOIL25DECFUT@MCX", 1, bar("2024-03-04 23:45"))
    assert not fno.can_execute(FNO, 1, bar("2024-03-04 22:00"))


def test_no_fill_on_out_of_session_bar(tmp_path):
    # Signal long from the very first bar (09:00, out of session): entry must be 09:15.
    eng = run(IndiaEquityEngine, EQ, lambda ts, i: 1.0, tmp_path, **ZERO_EQ)
    assert eng.trades[0].entry_time == pd.Timestamp("2024-03-04 09:15")
    assert all(pd.Timestamp("09:15").time() <= t.entry_time.time() <= pd.Timestamp("15:30").time()
               for t in eng.trades)


def test_mis_squares_off_at_1520(tmp_path):
    eng = run(IndiaEquityEngine, EQ, lambda ts, i: 1.0, tmp_path, product="MIS", **ZERO_EQ)
    sq = [t for t in eng.trades if t.exit_reason == "mis_squareoff"]
    assert len(sq) == 3
    assert {t.exit_time for t in sq} == {pd.Timestamp(f"2024-03-0{d} 15:20") for d in (4, 5, 6)}
    assert all(t.entry_time.date() == t.exit_time.date() for t in sq)
    # nothing is carried overnight, nothing is entered after 15:20
    assert all(t.entry_time.time() < pd.Timestamp("15:20").time() for t in eng.trades)


def test_cnc_intraday_blocks_same_day_sell(tmp_path):
    cnc = run(IndiaEquityEngine, EQ, lambda ts, i: 1.0 if i < 30 and ts.date().day == 4 else 0.0,
              tmp_path, **ZERO_EQ)
    assert len(cnc.trades) == 1
    assert cnc.trades[0].exit_time.date() > cnc.trades[0].entry_time.date()
    assert cnc.trades[0].exit_reason != "mis_squareoff"
    mis = run(IndiaEquityEngine, EQ, lambda ts, i: 1.0 if 3 <= i < 30 and ts.date().day == 4 else 0.0,
              tmp_path, product="MIS", **ZERO_EQ)
    assert mis.trades[0].exit_time.date() == mis.trades[0].entry_time.date()
    assert mis.trades[0].exit_reason != "mis_squareoff"


def test_mis_short_allowed_cnc_short_blocked(tmp_path):
    mis = run(IndiaEquityEngine, EQ, lambda ts, i: -1.0, tmp_path, product="MIS", **ZERO_EQ)
    assert mis.trades and all(t.direction == -1 for t in mis.trades)
    cnc = run(IndiaEquityEngine, EQ, lambda ts, i: -1.0, tmp_path, **ZERO_EQ)
    assert cnc.trades == []


def test_mis_stt_sell_side_only():
    e = IndiaEquityEngine({"interval": "5m", "product": "MIS", "in_exchange_txn": 0,
                           "in_sebi_fee": 0, "in_stamp_duty": 0, "in_mis_stamp_duty": 0})
    assert e.calc_commission(100, 100.0, 1, True) == 0.0                   # buy: no STT
    assert e.calc_commission(100, 100.0, 1, False) == pytest.approx(10000 * 0.00025)
    assert e.calc_commission(100, 100.0, -1, True) == pytest.approx(10000 * 0.00025)  # short sell
    assert IndiaEquityEngine({"interval": "5m", "in_mis_stt": 0.0005, "product": "MIS",
                              "in_exchange_txn": 0, "in_sebi_fee": 0, "in_stamp_duty": 0,
                              "in_mis_stamp_duty": 0}
                             ).calc_commission(100, 100.0, 1, False) == pytest.approx(5.0)
    # CNC / daily keep the bilateral delivery STT
    d = IndiaEquityEngine({"in_exchange_txn": 0, "in_sebi_fee": 0, "in_stamp_duty": 0})
    assert d.calc_commission(100, 100.0, 1, True) == pytest.approx(10.0)


def test_fno_nrml_holds_overnight_mis_squares_off(tmp_path):
    nrml = run(IndiaFnoEngine, FNO, lambda ts, i: 1.0, tmp_path, **ZERO_FNO)
    assert [t.exit_reason for t in nrml.trades] == ["end_of_backtest"]
    assert nrml.trades[0].exit_time.date() > nrml.trades[0].entry_time.date()
    mis = run(IndiaFnoEngine, FNO, lambda ts, i: 1.0, tmp_path, product="MIS", **ZERO_FNO)
    sq = [t for t in mis.trades if t.exit_reason == "mis_squareoff"]
    assert len(sq) == 3
    assert all(t.exit_time.time() == pd.Timestamp("15:20").time() for t in sq)


@pytest.mark.parametrize("interval", ["5m", "15m", "30m", "1H"])
def test_crypto_funding_three_settlements_per_day(interval):
    span = _interval_span_hours(interval)
    pos = {"BTC-USDT-SWAP": Position("BTC-USDT-SWAP", 1, 100.0, pd.Timestamp("2024-03-04"), 1.0)}
    applied, daily = set(), set()
    bar = pd.Series({"close": 100.0})
    total = 0.0
    for ts in pd.date_range("2024-03-04", "2024-03-05", freq=f"{int(span * 60)}min", inclusive="left"):
        total += calc_crypto_funding_fee("BTC-USDT-SWAP", bar, ts, pos, 0.0001, applied, daily, span)
    assert total == pytest.approx(3 * 100.0 * 0.0001)  # 3 settlements, independent of bar size


def test_bars_per_year_india_and_crypto():
    for interval, per_day in (("1m", 375), ("5m", 75), ("15m", 25), ("30m", 13), ("1H", 7)):
        assert calc_bars_per_year(interval, "india_broker") == 252 * per_day
    assert calc_bars_per_year("1D", "india_broker") == 252
    assert calc_bars_per_year("1H", "ccxt") == 365 * 24
