# Hand-off 2026-11-28 (two builders: OWNER + TM2)

The owner session (vjk7989) is the coordinator and second builder. TM2 (buckleson, cloud) keeps building. Rules: `coord/TM2_SOLO.md` §0, ADR-17.
- Each side runs the full chain on its own PRs: Sonnet developer → a separate Sonnet reviewer → Opus edge tests → Haiku on the PR merged onto the latest main → GitHub CI green → `gh pr merge --match-head-commit <tested sha>`.
- The OWNER writes briefs and keeps the board. TM2 may brief its own follow-ups.

## State
- `main` is green on CI (Linux, 4 jobs: trade-mcp, agent-runner, bt-service on py3.12, deploy with Docker).
- trade-mcp: 2472 passed / 5 skipped on Linux; **Windows fully green** (owner run 06:38, 2438 passed / 31 skipped / 0 failed) after TM2-49.
- **bt-service is on pandas 3.1.1** (TM2-43); datetime indexes are normalised to ns at the loader boundary (TM2-41/42/45). The full suite emits 1 warning (third-party Starlette, TM2-55).
- Smoke: 18 steps, including the execute concurrency cap and memory recovery (TM2-53).
- **Sandbox security is complete** (ADR-18, ADR-19):
  - no binary buffers;
  - binding args are snapshotted once in the guest, capped at 1 MB;
  - results capped at min(4 MB, memoryBytes/4);
  - in-flight binding calls capped at 64;
  - a hard WASM memory maximum per run (16 MB + memoryBytes + 16 MB);
  - EXECUTE_MAX_CONCURRENT (default 4);
  - fail-closed init;
  - the limits are documented for the AI in API_HEADER, tied to the code by tests.
- Merged by the OWNER on 2026-11-28:
  - CI (#32), Dependabot action bumps (#49, #50);
  - O-1..O-5 (#33, #34, #43, #44, #45);
  - O-6/O-8 (#57), O-7 (#59), O-9 (#65), O-10 (#68), O-11 (#71), O-12 (#74), O-13 (#77), O-14 (#81);
  - #38 (Linux-only test fixes).
- Merged by TM2 on 2026-11-28: TM2-17..TM2-56 (all briefed TM2 tasks).
  - Highlights: walk-forward options and partial folds; P3-A/B (pandas 3 prep); oauth:revoke-all with the DATA_DIR lock; `--dry-run` and `--history`; Dependabot; search ranking.

## In flight / queued
- TM2: queue empty; next tasks proposed in chat (2026-11-28, after #90/#91).
- Known load-sensitive test: `tm2_46_datadir_lock.edge` "SIGKILLed server seen from another hostname" (2 of 14 loaded runs failed); proposed as a de-flake task.
- The tm3_holidays perf test (TM2-52) now takes about 21 s (CPU-time ratio, Windows-safe); it adds about 20 s to the trade-mcp CI job.

## Needs the owner (human)
- P4.4: a 5-day paper-mode run on the VPS before `MODE=live`.
- Verify on live systems:
  - the Delta perpetual symbol;
  - the OpenAlgo `WEBSOCKET_URL`;
  - the Fincept menu names;
  - the SENSEX/BANKEX/SENSEX50 lot sizes (stay at lot 1 with a warning until checked).
- Size `EXECUTE_MAX_CONCURRENT` and the container limits (TM2-47) to the VPS RAM. Worst case for trade-mcp ≈ base + N × (memoryBytes + 32 MB).

## Known limits (accepted)
- Capital equal to margin opens nothing (fees).
- Funding is not charged for a scale-in plus full exit inside one sparse gap.
- One process per DATA_DIR (lock enforced; a new container may wait ≤15 s after a crash).
- Options expiry costs come from the normal stack. No holiday shift for the monthly expiry.
- Jobs run on Asia/Kolkata or UTC only.
- Never publish trade-mcp's port.
- The sandbox is not a defence against a QuickJS/WASM zero-day; use a dedicated VPS.

## Gotchas
- NSE-order tests must pin the clock. The smoke test pins it through a preload, never in src.
- Pinned api-docs baseline tests change with every docs change. Only the test writer updates them.
- Disk G: on the owner's PC is full. Use C: scratchpad clones.
- `TZ=Asia/Kolkata` doesn't work in this Windows shell. Compute IST with Python.
- Generate uv.lock with the Dockerfile's uv version (0.9.26).
