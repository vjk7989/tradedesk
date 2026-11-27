# TM-1 · bt-service · use the intraday stamp duty rate for MIS trades
Branch: tm/TM-1        Base: main @ 46000ed
Owner: TM1

## Files you may touch (≤5)
- `bt-service/vibe_bt/backtest/engines/india_equity.py`
- `bt-service/tests/test_tm1_mis_stamp.py` (new)

## Do not touch
Any other file. In particular, no existing test files.

## Context (read only these)
- `bt-service/vibe_bt/backtest/engines/india_equity.py:20-90`:
  - the cost docstring (`:25` stamp duty 0.015% on buy only, key `in_stamp_duty`);
  - `__init__` cost fields (`:73` `self.in_stamp_duty`);
  - the `product`/`mis` handling and `in_mis_stt`;
  - `after_rebalance_bar` (`:83-86`).
- `bt-service/vibe_bt/backtest/engines/india_session.py`: `resolve_product`, `is_intraday`.
- ADR-13 in `architecture-record-document.md`. Its "MIS stamp duty uses the delivery rate" is the open item you fix.

## What to build
For MIS trades only, intraday equity stamp duty is 0.003% on the buy side. Mark it "verify current rate" in a comment.
- Add a config key `in_mis_stamp_duty` (default 0.00003).
- When the engine's product is MIS, use it instead of `in_stamp_duty`.
- CNC keeps `in_stamp_duty` (0.00015). Daily (1D) runs are unchanged.

## Acceptance criteria
- MIS buy stamp = notional × 0.00003, and MIS sell stamp = 0. CNC buy stamp = notional × 0.00015, unchanged.
- `in_mis_stamp_duty` can be overridden through `costs`. A negative or non-finite value raises `ValueError`, so the run returns ok False.
- Write a hand-computed MIS round-trip cost test: buy and sell one position at known prices, including STT (`in_mis_stt`), exchange fee, SEBI fee and GST, exactly as the engine computes them today. Read the engine's cost function to get the exact formula.
- All existing tests stay green.

## Verify (must pass before you report)
```
cd bt-service && uv sync && uv run pytest -q tests/test_tm1_mis_stamp.py && uv run pytest -q
```
The full suite takes about 5 minutes.

YAGNI: no other cost changes, no new dependencies.
