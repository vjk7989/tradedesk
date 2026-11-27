"""OpenAlgo history loader (NSE/BSE equities, NFO/BFO/MCX/CDS derivatives, CRYPTO).

Local addition (not in upstream Vibe-Trading). Talks to an OpenAlgo server:
``POST {OPENALGO_URL}/api/v1/history``. Configured by env ``OPENALGO_URL`` and
``OPENALGO_API_KEY``; when either is missing the loader reports unavailable so
the fallback chain moves on.

Symbols handled: ``RELIANCE.NS`` (NSE), ``500325.BO`` (BSE), and the explicit
``SYMBOL@EXCHANGE`` form (``NIFTY28NOV2524000CE@NFO``). Anything else is skipped.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Dict, List, Optional, Tuple

import httpx
import pandas as pd

from vibe_bt.backtest.loaders.base import NoAvailableSourceError, validate_date_range
from vibe_bt.backtest.loaders.registry import register

logger = logging.getLogger(__name__)

_TIMEOUT_S = 30
_OUTPUT_COLUMNS = ["open", "high", "low", "close", "volume"]
_INTERVAL_MAP = {
    "1m": "1m",
    "3m": "3m",
    "5m": "5m",
    "10m": "10m",
    "15m": "15m",
    "30m": "30m",
    "1h": "1h",
    "1H": "1h",
    "1D": "D",
    "1d": "D",
    "D": "D",
}
_BASE = re.compile(r"^[A-Za-z0-9&_\-]+$")
_EXPLICIT = re.compile(r"^([A-Za-z0-9&_\-]+)@([A-Za-z]+)$")
_EXCHANGES = {"NSE", "BSE", "NFO", "BFO", "CDS", "BCD", "MCX", "CRYPTO"}


def _map_symbol(code: str) -> Optional[Tuple[str, str]]:
    """Return ``(symbol, exchange)`` for a project symbol, or ``None`` if not ours."""
    text = code.strip()
    explicit = _EXPLICIT.match(text)
    if explicit:
        exchange = explicit.group(2).upper()
        return (explicit.group(1), exchange) if exchange in _EXCHANGES else None
    upper = text.upper()
    for suffix, exchange in ((".NS", "NSE"), (".BO", "BSE")):
        if upper.endswith(suffix):
            base = text[: -len(suffix)]
            return (base, exchange) if _BASE.match(base) else None
    return None


def _settings() -> Optional[Tuple[str, str]]:
    url = (os.environ.get("OPENALGO_URL") or "").strip().rstrip("/")
    key = (os.environ.get("OPENALGO_API_KEY") or "").strip()
    return (url, key) if url and key else None


def _to_frame(rows: list, interval: str) -> Optional[pd.DataFrame]:
    if not rows:
        return None
    frame = pd.DataFrame(rows)
    if "timestamp" not in frame.columns:
        return None
    ts = pd.to_numeric(frame["timestamp"], errors="coerce")
    if ts.notna().all():  # epoch: >1e11 is milliseconds, else seconds
        unit = "ms" if ts.abs().max() > 1e11 else "s"
        index = pd.DatetimeIndex(pd.to_datetime(ts, unit=unit, utc=True))
    else:  # ISO strings; naive ones are IST wall clock
        index = pd.DatetimeIndex(pd.to_datetime(frame["timestamp"].astype(str), errors="coerce", utc=False))
    if index.tz is not None:
        index = index.tz_convert("Asia/Kolkata").tz_localize(None)
    if interval == "D":
        index = index.normalize()
    frame = frame.drop(columns=["timestamp"])
    frame.index = index
    frame.index.name = "trade_date"
    for col in _OUTPUT_COLUMNS:
        if col not in frame.columns:
            frame[col] = 0.0 if col == "volume" else pd.NA
    frame = frame[_OUTPUT_COLUMNS].apply(pd.to_numeric, errors="coerce")
    frame = frame.dropna(subset=["open", "high", "low", "close"])
    frame = frame[~frame.index.isna()].sort_index()
    frame = frame[~frame.index.duplicated(keep="last")]
    return frame.astype(float) if not frame.empty else None


@register
class DataLoader:
    """OpenAlgo REST history adapter."""

    name = "openalgo"
    markets = {"india_equity", "india_fno", "crypto"}
    requires_auth = True

    def __init__(self) -> None:
        pass

    def is_available(self) -> bool:
        return _settings() is not None

    def _fetch_one(self, base: str, key: str, symbol: str, exchange: str, interval: str,
                   start_date: str, end_date: str) -> Optional[pd.DataFrame]:
        body = {
            "apikey": key,
            "symbol": symbol,
            "exchange": exchange,
            "interval": interval,
            "start_date": start_date,
            "end_date": end_date,
        }
        try:
            with httpx.Client(timeout=_TIMEOUT_S) as client:
                resp = client.post(f"{base}/api/v1/history", json=body)
            if resp.status_code != 200:
                raise NoAvailableSourceError(f"openalgo history HTTP {resp.status_code} for {symbol}@{exchange}")
            payload = resp.json()
        except NoAvailableSourceError:
            raise
        except Exception as exc:  # noqa: BLE001 - never leak request body / apikey
            msg = str(exc).replace(key, "***")
            raise NoAvailableSourceError(f"openalgo request failed for {symbol}@{exchange}: {type(exc).__name__}: {msg}") from None
        if not isinstance(payload, dict) or str(payload.get("status", "")).lower() != "success":
            detail = str(payload.get("message", "")) if isinstance(payload, dict) else ""
            raise NoAvailableSourceError(f"openalgo history error for {symbol}@{exchange}: {detail}".replace(key, "***"))
        data = payload.get("data")
        return _to_frame(data if isinstance(data, list) else [], interval)

    def fetch(
        self,
        codes: List[str],
        start_date: str,
        end_date: str,
        *,
        interval: str = "1D",
        fields: Optional[List[str]] = None,
    ) -> Dict[str, pd.DataFrame]:
        del fields
        if not codes:
            return {}
        validate_date_range(start_date, end_date)
        settings = _settings()
        if settings is None:
            return {}
        oa_interval = _INTERVAL_MAP.get(str(interval).strip())
        if oa_interval is None:
            logger.warning("openalgo does not support interval=%r", interval)
            return {}
        base, key = settings
        start_date, end_date = pd.Timestamp(start_date).strftime("%Y-%m-%d"), pd.Timestamp(end_date).strftime("%Y-%m-%d")
        result: Dict[str, pd.DataFrame] = {}
        for code in codes:
            mapped = _map_symbol(code)
            if mapped is None:
                continue
            try:
                frame = self._fetch_one(base, key, mapped[0], mapped[1], oa_interval, start_date, end_date)
            except Exception as exc:  # noqa: BLE001 - skip symbol so the chain falls through
                logger.warning("%s", str(exc).replace(key, "***"))
                continue
            if frame is not None:
                result[code] = frame
        return result
