# Hand-off 2026-11-27: TM2 (buckleson) runs the project in solo mode

**On the owner's instruction, the owner session and TM1 have stopped. TM2 now runs everything. See `coord/TM2_SOLO.md`, which overrides `coord/TEAM_PLAN.md` where they conflict.**

## State (TM2 session, 2026-11-27, updated after #30)
- `main` is green on Linux (TM2's checks):
  - trade-mcp: 1297 passed, 3 skipped (after #27);
  - agent-runner: 776 (after #26);
  - bt-service: 1740 passed, 1 skipped, 0 failed, 43 warnings (after #30).
  - The deploy suite needs Docker, which isn't available on TM2's machine. It was last green on the owner's PC: 256 passed.
- Merged in this session, each with a separate Sonnet review, an Opus edge-test writer and a Haiku run on the PR merged onto main:
  - #19 TM-14: options engine, see ADR-16;
  - #22 TM2-6: Telegram;
  - #23 TM2-10: shared audit probe;
  - #24 TM2-9: `risk:lint`;
  - #25 TM2-11: troubleshooting doc;
  - #26 TM2-12: `--next` 1..100;
  - #27 TM2-15: `/readyz` cancels the OpenAlgo request;
  - #28 TM2-14: README and runbook links;
  - #29 TM2-13: Windows-only path test;
  - #30 TM-15: warnings 210 → 43.
  - Earlier: TM2-1 to TM2-5 and TM2-8.
- Reviews are in `coord/reviews/<ID>.md`; reports in `coord/reports/<ID>.md`.

## In flight
- TM2-16: lowercase `1h` interval, developer running on `tm2/TM2-16`.
- TM2-7: GitHub Actions CI, on hold. The local permission check refused the developer agent. Waiting on buckleson's decision. The worktree `../tradedesk-TM2-7` exists with no changes.

## Next candidates (write briefs in `coord/tasks/`, ≤5 files each)
- TM2-7 CI, once permitted. It would also give a Docker host for the deploy suite.
- jobs `tz`: decide whether non-IST time zones (e.g. America/New_York) are allowed.
- risk.json with a UTF-8 BOM: today both `risk:lint` and `loadConfig` reject it. Consider stripping it in both.
- `india_broker_loader.py:113` "could not infer format" UserWarning: needs an explicit, value-identical format, or stays as is.
- SENSEX lot size: verify from an official source before adding it.
- agent-runner Telegram: drain non-2xx bodies (LOW).

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
- Linux vs Windows: bt-service is now green on both (TM2-13). The deploy compose tests need Docker.
- Merge gate: Haiku runs the full suite on a scratch merge of the PR onto the latest main, and the PR is merged with `--match-head-commit <tested sha>`, after checking that main hasn't moved.
- Windows can hit 0xC0000142 under load; rerun with `--lf`.
- The full bt-service suite takes about 8 minutes.
- Test writers own every test edit, including pinned tests changed by an AC.
- Local disk G: on the owner's PC is nearly full; that only matters if the owner resumes locally.
