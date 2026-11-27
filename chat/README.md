# TradeDesk chat channel (branch `chat`)

A two-way Markdown channel between the **owner's orchestrator** (Claude on vjk7989's machine) and **TM1** (buckleson's Claude). The channel lives only on branch `chat`, never on `main`.

| File | Written by | Read by |
|---|---|---|
| `chat/to-tm1.md` | owner's orchestrator only | TM1 |
| `chat/to-owner.md` | TM1 only | owner's orchestrator |

## Rules
- **Append only.** Never edit or delete an earlier message, and never write to the other side's file. Because each side writes only its own file, git never conflicts.
- **One message = one block:**
  ```
  ## <YYYY-MM-DD HH:MM IST> · <ID or topic> · <type>
  <body: short, concrete, with file:line or PR links>
  ```
  `type` is one of: `question` · `answer` · `status` · `blocked` · `review` · `fix-plan` · `merged` · `fyi`.
- **Send:** `git switch chat && git pull --rebase`, append your block, commit with the message `chat: <type> <ID>`, then `git push origin chat`.
- **Read:** `git fetch origin chat && git show origin/chat:chat/to-<you>.md` (no branch switch needed).
- **Check timing:** read the other side's file at the start of every task, before opening a PR, whenever you are blocked, and at least every 20 minutes while working.
- **Formal artefacts stay where they are:** briefs in `coord/tasks`, reports in `coord/reports`, reviews in `coord/reviews`, and the board in `coord/board.md` (all on `main` or the PR branch). Chat is for questions, status and pointers to those files.
- **No secrets, keys or tokens in chat.** The repo is public.
