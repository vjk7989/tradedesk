"""Shared intraday session rules for the India equity and F&O engines.

Bar timestamps are read as IST wall-clock time. Naive timestamps are assumed to
already be IST; tz-aware ones are converted. ``1M`` (month) is not intraday.

  - NSE/BSE session 09:15-15:30; MCX futures session 09:00-23:30.
  - MIS positions are squared off at the last bar at or before 15:20 each day
    (MCX: 23:20, i.e. ten minutes before its close; adjust if your broker differs).
"""

from __future__ import annotations

import re
from datetime import time

import pandas as pd

_INTRADAY_RE = re.compile(r"^\d+[mHh]$")  # "1M" (month) deliberately does not match

NSE_OPEN, NSE_CLOSE, NSE_SQUAREOFF = time(9, 15), time(15, 30), time(15, 20)
MCX_OPEN, MCX_CLOSE, MCX_SQUAREOFF = time(9, 0), time(23, 30), time(23, 20)


def is_intraday(interval) -> bool:
    return bool(_INTRADAY_RE.match(str(interval or "1D").strip()))


def resolve_product(config: dict, market: str) -> str:
    """Product for ``market`` ("india_equity" / "india_fno"), validated.

    ``config["product_by_market"][market]`` overrides the run-level ``product``.
    Equity accepts CNC (default) / MIS; F&O accepts NRML (default) / MIS, and
    CNC as a non-MIS alias so one run-level CNC works in a composite basket.
    """
    by_market = config.get("product_by_market") or {}
    raw = by_market.get(market, config.get("product"))
    if raw is None:
        return "CNC" if market == "india_equity" else "NRML"
    product = str(raw).strip().upper()
    allowed = {"CNC", "MIS"} if market == "india_equity" else {"CNC", "NRML", "MIS"}
    if product not in allowed:
        raise ValueError(f"unsupported product {raw!r} for {market}; use one of {sorted(allowed)}")
    return product


def _is_mcx(symbol: str) -> bool:
    return str(symbol).upper().endswith("@MCX")


def _ist_time(ts) -> time | None:
    try:
        t = pd.Timestamp(ts)
    except Exception:
        return None
    if t is pd.NaT:
        return None
    if t.tzinfo is not None:
        t = t.tz_convert("Asia/Kolkata")
    return t.time()


def in_session(ts, symbol: str = "") -> bool:
    """True when ``ts`` lies in the symbol's trading session (unknown time -> True)."""
    t = _ist_time(ts)
    if t is None:
        return True
    lo, hi = (MCX_OPEN, MCX_CLOSE) if _is_mcx(symbol) else (NSE_OPEN, NSE_CLOSE)
    return lo <= t <= hi


def after_squareoff(ts, symbol: str = "") -> bool:
    """True when ``ts`` is at or past the MIS square-off time."""
    t = _ist_time(ts)
    if t is None:
        return False
    return t >= (MCX_SQUAREOFF if _is_mcx(symbol) else NSE_SQUAREOFF)


def squareoff_bars(index: pd.DatetimeIndex, symbol: str = "") -> set:
    """Timestamps that are the last bar at or before the square-off time of their day."""
    limit = MCX_SQUAREOFF if _is_mcx(symbol) else NSE_SQUAREOFF
    last: dict = {}
    for ts in index:
        t = _ist_time(ts)
        if t is None or t > limit:
            continue
        day = pd.Timestamp(ts).date()
        if day not in last or ts > last[day]:
            last[day] = ts
    return set(last.values())


def squareoff_all(engine, data_map, timestamp, codes) -> None:
    """Close every open position whose data has ``timestamp`` as its square-off bar."""
    cache = engine.__dict__.setdefault("_squareoff_cache", {})
    for code in codes:
        pos = engine.positions.get(code)
        frame = data_map.get(code)
        if pos is None or frame is None or timestamp not in frame.index:
            continue
        if code not in cache:
            cache[code] = squareoff_bars(frame.index, code)
        if timestamp not in cache[code]:
            continue
        close = float(frame.loc[timestamp, "close"])
        engine._active_symbol = code
        engine._close_position(
            code, engine._execution_price(close, -pos.direction), timestamp, "mis_squareoff"
        )
