"""TM-6 owner-side edges: ``in_mis_stamp_duty`` accepts any finite ``numbers.Real`` >= 0."""

import decimal
import fractions
import json
import math

import numpy as np
import pytest

from vibe_bt.backtest.engines.india_equity import IndiaEquityEngine
from tests.test_intraday_edge import (
    EQ,
    FIXTURES,
    ZERO_EQ,
    _svc_run,
    svc,  # noqa: F401 - pytest fixture
)

ONLY_STAMP = {"in_brokerage": 0, "in_exchange_txn": 0, "in_sebi_fee": 0, "in_stt": 0,
              "in_mis_stt": 0, "in_dp_charge": 0}
N = 100 * 100.0  # notional for 100 @ 100


def _mk(v, **kw):
    return IndiaEquityEngine({"in_mis_stamp_duty": v, **kw})


def _mis(v):
    return IndiaEquityEngine({**ONLY_STAMP, "interval": "5m", "product": "MIS", "in_mis_stamp_duty": v})


# ── accepted: numpy floats / ints, Fraction, zero, tiny ──

ACCEPTED = [
    np.float16(0.5), np.float32(0.00003), np.float64(0.00003),
    np.int8(0), np.int16(1), np.int32(0), np.int64(0), np.int64(1), np.uint8(0), np.uint8(255),
    fractions.Fraction(3, 100000),  # numbers.Rational -> numbers.Real: accepted
    0, 0.0, 1e-12, 5e-324,  # plain int 0, tiny float, smallest subnormal (lower boundary, > 0 side)
]


@pytest.mark.parametrize("v", ACCEPTED, ids=lambda v: f"{type(v).__name__}({v})")
def test_accepts_real(v):
    e = _mk(v)
    assert e.in_mis_stamp_duty == v


@pytest.mark.parametrize("v", ACCEPTED, ids=lambda v: f"{type(v).__name__}({v})")
def test_accepted_value_prices_mis_buy(v):
    got = _mis(v).calc_commission(100, 100.0, 1, True)
    assert math.isfinite(float(got))
    assert float(got) == pytest.approx(N * float(v), rel=1e-3, abs=1e-12)
    assert _mis(v).calc_commission(100, 100.0, 1, False) == 0.0  # sell side carries no MIS stamp


def test_fraction_is_accepted_documented():
    # Fraction registers as numbers.Real, so TM-6 accepts it; it must also price like the float.
    e = _mis(fractions.Fraction(3, 100000))
    assert e.calc_commission(100, 100.0, 1, True) == pytest.approx(N * 0.00003)


@pytest.mark.parametrize("v", [-0.0, np.float64(-0.0), np.float32(-0.0)])
def test_negative_zero_is_not_negative(v):
    # -0.0 < 0 is False: accepted as zero, no crash, buy is free
    e = _mis(v)
    assert e.calc_commission(100, 100.0, 1, True) == 0.0


# ── rejected ──

REJECTED = [
    True, False, np.bool_(True), np.bool_(False),
    "0.00003", "", None, decimal.Decimal("0.00003"), decimal.Decimal("0"),
    complex(0.00003, 0), complex(0, 0),
    float("nan"), np.nan, np.float32("nan"),
    float("inf"), float("-inf"), np.inf, -np.inf, np.float16("inf"),
    -1, -1e-12, -5e-324, np.float64(-0.1), np.int8(-1), np.int64(-1),
    fractions.Fraction(-1, 100000),
    [0.1], {"v": 0.1},
]


@pytest.mark.parametrize("v", REJECTED, ids=lambda v: f"{type(v).__name__}({v!r})")
def test_rejects(v):
    with pytest.raises(ValueError, match="in_mis_stamp_duty"):
        _mk(v)


@pytest.mark.parametrize("v", [10 ** 400, -(10 ** 400), fractions.Fraction(10 ** 400, 3)],
                         ids=["int_1e400", "neg_int_1e400", "fraction_1e400"])
def test_huge_real_does_not_crash_with_non_valueerror(v):
    # math.isfinite() on an int/Fraction beyond float range raises OverflowError.
    # Either outcome is OK (accept or ValueError naming the key) but never another exception type.
    try:
        _mk(v)
    except ValueError as exc:
        assert "in_mis_stamp_duty" in str(exc)


def test_rejection_names_key_and_value():
    with pytest.raises(ValueError) as ei:
        _mk(-1)
    assert "in_mis_stamp_duty" in str(ei.value)
    assert "-1" in str(ei.value)


@pytest.mark.parametrize("big", ["x" * 100_000, list(range(50_000))], ids=["str", "list"])
def test_rejection_message_does_not_echo_huge_input(big):
    with pytest.raises(ValueError) as ei:
        _mk(big)
    msg = str(ei.value)
    assert "in_mis_stamp_duty" in msg
    assert len(msg) < 1000, f"error message is {len(msg)} chars"


def test_default_still_applies_when_key_absent():
    assert IndiaEquityEngine({}).in_mis_stamp_duty == pytest.approx(0.00003)


def test_validation_runs_at_daily_and_cnc_too():
    with pytest.raises(ValueError, match="in_mis_stamp_duty"):
        _mk(np.bool_(True), interval="1D", product="CNC")


# ── service path: config goes through json.dumps -> child ──


@pytest.mark.parametrize("v", [0.00003, 1e-12, 0.0, 0.001])
def test_service_float_survives_json_round_trip(svc, v):  # noqa: F811
    v2 = json.loads(json.dumps(v))
    assert v2 == v and type(v2) is float
    svc(FIXTURES / "reliance_5m.csv")
    r = _svc_run([EQ], {**ZERO_EQ, "product": "MIS", "in_mis_stamp_duty": v2})
    assert r["ok"] is True, r.get("error")


def test_service_np_float64_matches_plain_float(svc):  # noqa: F811
    svc(FIXTURES / "reliance_5m.csv")
    a = _svc_run([EQ], {**ZERO_EQ, "product": "MIS", "in_mis_stamp_duty": np.float64(0.001)}, weight=1.0)
    b = _svc_run([EQ], {**ZERO_EQ, "product": "MIS", "in_mis_stamp_duty": 0.001}, weight=1.0)
    assert a["ok"] and b["ok"], (a.get("error"), b.get("error"))
    assert a["equity"][-1]["value"] == pytest.approx(b["equity"][-1]["value"])


@pytest.mark.parametrize("bad", [None, -0.5, "1e-5"])
def test_service_rejects_bad_value(svc, bad):  # noqa: F811
    svc(FIXTURES / "reliance_5m.csv")
    r = _svc_run([EQ], {**ZERO_EQ, "product": "MIS", "in_mis_stamp_duty": bad})
    assert r["ok"] is False
    assert "in_mis_stamp_duty" in (r.get("error") or "")
