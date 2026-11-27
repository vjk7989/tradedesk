import decimal

import numpy as np
import pytest

from vibe_bt.backtest.engines.india_equity import IndiaEquityEngine


def _mk(v):
    return IndiaEquityEngine({"in_mis_stamp_duty": v})


@pytest.mark.parametrize("v", [np.float64(0.00003), np.int64(0), 0, 0.5, np.float32(0.1)])
def test_accepts_real_numbers(v):
    assert _mk(v).in_mis_stamp_duty == v


@pytest.mark.parametrize("v", [True, "0.1", None, float("nan"), float("inf"), -1, np.float64(-0.1),
                               decimal.Decimal("0.00003")])
def test_rejects(v):
    with pytest.raises(ValueError):
        _mk(v)
