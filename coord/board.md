# Task board (Opus orchestrator edits this file only)

| ID | Owner | State | Task file | Notes |
|---|---|---|---|---|
| OC-P7.3 | OC1 | done | coord/tasks/OC-P7.3.md | walk-forward / OOS endpoint in bt-service |
| OC-P7.4 | OC1 | done | coord/tasks/OC-P7.4.md | backtest.walkForward binding in trade-mcp |
| TM-1 | TM1 | done | coord/tasks/TM-1.md | MIS intraday stamp duty rate (bt-service) |
| TM-3 | TM1 | done | coord/tasks/TM-3.md | exchange holidays block orders (trade-mcp risk) |
| TM-4 | TM1 | done | coord/tasks/TM-4.md | root README.md for the public repo |
| TM-5 | TM1 | done | coord/tasks/TM-5.md | agent-runner OpenAI API backend (remote MCP) |
| TM2-1 | TM2 | ready | coord/tasks/TM2-1.md | VPS backup/restore scripts + docs |
| TM2-2 | TM2 | ready | coord/tasks/TM2-2.md | trade-mcp audit log rotation + retention |
| TM-11 | TM1 | ready (after TM-8 merged) | coord/tasks/TM-11.md | remaining deprecation-warning sites |
| TM-10 | TM1 | ready | coord/tasks/TM-10.md | EXECUTE_TIMEOUT_MS so walkForward can finish in execute |
| TM-6 | TM1 | fix | coord/tasks/TM-6.md | review follow-ups: numbers.Real + --once exit guard |
| TM-7 | TM1 | ready | coord/tasks/TM-7.md | jobs accept api-openai backend |
| TM-8 | TM1 | ready | coord/tasks/TM-8.md | remove numpy generic-timedelta warnings |
| TM-9 | TM1 | done | coord/tasks/TM-9.md | e2e smoke: walkForward + OAuth-off steps |
| TM-2 | TM1 | done | coord/tasks/TM-2.md | agent-runner clean shutdown on signals, tested |
| OC-P5.2 | — | withdrawn | coord/tasks/OC-P5.2.md | Caddy OAuth routes + compose env + runbook | (reassigned to Claude developer as P5.2) |

States: `ready` · `fix` · `review` · `testing` · `done` · `blocked`.

> NOTE to OpenCode: never `git switch` inside G:\uday-demos (the orchestrator's checkout). Use your own worktree (see OPENCODE_PROMPT.md step 0). OC-P7.3 was committed in the main checkout; the orchestrator has moved it to its branch, nothing was lost.

> 2026-11-27: Per the user's instruction, no further tasks are assigned to OpenCode. OpenCode sessions can stop. OC-P7.4 (already delivered) is reviewed by Claude agents and then merged.

> 2026-11-27: Teammate developer TM1 (other machine) works from coord/TEAMMATE_PROMPT.md on branches `tm/<ID>`.

> 2026-11-27 16:00 IST: Two teammate sessions. **TM1** is a Claude session on the owner's PC (commits as vjk7989) and owns TM-3..TM-9. **TM2** is buckleson (separate machine) and owns TM2-*. TM2 uses branches `tm2/<ID>` and chat files `chat/to-tm2.md` / `chat/from-tm2.md`.
