# TM-3 · trade-mcp · block orders on NSE/BSE/MCX exchange holidays
Branch: tm/TM-3        Base: main (latest)
Owner: TM1

## Files you may touch (≤5)
- `trade-mcp/src/risk/hours.ts`
- `trade-mcp/src/risk/engine.ts` (only the market-hours check around line 124)
- `trade-mcp/src/config.ts` (only the `riskSchema` and `RiskConfig`)
- `trade-mcp/test/tm3_holidays.test.ts` (new)
- `deploy/risk.example.json` (add the new key)

## Do not touch
Other files, and no existing test files. `test/config.edge.test.ts` and `deploy/test_deploy.py` pin the exact risk-config key set. They will fail when you add a key: list them in your report, and the owner's side updates them.

## Context (read only these)
- `trade-mcp/src/risk/hours.ts:16-24`: `isMarketOpen(exchange, now)` handles weekdays and session hours only. It has no holidays, which is the known gap in `hand-off.md`.
- `trade-mcp/src/risk/engine.ts:124`: `if (!isMarketOpen(ex, this.now())) r.push("market closed for ...")`.
- `trade-mcp/src/config.ts`: `riskSchema` (zod, strict). Its errors must name only the field, never values (see existing code).
- ADR-5 in `architecture-record-document.md`: limits are server config only.
- OpenAlgo also exposes `POST /api/v1/market/holidays`. Do NOT call it in this task; config only (YAGNI).

## What to build
1. Risk config key `marketHolidays`:
   - Shape: an object mapping an exchange group to a list of `YYYY-MM-DD` IST dates, e.g. `{ "NSE": ["2026-01-26", ...], "MCX": [...] }`.
   - Default: `{}`.
   - Groups: `NSE` covers NSE, NFO, CDS, BSE, BFO; `MCX` covers MCX.
   - Validation: invalid dates (bad format, impossible dates like 2026-02-30) or unknown group names raise ConfigError. The message names only the field, never the values.
2. `isMarketOpen(exchange, now, holidays?)` returns false when the IST date of `now` is listed for that exchange's group. CRYPTO ignores holidays.
3. `engine.ts` passes `cfg.marketHolidays` through. The reason text stays "market closed for <EX>".
4. `deploy/risk.example.json`: add `"marketHolidays": {}` plus nothing else. JSON has no comments, so don't add one.

## Acceptance criteria
- A listed NSE date blocks orders at 10:00 IST on NSE, NFO and BSE. MCX on the same date is open unless MCX lists it.
- The IST date boundary is handled:
  - 2026-01-25 at 18:29 UTC is still the 25th in IST.
  - 2026-01-25 at 18:30 UTC is the 26th in IST.
- Weekends and session hours work exactly as before.
- CRYPTO is never blocked.
- Bad config is rejected without echoing any values.
- The default `{}` means no change in behaviour.

## Verify (must pass before you report, except the two pinned key-set tests noted above)
```
cd trade-mcp && npm ci && npx vitest run test/tm3_holidays.test.ts && npx vitest run && npx tsc --noEmit
```

YAGNI: no network fetch of holidays, no new dependencies.
