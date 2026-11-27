# Hand-off 2026-11-28: two builders (OWNER + TM2)

The owner session (vjk7989) is back as coordinator and second builder. TM2 (buckleson, cloud) keeps building. Rules: `coord/TM2_SOLO.md` §0 and ADR-17.
- Each side runs the full chain on its own PRs: Sonnet developer → a separate Sonnet reviewer → Opus edge tests → Haiku run on the PR merged onto the latest main → GitHub CI green → `gh pr merge --match-head-commit <tested sha>`.
- The OWNER writes the briefs and keeps the board.

## State
- `main` is green, and CI (`.github/workflows/ci.yml`) runs on every PR and every push. It has 4 jobs: trade-mcp, agent-runner, bt-service (Python 3.12, the same as the production image) and deploy (Docker).
- Last full runs: trade-mcp 1671 passed and 11 skipped (after #44); bt-service about 1860; agent-runner about 850; deploy 256+.
- Merged on 2026-11-28:
  - OWNER: #32 CI, #33 O-2 (BOM), #34 O-1 (api-docs options), #38 (2 tests that were red on Linux), #43 O-3 (`audit.recent`, secret scrub), #44 O-4 (audit entry size limits), #45 O-5 (api-docs short-option cap).
  - TM2: #35, #36, #37, #39, #40, #42, #46 (TM2-18..24).

## In flight
- OWNER: O-6, stabilising the sandbox memory-limit tests (possible flake).
- TM2: #41 TM2-17 (fix round), #47 TM2-26 (Dependabot). Queued:
  - TM2-25 (search matches header rules);
  - TM2-27 (risk.status shows all limits; the OWNER applies its api-docs text);
  - TM2-28 (smoke: options + audit.recent);
  - TM2-29 (connect-clients doc);
  - TM2-30 (`--dry-run`);
  - TM2-31 (walk-forward with options).

## Next for the OWNER
- Apply the api-docs text for TM2-27 when TM2 reports it.
- Keep 3–4 briefs queued for TM2.
- Watch cron (session-only) every 20 min.

## Needs the owner (human)
- P4.4: a paper-mode end-to-end run on the VPS before `MODE=live`.
- Verify on live systems:
  - the Delta perpetual symbol;
  - the OpenAlgo `WEBSOCKET_URL`;
  - the Fincept menu names;
  - the SENSEX/BANKEX/SENSEX50 lot sizes. The official sites refused automated fetches; until checked they stay at lot 1 with a warning.

## Known limits (accepted)
- Capital equal to margin opens nothing (fees).
- Funding is not charged for a scale-in and full exit inside one sparse gap.
- OAuth state is single-process per DATA_DIR.
- Options expiry costs come from the normal cost stack: a long that expires pays STT on intrinsic value, a short pays stamp duty. Monthly expiry dates are not shifted for exchange holidays.
- Jobs run in `Asia/Kolkata` or `UTC` only.
- trade-mcp's port must never be published.

## Gotchas
- Tests that place NSE orders must pin the clock (`RiskEngine` `now`). The e2e smoke pins it through a preload in the spawned process only, never in src.
- Pinned API-surface tests (o1/scope/sdk edge) change whenever api-docs changes. The test writer updates them; developers never do.
- Drive G: on the owner's PC is full. Do all clones, builds and tests in C: scratchpad clones.
- The full bt-service suite takes about 5 min on CI and about 8 min locally.
