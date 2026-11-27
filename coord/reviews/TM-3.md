# TM-3 review

## Code review (Sonnet)

Verdict: approve, with one merge prerequisite.

1. test/config.edge.test.ts (absent -> full defaults) and deploy/test_deploy.py::test_risk_example_keys_match_schema fail on this branch (brief anticipated it). Owner must update both pinned key sets before or with merge, or main CI goes red. Severity: medium (process).
2. config.ts:35-37, nit: the refine has no message; the builder reports only 'marketHolidays (custom)', so the error names the field and no value (verified at config.ts:113-115). Fine, but it does not say which rule failed (bad date vs group). Optional.
3. hours.ts:18, nit: holidays param type is Partial<Record<NSE|MCX,string[]>>; OK. Duplicate dates are accepted harmlessly.
Checked OK: isoDate round-trips through toISOString so 2026-02-30 is rejected; IST date derived from UTC+5.5h (hours.ts:5-6), boundary tested; NSE group = NSE/NFO/CDS/BSE/BFO, MCX alone; CRYPTO returns true before holiday check; default {} and omitted param unchanged; engine.ts:124 passes c.marketHolidays and reserve() calls checkOrder (engine.ts:139) so the concurrency path is blocked; isMarketOpen has no other callers; risk.example.json adds only the key. Tests not run by me.

## Edge tests (Opus)
The owner side updated the pinned key-set tests (config.edge "absent -> full defaults", deploy `test_risk_example_keys_match_schema` = 13, and the `risk_keys_from_config_ts` regex) and added 61 edge tests on `tm/TM-3` (c08bfd8). Result: vitest 861 pass, 1 fail; deploy 93 pass.

## Fix plan (Opus), fix round 1
Pull `tm/TM-3` first. Do not edit tests.
1. `src/config.ts` `marketHolidays`: with zod `z.record`, a `"__proto__"` key sets the prototype instead of becoming a key. The group check never sees it, so the holiday list is silently dropped. Replace it with `z.object({ NSE: dates.optional(), MCX: dates.optional() }).strict()`, so unknown keys, including `__proto__` and lowercase `nse`, are rejected. Keep the existing error format (field name only).
2. Check `contractValues` (also `z.record`) for the same `__proto__` problem. If it's affected, reject keys that are `__proto__`, `constructor` or `prototype` there too, with the field-name-only error. `src/config.ts` is already in your allowed list.
Verify: `cd trade-mcp && npx vitest run && npx tsc --noEmit`, then from the repo root `uv run --with pytest --with pyyaml pytest -q deploy/test_deploy.py`. All green, then push to `tm/TM-3` and add `## Fix round 1` to `coord/reports/TM-3.md`.
