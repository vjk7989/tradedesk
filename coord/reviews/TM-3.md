# TM-3 review

## Code review (Sonnet)

Verdict: approve, with one merge prerequisite.

1. test/config.edge.test.ts (absent -> full defaults) and deploy/test_deploy.py::test_risk_example_keys_match_schema fail on this branch (brief anticipated it). Owner must update both pinned key sets before or with merge, or main CI goes red. Severity: medium (process).
2. config.ts:35-37, nit: the refine has no message; the builder reports only 'marketHolidays (custom)', so the error names the field and no value (verified at config.ts:113-115). Fine, but it does not say which rule failed (bad date vs group). Optional.
3. hours.ts:18, nit: holidays param type is Partial<Record<NSE|MCX,string[]>>; OK. Duplicate dates are accepted harmlessly.
Checked OK: isoDate round-trips through toISOString so 2026-02-30 is rejected; IST date derived from UTC+5.5h (hours.ts:5-6), boundary tested; NSE group = NSE/NFO/CDS/BSE/BFO, MCX alone; CRYPTO returns true before holiday check; default {} and omitted param unchanged; engine.ts:124 passes c.marketHolidays and reserve() calls checkOrder (engine.ts:139) so the concurrency path is blocked; isMarketOpen has no other callers; risk.example.json adds only the key. Tests not run by me.
