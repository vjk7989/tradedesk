"""TM2-60: datetime COLUMNS that reach unit-sensitive operations.

TM2-45 normalises loader-returned indexes to ns, but pandas 3 parses strings to
``us``, so a datetime column built inside a loader/enricher can carry a different
unit from the frame index. These tests feed every path the audit classified
(coord/reports/TM2-60.md) with indexes/columns in several units and assert the
results are identical across units.

No network: providers/APIs are faked or monkeypatched.
"""

from __future__ import annotations

import warnings
from contextlib import contextmanager

import numpy as np
import pandas as pd
import pytest

from vibe_bt.backtest.loaders import (
    fundamentals_loader,
    industry_loader,
    local_loader,
    registry,
    rsshub_events,
    tushare_fundamentals,
)

UNITS = ["s", "ms", "us", "ns"]


@contextmanager
def _strict():
    with warnings.catch_warnings():
        warnings.simplefilter("error", DeprecationWarning)
        warnings.simplefilter("error", FutureWarning)
        yield


def _idx(stamps, unit: str, tz: str | None = None) -> pd.DatetimeIndex:
    index = pd.DatetimeIndex([pd.Timestamp(s) for s in stamps]).as_unit(unit)
    return index.tz_localize(tz) if tz else index


def _nan_aware(values) -> list:
    return [None if pd.isna(v) else v for v in values]


# ── 1. tushare_fundamentals.enrich_price_frames_with_fundamentals (merge_asof) ──

_PIT_ROWS = {
    "ts_code": ["A"],
    "ann_date": ["20240229"],
    "f_ann_date": ["20240229"],
    "end_date": ["20231231"],
    "revenue": [42.0],
}
_DAILY = ["2024-02-28", "2024-02-29", "2024-03-01"]
_INTRADAY = ["2024-02-28 14:00", "2024-02-29 09:30", "2024-02-29 14:00", "2024-03-01 09:30"]


def _provider(monkeypatch, rows=_PIT_ROWS):
    provider = tushare_fundamentals.TushareFundamentalProvider(api=object())
    monkeypatch.setattr(provider, "_query_pit_cut", lambda *a, **k: pd.DataFrame(rows))
    return provider


def _enrich(monkeypatch, index, **kwargs):
    frame = pd.DataFrame({"close": np.arange(1.0, len(index) + 1.0)}, index=index)
    with _strict():
        out = tushare_fundamentals.enrich_price_frames_with_fundamentals(
            {"A": frame}, _provider(monkeypatch), {"balancesheet": ["revenue"]},
            as_of="2024-12-31", **kwargs,
        )
    return frame, out["A"]


@pytest.mark.parametrize("unit", UNITS)
def test_tushare_enrich_daily_every_unit(monkeypatch, unit):
    index = _idx(_DAILY, unit)
    frame, got = _enrich(monkeypatch, index)
    # Visible from its ann_date (2024-02-29) on, never before.
    assert _nan_aware(got["balancesheet_revenue"]) == [None, 42.0, 42.0]
    # The caller's index comes back untouched, unit included.
    assert got.index.equals(index)
    assert got.index.dtype == index.dtype
    assert got["close"].tolist() == frame["close"].tolist()
    # Merge helper keys never leak into the output.
    assert not {"_trade_date", "_pit_date", "_original_order"} & set(got.columns)


def test_tushare_enrich_daily_identical_across_units(monkeypatch):
    results = [_enrich(monkeypatch, _idx(_DAILY, unit))[1] for unit in UNITS]
    base = results[0].reset_index(drop=True)
    for other in results[1:]:
        pd.testing.assert_frame_equal(other.reset_index(drop=True), base)


@pytest.mark.parametrize("unit", UNITS)
def test_tushare_enrich_next_day_intraday_every_unit(monkeypatch, unit):
    index = _idx(_INTRADAY, unit)
    _, got = _enrich(monkeypatch, index, subdaily="next_day")
    # Announced 2024-02-29: hidden on every bar of that day, visible from 03-01.
    assert _nan_aware(got["balancesheet_revenue"]) == [None, None, None, 42.0]
    assert got.index.equals(index)
    assert got.index.dtype == index.dtype


@pytest.mark.parametrize("unit", UNITS)
def test_tushare_enrich_mixed_unit_frames_in_one_call(monkeypatch, unit):
    # One call, two codes whose frames carry different units (ns vs ``unit``).
    rows = {k: v * 2 for k, v in _PIT_ROWS.items()}
    rows["ts_code"] = ["A", "B"]
    provider = tushare_fundamentals.TushareFundamentalProvider(api=object())
    monkeypatch.setattr(provider, "_query_pit_cut", lambda *a, **k: pd.DataFrame(rows))
    frames = {
        "A": pd.DataFrame({"close": [1.0, 2.0, 3.0]}, index=_idx(_DAILY, "ns")),
        "B": pd.DataFrame({"close": [1.0, 2.0, 3.0]}, index=_idx(_DAILY, unit)),
    }
    with _strict():
        out = tushare_fundamentals.enrich_price_frames_with_fundamentals(
            frames, provider, {"balancesheet": ["revenue"]}, as_of="2024-12-31",
        )
    for code in ("A", "B"):
        assert _nan_aware(out[code]["balancesheet_revenue"]) == [None, 42.0, 42.0]
        assert out[code].index.equals(frames[code].index)


# ── 1b. TM2-67: tz-aware price indexes are keyed by their CN-local date ────────
# Tushare PIT dates are CN-local calendar dates, so a tz-aware bar is matched on
# its Asia/Shanghai date. The caller's index comes back unchanged (tz and unit).

TZS = ["UTC", "Asia/Shanghai"]


def _cn_local_naive(index: pd.DatetimeIndex) -> pd.DatetimeIndex:
    return index.tz_convert("Asia/Shanghai").tz_localize(None)


def _assert_same_index(got: pd.DatetimeIndex, index: pd.DatetimeIndex) -> None:
    assert got.equals(index)
    assert got.dtype == index.dtype  # tz and unit
    assert str(got.tz) == str(index.tz)
    assert got.unit == index.unit
    assert got.asi8.tolist() == index.asi8.tolist()


@pytest.mark.parametrize("unit", UNITS)
@pytest.mark.parametrize("tz", TZS)
def test_tushare_enrich_tz_aware_daily_index_supported(monkeypatch, tz, unit):
    index = _idx(_DAILY, unit, tz=tz)
    frame, got = _enrich(monkeypatch, index)
    _assert_same_index(got.index, index)
    assert got["close"].tolist() == frame["close"].tolist()
    assert not {"_trade_date", "_pit_date", "_original_order"} & set(got.columns)

    # Equivalent naive frame: the CN-local calendar dates (UTC midnight is
    # 08:00 CST, which a naive frame would treat as an intraday bar).
    _, naive = _enrich(monkeypatch, _cn_local_naive(index).normalize())
    pd.testing.assert_frame_equal(got.reset_index(drop=True), naive.reset_index(drop=True))
    # UTC midnight is 08:00 CST the same day; Shanghai midnight is itself.
    assert _nan_aware(got["balancesheet_revenue"]) == [None, 42.0, 42.0]


@pytest.mark.parametrize("unit", UNITS)
@pytest.mark.parametrize("tz", TZS)
def test_tushare_enrich_tz_aware_intraday_index_supported(monkeypatch, tz, unit):
    index = _idx(_INTRADAY, unit, tz=tz)
    _, got = _enrich(monkeypatch, index, subdaily="next_day")
    _assert_same_index(got.index, index)
    _, naive = _enrich(monkeypatch, _cn_local_naive(index), subdaily="next_day")
    pd.testing.assert_frame_equal(got.reset_index(drop=True), naive.reset_index(drop=True))


# Reviewer's no-look-ahead case: ann_date 2024-02-29, next_day => visible from
# the first bar of CN-local 03-01, i.e. from 2024-02-29 16:00Z, not before.
_EDGE = [
    "2024-02-29 00:00",  # 08:00 CST 02-29
    "2024-02-29 15:59",  # 23:59 CST 02-29
    "2024-02-29 16:00",  # 00:00 CST 03-01
    "2024-02-29 23:30",  # 07:30 CST 03-01
    "2024-03-01 00:00",  # 08:00 CST 03-01
]


@pytest.mark.parametrize("unit", UNITS)
def test_tushare_enrich_next_day_utc_no_look_ahead(monkeypatch, unit):
    index = _idx(_EDGE, unit, tz="UTC")
    _, got = _enrich(monkeypatch, index, subdaily="next_day")
    assert _nan_aware(got["balancesheet_revenue"]) == [None, None, 42.0, 42.0, 42.0]
    _assert_same_index(got.index, index)

    # The same instants expressed in Asia/Shanghai give the same answer.
    cn_index = index.tz_convert("Asia/Shanghai")
    _, cn = _enrich(monkeypatch, cn_index, subdaily="next_day")
    assert _nan_aware(cn["balancesheet_revenue"]) == [None, None, 42.0, 42.0, 42.0]
    _assert_same_index(cn.index, cn_index)


@pytest.mark.parametrize("unit", UNITS)
def test_tushare_enrich_next_day_shanghai_wall_clock_control(monkeypatch, unit):
    # Reviewer's control: the same wall-clock stamps localised to Asia/Shanghai
    # are all on CN 02-29 except the last, so only 03-01 00:00 CST sees it.
    index = _idx(_EDGE, unit, tz="Asia/Shanghai")
    _, got = _enrich(monkeypatch, index, subdaily="next_day")
    assert _nan_aware(got["balancesheet_revenue"]) == [None, None, None, None, 42.0]
    _assert_same_index(got.index, index)


@pytest.mark.parametrize("unit", UNITS)
def test_tushare_enrich_reject_raises_for_non_midnight_utc_bars(monkeypatch, unit):
    with pytest.raises(tushare_fundamentals.SubdailyPitError):
        _enrich(monkeypatch, _idx(_EDGE, unit, tz="UTC"))


@pytest.mark.parametrize("unit", UNITS)
def test_tushare_enrich_unsorted_tz_index_keeps_order(monkeypatch, unit):
    order = [3, 0, 4, 2, 1]
    index = _idx([_EDGE[i] for i in order], unit, tz="UTC")
    frame, got = _enrich(monkeypatch, index, subdaily="next_day")
    _assert_same_index(got.index, index)
    assert got["close"].tolist() == frame["close"].tolist()
    expected = [None, None, 42.0, 42.0, 42.0]
    assert _nan_aware(got["balancesheet_revenue"]) == [expected[i] for i in order]


# ── 2. industry_loader membership int64 comparison ─────────────────────────────

_MEMBERSHIP = pd.DataFrame({
    "ts_code": ["600000.SH", "600000.SH", "000001.SZ", "000002.SZ"],
    "l1_name": ["Old", "Banks", "Banks", "Property"],
    "in_date": ["20200101", "20240102", "20230601", "20240104"],
    "out_date": ["20240102", None, "20240103", None],
})
_IND_DAYS = ["2023-12-29", "2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"]


def _industry(monkeypatch, index):
    monkeypatch.setattr(industry_loader, "_fetch_membership", lambda api, src: _MEMBERSHIP.copy())
    with _strict():
        return industry_loader.load_industry_frame_with_coverage(
            symbols=["600000.SH", "000001.SZ", "000002.SZ", "999999.SZ"],
            start="2023-12-29", end="2024-01-05", index=index, api=object(),
        )


@pytest.mark.parametrize("unit", UNITS)
def test_industry_membership_identical_across_units(monkeypatch, unit):
    index = _idx(_IND_DAYS, unit)
    frame, coverage = _industry(monkeypatch, index)
    ref_frame, ref_coverage = _industry(monkeypatch, _idx(_IND_DAYS, "ns"))

    expected = {
        # in <= d < out: the Old row ends exactly where Banks starts.
        "600000.SH": ["Old", "Banks", "Banks", "Banks", "Banks"],
        "000001.SZ": ["Banks", "Banks", None, None, None],
        "000002.SZ": [None, None, None, "Property", "Property"],
        "999999.SZ": [None] * 5,
    }
    for symbol, labels in expected.items():
        assert _nan_aware(frame[symbol]) == labels, symbol
    assert coverage == ref_coverage == 0.75
    assert frame.index.equals(index)
    pd.testing.assert_frame_equal(frame.reset_index(drop=True), ref_frame.reset_index(drop=True))


# ── 3. rsshub_events.enrich_price_frames_with_events ───────────────────────────


class _FakeEventProvider:
    def __init__(self, events: pd.DataFrame) -> None:
        self._events = events

    def query_events(self, codes, *, as_of, feeds=None, scorer=None):
        return self._events.copy()


def _events(unit: str) -> pd.DataFrame:
    return pd.DataFrame({
        "ts_code": ["A", "A", "A", "B"],
        "knowable_date": pd.DatetimeIndex(
            ["2024-01-02", "2024-01-03", "2023-11-01", "2024-01-03"]
        ).as_unit(unit),
        "score": [0.5, -0.2, 0.9, 0.3],
    })


_EV_DAYS = ["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04"]


def _event_enrich(event_unit: str, index_unit: str) -> dict[str, pd.DataFrame]:
    frames = {
        code: pd.DataFrame({"close": [1.0, 2.0, 3.0, 4.0]}, index=_idx(_EV_DAYS, index_unit))
        for code in ("A", "B")
    }
    with _strict():
        return rsshub_events.enrich_price_frames_with_events(
            frames, _FakeEventProvider(_events(event_unit)), as_of="2024-01-31",
        )


@pytest.mark.parametrize("index_unit", UNITS)
@pytest.mark.parametrize("event_unit", UNITS)
def test_rsshub_event_score_identical_across_units(event_unit, index_unit):
    got = _event_enrich(event_unit, index_unit)
    ref = _event_enrich("ns", "ns")
    for code in ("A", "B"):
        assert got[code]["event_count"].tolist() == ref[code]["event_count"].tolist()
        np.testing.assert_array_equal(
            got[code]["event_score"].to_numpy(), ref[code]["event_score"].to_numpy()
        )
        assert got[code].index.dtype == np.dtype(f"datetime64[{index_unit}]")

    # Pin the reference values so "identical" cannot mean "identically empty".
    # The 2023-11-01 event is outside the 30-day window on every bar.
    assert ref["A"]["event_count"].tolist() == [0, 1, 2, 2]
    decay = np.exp(-0.1)
    np.testing.assert_allclose(
        ref["A"]["event_score"].to_numpy(),
        [0.0, 0.5, 0.5 * decay - 0.2, 0.5 * decay**2 - 0.2 * decay],
    )
    assert ref["B"]["event_count"].tolist() == [0, 0, 1, 1]


# ── 4. fundamentals_loader._ffill_pit ──────────────────────────────────────────

_FILED = ["2024-01-03 00:00", "2024-01-04 16:30", "2024-01-05 00:00", "2024-01-09 00:00"]
_FF_DAYS = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05", "2024-01-08", "2024-01-09"]


def _sparse(filed_unit: str | None) -> pd.DataFrame:
    filed = pd.DatetimeIndex(_FILED).as_unit(filed_unit) if filed_unit else list(_FILED)
    return pd.DataFrame({"filed": filed, "value": [1.0, 2.0, 3.0, 4.0]})


@pytest.mark.parametrize("index_unit", UNITS)
@pytest.mark.parametrize("filed_unit", [*UNITS, None])  # None: raw strings
def test_ffill_pit_identical_across_units(filed_unit, index_unit):
    index = _idx(_FF_DAYS, index_unit)
    with _strict():
        got = fundamentals_loader._ffill_pit(_sparse(filed_unit), index)
        ref = fundamentals_loader._ffill_pit(_sparse("ns"), _idx(_FF_DAYS, "ns"))
    # The intraday filing (01-04 16:30) is normalised to its day.
    expected = [None, 1.0, 2.0, 3.0, 3.0, 4.0]
    assert _nan_aware(got) == expected
    assert _nan_aware(ref) == expected
    assert got.index.equals(index)


# ── 5. Loader output contract: trade_date is the index, no datetime64 columns ──


def test_local_loader_output_has_no_datetime_columns(tmp_path, monkeypatch):
    days = ["2024-01-02", "2024-01-03", "2024-01-04"]
    csv = tmp_path / "aapl.csv"
    csv.write_text(
        "date,open,high,low,close,volume\n"
        + "".join(f"{d},{10 + i},{11 + i},{9 + i},{10.5 + i},{100 + i}\n" for i, d in enumerate(days)),
        encoding="utf-8",
    )
    cfg = tmp_path / "config.yaml"
    cfg.write_text(
        f'sources:\n  - symbol: "AAPL"\n    type: csv\n    path: "{csv.as_posix()}"\n',
        encoding="utf-8",
    )
    monkeypatch.setenv("BT_LOCAL_DATA_CONFIG", str(cfg))
    monkeypatch.setattr(local_loader, "_CONFIG_PATH", cfg)
    monkeypatch.setenv("VIBE_TRADING_DATA_CACHE", "false")
    monkeypatch.setenv("VIBE_TRADING_DATA_CACHE_ROOT", str(tmp_path / "cache"))

    loader = registry.get_loader_cls_with_fallback("local")()
    with _strict():
        frame = loader.fetch(["AAPL"], "2024-01-01", "2024-01-31", interval="1D")["AAPL"]

    assert isinstance(frame.index, pd.DatetimeIndex)
    assert frame.index.unit == "ns"
    assert frame.index.name == "trade_date"
    assert "trade_date" not in frame.columns
    datetime_cols = [c for c in frame.columns if pd.api.types.is_datetime64_any_dtype(frame[c])]
    assert datetime_cols == []
    assert frame["close"].tolist() == [10.5, 11.5, 12.5]
