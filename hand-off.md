# Hand-off 2026-11-27 (afternoon)
State: `main` on https://github.com/vjk7989/tradedesk (public).
- All planned phases are built and merged.
- Since the final gate, these also merged: P9.1 (NSE lot sizes and futures STT verified Nov 2026), P9.2 (funding cursor across scale-in), P9.3 (session-anchored 3m/10m bins), TM-1 and TM-2 (teammate PRs).
- Last full runs: bt-service 960–998 passed (depending on branch), trade-mcp 789 (+1 skipped), agent-runner 267, deploy 93, e2e 8/8.
- Code graph: codebase-memory `tradedesk`, re-indexed (3,390 nodes).

## Team
- **Owner side (this machine):** the Opus orchestrator.
  - Claude Sonnet developers.
  - Opus test writer.
  - Haiku runner.
  - Sonnet reviewer, for teammate PRs.
- **Teammate TM1 = buckleson.** Runs Claude Code on another machine: an Opus orchestrator plus parallel Sonnet developers.
  - Works on `tm/<ID>` branches and opens PRs to `main`.
  - Prompts: `coord/TEAMMATE_PROMPT.md` and `coord/CHAT_PROMPT.md`.
- **Chat:** branch `chat`. TM1 writes `chat/to-owner.md`; we write `chat/to-tm1.md` (local worktree `G:\uday-demos.chat`). Append-only.
- **Watch:** a session cron job (20 min) reads chat and PRs and runs the review chain on new PRs: Sonnet review, Opus edge tests, Haiku run, then merge or fix plan.
- **OpenCode:** retired (ADR-14).

## TM1 queue (coord/board.md)
| Task | What | Status |
|---|---|---|
| TM-3 | Exchange holidays in risk | ready |
| TM-4 | Root README | ready |
| TM-5 | OpenAI API backend | ready |
| TM-6 | Review follow-ups | ready |
| TM-7 | Jobs accept api-openai | after TM-5 |
| TM-8 | Remove numpy deprecation warnings | ready |
| TM-9 | e2e walkForward + OAuth-off steps | ready |

Expected pinned-test updates on our side:
- TM-3: `test/config.edge.test.ts` and `deploy/test_deploy.py` key sets.
- TM-7: the jobs backend error text.

## Open (needs the user)
- P4.4: paper-mode end-to-end run on the VPS before `MODE=live`.
- Verify on live systems: the Delta perpetual symbol (BTCUSD vs BTCUSDFUT via `market.search`), the OpenAlgo `WEBSOCKET_URL`, and the Fincept menu names.

## Known limits
- 1 lot needs margin plus opening fees, so capital exactly equal to margin opens nothing.
- Funding is not charged when a scale-in and a full exit both happen inside one sparse gap.
- OAuth codes and the login rate limiter are in memory.

- trade-mcp's port must never be published.

## Worktrees
`G:\uday-demos` (main), `.chat` (chat branch), `.d1` and `.d2` (idle; safe to remove).

## Gotchas
- Haiku runners need absolute `cd /g/uday-demos.<wt>` paths.
- Test writers own test edits.
- Concurrent full bt-service suites can hit Windows process-init failures (0xC0000142); rerun with `--lf`.
- Drive G: has ~6 GB free.
