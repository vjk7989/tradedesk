"""TM-1 edge cases: MIS buy-side stamp duty uses ``in_mis_stamp_duty`` (0.003%)."""

import math

import pytest

from vibe_bt.backtest.engines.composite import CompositeEngine
from vibe_bt.backtest.engines.india_equity import IndiaEquityEngine
from tests.test_intraday_edge import (
    EQ,
    FIXTURES,
    FNO,
    ZERO_EQ,
    ZERO_FNO,
    _svc_run,
    day_bars,
    flat_frame,
    run,
    svc,  # noqa: F401 - pytest fixture
)

ONLY_STAMP = {"in_brokerage": 0, "in_exchange_txn": 0, "in_sebi_fee": 0, "in_stt": 0,
              "in_mis_stt": 0, "in_dp_charge": 0}
N = 100 * 100.0  # notional for 100 @ 100


def eng(**kw):
    return IndiaEquityEngine({**ONLY_STAMP, **kw})


# ── product resolution paths ──


def test_mis_via_product_by_market_only():
    e = eng(interval="5m", product_by_market={"india_equity": "MIS"})
    assert e.mis
    assert e.calc_commission(100, 100.0, 1, True) == pytest.approx(N * 0.00003)
    assert e.calc_commission(100, 100.0, 1, False) == 0.0


def test_product_by_market_cnc_overrides_run_level_mis():
    e = eng(interval="5m", product="MIS", product_by_market={"india_equity": "CNC"})
    assert e.calc_commission(100, 100.0, 1, True) == pytest.approx(N * 0.00015)


@pytest.mark.parametrize("cfg", [{"product": "mis"}, {"product": " Mis "},
                                 {"product_by_market": {"india_equity": "mis"}}])
def test_lowercase_mis(cfg):
    e = eng(interval="5m", **cfg)
    assert e.calc_commission(100, 100.0, 1, True) == pytest.approx(N * 0.00003)


@pytest.mark.parametrize("cfg", [{"product": "MIS"}, {"product_by_market": {"india_equity": "MIS"}}])
def test_mis_at_daily_uses_delivery_stamp(cfg):
    e = eng(interval="1D", in_mis_stamp_duty=0.5, **cfg)  # MIS rate must be ignored at 1D
    assert not e.mis
    assert e.calc_commission(100, 100.0, 1, True) == pytest.approx(N * 0.00015)


def test_default_interval_is_daily():
    e = eng(product="MIS")  # no interval key -> 1D
    assert e.calc_commission(100, 100.0, 1, True) == pytest.approx(N * 0.00015)


def test_cnc_intraday_ignores_mis_rate():
    e = eng(interval="5m", product="CNC", in_mis_stamp_duty=0.5)
    assert e.calc_commission(100, 100.0, 1, True) == pytest.approx(N * 0.00015)


def test_mis_short_open_no_stamp_cover_mis_stamp():
    e = eng(interval="5m", product="MIS")
    assert e.calc_commission(100, 100.0, -1, True) == 0.0                         # short sell
    assert e.calc_commission(100, 100.0, -1, False) == pytest.approx(N * 0.00003)  # cover = buy


def test_mis_stamp_independent_of_in_stamp_duty():
    e = eng(interval="5m", product="MIS", in_stamp_duty=0.5)
    assert e.calc_commission(100, 100.0, 1, True) == pytest.approx(N * 0.00003)


# ── composite: MIS equity + NRML future ──


def test_composite_intraday_stamp_on_equity_leg_only(tmp_path):
    idx = day_bars("2024-03-04", "09:15", "15:30") + day_bars("2024-03-05", "09:15", "15:30")
    frames = {EQ: flat_frame(idx), FNO: flat_frame(idx)}
    eng_ = run(CompositeEngine, frames, lambda ts, i: 0.5, tmp_path,
               product_by_market={"india_equity": "MIS", "india_fno": "NRML"},
               **{**ZERO_EQ, **ZERO_FNO, "in_stamp_duty": 0.00015, "in_fno_stamp_duty": 0.00002})
    eq = [t for t in eng_.trades if t.symbol == EQ]
    fno = [t for t in eng_.trades if t.symbol == FNO]
    assert eq and fno
    assert all(t.exit_reason == "mis_squareoff" for t in eq)
    for t in eq:   # MIS equity: 0.003% on the buy leg, nothing on the sell
        assert t.commission == pytest.approx(t.size * 100.0 * 0.00003), t
    assert [t.exit_reason for t in fno] == ["end_of_backtest"]
    for t in fno:  # NRML future keeps its own F&O stamp (lot size 1)
        assert t.commission == pytest.approx(t.size * 100.0 * 0.00002), t


def test_composite_rule_engine_sees_mis_stamp():
    c = CompositeEngine({"interval": "5m", "product_by_market": {"india_equity": "MIS"},
                         "in_mis_stamp_duty": 0.0002, **ONLY_STAMP}, [EQ, FNO])
    sub = c._rule_engines["india_equity"]
    assert sub.mis and sub.in_mis_stamp_duty == 0.0002
    assert sub.calc_commission(100, 100.0, 1, True) == pytest.approx(N * 0.0002)


# ── validation ──


@pytest.mark.parametrize("bad", [True, False, "0.00003", None, -1, -1e-12,
                                 float("nan"), float("inf"), float("-inf")])
def test_engine_rejects_bad_mis_stamp(bad):
    with pytest.raises(ValueError, match="in_mis_stamp_duty"):
        IndiaEquityEngine({"interval": "5m", "product": "MIS", "in_mis_stamp_duty": bad})


def test_bad_mis_stamp_rejected_even_for_cnc():
    with pytest.raises(ValueError, match="in_mis_stamp_duty"):
        IndiaEquityEngine({"interval": "1D", "product": "CNC", "in_mis_stamp_duty": -1})


@pytest.mark.parametrize("ok", [0, 0.0, 1e-12, 1])
def test_engine_accepts_zero_and_positive(ok):
    e = eng(interval="5m", product="MIS", in_mis_stamp_duty=ok)
    assert e.calc_commission(100, 100.0, 1, True) == pytest.approx(N * ok)


def test_zero_mis_stamp_buy_is_free_when_other_costs_zero():
    assert eng(interval="5m", product="MIS", in_mis_stamp_duty=0).calc_commission(
        100, 100.0, 1, True) == 0.0


@pytest.mark.parametrize("bad", [True, "0.00003", -1, float("nan"), float("inf")])
def test_service_bad_mis_stamp_not_ok(svc, bad):  # noqa: F811
    svc(FIXTURES / "reliance_5m.csv")
    r = _svc_run([EQ], {**ZERO_EQ, "product": "MIS", "in_mis_stamp_duty": bad})
    assert r["ok"] is False
    assert "in_mis_stamp_duty" in (r.get("error") or "")


def test_service_override_via_costs_changes_equity(svc):  # noqa: F811
    svc(FIXTURES / "reliance_5m.csv")
    zero = _svc_run([EQ], {**ZERO_EQ, "product": "MIS", "in_mis_stamp_duty": 0}, weight=1.0)
    high = _svc_run([EQ], {**ZERO_EQ, "product": "MIS", "in_mis_stamp_duty": 0.001}, weight=1.0)
    assert zero["ok"], zero.get("error")
    assert high["ok"], high.get("error")
    assert high["equity"][-1]["value"] < zero["equity"][-1]["value"]


# ── hand-computed MIS round trip ──


def test_mis_round_trip_hand_computed_with_brokerage():
    e = IndiaEquityEngine({"interval": "5m", "product": "MIS", "in_brokerage": 0.0003})
    # Buy 50 @ 1000 -> notional 50_000
    #   brokerage 15.0; exch 1.485; sebi 0.05
    #   GST 0.18 * (15.0 + 1.485 + 0.05) = 2.9763   (stamp/STT not in GST base)
    #   STT 0 (MIS buy); stamp 50_000 * 0.00003 = 1.5
    buy = 15.0 + 1.485 + 0.05 + 2.9763 + 1.5                      # 21.0113
    # Sell 50 @ 1010 -> notional 50_500
    #   brokerage 15.15; exch 1.49985; sebi 0.0505
    #   GST 0.18 * (15.15 + 1.49985 + 0.0505) = 3.006063
    #   STT 50_500 * 0.00025 = 12.625; stamp 0; DP 0
    sell = 15.15 + 1.49985 + 0.0505 + 3.006063 + 12.625           # 32.331413
    b = e.calc_commission(50, 1000.0, 1, True)
    s = e.calc_commission(50, 1010.0, 1, False)
    assert buy == pytest.approx(21.0113) and sell == pytest.approx(32.331413)
    assert b == pytest.approx(buy)
    assert s == pytest.approx(sell)
    assert b + s == pytest.approx(53.342713)


def test_gst_base_excludes_stamp_and_stt():
    base = {"interval": "5m", "product": "MIS", "in_brokerage": 0.0003}
    lo = IndiaEquityEngine({**base, "in_mis_stamp_duty": 0.0, "in_mis_stt": 0.0})
    hi = IndiaEquityEngine({**base, "in_mis_stamp_duty": 0.001, "in_mis_stt": 0.002})
    # raising stamp/STT shifts cost by exactly notional * rate (no 18% GST markup)
    assert hi.calc_commission(50, 1000.0, 1, True) - lo.calc_commission(50, 1000.0, 1, True) \
        == pytest.approx(50_000 * 0.001)
    assert hi.calc_commission(50, 1000.0, 1, False) - lo.calc_commission(50, 1000.0, 1, False) \
        == pytest.approx(50_000 * 0.002)
    assert math.isfinite(hi.calc_commission(50, 1000.0, 1, True))
