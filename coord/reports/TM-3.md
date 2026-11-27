# TM-3 report
Status: done (2 pinned key-set tests need owner-side update, as the brief anticipated)
Branch: tm/TM-3   Commit: ec87eb9
Files: trade-mcp/src/risk/hours.ts (+7/-3), trade-mcp/src/risk/engine.ts (+1/-1), trade-mcp/src/config.ts (+13/-2), deploy/risk.example.json (+2/-1), trade-mcp/test/tm3_holidays.test.ts (new, 12 tests)
Verify:
- npx vitest run test/tm3_holidays.test.ts → 12 passed
- npx vitest run → 800 passed, 1 skipped, 1 failed: test/config.edge.test.ts > RISK_CONFIG > absent -> full defaults (pins the exact risk key set; now has marketHolidays: {})
- npx tsc --noEmit → clean
- deploy/test_deploy.py → 92 passed, 1 failed: test_risk_example_keys_match_schema (pins 12 keys; now 13)
Decisions:
- marketHolidays: Record<"NSE"|"MCX", YYYY-MM-DD[]> default {}; dates must round-trip as real calendar dates; any other group key is rejected. Errors come from the existing builder ("RISK_CONFIG: invalid field marketHolidays (...)"), never with values.
- isMarketOpen(exchange, now, holidays?): holiday check runs after the weekend check and before session hours; NSE group = NSE/NFO/CDS/BSE/BFO, MCX = MCX; CRYPTO returns open before any holiday check. Reason text is unchanged ("market closed for <EX>").
- No OpenAlgo holiday fetch (YAGNI, per brief).
- README (TM-4) has the limit "Holidays are not modelled until TM-3 lands"; drop it when both are merged.
developers: 1 sonnet, fix rounds: 0

## Fix round 1
Commit: 607807e. File: trade-mcp/src/config.ts only.
1. marketHolidays is now `z.object({NSE: dates.optional(), MCX: dates.optional()}).strict().default({})`. `__proto__`, lowercase `nse` and any other group are rejected.
2. Error builder: `unrecognized_keys` gives "unknown key(s) present" only at the root. Nested ones read "invalid field marketHolidays (unrecognized_keys)". No values are echoed.
3. contractValues WAS affected: `{"__proto__":5,"abc":2}` loaded with `__proto__` silently dropped. Fix: a raw-input own-key check before safeParse rejects `__proto__`/`constructor`/`prototype` with "RISK_CONFIG: invalid field contractValues". Zod's record never exposes the key after parsing, so the check is on the raw JSON.
Verify: vitest 862 passed / 1 skipped; tsc clean; deploy 93 passed.
developers: 1 sonnet (same), fix rounds: 1
