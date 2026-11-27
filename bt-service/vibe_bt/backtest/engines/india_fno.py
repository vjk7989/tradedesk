"""India F&O futures (NFO / BFO / MCX) backtest engine, daily bars.

Scope: **futures only** (symbols such as ``NIFTY25DECFUT@NFO``). Options are out
of scope for this engine. Intraday intervals ignore bars outside the session
(NSE/BFO 09:15-15:30 IST, MCX 09:00-23:30). Positions are held overnight
(NRML) unless ``product: "MIS"``, which squares off at the last bar <= 15:20 IST
(MCX 23:20) with reason ``mis_squareoff``.

Model:
  - Positions are counted in lots (contracts). One contract = ``lot`` units of
    the underlying, so P&L = direction * lots * lot * (exit - entry) and the
    sizing rule is ``lots = floor(equity * |weight| * leverage / (price * lot))``
    with ``leverage = 1 / margin_pct``.
  - Margin: ``margin_pct`` (default 0.15, a flat SPAN+exposure approximation).
    Equity is marked to market every bar by the base engine. A basket that does
    not fit the available margin is scaled down by the base engine's fitter
    (whole lots, with a warning) - nothing opens beyond available margin.
  - Shorting is allowed (futures); no T+1 and no circuit bands.

Lot sizes (``lot_sizes: {ROOT: int}`` in config, root = symbol without expiry
and FUT, e.g. NIFTY). VERIFY CURRENT NSE LOT SIZES: the built-in fallback table
below is only a convenience, lot sizes are revised periodically. A root absent
from both config and the table is priced at lot 1 with a warning and is listed
under ``pricing_assumptions`` in the run metrics.

Costs, all overridable through ``in_fno_*`` config keys. VERIFY CURRENT RATES;
tariffs change:
  - Brokerage: flat per order, default INR 20                   [in_fno_brokerage]
  - STT: 0.02% of notional, sell side only                      [in_fno_stt]
  - Exchange transaction charge: 0.00183% of notional           [in_fno_exchange_txn]
  - SEBI turnover fee: INR 10/crore = 0.0001% of notional       [in_fno_sebi_fee]
  - Stamp duty: 0.002% of notional, buy side only               [in_fno_stamp_duty]
  - GST: 18% on (brokerage + exchange txn + SEBI fee)           [in_fno_gst]
"""

from __future__ import annotations

import logging
import re
from typing import Any, Dict

import pandas as pd

from vibe_bt.backtest.engines.futures_base import FuturesBaseEngine
from vibe_bt.backtest.engines.india_session import (
    after_squareoff,
    in_session,
    is_intraday,
    resolve_product,
    squareoff_all,
)

logger = logging.getLogger(__name__)

# VERIFY CURRENT NSE LOT SIZES before relying on results; override via config["lot_sizes"].
_FALLBACK_LOT_SIZES = {"NIFTY": 75, "BANKNIFTY": 35}

_EXPIRY_RE = re.compile(r"\d{2}[A-Z]{3}(?:\d{2})?$")


def fno_root(symbol: str) -> str:
    """``NIFTY25DECFUT@NFO`` / ``NIFTY28NOV25FUT`` -> ``NIFTY``."""
    base = symbol.split("@", 1)[0].upper()
    if base.endswith("FUT"):
        base = base[:-3]
    return _EXPIRY_RE.sub("", base)


def _lot_size(root: Any, value: Any) -> int:
    """Lot sizes are positive integers (an exact-integer float such as 75.0 is accepted)."""
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"lot size for {root} must be a positive integer, got {value!r}")
    return value


class IndiaFnoEngine(FuturesBaseEngine):
    """NFO / BFO / MCX futures engine (see module docstring)."""

    def __init__(self, config: dict):
        margin_pct = float(config.get("margin_pct", 0.15))
        if not 0 < margin_pct <= 1:
            raise ValueError("margin_pct must be in (0, 1]")
        self.margin_pct = margin_pct
        super().__init__({**config, "leverage": 1.0 / margin_pct})
        self.slippage_rate: float = config.get("slippage", 0.0005)
        self.lot_sizes: dict[str, int] = {
            **_FALLBACK_LOT_SIZES,
            **{str(k).upper(): _lot_size(k, v) for k, v in (config.get("lot_sizes") or {}).items()},
        }
        self._assumed_roots: set[str] = set()
        self.intraday: bool = is_intraday(config.get("interval", "1D"))
        self.product: str = resolve_product(config, "india_fno")  # validates even at 1D
        self.mis: bool = self.intraday and self.product == "MIS"
        self.in_fno_brokerage: float = config.get("in_fno_brokerage", 20.0)
        self.in_fno_stt: float = config.get("in_fno_stt", 0.0002)
        self.in_fno_exchange_txn: float = config.get("in_fno_exchange_txn", 0.0000183)
        self.in_fno_sebi_fee: float = config.get("in_fno_sebi_fee", 0.000001)
        self.in_fno_stamp_duty: float = config.get("in_fno_stamp_duty", 0.00002)
        self.in_fno_gst: float = config.get("in_fno_gst", 0.18)

    def get_contract_multiplier(self, symbol: str) -> float:
        """Units per contract (the lot size) for the symbol's root."""
        root = fno_root(symbol)
        lot = self.lot_sizes.get(root)
        if lot is None:
            if root not in self._assumed_roots:
                self._assumed_roots.add(root)
                logger.warning(
                    "India F&O root %r has no lot size in config lot_sizes; assuming lot 1. "
                    "Set lot_sizes={%r: <current NSE lot>}.",
                    root,
                    root,
                )
            return 1.0
        return float(lot)

    def _engine_diagnostics(self) -> Dict[str, Any]:
        if not self._assumed_roots:
            return {}
        return {
            "pricing_assumptions": [
                {"product": r, "field": "lot_size", "value": 1} for r in sorted(self._assumed_roots)
            ]
        }

    def can_execute(self, symbol: str, direction: int, bar: pd.Series) -> bool:
        """Futures trade T+0 in both directions; no price bands are modelled.

        Intraday: bars outside the session are ignored; MIS takes no new
        entries from the square-off time on.
        """
        if self.intraday:
            if not in_session(bar.name, symbol):
                return False
            if self.mis and direction != 0 and after_squareoff(bar.name, symbol):
                return False
        return True

    def after_rebalance_bar(self, timestamp, data_map, codes) -> bool:
        stop = super().after_rebalance_bar(timestamp, data_map, codes)
        if self.mis:
            squareoff_all(self, data_map, timestamp, codes)
        return stop

    def round_size(self, raw_size: float, price: float) -> float:
        """Whole lots, rounded down."""
        return float(max(int(raw_size), 0))

    def calc_commission(self, size: float, price: float, direction: int, is_open: bool) -> float:
        lot = self.get_contract_multiplier(self._active_symbol)
        notional = size * lot * price
        brokerage = self.in_fno_brokerage  # flat per order
        txn = notional * self.in_fno_exchange_txn
        sebi = notional * self.in_fno_sebi_fee
        gst = (brokerage + txn + sebi) * self.in_fno_gst
        comm = brokerage + txn + sebi + gst
        # The trade side follows open/close and the position direction (see IndiaEquityEngine).
        is_buy = (direction > 0) if is_open else (direction < 0)
        if is_buy:
            comm += notional * self.in_fno_stamp_duty
        else:
            comm += notional * self.in_fno_stt
        return comm

    def apply_slippage(self, price: float, direction: int) -> float:
        return price * (1 + direction * self.slippage_rate)
