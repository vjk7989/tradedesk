# TM-4 · repo · root README.md for the public repo
Branch: tm/TM-4        Base: main (latest)
Owner: TM1

## Files you may touch
- `README.md` (new, at the repo root)

## Context (read only these)
- `plan.md` §1 and §3 (goal and architecture diagram).
- `hand-off.md` ("What exists" table, known limits).
- `docs/connect-clients.md` and `docs/vps-runbook.md`: link to them, don't copy them.
- `architecture-record-document.md`: ADR titles only, so you can link the important ones (ADR-2, 3, 5, 7, 9).
- `bt-service/vibe_bt/NOTICE`: MIT attribution for Vibe-Trading.

## What to build
`README.md`, at most 150 lines, with these sections:
1. **Title and one-line summary.**
2. **What it is.** Code Mode MCP server (`search`/`execute`) over OpenAlgo (Indian brokers + Delta crypto), a backtest service (from Vibe-Trading), an agent runner (Claude, Codex, Gemini CLIs or the Anthropic API), and Fincept as an optional desktop cockpit.
3. **Architecture.** Copy the ASCII diagram from plan.md §3.
4. **Safety model.** Paper mode by default; live mode only via server config; risk limits; kill switch; audit log; read-only token for scheduled jobs; nothing in the sandbox can switch modes.
5. **Quick start.**
   - Local tests per package: the commands from `hand-off.md`.
   - Local smoke test: `node e2e/smoke.mjs`.
   - VPS: point to `docs/vps-runbook.md`.
   - Connecting clients: point to `docs/connect-clients.md`.
6. **Repo layout.** A table with one line per folder.
7. **Status and limits.** Copy the "Known limits" from hand-off.md verbatim as bullets, plus "verify rates and lot sizes before live trading".
8. **Licences and credits.**
   - Vibe-Trading code under `bt-service/vibe_bt` is MIT (see NOTICE).
   - OpenAlgo and Fincept are separate AGPL projects, used unmodified and not vendored.
   - Not affiliated with Fincept, OpenAlgo, Delta or any broker.
9. **Disclaimer.** Not financial advice; use at your own risk; paper-trade first.

## Acceptance criteria
- Every relative link resolves to a file that exists.
- No secrets, tokens, real domains or personal data. Use `<DOMAIN>` placeholders.
- 150 lines or fewer.

## Verify
```
test -f README.md && [ $(wc -l < README.md) -le 150 ] && grep -oE '\]\(([^)#]+)' README.md | sed 's/](//' | grep -v '^http' | while read p; do test -e "$p" || echo "MISSING $p"; done
```
The command must print nothing.

YAGNI: no badges, no CI, no extra files.
