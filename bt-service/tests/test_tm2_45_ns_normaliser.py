"""TM2-45: central ns normaliser in the shared load path (``registry.register``).

``register()`` wraps every registered loader's ``fetch`` with ``_ns_normalised_fetch``,
which applies ``_to_ns_index`` (DatetimeIndex -> ``as_unit("ns")``, tz kept) to each
returned frame. These tests pass on pandas 2.3 (where most constructors already give
ns) and on 3.x (where many give us). Inputs are built with an explicit non-ns unit,
so the wrapper is exercised on both versions.

Run under pandas 3 with:
    uv run --with "pandas>=3,<4" python -m pytest -q tests/test_tm2_45_ns_normaliser.py
"""
from __future__ import annotations

import inspect
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import pytest

from vibe_bt.backtest.loaders import ccxt_loader, industry_loader, local_loader, registry
from vibe_bt.backtest.loaders.registry import (
    LOADER_REGISTRY,
    _ns_normalised_fetch,
    _to_ns_index,
    register,
)

UNITS = ["s", "ms", "us", "ns"]
NON_NS_UNITS = ["s", "ms", "us"]
TZS = [None, "UTC", "Asia/Kolkata"]
_STAMPS = ["2024-01-02 09:15:00", "2024-01-03 09:15:00", "2024-01-04 15:30:00"]


def _index(unit: str, tz: str | None, stamps=_STAMPS, name="trade_date") -> pd.DatetimeIndex:
    index = pd.DatetimeIndex([pd.Timestamp(s) for s in stamps], name=name).as_unit(unit)
    return index.tz_localize(tz) if tz else index


def _frame(unit: str, tz: str | None = None, stamps=_STAMPS) -> pd.DataFrame:
    n = len(stamps)
    frame = pd.DataFrame(
        {"open": [1.0 + i for i in range(n)], "close": [1.5 + i for i in range(n)],
         "volume": [100 + i for i in range(n)]},
        index=_index(unit, tz, stamps),
    )
    frame.attrs["quote_currency"] = "USD"
    return frame


def _assert_ns(index: pd.Index, tz: str | None = None) -> None:
    assert isinstance(index, pd.DatetimeIndex)
    assert index.unit == "ns"
    if tz is None:
        assert index.tz is None
        assert str(index.dtype) == "datetime64[ns]"
    else:
        assert str(index.tz) == tz
        assert str(index.dtype) == f"datetime64[ns, {tz}]"


def _assert_same_values(out: pd.DataFrame, inp: pd.DataFrame) -> None:
    """Same instants, same columns/values/attrs; only the index unit may differ."""
    assert list(out.index) == list(inp.index)  # Timestamps compare by instant
    assert list(out.index.isna()) == list(inp.index.isna())
    factor = {"s": 10**9, "ms": 10**6, "us": 10**3, "ns": 1}[inp.index.unit]
    finite = ~inp.index.isna()
    assert list(out.index.asi8[finite]) == [v * factor for v in inp.index.asi8[finite]]
    assert out.index.name == inp.index.name
    assert list(out.columns) == list(inp.columns)
    assert list(out.dtypes) == list(inp.dtypes)
    np.testing.assert_array_equal(out.to_numpy(), inp.to_numpy())
    assert out.attrs == inp.attrs


@pytest.fixture
def clean_registry():
    """Restore LOADER_REGISTRY after a test registers fake loaders."""
    snapshot = dict(LOADER_REGISTRY)
    yield
    LOADER_REGISTRY.clear()
    LOADER_REGISTRY.update(snapshot)


# ── _to_ns_index ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("tz", TZS)
@pytest.mark.parametrize("unit", UNITS)
def test_to_ns_index_pins_ns_keeps_tz_and_values(unit, tz):
    frame = _frame(unit, tz)
    out = _to_ns_index(frame)
    _assert_ns(out.index, tz)
    _assert_same_values(out, frame)
    assert frame.index.unit == unit  # the input frame is not mutated


@pytest.mark.parametrize("unit", UNITS)
def test_to_ns_index_on_ns_input_returns_same_object(unit):
    frame = _frame(unit)
    out = _to_ns_index(frame)
    if unit == "ns":
        assert out is frame
    else:
        assert out is not frame


@pytest.mark.parametrize("tz", TZS)
@pytest.mark.parametrize("unit", NON_NS_UNITS)
def test_to_ns_index_series(unit, tz):
    series = pd.Series([1.0, 2.0, 3.0], index=_index(unit, tz), name="close")
    out = _to_ns_index(series)
    assert isinstance(out, pd.Series)
    _assert_ns(out.index, tz)
    assert list(out.index) == list(series.index)
    assert list(out) == [1.0, 2.0, 3.0] and out.name == "close"


@pytest.mark.parametrize(
    "index",
    [
        pd.RangeIndex(3),
        pd.Index(["a", "b", "c"]),
        pd.Index(["2024-01-02", "2024-01-03", "2024-01-04"]),  # date strings, not datetimes
        pd.PeriodIndex(["2024-01", "2024-02", "2024-03"], freq="M"),
        pd.TimedeltaIndex(["1s", "2s", "3s"]),
    ],
    ids=["range", "str", "datestr", "period", "timedelta"],
)
def test_to_ns_index_non_datetime_index_passes_through(index):
    frame = pd.DataFrame({"x": [1, 2, 3]}, index=index)
    assert _to_ns_index(frame) is frame


def test_to_ns_index_leaves_datetime_columns_alone():
    col = pd.DatetimeIndex([pd.Timestamp(s) for s in _STAMPS]).as_unit("us")
    frame = pd.DataFrame({"ts": col, "x": [1, 2, 3]})
    out = _to_ns_index(frame)
    assert out is frame
    assert out["ts"].dt.unit == "us"


@pytest.mark.parametrize("value", [None, {}, [], "text", 3, np.array([1, 2])],
                         ids=["none", "dict", "list", "str", "int", "ndarray"])
def test_to_ns_index_non_frames_pass_through(value):
    assert _to_ns_index(value) is value


@pytest.mark.parametrize("tz", TZS)
@pytest.mark.parametrize("unit", NON_NS_UNITS)
def test_to_ns_index_preserves_nat(unit, tz):
    stamps = [pd.Timestamp("2024-01-02"), pd.NaT, pd.Timestamp("2024-01-04"), pd.NaT]
    index = pd.DatetimeIndex(stamps, name="trade_date").as_unit(unit)
    if tz:
        index = index.tz_localize(tz)
    frame = pd.DataFrame({"close": [1.0, 2.0, 3.0, 4.0]}, index=index)
    out = _to_ns_index(frame)
    _assert_ns(out.index, tz)
    assert list(out.index.isna()) == [False, True, False, True]
    _assert_same_values(out, frame)


@pytest.mark.parametrize("tz", TZS)
@pytest.mark.parametrize("unit", UNITS)
def test_to_ns_index_empty_frame(unit, tz):
    frame = _frame(unit, tz).iloc[:0]
    out = _to_ns_index(frame)
    assert out.empty
    _assert_ns(out.index, tz)
    assert list(out.columns) == ["open", "close", "volume"]


# ── _ns_normalised_fetch through register() ──────────────────────────────────

def _make_loader(name: str, result_factory):
    class FakeLoader:
        markets = {"crypto"}
        requires_auth = False

        def is_available(self) -> bool:
            return True

        def fetch(self, codes, start_date, end_date, *, interval="1D", fields=None):
            """Fake fetch docstring."""
            return result_factory(codes)

    FakeLoader.name = name
    return FakeLoader


@pytest.mark.parametrize("tz", [None, "UTC"])
def test_registered_fake_loader_dict_of_us_frames_is_ns(clean_registry, tz):
    frames = {"AAA": _frame("us", tz), "BBB": _frame("ms", tz), "CCC": _frame("ns", tz)}
    cls = register(_make_loader("tm2_45_fake_dict", lambda codes: dict(frames)))
    assert LOADER_REGISTRY["tm2_45_fake_dict"] is cls
    out = LOADER_REGISTRY["tm2_45_fake_dict"]().fetch(["AAA"], "2024-01-01", "2024-01-31")
    assert isinstance(out, dict) and list(out) == ["AAA", "BBB", "CCC"]
    for key, frame in out.items():
        _assert_ns(frame.index, tz)
        _assert_same_values(frame, frames[key])
    assert frames["AAA"].index.unit == "us"  # loader's own frames are not mutated


def test_registered_fake_loader_dict_with_none_value(clean_registry):
    cls = register(_make_loader("tm2_45_fake_none_val",
                                lambda codes: {"AAA": _frame("us"), "BBB": None}))
    out = cls().fetch(["AAA", "BBB"], "2024-01-01", "2024-01-31")
    _assert_ns(out["AAA"].index)
    assert out["BBB"] is None


@pytest.mark.parametrize("unit", NON_NS_UNITS)
def test_registered_fake_loader_single_frame_is_ns(clean_registry, unit):
    frame = _frame(unit, "Asia/Kolkata")
    cls = register(_make_loader("tm2_45_fake_single", lambda codes: frame))
    out = cls().fetch(["AAA"], "2024-01-01", "2024-01-31")
    assert isinstance(out, pd.DataFrame)
    _assert_ns(out.index, "Asia/Kolkata")
    _assert_same_values(out, frame)


def test_registered_fake_loader_none_and_empty_dict(clean_registry):
    cls_none = register(_make_loader("tm2_45_fake_none", lambda codes: None))
    assert cls_none().fetch(["AAA"], "2024-01-01", "2024-01-31") is None
    cls_empty = register(_make_loader("tm2_45_fake_empty", lambda codes: {}))
    assert cls_empty().fetch(["AAA"], "2024-01-01", "2024-01-31") == {}


def test_wrapper_preserves_signature_name_and_docstring(clean_registry):
    cls = _make_loader("tm2_45_fake_sig", lambda codes: None)
    raw = cls.fetch
    raw_sig = inspect.signature(raw)
    register(cls)
    wrapped = cls.fetch
    assert wrapped is not raw
    assert getattr(wrapped, "_ns_normalised", False) is True
    assert inspect.signature(wrapped) == raw_sig
    assert wrapped.__name__ == "fetch"
    assert wrapped.__qualname__ == raw.__qualname__
    assert wrapped.__doc__ == "Fake fetch docstring."
    assert wrapped.__module__ == raw.__module__
    assert wrapped.__wrapped__ is raw
    # Bound-method signature (self dropped) also matches.
    assert list(inspect.signature(cls().fetch).parameters) == [
        "codes", "start_date", "end_date", "interval", "fields"
    ]


def test_wrapper_passes_args_and_kwargs_through(clean_registry):
    seen = {}

    class ArgLoader:
        name = "tm2_45_fake_args"

        def fetch(self, codes, start_date, end_date, *, interval="1D", fields=None):
            seen.update(codes=codes, start=start_date, end=end_date,
                        interval=interval, fields=fields)
            return None

    register(ArgLoader)
    ArgLoader().fetch(["X"], "2024-01-01", end_date="2024-02-01", interval="5m", fields=["c"])
    assert seen == {"codes": ["X"], "start": "2024-01-01", "end": "2024-02-01",
                    "interval": "5m", "fields": ["c"]}


class _LoaderBoom(RuntimeError):
    pass


def test_wrapper_propagates_exceptions_unchanged(clean_registry):
    err = _LoaderBoom("upstream exploded")

    def boom(codes):
        raise err

    cls = register(_make_loader("tm2_45_fake_boom", boom))
    with pytest.raises(_LoaderBoom) as excinfo:
        cls().fetch(["AAA"], "2024-01-01", "2024-01-31")
    assert excinfo.value is err
    assert str(excinfo.value) == "upstream exploded"


def _wrap_depth(fn) -> int:
    """How many ns-normaliser layers wrap ``fn``."""
    depth = 0
    while fn is not None and getattr(fn, "_ns_normalised", False):
        depth += 1
        fn = getattr(fn, "__wrapped__", None)
    return depth


def test_subclass_inheriting_fetch_is_wrapped_once(clean_registry):
    calls = []

    class Base:
        name = "tm2_45_base"

        def fetch(self, codes, start_date, end_date):
            calls.append(codes)
            return {"A": _frame("us")}

    register(Base)

    class Child(Base):
        name = "tm2_45_child"

    register(Child)
    assert Child.fetch is Base.fetch  # nothing new was assigned on top
    assert _wrap_depth(Child.fetch) == 1
    assert _wrap_depth(Base.fetch) == 1
    out = Child().fetch(["A"], "2024-01-01", "2024-01-31")
    _assert_ns(out["A"].index)
    assert calls == [["A"]]


def test_registering_twice_does_not_double_wrap(clean_registry):
    cls = _make_loader("tm2_45_twice", lambda codes: _frame("us"))
    register(cls)
    first = cls.fetch
    register(cls)
    assert cls.fetch is first
    assert _wrap_depth(cls.fetch) == 1


def test_wrapping_an_already_wrapped_function_is_identity():
    def fetch(self):
        return None

    once = _ns_normalised_fetch(fetch)
    assert _ns_normalised_fetch(once) is once
    assert _wrap_depth(once) == 1


def test_subclass_overriding_fetch_is_wrapped_too(clean_registry):
    class Base:
        name = "tm2_45_base_ns"

        def fetch(self, codes, start_date, end_date):
            return {"A": _frame("ns")}

    register(Base)
    base_fetch = Base.fetch

    class Child(Base):
        name = "tm2_45_child_override"

        def fetch(self, codes, start_date, end_date):
            """Child fetch."""
            return {"A": _frame("us", "UTC")}

    raw_child = Child.__dict__["fetch"]
    register(Child)
    assert Child.fetch is not raw_child
    assert Child.fetch.__wrapped__ is raw_child
    assert _wrap_depth(Child.fetch) == 1
    assert Child.fetch.__doc__ == "Child fetch."
    assert Base.fetch is base_fetch  # parent untouched
    out = Child().fetch(["A"], "2024-01-01", "2024-01-31")
    _assert_ns(out["A"].index, "UTC")


def test_subclass_overriding_fetch_and_calling_super_is_normalised(clean_registry):
    class Base:
        name = "tm2_45_super_base"

        def fetch(self, codes, start_date, end_date):
            return {"A": _frame("us")}

    register(Base)

    class Child(Base):
        name = "tm2_45_super_child"

        def fetch(self, codes, start_date, end_date):
            return super().fetch(codes, start_date, end_date)

    register(Child)
    out = Child().fetch(["A"], "2024-01-01", "2024-01-31")
    _assert_ns(out["A"].index)
    _assert_same_values(out["A"], _frame("us"))


# ── Coverage: every registered loader goes through the normaliser ────────────

def test_every_registered_loader_fetch_is_ns_wrapped():
    registry._ensure_registered()
    real = {name: cls for name, cls in LOADER_REGISTRY.items()
            if cls.__module__.startswith("vibe_bt.")}
    # The loaders this task is about must actually be present, or the loop is vacuous.
    assert {"local", "ccxt"} <= set(real)
    assert len(real) >= 10
    unwrapped = sorted(
        name for name, cls in real.items()
        if not getattr(cls.fetch, "_ns_normalised", False)
    )
    assert unwrapped == [], f"loaders bypassing the ns normaliser: {unwrapped}"
    for name, cls in real.items():
        assert _wrap_depth(cls.fetch) == 1, name


# ── End to end: local loader through the registry ────────────────────────────

def _write_local_config(tmp_path, monkeypatch, symbol: str, csv_path: str) -> None:
    cfg = tmp_path / "config.yaml"
    cfg.write_text(
        "sources:\n"
        f'  - symbol: "{symbol}"\n    type: csv\n    path: "{csv_path}"\n',
        encoding="utf-8",
    )
    monkeypatch.setenv("BT_LOCAL_DATA_CONFIG", str(cfg))
    monkeypatch.setattr(local_loader, "_CONFIG_PATH", cfg)
    monkeypatch.setenv("VIBE_TRADING_DATA_CACHE", "false")
    monkeypatch.setenv("VIBE_TRADING_DATA_CACHE_ROOT", str(tmp_path / "cache"))


def test_local_loader_us_output_is_ns_through_registry(tmp_path, monkeypatch):
    days = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"]
    rows = ["date,open,high,low,close,volume"] + [
        f"{d},{10 + i},{11 + i},{9 + i},{10.5 + i},{100 + i}" for i, d in enumerate(days)
    ]
    path = tmp_path / "aapl.csv"
    path.write_text("\n".join(rows) + "\n", encoding="utf-8")
    _write_local_config(tmp_path, monkeypatch, "AAPL", path.as_posix())

    original = local_loader._resample_to_interval

    def resample_then_cast_to_us(df, *args, **kwargs):
        out = original(df, *args, **kwargs).copy()
        out.index = out.index.as_unit("us")
        return out

    monkeypatch.setattr(local_loader, "_resample_to_interval", resample_then_cast_to_us)

    cls = registry.get_loader_cls_with_fallback("local")
    assert cls is LOADER_REGISTRY["local"]
    loader = cls()

    # The loader's own (unwrapped) output really is us, so the check below is not vacuous.
    raw = cls.fetch.__wrapped__(loader, ["AAPL"], "2024-01-01", "2024-01-31", interval="1D")
    assert raw["AAPL"].index.unit == "us"

    out = loader.fetch(["AAPL"], "2024-01-01", "2024-01-31", interval="1D")
    frame = out["AAPL"]
    _assert_ns(frame.index)
    _assert_same_values(frame, raw["AAPL"])
    expected = [int(datetime.fromisoformat(d).replace(tzinfo=timezone.utc).timestamp())
                * 10**9 for d in days]
    assert list(frame.index.asi8) == expected
    assert list(frame["close"]) == [10.5, 11.5, 12.5, 13.5]


# ── End to end: ccxt loader with a mocked exchange ───────────────────────────

class _FakeExchange:
    """Serves 1d OHLCV rows with ms timestamps, the way ccxt does."""

    def __init__(self, rows):
        self.rows = rows
        self.calls = []

    def fetch_ohlcv(self, symbol, timeframe, since=None, limit=None, params=None):
        self.calls.append((symbol, timeframe, since, limit))
        return [r for r in self.rows if r[0] >= since][:limit]


_DAY_MS = 86_400_000
_JAN2_MS = int(datetime(2024, 1, 2, tzinfo=timezone.utc).timestamp() * 1000)
_CCXT_ROWS = [
    [_JAN2_MS + i * _DAY_MS, 42000.0 + i, 42500.0 + i, 41500.0 + i, 42100.0 + i, 10.0 + i]
    for i in range(4)
]


def test_ccxt_loader_mocked_exchange_ms_timestamps_give_ns(monkeypatch, tmp_path):
    monkeypatch.setenv("VIBE_TRADING_DATA_CACHE", "false")
    monkeypatch.setenv("VIBE_TRADING_DATA_CACHE_ROOT", str(tmp_path / "cache"))
    exchange = _FakeExchange(_CCXT_ROWS)
    monkeypatch.setattr(ccxt_loader.DataLoader, "_get_exchange",
                        lambda self, instrument_type="spot": exchange)

    cls = registry.get_loader_cls_with_fallback("ccxt")
    assert cls is LOADER_REGISTRY["ccxt"]
    loader = cls()

    raw = cls.fetch.__wrapped__(loader, ["BTC-USDT"], "2024-01-01", "2024-01-10", interval="1D")
    # The loader's own unit is whatever pandas infers for unit="ms" (us on pandas 3).
    inferred = pd.to_datetime(pd.Series([_JAN2_MS]), unit="ms").dt.unit
    assert raw["BTC-USDT"].index.unit == inferred

    out = loader.fetch(["BTC-USDT"], "2024-01-01", "2024-01-10", interval="1D")
    frame = out["BTC-USDT"]
    _assert_ns(frame.index)
    _assert_same_values(frame, raw["BTC-USDT"])
    assert list(frame.index.asi8) == [r[0] * 10**6 for r in _CCXT_ROWS]
    assert list(frame["close"]) == [r[4] for r in _CCXT_ROWS]
    assert exchange.calls and exchange.calls[0][0] == "BTC/USDT"


# ── industry_loader: int64 comparison is unit-independent ────────────────────

class _FakeTushare:
    def __init__(self, frame: pd.DataFrame):
        self.frame = frame

    def index_member_all(self, is_new=None, l1_code=None, **_):
        if is_new == "Y":
            return self.frame[self.frame["out_date"].isna()].reset_index(drop=True)
        return self.frame[self.frame["out_date"].notna()].reset_index(drop=True)

    def index_classify(self, **_):  # pragma: no cover - only on a truncated snapshot
        raise AssertionError("not expected")


_MEMBERSHIP = pd.DataFrame(
    {
        "ts_code": ["600000.SH", "600000.SH", "000001.SZ", "000002.SZ"],
        "l1_name": ["Banks-old", "Banks", "Finance", "RealEstate"],
        "in_date": ["20200101", "20240103", "20190101", "20240105"],
        "out_date": ["20240103", None, None, None],
    }
)
_IND_DAYS = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"]
_IND_SYMBOLS = ["600000.SH", "000001.SZ", "000002.SZ", "999999.SH"]
_IND_EXPECTED = {
    "600000.SH": ["Banks-old", "Banks", "Banks", "Banks"],  # out_date is exclusive
    "000001.SZ": ["Finance"] * 4,
    "000002.SZ": [None, None, None, "RealEstate"],
    "999999.SH": [None] * 4,
}


def _industry(unit: str, tz=None):
    index = _index(unit, tz, stamps=_IND_DAYS, name=None)
    return industry_loader.load_industry_frame_with_coverage(
        symbols=_IND_SYMBOLS, start="2024-01-01", end="2024-01-31", index=index,
        api=_FakeTushare(_MEMBERSHIP), level="L1", src="SW2021",
    )


def _labels(frame: pd.DataFrame) -> dict:
    return {c: [None if pd.isna(v) else v for v in frame[c]] for c in frame.columns}


@pytest.mark.parametrize("unit", UNITS)
def test_industry_frame_is_unit_independent(unit):
    frame, coverage = _industry(unit)
    assert _labels(frame) == _IND_EXPECTED
    assert coverage == 0.75
    ref_frame, ref_cov = _industry("ns")
    assert _labels(frame) == _labels(ref_frame) and coverage == ref_cov
    assert list(frame.index) == list(ref_frame.index)
