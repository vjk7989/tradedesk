"""India index/stock options (NFO / BFO) backtest engine, daily bars.

Symbols look like ``NIFTY28NOV2524000CE@NFO`` (DDMONYY expiry) or
``NIFTY25NOV24000PE@NFO`` (YYMON monthly expiry); root, expiry, strike and
CE/PE are parsed from the symbol.

Model:
  - Positions are counted in whole lots. P&L = direction * lots * lot * (exit - entry)
    in PREMIUM terms, taken from the option's own price series (no pricing model).
  - Lot size: ``lot_sizes: {ROOT: int}`` override, else the india_fno fallback
    table (VERIFY CURRENT NSE LOT SIZES). A root in neither gets lot 1 with a
    warning and is listed under ``pricing_assumptions``.
  - Margin: a long position pays the full premium (leverage 1). A short position
    blocks ``opt_short_margin_pct`` (default 0.15) x underlying price x lot x lots.
    The underlying price is the close at or before the entry bar of the series
    mapped by config ``underlying: {ROOT: symbol}`` (frozen while the position is
    open), else the strike. A basket that does not fit the available
    capital is scaled down in whole lots by the base engine's fitter.
  - Expiry: ``YYMON`` monthly expiry is taken to be the LAST TUESDAY of the month
    (NSE moved index derivatives expiries to Tuesday from Sep 2025; VERIFY
    CURRENT; exchange-holiday shifts to the prior trading day are NOT modelled).
    On the first bar on/after expiry any open option is closed with reason
    ``expiry`` at intrinsic value against the underlying's close on the expiry
    date when config ``underlying: {ROOT: "<underlying symbol>"}`` maps the root
    and that series is in ``data_map``; otherwise at the option's last price.
    No new entries are taken on/after the expiry date. The expiry close goes
    through the normal cost stack (a simplification; real ITM expiry STT differs).
  - Symbols that do not parse as options are priced at lot 1 and never expire.

Costs on PREMIUM turnover, all overridable through ``in_opt_*`` keys (VERIFY
CURRENT RATES; tariffs change):
  - Brokerage: flat per order, default INR 20                   [in_opt_brokerage]
  - STT: 0.15% of premium, sell side only                       [in_opt_stt]
  - Exchange transaction charge: 0.03503% of premium (NSE)      [in_opt_exchange_txn]
  - SEBI turnover fee: INR 10/crore = 0.0001% of premium        [in_opt_sebi_fee]
  - Stamp duty: 0.003% of premium, buy side only                [in_opt_stamp_duty]
  - GST: 18% on (brokerage + exchange txn + SEBI fee)           [in_opt_gst]
"""

from __future__ import annotations

import calendar
import logging
import math
import re
from dataclasses import dataclass
from datetime import date
from typing import Any, Dict, Optional

import pandas as pd

from vibe_bt.backtest.engines.futures_base import FuturesBaseEngine
from vibe_bt.backtest.engines.india_fno import _FALLBACK_LOT_SIZES, _lot_size

logger = logging.getLogger(__name__)

_MONTHS = {m.upper(): i for i, m in enumerate(calendar.month_abbr) if m}
_MON = "|".join(_MONTHS)
_DMY = re.compile(rf"^([A-Z][A-Z0-9&\-]*?)(\d{{2}})({_MON})(\d{{2}})(\d+(?:\.\d+)?)(CE|PE)$")
_YM = re.compile(rf"^([A-Z][A-Z0-9&\-]*?)(\d{{2}})({_MON})(\d+(?:\.\d+)?)(CE|PE)$")


@dataclass(frozen=True)
class OptionSpec:
    root: str
    expiry: date
    strike: float
    kind: str  # "CE" | "PE"


def _last_tuesday(year: int, month: int) -> date:
    last = calendar.monthrange(year, month)[1]
    d = date(year, month, last)
    return date(year, month, last - (d.weekday() - 1) % 7)


def parse_option(symbol: str) -> Optional[OptionSpec]:
    """``NIFTY28NOV2524000CE@NFO`` -> spec; None when not an option symbol.

    ``28NOV25`` + ``24000`` and ``25NOV`` + ``24000`` are ambiguous in general
    (``25NOV24000`` could be day 25, year 24, strike 000). The DDMONYY reading is
    accepted only if it gives a valid date and a strike of >= 4 digits.
    """
    base = symbol.split("@", 1)[0].upper()
    m = _DMY.match(base)
    if m and len(m.group(5).split(".")[0]) >= 4:
        root, dd, mon, yy, strike, kind = m.groups()
        try:
            return OptionSpec(root, date(2000 + int(yy), _MONTHS[mon], int(dd)), float(strike), kind)
        except ValueError:
            return None  # weekly form with an impossible calendar date: no monthly fallback
    m = _YM.match(base)
    if m:
        root, yy, mon, strike, kind = m.groups()
        return OptionSpec(root, _last_tuesday(2000 + int(yy), _MONTHS[mon]), float(strike), kind)
    return None


def _non_negative(name: str, value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError(f"{name} must be a finite non-negative number, got {value!r}")
    return float(value)


class IndiaOptionsEngine(FuturesBaseEngine):
    """NFO / BFO options engine (see module docstring)."""

    def __init__(self, config: dict):
        super().__init__({**config, "leverage": 1.0})
        pct = _non_negative("opt_short_margin_pct", config.get("opt_short_margin_pct", 0.15))
        if not 0 < pct <= 1:
            raise ValueError("opt_short_margin_pct must be in (0, 1]")
        self.short_margin_pct = pct
        self.slippage_rate: float = _non_negative("slippage", config.get("slippage", 0.0005))
        self.lot_sizes: dict[str, int] = {
            **_FALLBACK_LOT_SIZES,
            **{str(k).upper(): _lot_size(k, v) for k, v in (config.get("lot_sizes") or {}).items()},
        }
        self.underlying: dict[str, str] = {
            str(k).upper(): str(v) for k, v in (config.get("underlying") or {}).items()
        }
        self._assumed_roots: set[str] = set()
        self._plan: dict[str, tuple[int, float]] = {}
        self._data_map: dict = {}
        self.in_opt_brokerage = _non_negative("in_opt_brokerage", config.get("in_opt_brokerage", 20.0))
        self.in_opt_stt = _non_negative("in_opt_stt", config.get("in_opt_stt", 0.0015))
        self.in_opt_exchange_txn = _non_negative("in_opt_exchange_txn", config.get("in_opt_exchange_txn", 0.0003503))
        self.in_opt_sebi_fee = _non_negative("in_opt_sebi_fee", config.get("in_opt_sebi_fee", 0.000001))
        self.in_opt_stamp_duty = _non_negative("in_opt_stamp_duty", config.get("in_opt_stamp_duty", 0.00003))
        self.in_opt_gst = _non_negative("in_opt_gst", config.get("in_opt_gst", 0.18))

    def get_contract_multiplier(self, symbol: str) -> float:
        spec = parse_option(symbol)
        root = spec.root if spec else symbol.split("@", 1)[0].upper()
        lot = self.lot_sizes.get(root)
        if lot is None:
            if root not in self._assumed_roots:
                self._assumed_roots.add(root)
                logger.warning(
                    "India options root %r has no lot size in config lot_sizes; assuming lot 1. "
                    "Set lot_sizes={%r: <current NSE lot>}.", root, root,
                )
            return 1.0
        return float(lot)

    def _engine_diagnostics(self) -> Dict[str, Any]:
        if not self._assumed_roots:
            return {}
        return {"pricing_assumptions": [
            {"product": r, "field": "lot_size", "value": 1} for r in sorted(self._assumed_roots)
        ]}

    # ── margin: long = premium, short = pct x underlying notional ──

    def before_rebalance_bar(self, timestamp, data_map, codes) -> bool:
        # _calc_margin has no data access; remember the bar being executed.
        self._data_map = data_map
        return False

    def note_plan(self, symbol: str, target_weight: float, ts) -> None:
        """Fix direction and short-margin basis for a position about to be planned.

        The basis (underlying price per unit) is the underlying close at or before
        ``ts`` when config ``underlying`` maps the root and that series is in the
        cached data_map, else the strike. It is frozen while the position is open so
        the margin debited at entry equals the margin credited at close. (The
        close of bar ``ts`` counts as "at or before"; no later bar is ever read.)
        """
        if symbol in self.positions:
            return
        spec = parse_option(symbol)
        basis = spec.strike if spec else 0.0
        if spec is not None:
            und = self._data_map.get(self.underlying.get(spec.root, ""))
            if und is not None and ts is not None:
                hist = und.loc[und.index <= ts, "close"]
                if len(hist):
                    basis = float(hist.iloc[-1])
        self._plan[symbol] = (1 if target_weight > 0 else -1, basis)

    def _plan_open_order(self, symbol, target_weight, df, ts, *args, **kwargs):
        self.note_plan(symbol, target_weight, ts)
        return super()._plan_open_order(symbol, target_weight, df, ts, *args, **kwargs)

    def _calc_margin(self, symbol: str, size: float, price: float, leverage: float) -> float:
        pos = self.positions.get(symbol)
        spec = parse_option(symbol)
        direction, basis = self._plan.get(symbol, (1, spec.strike if spec else 0.0))
        if pos is not None:
            direction = pos.direction
        if direction < 0 and spec is not None:
            return self.short_margin_pct * basis * self.get_contract_multiplier(symbol) * size
        return super()._calc_margin(symbol, size, price, leverage)

    # ── execution rules ──

    def can_execute(self, symbol: str, direction: int, bar: pd.Series) -> bool:
        spec = parse_option(symbol)
        if spec is not None and pd.Timestamp(bar.name).date() >= spec.expiry:
            return False
        return True

    def round_size(self, raw_size: float, price: float) -> float:
        return float(max(int(raw_size), 0))

    def apply_slippage(self, price: float, direction: int) -> float:
        return price * (1 + direction * self.slippage_rate)

    def calc_commission(self, size: float, price: float, direction: int, is_open: bool) -> float:
        notional = size * self.get_contract_multiplier(self._active_symbol) * price
        brokerage = self.in_opt_brokerage
        txn = notional * self.in_opt_exchange_txn
        sebi = notional * self.in_opt_sebi_fee
        comm = brokerage + txn + sebi + (brokerage + txn + sebi) * self.in_opt_gst
        is_buy = (direction > 0) if is_open else (direction < 0)
        return comm + notional * (self.in_opt_stamp_duty if is_buy else self.in_opt_stt)

    # ── expiry settlement ──

    @staticmethod
    def _upto_expiry(frame, spec: OptionSpec, col: str = "close") -> pd.Series:
        """Valid (non-NaN) ``col`` values on or before the expiry DATE (no look-ahead)."""
        cutoff = pd.Timestamp(spec.expiry) + pd.Timedelta(1, unit="D")
        if frame.index.tz is not None:
            cutoff = cutoff.tz_localize(frame.index.tz)
        return pd.to_numeric(frame.loc[frame.index < cutoff, col], errors="coerce").dropna()

    def _settlement_price(self, code: str, spec: OptionSpec, data_map, timestamp) -> float:
        und = data_map.get(self.underlying.get(spec.root, ""))
        if und is not None and len(und):
            hist = self._upto_expiry(und, spec)
            if len(hist):
                s = float(hist.iloc[-1])
                return max(s - spec.strike, 0.0) if spec.kind == "CE" else max(spec.strike - s, 0.0)
        # no underlying: last VALID option close on or before the expiry date
        closes = self._upto_expiry(data_map[code], spec)
        if len(closes):
            return float(closes.iloc[-1])
        logger.warning("%s: no valid premium at expiry %s and no underlying series; settling at 0", code, spec.expiry)
        return 0.0

    def settle_expired(self, host, data_map, timestamp, codes) -> None:
        """Close expired options on ``host`` (this engine, or the composite owning the book)."""
        for code in codes:
            pos = host.positions.get(code)
            spec = parse_option(code)
            if pos is None or spec is None or code not in data_map:
                continue
            if pd.Timestamp(timestamp).date() >= spec.expiry:
                price = self._settlement_price(code, spec, data_map, timestamp)
                host._close_position(code, price, timestamp, "expiry")

    def after_rebalance_bar(self, timestamp, data_map, codes) -> bool:
        stop = super().after_rebalance_bar(timestamp, data_map, codes)
        self.settle_expired(self, data_map, timestamp, codes)
        return stop
