# Task board (Opus orchestrator edits this file only) — see coord/TEAM_PLAN.md for who is who

| ID | Owner | State | Task file | Notes |
|---|---|---|---|---|
| OC-P7.3 | OC1 | done | coord/tasks/OC-P7.3.md | walk-forward / OOS endpoint in bt-service |
| OC-P7.4 | OC1 | done | coord/tasks/OC-P7.4.md | backtest.walkForward binding in trade-mcp |
| TM-1 | TM1 | done | coord/tasks/TM-1.md | MIS intraday stamp duty rate (bt-service) |
| TM-3 | TM1 | done | coord/tasks/TM-3.md | exchange holidays block orders (trade-mcp risk) |
| TM-4 | TM1 | done | coord/tasks/TM-4.md | root README.md for the public repo |
| TM-5 | TM1 | done | coord/tasks/TM-5.md | agent-runner OpenAI API backend (remote MCP) |
| TM2-9 | TM2 | ready | coord/tasks/TM2-9.md | risk:lint CLI for risk.json |
| TM2-10 | TM2 | ready (after #17 merged) | coord/tasks/TM2-10.md | shared audit probe + /readyz abort/redirect |
| TM2-11 | TM2 | ready | coord/tasks/TM2-11.md | docs/troubleshooting.md |
| TM-15 | TM1 | ready (after #18 merged) | coord/tasks/TM-15.md | find + remove remaining ~570 warnings |
| TM-16 | TM1 | ready (after #16 merged) | coord/tasks/TM-16.md | OAuth follow-ups: HMAC IP hash, no persist on bad code |
| TM2-7 | TM2 | ready | coord/tasks/TM2-7.md | GitHub Actions CI for all suites |
| TM2-8 | TM2 | ready | coord/tasks/TM2-8.md | agent-runner --check / --next |
| TM2-5 | TM2 | fix | coord/tasks/TM2-5.md | trade-mcp /readyz |
| TM2-6 | TM2 | ready (after TM2-3 merged) | coord/tasks/TM2-6.md | Telegram notifications for job reports |
| TM2-3 | TM2 | fix | coord/tasks/TM2-3.md | agent-runner Gemini API backend |
| TM2-4 | TM2 | fix | coord/tasks/TM2-4.md | sync OpenAlgo holidays into risk.json |
| TM2-1 | TM2 | done | coord/tasks/TM2-1.md | VPS backup/restore scripts + docs |
| TM2-2 | TM2 | fix | coord/tasks/TM2-2.md | trade-mcp audit log rotation + retention |
| TM-13 | TM1 | fix | coord/tasks/TM-13.md | persist OAuth codes/pending/rate-limit across restarts |
| TM-14 | TM1 | review | coord/tasks/TM-14.md | NSE index options backtest engine (CE/PE) |
| TM-12 | TM1 | done | coord/tasks/TM-12.md | EXECUTE_TIMEOUT_MS in compose/.env.example/runbook |
| TM-11 | TM1 | review | coord/tasks/TM-11.md | remaining deprecation-warning sites |
| TM-10 | TM1 | done | coord/tasks/TM-10.md | EXECUTE_TIMEOUT_MS so walkForward can finish in execute |
| TM-6 | TM1 | done | coord/tasks/TM-6.md | review follow-ups: numbers.Real + --once exit guard |
| TM-7 | TM1 | done | coord/tasks/TM-7.md | jobs accept api-openai backend |
| TM-8 | TM1 | done | coord/tasks/TM-8.md | remove numpy generic-timedelta warnings |
| TM-9 | TM1 | done | coord/tasks/TM-9.md | e2e smoke: walkForward + OAuth-off steps |
| TM-2 | TM1 | done | coord/tasks/TM-2.md | agent-runner clean shutdown on signals, tested |
| OC-P5.2 | — | withdrawn | coord/tasks/OC-P5.2.md | Caddy OAuth routes + compose env + runbook | (reassigned to Claude developer as P5.2) |

States: `ready` · `fix` · `review` · `testing` · `done` · `blocked`.

> NOTE to OpenCode: never `git switch` inside G:\uday-demos (the orchestrator's checkout). Use your own worktree (see OPENCODE_PROMPT.md step 0). OC-P7.3 was committed in the main checkout; the orchestrator has moved it to its branch, nothing was lost.

> 2026-11-27: Per the user's instruction, no further tasks are assigned to OpenCode. OpenCode sessions can stop. OC-P7.4 (already delivered) is reviewed by Claude agents and then merged.

> 2026-11-27: Teammate developer TM1 (other machine) works from coord/TEAMMATE_PROMPT.md on branches `tm/<ID>`.

> 2026-11-27 16:00 IST: Two teammate sessions. **TM1** is a Claude session on the owner's PC (commits as vjk7989) and owns TM-3..TM-9. **TM2** is buckleson (separate machine) and owns TM2-*. TM2 uses branches `tm2/<ID>` and chat files `chat/to-tm2.md` / `chat/from-tm2.md`.
