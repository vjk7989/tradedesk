# TM-6 · review follow-ups from TM-1 and TM-2 (two tiny independent fixes)
Branch: tm/TM-6        Base: main (latest)        Owner: TM1

## Files you may touch
- `bt-service/vibe_bt/backtest/engines/india_equity.py`: only the `in_mis_stamp_duty` validation block (around lines 82-89).
- `agent-runner/src/main.ts`: only the `--once` signal handler (around lines 30-40).
- New tests: `bt-service/tests/test_tm6_numbers.py` and `agent-runner/test/tm6_once_exit.test.ts`.

## What to build
1. **india_equity:** accept any real number type, including numpy ints and floats, for `in_mis_stamp_duty` using `numbers.Real`. Keep rejecting bool, str, None, non-finite values and negatives.
2. **main.ts:** the `--once` SIGINT/SIGTERM handler must go through the same exit-at-most-once guard (`bye()`/`exited`) as scheduler mode, so a second signal never calls `exit` twice.

## Acceptance criteria
- `np.float64(0.00003)`, `np.int64(0)` and `Decimal`? No: Decimal is not a `numbers.Real` in the ABC sense, so check and document what you find. The two numpy values above must be accepted.
- True, "0.00003", -1, nan and inf are still rejected.
- `--once` with two signals calls `exit(0)` exactly once.
- All existing tests stay green, including `tests/test_tm1_edge.py` and `test/tm2_signals.edge.test.ts`.

## Verify
```
cd bt-service && uv run pytest -q tests/test_tm6_numbers.py tests/test_tm1_edge.py tests/test_tm1_mis_stamp.py
cd agent-runner && npm ci && npx vitest run && npx tsc --noEmit
```
