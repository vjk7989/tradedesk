# OC-P7.3 report

Status: blocked
Branch: oc/OC-P7.3   Commit: ebac186
Files:
- `bt-service/bt_service/walkforward.py` (new, +166)
- `bt-service/bt_service/app.py` (+59/-1: `WalkForwardRequest`, `POST /walkforward`)
- `bt-service/tests/test_walkforward.py` (new, +274, 28 tests)

Verify: `cd bt-service && uv sync && uv run pytest -q tests/test_walkforward.py && uv run pytest -q` → pass
```
28 passed, 1 warning in 3.08s
331 passed, 12 warnings in 56.21s
```

Notes / decisions:
- Fold loop: a fold exists while `t0 + train_days + test_days <= end`, with `t0 += test_days` (overlapping train windows, exactly as the brief specifies). Exact fit → 1 fold; one day short → `{"ok": False, "error": "range too short for one fold"}` with zero `run` calls.
- All limits (metric, `train_days >= 20`, `test_days >= 5`, 1–10 dict candidates, `folds * (len(candidates)+1) <= 60`) are checked before the first `run` call; 60 runs is allowed, 66 is rejected with `"too many runs"`.
- Selection uses train scores only (`strict >` so ties keep the first candidate); non-finite / failed / missing metric results are skipped. A fold with no valid candidate, or whose test run fails, returns `ok: False` with a `fold N: ...` error (fails closed).
- `oos_equity` chains fold test equities, rescaling each fold by `prev_last / first_value` so it starts where the previous fold ended.
- Route copies `/backtest`: `Depends(require_auth)`, semaphore held across the whole walk-forward (429 `busy`), `run_in_threadpool`, server-side `_timeout_s()`, body cap middleware already global; request model is `extra="forbid"`, ISO-date validator, metric `Literal`, no client `timeout_s`.
- Small addition beyond the literal step-5 list: unknown `metric` values are rejected up front instead of silently failing every fold.
- Environment note (not caused by this change): the first full-suite run had 3 `test_runner*` failures because the sandboxed child tried to write fresh scipy `__pycache__` files outside `run_dir` right after `uv sync`. After precompiling bytecode (`uv run python -c "import scipy.stats"`) the full suite is green (331 passed); no runner/sandbox files were touched.
- The branch received orchestrator commits/merges while I worked (`3ab4aa4` → `633f15f`); `ebac186` sits on top and only touches the three files above.

## Fix round 1

Status: blocked — the plan is implemented, but the shipped edge tests conflict with three of its requirements and the plan forbids editing test files.

Branch: oc/OC-P7.3   Commit: e5f2e0a
Files: `bt-service/bt_service/walkforward.py` (+62/-14), `bt-service/bt_service/app.py` (+2/-2), `bt-service/tests/test_walkforward_budget.py` (new, 72), `bt-service/tests/test_walkforward_fix.py` (new, 80)

Verify: `cd bt-service && uv run pytest -q tests/test_walkforward.py tests/test_walkforward_edge.py tests/test_walkforward_budget.py` → RED
```
56 failed, 111 passed, 1 warning in 2.84s
```
Full suite `uv run pytest -q` → 60 failed, 447 passed. Four of the 60 are unrelated pre-existing failures in `tests/test_crypto_edge.py` (negative fee, swap symbol, leverage); that file imports only `bt_service.run_backtest`, `bt_service._child` and vibe_bt market hooks, no walk-forward code.

### Implemented per plan
1. Leakage: every `run(...)` gets `end = fold_end - 1 day` (train and test); reported folds stay half-open `[s, e)`.
2. Bounds/overflow: `train_days`/`test_days` bounded 20/5..3650 in `walk_forward` and with `Field(le=3650)` in `WalkForwardRequest`; the window build catches `OverflowError`; `9999-12-31` no longer raises and `train_days=10**9` returns 422 instead of 500.
3. Budget: `BT_WALKFORWARD_BUDGET_S` (default 600, clamp 30..3600), injectable `clock=time.monotonic`, per-run `timeout_s=min(timeout_s, remaining)`, and `{"ok": False, "error": "time budget exceeded", "folds": [...]}` when spent. `tests/test_walkforward_budget.py` (9 tests, green).
4. Minors: first failed run's `error` appended to the all-candidates-fail message; warning when a fold cannot be rescaled (first equity 0/missing); `scored_folds` in the summary; "calendar days" documented in the docstring. `tests/test_walkforward_fix.py` (6 tests, green).

### Why blocked (all test-side; no test was edited)
A. `test_walkforward_edge.py` `Recorder` (lines 40-47) classifies a call by `(end - start).days == train_days/test_days`. With inclusive-end semantics the correct run spans are 19/4, so the fake raises `AssertionError: unexpected window ...`; this one error accounts for all 55 edge failures (100 call sites). Needs `Recorder(19, 4)`, or inclusive-bar classification (`+1`) in `__call__`, `train_calls` and `test_calls`.
B. `test_walkforward_edge.py:202-205` asserts run `[start, end] == f["test"]/f["train"]`; after the fix the run end is one day before the reported fold end, so it must compare against `[s, end - 1 day]`.
C. `test_walkforward_edge.py:229-231` is unsatisfiable with overlapping folds: `nxt` is the earliest test starting at or after the train start, which for fold k>0 is an *earlier* fold's test that this train window overlaps by design (step = `test_days`). It must use the same fold's test (start == train end + 1 day); it will still fail after A/B are fixed.
D. `scored_folds` (plan item 4) breaks exact-dict summary assertions: `test_walkforward.py::test_oos_equity_chains_and_scales` and edge `test_summary_mean_and_positive_folds_known_numbers`, `test_summary_rounds_to_6dp`, `test_summary_skips_non_finite_test_metric`, `test_summary_all_test_metrics_missing_mean_is_none`, `test_each_metric_selects_on_its_own_key[sharpe|total_return|calmar]`.
E. The budget cap breaks `test_route_timeout_env_clamped`: `BT_TIMEOUT_S=999999` → 3600, but `min(3600, remaining≈600)` is 600.

### Questions for orchestrator
1. Confirm `end = fold_end - 1 day` (inclusive runner, half-open reported folds). If yes, please update the edge harness per A–C; test files are yours and I did not touch them.
2. Keep `scored_folds` and update the exact-summary assertions (D), or drop `scored_folds`?
3. Keep the budget default at 600 and change `test_route_timeout_env_clamped` to expect 600 (E), or raise the default to 3600?
