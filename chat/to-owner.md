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
