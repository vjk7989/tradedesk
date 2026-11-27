# TM-1 report
Status: blocked
Branch: tm/TM-1   Commit: 34ce7ea
Files: bt-service/tests/test_tm1_mis_stamp.py (+78/-0), bt-service/vibe_bt/backtest/engines/india_equity.py (+16/-2)
Verify: `uv run pytest -q tests/test_tm1_mis_stamp.py` → pass (11 passed)
`uv run pytest -q tests/test_intraday.py tests/test_intraday_edge.py` → FAIL
```
FAILED tests/test_intraday.py::test_mis_stt_sell_side_only - assert 0.3 == 0.0
FAILED tests/test_intraday_edge.py::test_mis_stt_hand_computed_round_trip_defaults
FAILED tests/test_intraday_edge.py::test_mis_no_stt_on_buy_short_cover
FAILED tests/test_intraday_edge.py::test_stamp_duty_unchanged_by_mis
FAILED tests/test_intraday_edge.py::test_mis_run_commission_matches_hand_rates
```
Full suite not run: it can't go green until the conflict below is resolved.

Notes / decisions:
- MIS (intraday interval + product MIS) buy-side stamp uses `in_mis_stamp_duty` (default 0.00003, "verify current rate"). CNC and 1D still use `in_stamp_duty` (0.00015). Sell side has no stamp, as before.
- `in_mis_stamp_duty` that is negative, NaN, ±inf, non-numeric or bool raises ValueError in the engine's `__init__`. `run_backtest` then returns ok False. The bool and non-numeric checks were added so `True` or a string can't slip past `math.isfinite`.
- New tests: MIS buy and sell stamp, CNC/1D unchanged, override, invalid values (parametrized), a hand-computed MIS round trip at default rates, and an offline end-to-end runner check (RELIANCE.NS mapped to the aapl.csv fixture) with a passing control run.
- developers: 1 sonnet, fix rounds: 0

Questions for orchestrator (why blocked):
The AC "all existing tests stay green" conflicts with the intended change. The 5 tests above hard-code that MIS stamp equals the delivery rate (0.015%), e.g. `test_stamp_duty_unchanged_by_mis`. Some also zero stamp via `in_stamp_duty: 0`, which no longer zeroes MIS stamp. The brief forbids editing existing test files. Suggested resolution: allow updating those 5 tests, either by adding `in_mis_stamp_duty: 0` where stamp should be zeroed or by changing expected MIS stamp to 0.003%. Or the owner's side updates them. Please add them to the task's file list or advise.
