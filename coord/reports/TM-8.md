# TM-8 report
Status: done
Branch: tm/TM-8   Commit: e5815b8
Files: bt-service/vibe_bt/backtest/engines/_market_hooks.py (+2/-2), loaders/ccxt_loader.py (+11/-11), loaders/local_loader.py (+1/-1), tests/test_tm8_no_deprecation.py (new, 2 tests)
Verify:
- tests/test_tm8_no_deprecation.py → 2 passed
- AC command (-W error::DeprecationWarning:numpy on test_crypto_backtest/test_crypto_edge/test_intraday_edge/test_p92_edge) → 147 passed
- full suite → 1009 passed; warnings down from ~12.7k to 573
Decisions:
- Root cause: in pandas 2.3.3 the keyword form pd.Timedelta(minutes=/hours=/days=/seconds=/weeks=) itself triggers the "generic unit" DeprecationWarning. Replaced with the (value, unit) form; the values are identical (the new test pins _TIMEFRAME_DELTA).
- Fixed: _market_hooks.py:619-620 (funding), ccxt_loader.py:39-48 (_TIMEFRAME_DELTA) and the fetch end_ms line, local_loader.py:459.
Out of scope, same pattern, not edited (the remaining ~573 warnings): finnhub_loader.py:87, mootdx_loader.py:263, india_broker_loader.py:125, mt5_loader.py:184, nobitex.py:166, okx.py:178, wallex.py:164, tickerall_loader.py:453, yahoo_loader.py:191, yfinance_loader.py:99, tencent_loader.py:338, rsshub_events.py:293, tushare_fundamentals.py:446, _fundamental_schema.py:39, ccxt_loader.py:284, engines/options_portfolio.py:70, and an "ist - pd.Timedelta(hours=5, minutes=30)" line. A follow-up task could cover them.
developers: 1 sonnet, fix rounds: 0
