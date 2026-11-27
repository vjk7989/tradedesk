# TM-8 · bt-service · remove the ~10k NumPy/pandas "generic timedelta" DeprecationWarnings
Branch: tm/TM-8        Base: main (latest)        Owner: TM1

## Files you may touch (≤5)
- `bt-service/vibe_bt/backtest/engines/_market_hooks.py`: around lines 615-640, crypto funding.
- `bt-service/vibe_bt/backtest/loaders/ccxt_loader.py`: around lines 36-50.
- `bt-service/vibe_bt/backtest/loaders/local_loader.py`: only the lines the warnings point to.
- New: `bt-service/tests/test_tm8_no_deprecation.py`.

## Context
Running `uv run pytest -q` prints thousands of warnings like "The 'generic' unit for NumPy timedelta is deprecated". Find the exact lines with:
```
uv run pytest -q -W error::DeprecationWarning tests/test_crypto_backtest.py tests/test_intraday_edge.py -x
```
It shows the first offender with its traceback.

## What to build
Replace the deprecated constructs with explicit units, e.g. `np.timedelta64(x, "ns")` or `pd.Timedelta(...)`, without changing any computed value.

## Acceptance criteria
- `uv run pytest -q -W error::DeprecationWarning:numpy tests/test_crypto_backtest.py tests/test_crypto_edge.py tests/test_intraday_edge.py tests/test_p92_edge.py` passes. Only these warning categories from numpy and pandas in our `vibe_bt` files need to go; warnings raised inside third-party packages are fine.
- The full suite stays green with the same pass count, and results are byte-identical. The existing hand-computed funding and cost tests prove this.
- Add a test that runs one crypto funding backtest under `warnings.catch_warnings(); simplefilter("error", DeprecationWarning)` and expects no error from `vibe_bt` modules.

## Verify
```
cd bt-service && uv sync && uv run pytest -q tests/test_tm8_no_deprecation.py && uv run pytest -q
```
