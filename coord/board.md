> 2026-11-28: two builders. OWNER (vjk7989 session) builds O-* and TM2-7 and merges its own PRs; TM2 builds TM2-* and merges its own PRs, each with the full chain (see coord/TM2_SOLO.md §0).

# Task board (Opus orchestrator edits this file only) — see coord/TEAM_PLAN.md for who is who

| ID | Owner | State | Task file | Notes |
|---|---|---|---|---|
| PB-4 | OWNER | done | (inline) | paper-bot deploy defaults BTC+ETH, 300s (#106) |
| PB-3 | OWNER | done | (hotfix) | paper-bot egress network (#103) |
| TM2-66 | TM2 | merged (#105) | coord/tasks/TM2-66.md | revoke-cli prints the revoke sequence with the wait |
| TM2-67 | TM2 | testing (#107) | coord/tasks/TM2-67.md | tz-aware price index in tushare fundamentals merge |
| TM2-68 | TM2 | in progress | coord/tasks/TM2-68.md | explicit filed parsing in _ffill_pit, warn on drops |
| TM2-64 | TM2 | in progress (draft #104, CI data) | coord/tasks/TM2-64.md | recalibrate 50-runs external-growth bound from CI data |
| TM2-65 | TM2 | review (#108) | coord/tasks/TM2-65.md | docs/paper-bot.md operator guide |
| TM2-61 | TM2 | merged (#99) | coord/tasks/TM2-61.md | runbook end-to-end accuracy pass |
| TM2-62 | TM2 | merged #98 | coord/tasks/TM2-62.md | README refresh |
| TM2-63 | TM2 | merged (#102) | coord/tasks/TM2-63.md | register SIGINT/SIGTERM before startup completes |
| PB-1 | OWNER | done | coord/tasks/PB-1.md | paper-bot crypto paper trader + dashboard |
| PB-2 | OWNER | done | coord/tasks/PB-2.md | deploy paper-bot behind Caddy basic auth + CI |
| O-16 | OWNER | done | coord/tasks/O-16.md | EXECUTE_MEMORY_MB (per-run sandbox memory knob) |
| TM2-55 | TM2 | merged #92 (audit: 1 third-party warning) | coord/tasks/TM2-55.md | warnings audit after pandas 3 |
| TM2-56 | TM2 | merged #89 | coord/tasks/TM2-56.md | CONTRIBUTING.md developer setup |
| TM2-58 | TM2 | merged #94 | coord/tasks/TM2-58.md | tm3_holidays perf test under 8 s |
| TM2-57 | TM2 | merged #96 | coord/tasks/TM2-57.md | de-flake tm2_46 SIGKILL/other-hostname test |
| TM2-59 | TM2 | merged #101 | coord/tasks/TM2-59.md | explicit-unit asserts in pass-through tests |
| TM2-60 | TM2 | merged (#100) | coord/tasks/TM2-60.md | datetime columns vs int64 audit |
| O-15 | OWNER | done | coord/tasks/O-15.md | CI asserts pandas 3 in bt-service job |
| TM2-53 | TM2 | merged #91 | coord/tasks/TM2-53.md | smoke: concurrency cap + memory recovery e2e |
| TM2-54 | TM2 | merged #88 | coord/tasks/TM2-54.md | troubleshooting: sandbox-limit errors |
| TM2-50 | TM2 | merged #86 | coord/tasks/TM2-50.md | docs: thin-fold warning + no fixed hostname |
| TM2-51 | TM2 | merged #84 | coord/tasks/TM2-51.md | walk-forward non-list equity guard |
| TM2-52 | TM2 | merged #90 | coord/tasks/TM2-52.md | de-flake tm3_holidays perf test |
| O-14 | OWNER | done | coord/tasks/O-14.md | api-docs: sandbox limits for the AI |
| TM2-47 | TM2 | merged #82 | coord/tasks/TM2-47.md | container mem/cpu limits (compose) |
| TM2-48 | TM2 | merged #80 | coord/tasks/TM2-48.md | SECURITY.md threat model + reporting |
| O-13 | OWNER | done | coord/tasks/O-13.md | in-run memory check misses JSON.parse loop |
| O-12 | OWNER | done | coord/tasks/O-12.md | api-docs walkForward partial folds; de-flake O-8 JSON.parse test |
| TM2-45 | TM2 | merged #79 (squash) | coord/tasks/TM2-45.md | central ns normaliser in shared load path |
| TM2-46 | TM2 | merged #76 | coord/tasks/TM2-46.md | DATA_DIR lock; revoke-all refuses live server |
| TM2-49 | TM2 | merged #83 (Windows green, owner 06:38) | coord/tasks/TM2-49.md | TM2-35/46 tests green on Windows |
| O-11 | OWNER | done | (inline) | deploy: EXECUTE_MAX_CONCURRENT in .env.example/compose/runbook |
| TM2-44 | TM2 | merged #75 | coord/tasks/TM2-44.md | de-flake OAuth rate-limit tests (scrypt timing) |
| O-10 | OWNER | done | coord/tasks/O-10.md | cap concurrent execute runs |
| O-9 | OWNER | done | coord/tasks/O-9.md | sandbox hardening follow-ups (O-8 security review) |
| TM2-35 | TM2 | merged #66 | coord/tasks/TM2-35.md | oauth:revoke-all operator command |
| TM2-36 | TM2 | merged #64 | coord/tasks/TM2-36.md | agent-runner --history [N] |
| TM2-37 | TM2 | merged #72 | coord/tasks/TM2-37.md | de-flake sandbox 50 sequential runs |
| TM2-40 | TM2 | merged #67 | coord/tasks/TM2-40.md | ccxt>=4.5.94 floor (after #52 downgrade) |
| TM2-38 | TM2 | merged #70 | coord/tasks/TM2-38.md | walk-forward keeps completed folds on failure |
| TM2-39 | TM2 | merged #78 | coord/tasks/TM2-39.md | walk-forward thin-fold warning |
| TM2-41 | TM2 | merged #69 | coord/tasks/TM2-41.md | P3-A loaders normalise to ns |
| TM2-42 | TM2 | merged #73 | coord/tasks/TM2-42.md | P3-B drop .values, unit-mixing guard |
| TM2-43 | TM2 | merged #85 (pandas 3.1.1) | coord/tasks/TM2-43.md | P3-C lift pandas pin to 3.x |
| O-8 | OWNER | done | coord/tasks/O-8.md | sandbox memory cap must cover ArrayBuffer/TypedArray (on PR #57) |
| O-7 | OWNER | done | coord/tasks/O-7.md | api-docs risk.status + kill-switch line; de-flake owner tests |
| TM2-32 | TM2 | merged #61 | coord/tasks/TM2-32.md | search: rank Rules lines by tokens matched |
| TM2-33 | TM2 | merged #60 | coord/tasks/TM2-33.md | dependabot ignore pandas major; close #53 |
| TM2-34 | TM2 | merged #62 | coord/tasks/TM2-34.md | pandas 3 readiness report (no upgrade) |
| O-6 | OWNER | done | (inline) | stabilise sandbox memory-limit tests |
| TM2-28 | TM2 | merged #56 | coord/tasks/TM2-28.md | smoke: options backtest + audit.recent |
| TM2-29 | TM2 | merged #58 | coord/tasks/TM2-29.md | docs: connect-clients refresh |
| TM2-30 | TM2 | merged #54 | coord/tasks/TM2-30.md | agent-runner --dry-run <name> |
| TM2-31 | TM2 | merged #63 | coord/tasks/TM2-31.md | walk-forward with options + composite |
| TM2-25 | TM2 | merged #55 | coord/tasks/TM2-25.md | search matches API_HEADER rules |
| TM2-26 | TM2 | merged #47 | coord/tasks/TM2-26.md | Dependabot for actions + lockfiles |
| TM2-27 | TM2 | merged #48 | coord/tasks/TM2-27.md | risk.status reports all limits |
| O-5 | OWNER | done | coord/tasks/O-5.md | api-docs: short-option qty cap |
| O-4 | OWNER | done | coord/tasks/O-4.md | bound size of audited entries |
| TM2-24 | TM2 | merged #46 | coord/tasks/TM2-24.md | e2e smoke: pin clock via preload + #37 LOWs |
| O-3 | OWNER | done | coord/tasks/O-3.md | audit.recent binding + exact busy text |
| TM2-21 | TM2 | merged #39 | coord/tasks/TM2-21.md | Telegram timeout-path tidy |
| TM2-22 | TM2 | merged #42 | coord/tasks/TM2-22.md | docs: EXECUTE_TIMEOUT_MS clamp + trade truncation |
| TM2-23 | TM2 | merged #40 | coord/tasks/TM2-23.md | optional short-option qty risk cap |
| O-1 | OWNER | done | coord/tasks/O-1.md | api-docs: document india_options |
| O-2 | OWNER | done | coord/tasks/O-2.md | risk.json UTF-8 BOM accepted |
| TM2-17 | TM2 | merged #41 | coord/tasks/TM2-17.md | explicit datetime format, india_broker_loader |
| TM2-18 | TM2 | merged #35 | coord/tasks/TM2-18.md | Telegram drain non-2xx + LOWs |
| TM2-19 | TM2 | merged #37 | coord/tasks/TM2-19.md | e2e smoke: /readyz, risk:lint, --check |
| TM2-20 | TM2 | merged #36 | coord/tasks/TM2-20.md | docs/backtesting.md |
| OC-P7.3 | OC1 | done | coord/tasks/OC-P7.3.md | walk-forward / OOS endpoint in bt-service |
| OC-P7.4 | OC1 | done | coord/tasks/OC-P7.4.md | backtest.walkForward binding in trade-mcp |
| TM-1 | TM1 | done | coord/tasks/TM-1.md | MIS intraday stamp duty rate (bt-service) |
| TM-3 | TM1 | done | coord/tasks/TM-3.md | exchange holidays block orders (trade-mcp risk) |
| TM-4 | TM1 | done | coord/tasks/TM-4.md | root README.md for the public repo |
| TM-5 | TM1 | done | coord/tasks/TM-5.md | agent-runner OpenAI API backend (remote MCP) |
| TM2-9 | TM2 | done | coord/tasks/TM2-9.md | risk:lint CLI for risk.json |
| TM2-10 | TM2 | done | coord/tasks/TM2-10.md | shared audit probe + /readyz abort/redirect |
| TM2-11 | TM2 | done | coord/tasks/TM2-11.md | docs/troubleshooting.md |
| TM2-12 | TM2 | done | coord/tasks/TM2-12.md | agent-runner --next N upper bound (1..100) |
| TM2-13 | TM2 | done | coord/tasks/TM2-13.md | Windows-only backslash test made platform-correct (Linux red on main) |
| TM2-14 | TM2 | done | coord/tasks/TM2-14.md | README + runbook links for the new tools/docs |
| TM2-15 | TM2 | done | coord/tasks/TM2-15.md | /readyz really cancels the OpenAlgo probe |
| TM2-16 | TM2 | done | coord/tasks/TM2-16.md | accept lowercase "1h" interval consistently |
| TM-15 | TM2 (from TM1) | done | coord/tasks/TM-15.md | find + remove remaining ~570 warnings |
| TM-16 | TM1 | done | coord/tasks/TM-16.md | OAuth follow-ups: HMAC IP hash, no persist on bad code |
| TM2-7 | OWNER (from TM2) | done | coord/tasks/TM2-7.md | GitHub Actions CI for all suites |
| TM2-8 | TM2 | done | coord/tasks/TM2-8.md | agent-runner --check / --next |
| TM2-5 | TM2 | done | coord/tasks/TM2-5.md | trade-mcp /readyz |
| TM2-6 | TM2 | done | coord/tasks/TM2-6.md | Telegram notifications for job reports |
| TM2-3 | TM2 | done | coord/tasks/TM2-3.md | agent-runner Gemini API backend |
| TM2-4 | TM2 | done | coord/tasks/TM2-4.md | sync OpenAlgo holidays into risk.json |
| TM2-1 | TM2 | done | coord/tasks/TM2-1.md | VPS backup/restore scripts + docs |
| TM2-2 | TM2 | done | coord/tasks/TM2-2.md | trade-mcp audit log rotation + retention |
| TM-13 | TM1 | done | coord/tasks/TM-13.md | persist OAuth codes/pending/rate-limit across restarts |
| TM-14 | TM2 (from TM1) | done | coord/tasks/TM-14.md | NSE index options backtest engine (CE/PE) |
| TM-12 | TM1 | done | coord/tasks/TM-12.md | EXECUTE_TIMEOUT_MS in compose/.env.example/runbook |
| TM-11 | TM1 | done | coord/tasks/TM-11.md | remaining deprecation-warning sites |
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
