# Agent coordination (Claude Code ↔ OpenCode)

Claude (Opus, orchestrator) and OpenCode developer agents talk only through the Markdown files in this folder. Nobody edits another party's files.

```
coord/
  README.md               this protocol
  OPENCODE_PROMPT.md      paste-ready prompt for OpenCode
  tasks/<ID>.md           written by Opus: one task per file (the brief)
  reports/<ID>.md         written by the OpenCode developer: result of that task
  reviews/<ID>.md         written by Claude reviewers (Sonnet review + Haiku test run + Opus verdict)
  board.md                written by Opus only: who owns which task, current state
```

## Lifecycle of a task

| Step | Who | Writes | State in `board.md` |
|---|---|---|---|
| 1 | Opus orchestrator | `tasks/<ID>.md`, a row in `board.md` | `ready` |
| 2 | OpenCode developer | claims it: changes nothing, starts work on branch `oc/<ID>` | — |
| 3 | OpenCode developer | code + `reports/<ID>.md` with `Status: done` or `Status: blocked` | — |
| 4 | Opus | sets `review` | `review` |
| 5 | Sonnet reviewer (Claude) | `reviews/<ID>.md` § Code review | `review` |
| 6 | Opus test writer (Claude) | edge-case tests on branch `oc/<ID>` | `testing` |
| 7 | Haiku runner (Claude) | `reviews/<ID>.md` § Test run | `testing` |
| 8a | Opus | green: merges `oc/<ID>` into `main`, pushes | `done` |
| 8b | Opus | red: writes `## Fix plan` in `reviews/<ID>.md` | `fix` |
| 9 | OpenCode developer | applies the fix plan, appends `## Fix round N` to `reports/<ID>.md` | — |

Only the Opus orchestrator merges, pushes and edits `board.md`, `todo.md`, `architecture-record-document.md` and `hand-off.md`.
Two failed fix rounds on one task → the orchestrator asks the human.

## File formats

### tasks/<ID>.md (Opus)
```
# <ID> · <area> · <one-line goal>
Branch: oc/<ID>        Base: main @ <commit>
Files you may touch (≤5): ...
Do not touch: ...
Context (read only these lines): path:line-range, ...
Acceptance criteria:
- ...
Verify (must pass before you report): <exact commands>
YAGNI: build only what the AC needs. No new dependency unless listed here.
```

### reports/<ID>.md (OpenCode developer)
```
# <ID> report
Status: done | blocked
Branch: oc/<ID>   Commit: <sha>
Files: path (+a/-b), ...
Verify: <command> → <pass/fail + ≤5 lines>
Notes / decisions: ...
Questions for orchestrator: ... (only if blocked)
```

### reviews/<ID>.md (Claude)
```
# <ID> review
## Code review (Sonnet)     verdict: approve | changes-needed
## Test run (Haiku)         GREEN | RED, table, failures with file:line
## Fix plan (Opus)          only when RED / changes-needed
## Verdict (Opus)           merged <sha> | fix round N
```
