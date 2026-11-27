# Messages to the owner (written by TM1)


## 2026-11-27 12:14 IST · TM-1 · blocked
Draft PR https://github.com/vjk7989/tradedesk/pull/1 (tm/TM-1). Engine change + 11 new tests pass, but 5 existing tests encode "MIS stamp = delivery rate 0.015%" and now fail by design:
- bt-service/tests/test_intraday.py::test_mis_stt_sell_side_only (its `in_stamp_duty: 0` no longer zeroes MIS stamp)
- bt-service/tests/test_intraday_edge.py::test_mis_stt_hand_computed_round_trip_defaults, test_mis_no_stt_on_buy_short_cover, test_stamp_duty_unchanged_by_mis, test_mis_run_commission_matches_hand_rates
The brief requires "all existing tests stay green" and also forbids editing existing tests. Need: permission to update those 5 tests (add `in_mis_stamp_duty: 0` where stamp is zeroed, MIS expectation → 0.003%), or you update them on your side. Details: coord/reports/TM-1.md on tm/TM-1.

## 2026-11-27 12:14 IST · TM-2 · status
PR opened: https://github.com/vjk7989/tradedesk/pull/2 (tm/TM-2). vitest 246/246, tsc and build clean. Report: coord/reports/TM-2.md.

## 2026-11-27 12:25 IST · queue · question
TM-2 merge noted, thanks; local tm/TM-2 deleted. TM-1: holding off tm/TM-1 until your `merged`/`fix-plan`. My TM1 queue is otherwise empty. Can you assign more tasks on coord/board.md? I can now run several Sonnet developers in parallel, so independent tasks with non-overlapping files (or one larger task split by file) work well. I'll keep clear of the files you listed (local_loader.py, engines/base.py, engines/india_fno.py, trade-mcp/src/sdk/api-docs.ts). If you want them, I can also pick up the two optional review notes (TM-1 numbers.Real, TM-2 --once exit guard) as small tasks.

## 2026-11-27 07:13 IST · role · status
TM1 role reset; starting TM-4 and TM-3. PR watcher stopped; I will not review, merge or push to main.

## 2026-11-27 07:13 IST · TM-4 · status
TM-4 started on tm/TM-4.

## 2026-11-27 07:13 IST · TM-3 · status
TM-3 started on tm/TM-3.

## 2026-11-27 07:15 IST · TM-4 · status
TM1 opened PR for TM-4: https://github.com/vjk7989/tradedesk/pull/3 (report coord/reports/TM-4.md). Note: coord/reports is matched by .gitignore `reports/`, so reports need `git add -f`.

## 2026-11-27 07:15 IST · queue · status
In progress in parallel: TM-3, TM-5, TM-6, TM-8, TM-9 (one tm/<ID> branch each).

## 2026-11-27 07:16 IST · TM-3 · status
TM1 opened PR for TM-3: https://github.com/vjk7989/tradedesk/pull/4. As the brief expected, two pinned key-set tests need your side to update them: test/config.edge.test.ts "absent -> full defaults" and deploy/test_deploy.py::test_risk_example_keys_match_schema (12→13 keys). Also drop the README line "Holidays are not modelled until TM-3 lands" once TM-3 and TM-4 are both merged.

## 2026-11-27 07:16 IST · TM-5 · status
TM1 opened PR for TM-5: https://github.com/vjk7989/tradedesk/pull/5 (279 tests green). TM-7 (jobs accept api-openai) can follow once it is merged.

## 2026-11-27 07:25 IST · TM-6 · status
TM1 opened PR for TM-6: https://github.com/vjk7989/tradedesk/pull/6 (bt-service 1020 green, agent-runner 268). Decimal is not numbers.Real, so it stays rejected.

## 2026-11-27 07:25 IST · TM-9 · status
TM1 opened PR for TM-9: https://github.com/vjk7989/tradedesk/pull/7 (smoke 11/11 twice).

## 2026-11-27 07:25 IST · TM-9 · fyi
Product gap found: trade-mcp execute timeout is 60 s (src/server.ts executeTimeoutMs default), but walkForward allows 600 s server-side. A realistic walk-forward via execute times out, and bt-service stays busy. Details in coord/reports/TM-9.md. A follow-up task is your call.

## 2026-11-27 07:31 IST · TM-8 · status
TM1 opened PR for TM-8: https://github.com/vjk7989/tradedesk/pull/8 (warnings ~12.7k → 573; the remaining offenders are in out-of-scope loaders, listed in the report). All six ready TM1 tasks now have PRs (#3-#8). Waiting on merges; TM-7 starts after TM-5 merges.

## 2026-11-27 07:31 IST · TM-3, TM-5 · status
Fix round 1 started on both (pulled your edge tests first): TM-3 switches marketHolidays to a strict z.object and checks contractValues for __proto__; TM-5 covers the empty OPENAI_MODEL fallback, whitespace tokens (openai.ts + api.ts) and mcp_call errors leading to ok:false. TM-10 is noted; it starts after TM-3 merges. The TM-9 follow-up (assert folds[0].chosen) goes into my next e2e change.
