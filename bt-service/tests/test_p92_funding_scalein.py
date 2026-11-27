"""P9.2: crypto funding cursor survives scale-in / partial reduce."""
from types import SimpleNamespace
from unittest.mock import MagicMock

import pandas as pd

from vibe_bt.backtest.engines._market_hooks import calc_crypto_funding_fee
from vibe_bt.backtest.engines.base import BaseEngine, _OpenOrder
from vibe_bt.backtest.models import Position

SWAP = "BTC-USDT-SWAP"
T = pd.Timestamp
BAR = pd.Series({"close": 100.0})


def _fee(ts, positions, applied):
    return calc_crypto_funding_fee(SWAP, BAR, T(ts), positions, 0.0001, applied, set(), 1 / 60)


def _scale_in(positions):
    eng = MagicMock()
    eng.positions = positions
    eng.available_cash.return_value = 1e9
    order = SimpleNamespace(symbol=SWAP, direction=1, size=1.0, price=100.0, cost=0.0,
                            commission=0.0, margin=0.0, leverage=1.0)
    BaseEngine._execute_position_increase(eng, order, T("2024-03-04 08:05"))


def _reduce(positions):
    eng = MagicMock()
    eng.positions = positions
    order = SimpleNamespace(before=positions[SWAP], target_size=1.0, price=100.0,
                            released_margin=0.0, realized_pnl=0.0, exit_commission=0.0,
                            capital_credit=0.0)
    eng.capital = 0.0
    eng.trades = []
    BaseEngine._execute_partial_reduction(eng, order, T("2024-03-04 08:05"))


def _held():
    return {SWAP: Position(SWAP, 1, 100.0, T("2024-03-04"), 2.0)}


def test_scale_in_gap_charges_slot_once():
    pos, applied = _held(), set()
    total = _fee("2024-03-04 07:55", pos, applied)
    _scale_in(pos)
    assert pos[SWAP].size == 3.0
    total += _fee("2024-03-04 08:05", pos, applied)
    ctl = {SWAP: Position(SWAP, 1, 100.0, T("2024-03-04"), 3.0)}
    object.__setattr__(ctl[SWAP], "_funding_last_ts", T("2024-03-04 07:55"))
    control = _fee("2024-03-04 08:05", ctl, set())
    assert control != 0.0
    assert total == control  # one slot, charged on the scaled size
    assert _fee("2024-03-04 08:06", pos, applied) == 0.0


def test_reduce_keeps_cursor():
    pos, applied = _held(), set()
    _fee("2024-03-04 07:55", pos, applied)
    _reduce(pos)
    assert pos[SWAP].size == 1.0
    assert pos[SWAP]._funding_last_ts == T("2024-03-04 07:55")
    assert _fee("2024-03-04 08:05", pos, applied) != 0.0


def test_scale_in_keeps_cursor_and_dense_unchanged():
    pos, applied = _held(), set()
    _fee("2024-03-04 07:55", pos, applied)
    _scale_in(pos)
    assert pos[SWAP]._funding_last_ts == T("2024-03-04 07:55")
    dense, applied2, p2 = 0.0, set(), _held()
    for ts in pd.date_range("2024-03-04 07:50", "2024-03-04 08:10", freq="1min"):
        dense += _fee(ts, p2, applied2)
    assert dense != 0.0


def test_new_position_starts_fresh():
    pos, applied = _held(), set()
    _fee("2024-03-04 07:55", pos, applied)
    fresh = Position(SWAP, 1, 100.0, T("2024-03-04 08:05"), 1.0)
    assert getattr(fresh, "_funding_last_ts", None) is None
