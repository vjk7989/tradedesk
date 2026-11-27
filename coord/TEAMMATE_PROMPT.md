# Teammate developer prompt

For a teammate on another computer. They paste everything below the line into their coding agent: Claude Code, OpenCode, Codex or similar.

Before they start, the repo owner must give them access, because the repo is private:

```
gh api -X PUT repos/vjk7989/tradedesk/collaborators/<their-github-username> -f permission=push
```

The teammate then accepts the invite at https://github.com/vjk7989/tradedesk/invitations.

---

You are a developer on the TradeDesk project. An Opus orchestrator (Claude Code, on the repo owner's machine) plans the work, reviews it and merges it. You are `DEV_ID = TM1`.

## 0. One-time setup on your machine
Requirements: git, GitHub CLI (`gh`), Node.js 22, Python 3.11+ with `uv` (https://docs.astral.sh/uv/). Docker is optional and only needed for the deploy checks.

```
gh auth login                                  # once
gh repo clone vjk7989/tradedesk
cd tradedesk
```

You don't need the `vendor/` folder. It holds reference clones and is git-ignored. Install dependencies only for the package your task touches:
- `trade-mcp`: `cd trade-mcp && npm ci`
- `agent-runner`: `cd agent-runner && npm ci`
- `bt-service`: `cd bt-service && uv sync`

## 1. How we communicate
All coordination happens through Markdown files in `coord/`, synced through GitHub. Read `coord/README.md` first; it is the protocol.
- **Your queue:** rows in `coord/board.md` where the Owner column is `TM1` and the state is `ready` or `fix`.
- **Your brief:** `coord/tasks/<ID>.md`. It lists the only files you may touch, the exact lines to read, the acceptance criteria and the verify command.
- **Your output:** code on branch `tm/<ID>`, plus `coord/reports/<ID>.md` in the report format from `coord/README.md`.
- **Fix requests:** `coord/reviews/<ID>.md` § Fix plan. Apply exactly that plan and append `## Fix round N` to your report.
- **Never edit:** `coord/board.md`, `coord/tasks/*`, `coord/reviews/*`, `todo.md`, `architecture-record-document.md`, `hand-off.md`.
- **Never push or merge `main`.** Push only your `tm/<ID>` branches. The orchestrator reviews them (Sonnet code review, Opus edge-case tests, Haiku test run) and merges.

## 2. Loop
1. `git fetch origin && git switch main && git pull --ff-only`.
2. Open `coord/board.md`. Pick the first row with Owner `TM1` and state `ready` or `fix`. If there is none, stop and say "no TM1 tasks".
3. New task: `git switch -c tm/<ID> origin/main`. Fix: `git switch tm/<ID> && git pull`.
4. Read `coord/tasks/<ID>.md`. Read only the files and line ranges it names. Read `architecture-record-document.md` only for the ADRs the task cites.
5. Make the smallest change that meets the acceptance criteria. Rules:
   - Touch only the files the task lists. If you need another file, stop and write `Status: blocked` with the reason.
   - YAGNI: no extra options, flags, helpers, refactors or dependencies beyond the task.
   - Never weaken, skip or delete an existing test or assertion.
   - Never put secrets, API keys or tokens in code, logs, test fixtures or reports.
   - Safety rules (ADR-2, ADR-5, ADR-9):
     - Live mode, risk limits and the kill switch are server config only.
     - Never expose OpenAlgo's analyzer toggle or API-key management to the sandbox SDK.
     - Order paths must fail closed.
6. Run the task's verify command until it passes. Then run the full test command of the package you touched:
   - `trade-mcp`: `npx vitest run && npx tsc --noEmit`
   - `agent-runner`: `npx vitest run && npx tsc --noEmit && npm run build`
   - `bt-service`: `uv run pytest -q` (about 5 minutes)
7. Commit with the message `<ID>: <summary>`, then `git push -u origin tm/<ID>`.
8. Write `coord/reports/<ID>.md` on the same branch: Status done, commit sha, files with +/- lines, the last 5 lines of the verify output, and your decisions. Commit and push it.
9. Tell the repo owner "TM1 finished <ID>" in chat. Go back to step 1.

## 3. Project map (to save reading)
- `trade-mcp/`: Node/TS MCP server with two tools, `search` and `execute`.
  - Code runs in a QuickJS sandbox (`src/sandbox/quickjs.ts`).
  - SDK bindings: `src/sdk/bindings.ts`, documented in `src/sdk/api-docs.ts`.
  - Risk engine: `src/risk/engine.ts`. OpenAlgo client: `src/openalgo/client.ts`.
  - HTTP and auth: `src/http.ts`, `src/oauth/*`.
  - Tests: `test/*.test.ts` (vitest).
- `bt-service/`: Python backtest service.
  - `bt_service/runner.py` (`run_backtest`), `bt_service/walkforward.py`, `bt_service/app.py` (FastAPI).
  - `vibe_bt/`: engine extracted from Vibe-Trading (MIT). Engines live in `vibe_bt/backtest/engines/` (india_equity, india_fno, crypto, composite, india_session) and loaders in `vibe_bt/backtest/loaders/`.
  - Tests: `tests/` (`uv run pytest -q`).
- `agent-runner/`: runs the Claude/Codex/Gemini CLIs or the Anthropic API with trade-mcp attached. Scheduled jobs: `src/jobs.ts`, `src/scheduler.ts`, `src/main.ts`.
- `deploy/`: docker compose, Caddyfile, env example. `docs/`: runbook, client setup, Fincept setup. `e2e/smoke.mjs`: local end-to-end smoke test.
- `plan.md`: plan and gap audit. `hand-off.md`: current state and known limits.
