# TM2 solo mode: buckleson's session runs the whole project

## 0. Update 2026-11-28: two builders
The owner session (vjk7989) is back as a second builder and coordinator. Both sides run the full chain (Sonnet dev → separate Sonnet reviewer → Opus edge tests → Haiku on PR merged onto latest main → merge with `--match-head-commit`) and **each side merges only its own PRs**:
- OWNER builds `O-*` and TM2-7 on branches `own/<ID>`;
- TM2 builds `TM2-*` on `tm2/<ID>`.
- The owner writes new briefs and the board. TM2 may still write its own follow-up briefs; post them in chat.
- Before merging, rebase onto the latest main and re-run, because both sides merge now.
- Jobs `tz` ruling: keep `Asia/Kolkata` and `UTC` only (crypto jobs use UTC). No non-IST/DST zones.

Effective 2026-11-27 ~16:15 IST, on the repo owner's instruction. This overrides `TEAM_PLAN.md` §1–2 where they conflict.

The owner's local session and TM1 have stopped. **TM2 (buckleson's Claude Code, which runs in the cloud) is now both builder and owner.** It plans, builds, reviews, tests and merges. The repo owner (vjk7989) stays the human approver for anything in "Ask the owner" below.

## 1. How each task flows (keep the separation of roles inside your session)
1. **Opus (you)** reads the brief in `coord/tasks/<ID>.md`, splits it, and briefs one **Sonnet developer** per task on branch `tm2/<ID>` (or the existing `tm/<ID>` for taken-over TM1 work), in its own worktree.
2. The developer builds, runs the brief's Verify command, writes `coord/reports/<ID>.md`, pushes, and opens a PR to `main`.
3. A **separate Sonnet reviewer** (fresh agent, reads only the diff + brief) posts `gh pr review <n> --comment` and writes `coord/reviews/<ID>.md`.
4. A **separate Opus test writer** (fresh agent, diff + AC only, never the developer's reasoning) writes edge tests and pushes them to the PR branch. Only test writers edit tests. Pinned tests that a brief changes on purpose are updated by the test writer.
5. **Haiku** runs the full suite of every touched package **with the PR merged onto the latest main**, and reports.
6. Green → `gh pr merge <n> --merge`. Red → Opus writes a fix plan in `coord/reviews/<ID>.md` and a PR comment, the same developer fixes it, and Haiku re-runs.
7. After two failed fix rounds on one problem, stop and ask the owner (see §4).
8. After each merge, update `coord/board.md` and `todo.md` (markers `[ ]` `[.]` `[x]` at the end of the line), append an ADR to `architecture-record-document.md` for any design decision, and rewrite `hand-off.md` at the end of each session. These doc-only commits may go straight to `main`. Everything else goes through a PR.

Use at most about 3 developers in parallel. Two tasks that touch the same file must run one after the other.

## 2. Queue (in this order)
| # | Task | Branch | State / notes |
|---|---|---|---|
| 1 | **TM-14** NSE options engine | `tm/TM-14`, PR #19 (open) | Taken over from TM1. Fix round 1 is open; see `coord/reviews/TM-14.md` (plan plus addendum items 1–6). Owner edge tests are on the branch, 7 failing until the fix lands. TM1 may have pushed partial fix commits, so pull first. |
| 2 | TM2-6 Telegram notifications | `tm2/TM2-6` | ready |
| 3 | TM2-10 shared audit probe + /readyz abort/redirect | `tm2/TM2-10` | ready |
| 4 | **TM-15** remaining ~570 bt-service warnings | `tm2/TM-15` | Taken over. TM1's work was never pushed, so start fresh from `coord/tasks/TM-15.md`. Don't touch the TM-14 files until #19 merges. |
| 5 | TM2-9 `risk:lint` CLI | `tm2/TM2-9` | ready |
| 6 | TM2-11 `docs/troubleshooting.md` | `tm2/TM2-11` | ready |
| 7 | TM2-12 `--next` upper bound | `tm2/TM2-12` | ready (small) |
| 8 | TM2-7 GitHub Actions CI | `tm2/TM2-7` | Waiting on your own permission decision. No secrets; `contents: read` only. |

When the queue is empty, write the next tasks yourself from `todo.md`, the review follow-ups below, and `plan.md`. Each brief needs files (≤5), a build section, acceptance criteria and a verify command. Post a one-line summary of each new task in `chat/from-tm2.md`.

Review follow-ups not yet tasked (good next candidates):
- the sandbox `execute` audit-probe helper is shared once TM2-10 lands; check that nothing else duplicates it;
- the jobs `tz` field rejects `America/New_York` (the #21 edge tests found this); decide whether non-IST time zones should be allowed;
- SENSEX lot size in the options lot table (verify the current value from an official source first);
- weekly option symbols with invalid dates (part of TM-14 item 6).

## 3. Known state (2026-11-27 ~16:15 IST)
- `main` is green: trade-mcp 1106 passed, agent-runner 629, deploy 256, bt-service ~1337.
- Merged today: TM-11, TM-12, TM-13, TM-16, TM2-1..TM2-5, TM2-8, and the owner's test fix that pins the clock in `server.edge.test.ts`.
- Gotchas:
  - Pin the clock in any test that places NSE orders (`RiskEngine` takes `now`).
  - Windows can hit 0xC0000142 under load; re-run with `--lf`.
  - The full bt-service suite takes about 8 minutes.

## 4. Ask the owner (vjk7989) before
- anything that touches real money or `MODE=live`, broker or Delta keys, or the VPS;
- adding repo collaborators, changing repo settings or secrets, or force-pushing;
- deleting branches other than your own merged ones;
- a change that drops a documented safety rule (kill switch, risk caps, audit fail-closed, read-only token);
- two failed fix rounds on one problem.

The owner reads `chat/from-tm2.md`, so post questions there with the `question` or `blocked` type, and also tell the owner directly if they're waiting.

## 5. Still the owner's own job (don't do these)
- **P4.4:** the 5-day paper-trading run on the VPS before going live.
- **Verify on live systems:** the Delta perpetual symbol, the OpenAlgo `WEBSOCKET_URL`, and the Fincept menu names.

## 6. Hard rules
- No secrets in the repo, PRs, reports or chat, ever. The repo is public.
- Never weaken a test to make it pass.
- Only edit tests through the test-writer role.
