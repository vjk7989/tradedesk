# Hand-off 2026-11-27 ~16:15 IST: handed to TM2 (buckleson, cloud session)

**On the owner's instruction, the owner session and TM1 have stopped. TM2 now runs everything. See `coord/TM2_SOLO.md`, which overrides `coord/TEAM_PLAN.md` where they conflict.**

## State
- `main` on https://github.com/vjk7989/tradedesk (public) is green:
  - trade-mcp: 1106 passed, 7 skipped;
  - agent-runner: 629;
  - deploy: 256 passed, 3 skipped;
  - bt-service: ~1337.
- All planned phases P0–P9 are merged.
- Teammate tasks merged:
  - TM-1 to TM-13 and TM-16;
  - TM2-1 to TM2-5 and TM2-8;
  - OC-P7.3 and OC-P7.4.
- Open PR: **#19 TM-14** (options engine). Fix round 1 is open; the plan and addendum are in `coord/reviews/TM-14.md`, and the owner edge tests are on the branch (7 fail until the fix).

## Next (queue in `coord/TM2_SOLO.md` §2)
1. TM-14 fix.
2. TM2-6.
3. TM2-10.
4. TM-15 (start fresh).
5. TM2-9.
6. TM2-11.
7. TM2-12.
8. TM2-7.

## Needs the owner (vjk7989)
- P4.4: a paper-mode end-to-end run on the VPS before `MODE=live`.
- Verify the Delta perpetual symbol, the OpenAlgo `WEBSOCKET_URL` and the Fincept menu names.

## Known limits (accepted)
- Capital exactly equal to margin opens nothing, because of fees.
- Funding is not charged for a scale-in and full exit inside one sparse gap.
- OAuth state is single-process per DATA_DIR.
- Expiry STT for options is taken at 0.15% of intrinsic value, and holiday shifts of the monthly option expiry are not modelled.
- trade-mcp's port must never be published.

## Gotchas
- Tests that place NSE orders must pin the clock (`RiskEngine` `now`).
- Windows can hit 0xC0000142 under load; rerun with `--lf`.
- The full bt-service suite takes about 8 minutes.
- Test writers own every test edit, including pinned tests changed by an AC.
- Local disk G: on the owner's PC is nearly full; that only matters if the owner resumes locally.
