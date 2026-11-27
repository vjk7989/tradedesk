# TM-8 review

## Code review (Sonnet)
Verdict: approve

1. All replacements value-identical: kw form -> (value, unit). "min"/"h"/"D"/"W" correct; 1W == weeks=1 verified; seconds float bar_span_hours*3600 with unit="s" keeps fractional seconds (no int truncation). tz handling in _market_hooks.py:619-640 untouched. Funding/annualisation logic unchanged (2 lines only).
2. Scope: only the 3 allowed source files + new test (+ coord report). OK.
3. New test fails on old code: verified pd.Timedelta(minutes=1) raises the generic-unit DeprecationWarning under -W error in this env, and old _market_hooks.py:619-620 sits on the path _funding_total drives. Test passes on new code (2 passed). (Reasoned, old code not re-run: no edits allowed.)
4. Low, test_tm8_no_deprecation.py:16: `assert SWAP` is vacuous and the import only exists to use it; drop or use meaningfully.
5. Low, report: lists ccxt_loader.py:284 as out of scope yet the diff fixed it. Remaining 15 keyword-form sites in vibe_bt (finnhub, mootdx, india_broker, mt5, nobitex, okx, wallex, tickerall, yahoo, yfinance, tencent, rsshub_events, tushare_fundamentals, _fundamental_schema, options_portfolio) are genuinely outside the allowed list; a follow-up is appropriate.

## Test run (Haiku)

| command | result | time |
|---|---|---|
| uv sync | exit 0 | <1 s |
| uv run pytest -q tests/test_tm8_edge.py tests/test_tm8_no_deprecation.py | 195 passed | 12 s |
| uv run pytest -q | 1202 passed, 0 failed | 6 min 43 s |

Result: GREEN. Merge of origin/main was clean. Full log: G:\uday-demos\reports\TM-8.full.log

## Verdict (Opus)
PR #8 merged as 5c6a424. Haiku: bt-service 1202/1202. Accepted: a 1 ns rounding change for interval spans the runner does not accept (the new value is arithmetically correct).
