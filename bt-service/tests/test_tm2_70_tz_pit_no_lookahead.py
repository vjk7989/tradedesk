"""TM2-70: no look-ahead from timezone mixing in point-in-time (PIT) joins.

The oracle here is the spec, not the loader internals: a value may appear on a
bar only if the bar's **market-local calendar date** is on or after the PIT
date, and (where TM2-70 removed a delay) it must appear from exactly that date.
Expectations are hard-coded or derived from that one rule.

Market calendars (one per loader):

* ``fundamentals_loader._ffill_pit`` (SEC ``filed``): America/New_York. A
  tz-suffixed ``filed`` has PIT date ``max(stated wall date, ET date of the
  instant)``.
* ``industry_loader`` (Tushare ``in_date``/``out_date``): Asia/Shanghai.
* ``rsshub_events`` (``knowable_date``): Asia/Shanghai. A tz-aware ``pubDate``
  is knowable on ``max(rolled wall date, rolled CN date of the instant)``.

A naive bar index is taken as already market-local. A tz-aware one is read in
the market tz, and every loader returns the caller's exact index.

``pit_calendar`` is imported only inside the guard tests, so the behavioural
tests also run (and fail where expected) against the pre-TM2-70 loaders.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd
import pytest

from vibe_bt.backtest.loaders import fundamentals_loader as F
from vibe_bt.backtest.loaders import industry_loader as I
from vibe_bt.backtest.loaders import rsshub_events as R

ET = "America/New_York"
CN = "Asia/Shanghai"
IST = "Asia/Kolkata"
LA = "America/Los_Angeles"
UNITS = ["s", "ms", "us", "ns"]
D = pd.Timestamp


def _nan_none(values) -> list:
    return [None if (isinstance(v, float) and math.isnan(v)) else v for v in values]


def _market_dates(index: pd.DatetimeIndex, tz: str) -> pd.DatetimeIndex:
    """Oracle: market-local calendar date of each bar (naive = already local)."""
    idx = pd.DatetimeIndex(index)
    if idx.tz is not None:
        idx = idx.tz_convert(tz).tz_localize(None)
    return idx.normalize()


def _same_index(out_index: pd.Index, idx: pd.DatetimeIndex) -> None:
    assert out_index.equals(idx)
    assert out_index.dtype == idx.dtype
    assert out_index.name == idx.name
    assert list(out_index) == list(idx)


# ── loader drivers ────────────────────────────────────────────────────────────


def _fund(filed: list, idx: pd.DatetimeIndex, values: list | None = None) -> pd.Series:
    values = values if values is not None else [5.0] * len(filed)
    return F._ffill_pit(pd.DataFrame({"filed": filed, "value": values}), idx)


class _IndustryApi:
    """Fake Tushare: ``in`` = A joins Banks 01-05; ``out`` = A leaves Old 01-05."""

    def __init__(self, kind: str) -> None:
        self.kind = kind

    def index_member_all(self, **kw):
        empty = pd.DataFrame({"ts_code": [], "l1_name": [], "in_date": [], "out_date": []})
        if self.kind == "in" and kw.get("is_new") == "Y":
            return pd.DataFrame(
                {"ts_code": ["A"], "l1_name": ["Banks"], "in_date": ["20240105"], "out_date": [None]}
            )
        if self.kind == "out" and kw.get("is_new") == "N":
            return pd.DataFrame(
                {"ts_code": ["A"], "l1_name": ["Old"], "in_date": ["20240101"], "out_date": ["20240105"]}
            )
        return empty

    def index_classify(self, **kw):
        return pd.DataFrame({"index_code": []})


def _industry(kind: str, idx: pd.DatetimeIndex) -> pd.DataFrame:
    return I.load_industry_frame(symbols=["A"], start="2024-01-01", end="2024-01-31", index=idx, api=_IndustryApi(kind))


def _industry_labels(kind: str, idx: pd.DatetimeIndex) -> list:
    return [None if isinstance(v, float) else v for v in _industry(kind, idx)["A"].tolist()]


class _KnowableProvider:
    """Fake provider: one event for A, knowable on CN date 2024-01-05."""

    def query_events(self, codes, *, as_of, feeds=None, scorer=None):
        return pd.DataFrame(
            {
                "ts_code": ["A"],
                "knowable_date": [D("2024-01-05")],
                "event_type": ["news"],
                "score": [1.0],
                "source": ["s"],
                "summary": ["x"],
            }
        )


def _rss_frame(idx: pd.DatetimeIndex, provider=None, **kw) -> pd.DataFrame:
    frame = pd.DataFrame({"close": np.arange(len(idx), dtype=float)}, index=idx)
    kw.setdefault("as_of", "2024-12-31")
    kw.setdefault("decay_lambda", 0.0)
    return R.enrich_price_frames_with_events({"A": frame}, provider or _KnowableProvider(), **kw)["A"]


def _rss_counts(idx: pd.DatetimeIndex) -> list:
    return [None if c == 0 else float(c) for c in _rss_frame(idx)["event_count"]]


class _Resp:
    def __init__(self, text: str) -> None:
        self.text = text

    def raise_for_status(self) -> None:
        pass


class _Client:
    def __init__(self, xml: str) -> None:
        self.xml = xml

    def get(self, url, timeout=None):
        return _Resp(self.xml)


def _rss_provider(pub_dates: list[str]) -> R.RSSHubEventProvider:
    items = "".join(
        f"<item><title>t{i}</title><description>d{i}</description><pubDate>{p}</pubDate></item>"
        for i, p in enumerate(pub_dates)
    )
    xml = f"<rss><channel>{items}</channel></rss>"
    feed = R.FeedSpec(name="f", route_template="/x", event_type="news")
    return R.RSSHubEventProvider("http://x", feeds=[feed], client=_Client(xml))


# ── 1. The dev's 27-case day-boundary probe (hard-coded expectations) ─────────
#
# Bars sit exactly at the market-local day boundary: 23:59:59 on 01-04, 00:00
# and 12:00 on 01-05 (ET for SEC, CN for industry/rsshub), shown as a naive,
# UTC or market-tz index, plus UTC-midnight daily bars (01-04/05/06 00:00Z,
# which are the previous evening in ET and 08:00 the same day in CN).

_ET_WALL = ["2024-01-04 23:59:59", "2024-01-05 00:00:00", "2024-01-05 12:00:00"]
_CN_WALL = _ET_WALL
_UTC_MID = pd.DatetimeIndex(["2024-01-04", "2024-01-05", "2024-01-06"]).tz_localize("UTC")

_FUND_BARS = {
    "naive": pd.DatetimeIndex(_ET_WALL),
    "UTC": pd.DatetimeIndex(_ET_WALL).tz_localize(ET).tz_convert("UTC"),
    "NY": pd.DatetimeIndex(_ET_WALL).tz_localize(ET),
    "UTCmid": _UTC_MID,
}
_CN_BARS = {
    "naive": pd.DatetimeIndex(_CN_WALL),
    "Shanghai": pd.DatetimeIndex(_CN_WALL).tz_localize(CN),
    "UTC": pd.DatetimeIndex(_CN_WALL).tz_localize(CN).tz_convert("UTC"),
    "UTCmid": _UTC_MID,
}
_FILED_0105 = {"naive": "2024-01-05", "Z": "2024-01-05T00:00:00Z", "+05:30": "2024-01-05T00:00:00+05:30"}

# (bars, source, expected); main had look-ahead in 13 of these 14.
_FUND_PROBE = [
    (bars, src, [None, None, 5.0] if bars == "UTCmid" else [None, 5.0, 5.0])
    for bars in _FUND_BARS
    for src in _FILED_0105
]


@pytest.mark.parametrize(("bars", "src", "expected"), _FUND_PROBE, ids=[f"{b}-{s}" for b, s, _ in _FUND_PROBE])
def test_probe_ffill_pit_day_boundary(bars, src, expected):
    idx = _FUND_BARS[bars]
    out = _fund([_FILED_0105[src]], idx)
    assert _nan_none(out.tolist()) == expected
    _same_index(out.index, idx)


@pytest.mark.parametrize(
    ("tz", "expected"),
    [("UTC", [None, None, 5.0]), (ET, [None, 5.0, 5.0])],
    ids=["UTC", "NY"],
)
def test_probe_ffill_pit_leap_day_midnight(tz, expected):
    # TM2-67 case: filed 02-29 was visible on bar 02-28.
    idx = pd.DatetimeIndex(["2024-02-28", "2024-02-29", "2024-03-01"]).tz_localize(tz)
    out = _fund(["2024-02-29"], idx)
    assert _nan_none(out.tolist()) == expected
    _same_index(out.index, idx)


_INDUSTRY_PROBE = [
    (bars, kind, [None, "Banks", "Banks"] if kind == "in" else ["Old", None, None])
    for bars in _CN_BARS
    for kind in ("in", "out")
]


@pytest.mark.parametrize(
    ("bars", "kind", "expected"), _INDUSTRY_PROBE, ids=[f"{b}-{k}" for b, k, _ in _INDUSTRY_PROBE]
)
def test_probe_industry_day_boundary(bars, kind, expected):
    # UTCmid: 01-04Z = CN 01-04 08:00, so the CN-midnight probe values line up.
    idx = _CN_BARS[bars]
    frame = _industry(kind, idx)
    assert [None if isinstance(v, float) else v for v in frame["A"].tolist()] == expected
    _same_index(frame.index, idx)


_RSS_PROBE = [(bars, [None, 1.0, 1.0]) for bars in _CN_BARS] + [("UTC 15:59:59Z/16:00:00Z", [None, 1.0])]


@pytest.mark.parametrize(("bars", "expected"), _RSS_PROBE, ids=[b for b, _ in _RSS_PROBE])
def test_probe_rsshub_enrich_day_boundary(bars, expected):
    if bars in _CN_BARS:
        idx = _CN_BARS[bars]
    else:  # 16:00:00Z = CN 01-05 00:00
        idx = pd.DatetimeIndex(["2024-01-04 15:59:59", "2024-01-04 16:00:00"]).tz_localize("UTC")
    assert _rss_counts(idx) == expected


def test_probe_has_27_cases():
    assert len(_FUND_PROBE) + 2 + len(_INDUSTRY_PROBE) + len(_RSS_PROBE) == 27


# ── 2. Wider matrix: naive / UTC / market tz / Kolkata / Los Angeles ─────────
#
# Hourly bars spanning the market-local day boundary (market-local 01-04 20:00
# to 01-06 04:00), shown in each tz. The expected visibility is computed from
# the oracle alone: market-local date >= PIT date (exact, so also never late).

_WIDE_TZS = ["naive", "UTC", "market", IST, LA]


def _wide_index(market_tz: str, kind: str, unit: str = "ns") -> pd.DatetimeIndex:
    wall = pd.date_range("2024-01-04 20:00", "2024-01-06 04:00", freq="h", unit=unit)
    if kind == "naive":
        return wall
    local = wall.tz_localize(market_tz)
    return local if kind == "market" else local.tz_convert(kind)


# filed string -> SEC PIT date (hand-derived: max(wall date, ET date of instant)).
_SEC_SOURCES = {
    "naive": ("2024-01-05", "2024-01-05"),
    "Z": ("2024-01-05T00:00:00Z", "2024-01-05"),  # ET 01-04 19:00, wall 01-05
    "+05:30": ("2024-01-05T00:00:00+05:30", "2024-01-05"),  # ET 01-04 13:30
    "-08:00 late": ("2024-01-05T23:30:00-08:00", "2024-01-06"),  # ET 01-06 02:30
    "Z late": ("2024-01-05T06:00:00Z", "2024-01-05"),  # ET 01-05 01:00
}


@pytest.mark.parametrize("kind", _WIDE_TZS)
@pytest.mark.parametrize("src", list(_SEC_SOURCES))
def test_ffill_pit_matrix_no_lookahead_exact(kind, src):
    filed, pit = _SEC_SOURCES[src]
    idx = _wide_index(ET, kind)
    out = _fund([filed], idx)
    visible = _market_dates(idx, ET) >= D(pit)
    assert out.notna().tolist() == visible.tolist()
    assert (out[visible] == 5.0).all()
    _same_index(out.index, idx)


@pytest.mark.parametrize("kind", ["UTC", "market", IST, LA])
@pytest.mark.parametrize("src", list(_SEC_SOURCES))
def test_ffill_pit_daily_utc_midnight_matrix(kind, src):
    # Daily bars at 00:00 of each tz: in ET the eastern ones read as the same
    # date, the western/UTC ones as the previous ET evening (conservative).
    filed, pit = _SEC_SOURCES[src]
    days = pd.date_range("2024-01-03", "2024-01-08", freq="D")
    tz = ET if kind == "market" else kind
    idx = days.tz_localize(tz)
    out = _fund([filed], idx)
    visible = _market_dates(idx, ET) >= D(pit)
    assert out.notna().tolist() == visible.tolist()
    _same_index(out.index, idx)


@pytest.mark.parametrize("kind", _WIDE_TZS)
@pytest.mark.parametrize("which", ["in", "out"])
def test_industry_matrix_no_lookahead_exact(kind, which):
    idx = _wide_index(CN, kind)
    labels = _industry_labels(which, idx)
    after = (_market_dates(idx, CN) >= D("2024-01-05")).tolist()
    if which == "in":
        expected = ["Banks" if a else None for a in after]
    else:  # membership ends at out_date (exclusive): never a stale label after it
        expected = [None if a else "Old" for a in after]
    assert labels == expected


@pytest.mark.parametrize("kind", _WIDE_TZS)
def test_rsshub_enrich_matrix_no_lookahead_exact(kind):
    idx = _wide_index(CN, kind)
    frame = _rss_frame(idx)
    visible = _market_dates(idx, CN) >= D("2024-01-05")
    assert (frame["event_count"] > 0).tolist() == visible.tolist()
    assert (frame["event_score"] > 0).tolist() == visible.tolist()
    _same_index(frame.index, idx)


@pytest.mark.parametrize("kind", ["UTC", IST, LA, "market"])
def test_same_instants_same_answer_across_tzs(kind):
    """For tz-aware bars only the instant matters, not the display tz."""
    ref = _wide_index(ET, "UTC")
    idx = _wide_index(ET, kind)
    assert (idx == ref).all()
    for filed, _ in _SEC_SOURCES.values():
        assert _fund([filed], idx).notna().tolist() == _fund([filed], ref).notna().tolist()
    ref_cn, idx_cn = _wide_index(CN, "UTC"), _wide_index(CN, kind)
    assert _rss_counts(idx_cn) == _rss_counts(ref_cn)
    assert _industry_labels("in", idx_cn) == _industry_labels("in", ref_cn)


# ── 3. US DST days and 1-minute bars at ET midnight (_ffill_pit) ──────────────


@pytest.mark.parametrize("day", ["2024-03-10", "2024-11-03"], ids=["spring-forward", "fall-back"])
@pytest.mark.parametrize("filed_offset", [0, 1], ids=["filed-on-DST-day", "filed-day-after"])
@pytest.mark.parametrize("kind", ["NY", "UTC", "naive"])
def test_ffill_pit_dst_days(day, filed_offset, kind):
    pit = D(day) + pd.Timedelta(days=filed_offset)
    if kind == "naive":
        idx = pd.date_range(D(day) - pd.Timedelta(hours=6), D(day) + pd.Timedelta(hours=40), freq="h")
    else:
        start = (D(day) - pd.Timedelta(hours=6)).tz_localize(ET)
        idx = pd.date_range(start, periods=47, freq="h")  # real instants, ET-aware
        if kind == "UTC":
            idx = idx.tz_convert("UTC")
    if day == "2024-11-03" and kind == "NY":
        assert idx.tz_localize(None).duplicated().any()  # repeated 01:00 wall hour
    out = _fund([pit.strftime("%Y-%m-%d")], idx)
    visible = _market_dates(idx, ET) >= pit
    assert out.notna().tolist() == visible.tolist()
    assert visible.any() and not visible.all()
    _same_index(out.index, idx)


@pytest.mark.parametrize("filed", ["2024-01-05", "2024-01-05T00:00:00Z"], ids=["naive", "Z"])
@pytest.mark.parametrize("kind", ["naive", "UTC", "market", IST, LA])
def test_ffill_pit_one_minute_bars_at_et_midnight(filed, kind):
    # 1m bars 23:58..00:02 ET (04:58Z..05:02Z); first visible bar is 00:00 ET.
    idx = pd.date_range("2024-01-04 23:58", periods=5, freq="min")
    if kind != "naive":
        idx = idx.tz_localize(ET)
        if kind != "market":
            idx = idx.tz_convert(kind)
    out = _fund([filed], idx)
    assert _nan_none(out.tolist()) == [None, None, 5.0, 5.0, 5.0]
    _same_index(out.index, idx)


# ── 4. rsshub pubDate -> knowable_date through query_events ───────────────────

_PUBDATE_TABLE = [
    ("Fri, 05 Jan 2024 10:00:00 GMT", "2024-01-06"),  # CN 18:00, after 16h cutoff
    ("Fri, 05 Jan 2024 10:00:00 -0500", "2024-01-06"),  # CN 01-05 23:00
    ("Fri, 05 Jan 2024 07:00:00 GMT", "2024-01-05"),  # CN 15:00, before cutoff
    ("Fri, 05 Jan 2024 10:00:00 +0800", "2024-01-05"),
    ("Fri, 05 Jan 2024 16:30:00 +0800", "2024-01-06"),
    ("Fri, 05 Jan 2024 23:30:00 +1300", "2024-01-06"),  # CN 18:30; wall rolls too
    ("2024-01-05 10:00:00", "2024-01-05"),  # naive = CN-local
]


@pytest.mark.parametrize(("pub", "knowable"), _PUBDATE_TABLE, ids=[p for p, _ in _PUBDATE_TABLE])
def test_rsshub_pubdate_knowable_date(pub, knowable):
    events = _rss_provider([pub]).query_events(["A"], as_of="2024-12-31")
    assert events["knowable_date"].dt.strftime("%Y-%m-%d").tolist() == [knowable]


@pytest.mark.parametrize(("pub", "knowable"), _PUBDATE_TABLE, ids=[p for p, _ in _PUBDATE_TABLE])
def test_rsshub_pubdate_not_visible_before_knowable(pub, knowable):
    # as_of on the day before excludes it; as_of on the knowable date admits it.
    provider = _rss_provider([pub])
    day_before = (D(knowable) - pd.Timedelta(days=1)).strftime("%Y-%m-%d")
    assert provider.query_events(["A"], as_of=day_before).empty
    assert len(provider.query_events(["A"], as_of=knowable)) == 1
    # End to end: naive CN bars 01-05 / 01-06 see it only from its knowable date.
    idx = pd.DatetimeIndex(["2024-01-05", "2024-01-06"])
    counts = _rss_frame(idx, provider=provider)["event_count"].tolist()
    assert counts == [1 if d >= D(knowable) else 0 for d in idx]


@pytest.mark.parametrize(
    ("as_of", "admitted"),
    [
        ("2024-01-05", True),  # naive: CN-local date
        ("2024-01-04", False),
        ("2024-01-05T00:30:00+08:00", True),
        ("2024-01-05T00:30:00+09:00", False),  # = CN 01-04 23:30: capped at CN date
        ("2024-01-04T16:00:00Z", False),  # CN 01-05 00:00 but displayed 01-04: min
        ("2024-01-05T10:00:00-05:00", True),
    ],
)
def test_rsshub_tz_aware_as_of_capped(as_of, admitted):
    events = _rss_provider(["2024-01-05 10:00:00"]).query_events(["A"], as_of=as_of)
    assert (len(events) == 1) is admitted


# ── 5. Caller's exact index preserved for tz-aware inputs, all units ──────────


@pytest.mark.parametrize("unit", UNITS)
@pytest.mark.parametrize("tz", ["UTC", ET, CN])
def test_tz_aware_index_preserved_all_loaders(unit, tz):
    idx = _wide_index(CN, "UTC", unit=unit).tz_convert(tz).rename("trade_date")
    assert str(idx.dtype) == f"datetime64[{unit}, {tz}]"
    _same_index(_fund(["2024-01-05T00:00:00Z"], idx).index, idx)
    _same_index(_industry("in", idx).index, idx)
    _same_index(_rss_frame(idx).index, idx)
    # Unsorted caller order is kept too.
    shuffled = idx[::-1]
    _same_index(_fund(["2024-01-05"], shuffled).index, shuffled)
    _same_index(_industry("in", shuffled).index, shuffled)
    _same_index(_rss_frame(shuffled).index, shuffled)


# ── 6. Guard ──────────────────────────────────────────────────────────────────


def test_guard_rejects_unsorted_non_nat_index():
    from vibe_bt.backtest.loaders.pit_calendar import PitCalendarError, assert_clean_datetime_index

    unsorted = pd.DatetimeIndex(["2024-01-05", "2024-01-03", "2024-01-04"])
    with pytest.raises(PitCalendarError, match="not monotonic"):
        assert_clean_datetime_index(unsorted, "t", monotonic=True)
    with pytest.raises(PitCalendarError, match="not monotonic"):
        assert_clean_datetime_index(pd.DatetimeIndex(["2024-01-05", pd.NaT, "2024-01-03"]), "t", monotonic=True)
    assert_clean_datetime_index(unsorted, "t")  # ordering only checked when asked
    # NaT is ignored for the ordering check.
    assert_clean_datetime_index(pd.DatetimeIndex(["2024-01-03", pd.NaT, "2024-01-05"]), "t", monotonic=True)


def test_guard_rejects_object_and_tz_aware_index():
    from vibe_bt.backtest.loaders.pit_calendar import PitCalendarError, assert_clean_datetime_index

    mixed = pd.Index([D("2024-01-03"), D("2024-01-05", tz="UTC")], dtype=object)
    with pytest.raises(PitCalendarError, match="object"):
        assert_clean_datetime_index(mixed, "t")
    with pytest.raises(PitCalendarError, match="tz-aware"):
        assert_clean_datetime_index(pd.DatetimeIndex(["2024-01-03"]).tz_localize("UTC"), "t")
    assert issubclass(PitCalendarError, RuntimeError)


@pytest.mark.parametrize("loader", ["ffill_pit", "industry", "rsshub"])
def test_guard_fires_instead_of_silent_join(monkeypatch, loader):
    """A tz-aware key leaking into a join raises, never silently ffills."""
    from vibe_bt.backtest.loaders.pit_calendar import PitCalendarError

    module = {"ffill_pit": F, "industry": I, "rsshub": R}[loader]
    monkeypatch.setattr(module, "market_calendar_index", lambda index, tz: pd.DatetimeIndex(index).tz_localize("UTC"))
    idx = pd.DatetimeIndex(["2024-01-04", "2024-01-05", "2024-01-06"])
    with pytest.raises(PitCalendarError):
        if loader == "ffill_pit":
            _fund(["2024-01-05"], idx)
        elif loader == "industry":
            _industry("in", idx)
        else:
            _rss_frame(idx)


def test_naive_index_with_nat_returns_float64():
    # Main parity: a naive index containing NaT is accepted (no guard trip).
    # The NaT bar takes the last value, exactly as on main (NaT sorts last in
    # the union); it has no date, so it is not a look-ahead on a dated bar.
    idx = pd.DatetimeIndex(["2024-01-04", pd.NaT, "2024-01-06", "2024-01-08"])
    out = _fund(["2024-01-05", "2024-01-07"], idx, [1.0, 2.0])
    assert out.dtype == np.float64
    assert _nan_none(out.tolist()) == [None, 2.0, 1.0, 2.0]
    _same_index(out.index, idx)


# ── 7. Naive byte-identity pins (hard-coded; same as pre-TM2-70 main) ─────────


def test_naive_pin_ffill_pit_daily():
    idx = pd.DatetimeIndex(["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05", "2024-01-08"], name="d")
    out = _fund(["2024-01-03", "2024-01-05T16:30:00", "2024-01-05"], idx, [1.0, 2.0, 3.0])
    assert out.dtype == np.float64
    assert _nan_none(out.tolist()) == [None, 1.0, 1.0, 3.0, 3.0]
    _same_index(out.index, idx)


@pytest.mark.parametrize("unit", UNITS)
def test_naive_pin_ffill_pit_intraday_units(unit):
    idx = pd.date_range("2024-01-04 22:00", periods=4, freq="2h", unit=unit)
    out = _fund(["2024-01-05"], idx, [7.0])
    assert _nan_none(out.tolist()) == [None, 7.0, 7.0, 7.0]
    assert out.index.dtype == idx.dtype


def test_naive_pin_ffill_pit_unsorted_index():
    idx = pd.DatetimeIndex(["2024-01-08", "2024-01-02", "2024-01-05", "2024-01-04"])
    out = _fund(["2024-01-03", "2024-01-05"], idx, [1.0, 2.0])
    assert _nan_none(out.tolist()) == [2.0, None, 2.0, 1.0]
    _same_index(out.index, idx)


def test_naive_pin_industry():
    idx = pd.DatetimeIndex(["2024-01-01", "2024-01-04", "2024-01-05", "2024-01-08"], name="trade_date")
    frame_in = _industry("in", idx)
    frame_out = _industry("out", idx)
    assert [None if isinstance(v, float) else v for v in frame_in["A"]] == [None, None, "Banks", "Banks"]
    assert [None if isinstance(v, float) else v for v in frame_out["A"]] == ["Old", "Old", None, None]
    assert str(frame_in["A"].dtype) == str(frame_out["A"].dtype) == "str"
    _same_index(frame_in.index, idx)
    _same_index(frame_out.index, idx)


def test_naive_pin_rsshub():
    idx = pd.DatetimeIndex(["2024-01-04", "2024-01-05", "2024-01-06", "2024-01-08"])
    frame = _rss_frame(idx, decay_lambda=0.5)
    assert frame["event_count"].tolist() == [0, 1, 1, 1]
    assert frame["event_score"].tolist() == [0.0, 1.0, math.exp(-0.5), math.exp(-1.5)]
    assert frame["event_score"].dtype == np.float64
    assert frame["event_count"].dtype == np.int64
    _same_index(frame.index, idx)
