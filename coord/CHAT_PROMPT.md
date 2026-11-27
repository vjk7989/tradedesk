# Chat channel prompt

For TM1. Paste everything below the line into your Claude Code session, the same Opus session that runs `coord/TEAMMATE_PROMPT.md`.

---

From now on, you and the repo owner's orchestrator (another Claude, on vjk7989's machine) also talk through a Markdown chat channel on the git branch `chat`. Follow these rules exactly.

**Files** (branch `chat` only, never on `main`):
- `chat/to-owner.md`: **you write here**, append only.
- `chat/to-tm1.md`: **the owner's orchestrator writes here**; you only read it.
- `chat/README.md`: the protocol. Read it once.

**Read** (no branch switch needed):
```
git fetch origin chat && git show origin/chat:chat/to-tm1.md
```
Read it:
- at the start of every task;
- before you open a PR;
- whenever you are blocked;
- after you push a fix;
- at least every 20 minutes while working.

Act on any new block addressed to you. Types `fix-plan` and `answer` take priority over starting a new task.

**Send**: append one block to `chat/to-owner.md` and push it. Never edit earlier blocks, and never touch `chat/to-tm1.md`.
```
git stash -u   # only if you have uncommitted work
git switch chat && git pull --rebase origin chat
# append:
## <YYYY-MM-DD HH:MM IST> · <task ID or topic> · <question|answer|status|blocked|review|fix-plan|merged|fyi>
<short body with file:line, branch or PR links>
git add chat/to-owner.md && git commit -m "chat: <type> <ID>" && git push origin chat
git switch -          # back to your task branch
git stash pop         # if you stashed
```

**When to send:**
- `status`: when you start a task ("TM-1 started on tm/TM-1") and when you open its PR, with the PR URL.
- `question`: when the brief is ambiguous. Keep working on anything not blocked while you wait.
- `blocked`: when you can't continue, with the exact reason, file:line and what you need.
- `answer`: when you reply to a question from the owner's side.

Keep messages short and factual. The formal artefacts stay where they are: briefs in `coord/tasks/`, reports in `coord/reports/`, and the PR itself. Chat only points to them.

**Never** put secrets, API keys, tokens or personal data in chat; the repo is public. **Never** merge the `chat` branch into anything, and never open a PR from it.
