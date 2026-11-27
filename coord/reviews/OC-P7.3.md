# OC-P7.3 review

## Code review (Sonnet)

Verdict: changes-needed (no blockers; two majors).

1. major - bt-service/bt_service/walkforward.py:74-102 (train/test run calls). Windows are half-open [s,e), but `end=e.isoformat()` is passed to run_backtest, which treats end as inclusive (confirm in runner/engine). The boundary day then appears in both the train run (end=tr_e) and the test run (start=te_s). That is a one-bar overlap and mild leakage of the test's first bar into selection. Fix: pass `(e - timedelta(days=1)).isoformat()` as run `end` and keep the reported fold dates half-open. Otherwise document inclusivity. Update the tests that assert the `end` kwarg.
2. major - bt_service/app.py:192-218 and walkforward.py (whole loop). Worst case is 60 runs x BT_TIMEOUT_S (120 s) = 7200 s while holding the semaphore. Any HTTP client or proxy times out first, yet the threadpool job keeps running and keeps the semaphore, so abandoned requests starve /backtest. Fix: add a server-side total deadline (e.g. `deadline = monotonic() + BT_WF_TIMEOUT_S`, default ~600 s), pass `min(timeout_s, remaining)` to each run, and return `{ok:False,error:"walk-forward time budget exceeded"}` when it is spent. Alternatively cap MAX_RUNS lower. Add a test with a fake clock.
3. minor - walkforward.py:84-88. Failed train runs are silently dropped. When all fail, the error "no candidate produced a finite sharpe" hides the cause (e.g. a code error). Fix: keep the first `res.get("error")` and append it to the fold error.
4. minor - walkforward.py:123-136 (equity chaining). Math is right: scale=prev_last/first, and `first` of 0, None or an empty list falls back to scale 1.0. But a fold whose first equity is 0 produces a silent discontinuity. Also the fold's first point already embeds day-1 return, so chaining by the first point drops that return. Acceptable per brief. Add a warning when a fold is not rescaled, and a test for first==0 and for empty equity (neither is covered).
5. minor - walkforward.py:146-150. mean_test_<metric> silently excludes folds whose test metric is missing or non-finite, so "folds" and the mean's N can diverge. Fix: add `scored_folds` to summary, or warn.
6. minor - tests/test_walkforward.py (route section). The route fixture replaces walk_forward, so these cases are not covered: 429 busy, semaphore released after an exception, body cap on /walkforward. Add a busy test (BT_MAX_CONCURRENCY=1 with a blocked fake) and an exception-release test. The tests as written are real, not tautological: the TEST-star-vs-TRAIN-star test, the tie test, the 60/66 run boundary and the equity chaining values all assert concrete numbers.
7. minor - walkforward.py:21-24. train_days and test_days are calendar days, so 20 calendar days is about 14 daily bars. That may be too few for the sharpe or calmar to be meaningful. Document it in the docstring (no code change).

Verified OK:
- Fold arithmetic: loop condition `t0+train+test <= d1` and step by test_days; exact fit gives 1 fold, one day short gives none; the last fold never passes `end`.
- Selection: strict `>` on train scores only, so ties go to the first candidate; non-finite and bool values are skipped via `_finite`; the test run happens after selection and uses only the chosen candidate.
- Limits (metric, train_days, test_days, 1-10 dict candidates, ISO dates, folds*(n+1) <= 60) are all checked before the first run.
- Metric names: sharpe, calmar and total_return are present in vibe_bt/backtest/metrics.py:833-837, and runner._parse (runner.py:104-107) passes metrics.csv keys through.
- Route: Depends(require_auth); same semaphore acquire with 429 busy; released in `finally`; run_in_threadpool; `_timeout_s()` is server-side; no client timeout (extra="forbid" rejects it); the global BodySizeLimit middleware applies; the ISO validator is copied from BacktestRequest.
- Errors: only the runner's own error text is echoed (the same tail /backtest exposes); no secrets are added.
- YAGNI: no new dependencies; the only extra is the Literal metric, which is reasonable.
- The report cites commit ebac186 while the diff head is 51b0187 (rebase artefact; harmless).

## Edge tests (Opus)

File: `bt-service/tests/test_walkforward_edge.py` (worktree G:\uday-demos.rv, branch oc/OC-P7.3). Fake `run` injected (direct calls and `functools.partial(walk_forward, run=fake)` patched into `app_mod.walk_forward`); no subprocesses; no source edits.

Run: `uv run pytest -q tests/test_walkforward_edge.py tests/test_walkforward.py` -> 4 failed, 154 passed (edge file: 126 passed / 4 failed; existing test_walkforward.py: 28 passed).

Failures (real defects, tests not bent):
1. `test_train_run_does_not_include_first_test_day` - train run gets `end=te_s`; runner `end` is inclusive (local_loader.py:419 keeps bars `< end + 1 day`), so every train run sees the first test bar. Leakage. Confirms Sonnet #1.
2. `test_oos_equity_dates_strictly_increasing_with_inclusive_runner` - same root cause: test window k ends on the day test window k+1 starts, so `oos_equity` has a duplicated boundary date per fold, and the chaining joins two points for the same day.
3. `test_end_near_date_max_does_not_crash` - start 9999-12-01 / end 9999-12-31: the loop probe `t0 + train + test` raises `OverflowError: date value out of range` (uncaught; /walkforward would 500).
4. `test_route_huge_train_days_no_500` - POST `train_days: 10**9` -> 500 (`timedelta(days=10**9)` OverflowError). Needs an upper bound on train_days/test_days (pydantic `le=`) or a try/except around the window build.

Notes (passing, behaviour recorded):
- A fold whose first equity value is 0/None/NaN/missing does not crash; that fold is appended unscaled (scale 1), so there is a silent discontinuity (Sonnet #4).
- A NaN equity value inside a series is passed through unscaled and makes the response non-JSON-serialisable. It cannot be reached with the real runner (`_num` maps NaN/inf to None), so it is not asserted.
- 61 total runs cannot be reached (runs = folds x (n+1), and n+1 >= 2), so the cap is tested at 60 accepted versus 62/64/66 rejected.
- The semaphore is released after an exception, both when walk_forward raises and when run raises inside it (the next request is 200, not 429). /walkforward and /backtest share the semaphore (429 on /backtest while a walk-forward holds it, with BUSY_WAIT_S 0.3). Body = 1 MiB gives 200; 1 MiB+1 gives 413. BT_TOKEN never appears in 401/422/500 bodies or headers.

## Fix plan (Opus) — fix round 1
Branch `oc/OC-P7.3` now also contains the Opus edge tests `bt-service/tests/test_walkforward_edge.py` (4 failing, 154 passing). Pull it first: `git switch oc/OC-P7.3 && git pull --rebase`. Do not edit any test file.
1. **Leakage (blocker):** the runner treats `end` as inclusive (`vibe_bt/backtest/loaders/local_loader.py:419-422`). In `walkforward.py`, pass `end = (window_end - 1 day)` to every `run(...)` call (train and test), keep the reported fold dates half-open `[s, e)`, and update the docstring. Fixes `test_train_run_does_not_include_first_test_day` and `test_oos_equity_dates_strictly_increasing_with_inclusive_runner`.
2. **Overflow:** bound `train_days` and `test_days` to ≤ 3650 (validate with the other limits before any run, both in `walk_forward` and in the request model). Guard window arithmetic against `OverflowError` near `date.max`: a window that can't be computed means "no more folds". Fixes `test_end_near_date_max_does_not_crash` and `test_route_huge_train_days_no_500`.
3. **Total time budget (major, from the Sonnet review):** env `BT_WALKFORWARD_BUDGET_S` (default 600, clamp 30..3600). Track elapsed time with an injectable clock (`clock=time.monotonic` param). Give each run `timeout_s=min(timeout_s, remaining)`. When the budget is spent, return `{ok: False, error: "time budget exceeded", folds: <completed so far>}`. Add a test with a fake clock in a NEW file `tests/test_walkforward_budget.py`.
4. **Minor:** when every candidate fails, include the first run's error text in the fold error. Add a warning when a fold can't be rescaled (first equity value 0 or missing). Add `scored_folds` to the summary. Document "calendar days" in the docstring.
Verify: `cd bt-service && uv run pytest -q tests/test_walkforward.py tests/test_walkforward_edge.py tests/test_walkforward_budget.py && uv run pytest -q`. Then append `## Fix round 1` to `coord/reports/OC-P7.3.md`, commit and push `oc/OC-P7.3`.

## Verdict (Opus): fix round 1
OC1's fix is accepted. The 56 red tests were caused by my fix plan conflicting with the shipped edge tests, not by the code. Rulings: (1) `end = fold_end - 1 day` is correct; (2) keep `scored_folds`; (3) keep the 600 s budget default. The Opus test writer is updating the test expectations (A–E). After that comes the Haiku run and then the merge. No further action is needed from OC1 for this task.
