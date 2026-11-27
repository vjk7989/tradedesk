# OC-P7.3 · bt-service · walk-forward / out-of-sample endpoint
Branch: oc/OC-P7.3        Base: main @ eddb02b
Owner: OC1

## Files you may touch (≤5)
- `bt-service/bt_service/walkforward.py` (new)
- `bt-service/bt_service/app.py` (add one route + one request model only)
- `bt-service/tests/test_walkforward.py` (new)

## Do not touch
`bt_service/runner.py`, `bt_service/_child.py`, anything under `vibe_bt/` (another developer is editing engines and routing), `trade-mcp/`, `agent-runner/`, `deploy/`.

## Context (read only these)
- `bt-service/bt_service/runner.py:114` onward: the `run_backtest(code, symbols, start, end, interval="1D", capital=..., costs=None, source="auto", timeout_s=..., signal_parameters=None) -> dict` signature and its return shape `{ok, metrics, equity:[{date,value}], trades, warnings, error?}`. Call it; do not change it.
- `bt-service/bt_service/app.py:35-60` (`BacktestRequest`, the `extra="forbid"` model and its ISO-date validator), `:117` (`require_auth`), `:139-` (the `/backtest` route: semaphore, `run_in_threadpool`, `_timeout_s()`). Copy these patterns.
- `bt-service/tests/test_app.py` and `tests/test_runner.py`: how tests fake `run_backtest` and use the offline `local` source fixture.

## What to build
Walk-forward with parameter selection on training windows only, then frozen parameters on out-of-sample (OOS) windows.

`walk_forward(code, symbols, start, end, *, train_days, test_days, candidates, metric="sharpe", interval="1D", capital, costs, source, timeout_s, run=run_backtest) -> dict`
1. Split `[start, end]` into consecutive folds: train `[t0, t0+train_days)`, test `[t0+train_days, t0+train_days+test_days)`, then step forward by `test_days`. Stop when a test window would pass `end`. Need ≥1 fold, else return `{ok: False, error: "range too short for one fold"}`.
2. For each fold: run `run(...)` once per candidate (`signal_parameters=candidate`) on the TRAIN window. Pick the candidate with the highest `metrics[metric]`. Ties go to the first candidate. Skip non-finite values. If every candidate fails, the fold fails.
3. Run the chosen candidate once on the TEST window. Never select using test results.
4. Result: `{ok, metric, folds:[{train:[s,e], test:[s,e], chosen: {...}, train_score, test_metrics}], oos_equity:[{date,value}] (chain the fold test equities, each fold rescaled to start where the previous one ended), summary:{folds, mean_test_<metric>, positive_folds}, warnings}`.
5. Limits: 1 ≤ len(candidates) ≤ 10, each candidate a dict; train_days ≥ 20, test_days ≥ 5; total `run` calls ≤ 60, else `{ok: False, error: "too many runs"}` before running anything.

Route `POST /walkforward` with the same auth, semaphore (hold it for the whole walk-forward), body cap, ISO-date validation and server-side `timeout_s` as `/backtest`. Request model has `extra="forbid"` and fields code, symbols, start, end, train_days, test_days, candidates, metric (one of `sharpe`, `total_return`, `calmar` — check which keys `metrics` really has by reading `runner._parse`), interval, capital, costs, source. No client-set timeout.

## Acceptance criteria
- Fold split is correct at the boundaries (exact fit, one day short, single fold).
- Selection uses train results only. A test proves that a candidate that is best on TEST but worse on TRAIN is NOT chosen.
- Ties go to the first candidate. Non-finite scores are skipped. A fold with no valid candidate fails with a clear error.
- The limits from step 5 are checked before any run.
- `/walkforward`: 401 without token, 422 on extra fields and bad dates, 200 on success. Tests use an injected fake `run`, no subprocesses.
- Existing tests stay green.

## Verify (must pass before you report)
```
cd bt-service && uv sync && uv run pytest -q tests/test_walkforward.py && uv run pytest -q
```

YAGNI: no grid generation, no parallel runs, no new dependencies.
