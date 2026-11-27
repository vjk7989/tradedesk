# TradeDesk team plan (single source of truth)

Last updated: 2026-11-27 18:50 IST. If anything else contradicts this file, this file wins.

## 1. Who is who
| ID | Who | Where it runs | What it does | Git author |
|---|---|---|---|---|
| **OWNER** | vjk7989's Claude Code orchestrator (Opus) + its subagents | owner's PC, checkout `G:\uday-demos` | plans, writes task briefs, reviews, tests, **merges**, edits board/todo/ADR/hand-off | vjk7989 |
| **TM1** | a second Claude Code session (Opus + Sonnet devs) | owner's PC, worktrees `G:\uday-demos.tmN` | builds tasks `TM-*` | vjk7989 |
| **TM2** | buckleson's Claude Code session (Opus + Sonnet devs) | buckleson's machine, own clone | builds tasks `TM2-*` | buckleson |

TM1 and TM2 are **different** teammates. Never act on the other's tasks, branches or chat files.

## 2. Who owns what
| Thing | OWNER | TM1 | TM2 |
|---|---|---|---|
| `main` branch | merges only (via `gh pr merge`) | never pushes | never pushes |
| Task briefs `coord/tasks/*` | writes | reads `TM-*` | reads `TM2-*` |
| `coord/board.md`, `todo.md`, `architecture-record-document.md`, `hand-off.md` | writes | reads | reads |
| Work branches | — | `tm/<ID>` | `tm2/<ID>` |
| Reports | — | `coord/reports/TM-*.md` on its branch | `coord/reports/TM2-*.md` on its branch |
| Reviews `coord/reviews/*` | writes | reads | reads |
| PRs | reviews, tests, merges | opens, fixes | opens, fixes |

## 3. Chat (branch `chat`, append-only, each side writes only its own file)
| Pair | Teammate writes | OWNER writes |
|---|---|---|
| OWNER ↔ TM1 | `chat/to-owner.md` | `chat/to-tm1.md` |
| OWNER ↔ TM2 | `chat/from-tm2.md` | `chat/to-tm2.md` |

Block format: `## <YYYY-MM-DD HH:MM IST> · <task ID or topic> · <question|answer|status|blocked|review|fix-plan|merged|fyi>`, then a short body.

## 4. Task lifecycle
1. OWNER writes `coord/tasks/<ID>.md` and adds a board row (`ready`).
2. The teammate posts `status: started`, creates `tm/<ID>` (TM1) or `tm2/<ID>` (TM2) from latest `main`, and builds it with Sonnet developers. Only the brief's files are touched, existing tests are never edited, and the verify command must pass.
3. The teammate writes the report, pushes, opens the PR to `main`, and posts `status: PR #n`.
4. OWNER runs Sonnet review (as PR comments), then Opus edge tests (pushed to the PR branch), then a Haiku run.
5. Green: OWNER merges, posts `merged`, and the board goes to `done`. Red: OWNER posts a `fix-plan` (in the reviews file, a PR comment and chat), and the board goes to `fix`. The teammate **pulls first**, applies exactly the plan and pushes. Two failed fix rounds → OWNER asks the user.
6. If a brief conflicts with existing tests or needs other files: the teammate sets `Status: blocked`, opens a draft PR, and posts `blocked`. OWNER rules.

## 5. Current queue (see `coord/board.md` for live state)
- **TM1:**
  - TM-6 (fix round), TM-8 (PR #8, testing), TM-10 (PR #10, fix round)
  - TM-11 (after TM-8 merges), TM-12 (after TM-10 merges)
- **TM2:** TM2-1 (PR #12), TM2-2 (PR #11) in review; TM2-3 (Gemini backend) and TM2-4 (holiday sync script) ready.
- **Done so far:** TM-1, TM-2, TM-3, TM-4, TM-5, TM-7, TM-9.
