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
