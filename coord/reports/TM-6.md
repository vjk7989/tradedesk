# TM-6 report
Status: done
Branch: tm/TM-6   Commit: ceb5f5c
Files: bt-service/vibe_bt/backtest/engines/india_equity.py (+2/-1), agent-runner/src/main.ts (+7/-7), bt-service/tests/test_tm6_numbers.py (new), agent-runner/test/tm6_once_exit.test.ts (new)
Verify:
- pytest tests/test_tm6_numbers.py tests/test_tm1_edge.py tests/test_tm1_mis_stamp.py → 60 passed
- bt-service full: 1020 passed (6m40s)
- agent-runner vitest: 268 passed; tsc --noEmit clean
Decisions:
- in_mis_stamp_duty is validated with numbers.Real. np.float64, np.int64 and np.float32 are accepted. bool, str, None, nan, inf and negatives are rejected.
- decimal.Decimal is NOT a numbers.Real (not registered), so it is rejected with ValueError. A test asserts this.
- main.ts: the exited/bye() guard now sits above the --once branch, and --once registers onSignal(sig, bye). Two signals call exit(0) exactly once.
developers: 1 sonnet, fix rounds: 0

## Fix round 1
Commit: b05f91e. File: bt-service/vibe_bt/backtest/engines/india_equity.py (in_mis_stamp_duty check only).
1. Validity is now `not bool and numbers.Real`, then `math.isfinite(float(v)) and v >= 0` inside try/except OverflowError. 10**400, -(10**400) and Fraction(10**400, 3) now raise the same ValueError.
2. The message uses reprlib.Repr (maxlong/maxstring/maxother = 80), so huge inputs aren't echoed.
Unchanged: bool, np.bool_, str, None, Decimal, nan, inf and negatives are rejected; Fraction and numpy reals are accepted.
Verify: tests/test_tm6_edge.py + test_tm6_numbers.py + test_tm1_edge.py → 127 passed; full bt-service 1098 passed (6m57s).
developers: 1 sonnet (same), fix rounds: 1
