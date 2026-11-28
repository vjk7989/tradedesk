# Contributing

Developer setup for TradeDesk. Read [SECURITY.md](SECURITY.md) first: this code can place real orders when an operator switches it to live mode.

## Toolchain

| Tool | Version | Source |
|---|---|---|
| Node | 22 or newer | `engines` in `trade-mcp/package.json` and `agent-runner/package.json` (`>=22`); CI uses 22 |
| Python | 3.12 | CI (`python-version: "3.12"`); `bt-service/pyproject.toml` allows `>=3.11` |
| uv | 0.9.26 for lockfiles | `bt-service/Dockerfile`, rule in `bt-service/README.md` |
| Docker | any recent, with compose | `docker compose` config check in the deploy CI job |

Install uv from https://docs.astral.sh/uv/.

pandas 3 is current (`pandas>=3,<4`, see `bt-service/README.md`).

## Install and verify

Run these from the repo root. They are the same commands CI runs (`.github/workflows/ci.yml`), so a green local run means a green CI job.

```
# trade-mcp
cd trade-mcp && npm ci && npx vitest run && npx tsc --noEmit && npm run build

# agent-runner
cd agent-runner && npm ci && npx vitest run && npx tsc --noEmit && npm run build && node dist/main.js --help

# bt-service (the full suite is slow, about 8 minutes)
cd bt-service && uv sync && uv run python -c "import pandas; print(pandas.__version__); assert pandas.__version__.startswith('3')" && uv run pytest -q

# deploy tests, from the repo root
docker compose -f deploy/docker-compose.yml --env-file deploy/.env.example config -q
uv run --with pytest --with pyyaml pytest -q deploy/
```

Add `--co -q` to either pytest command to list the tests without running them.

### e2e smoke

Runs trade-mcp, bt-service and a fake OpenAlgo together, with no Docker, broker or network (`e2e/README.md`). Install and build first (`npm ci` and `npm run build` in both Node packages, `uv sync` in `bt-service`), then from the repo root:

```
node e2e/smoke.mjs
```

It prints PASS or FAIL per step and exits non-zero on any failure.

## Lockfiles

Generate `bt-service/uv.lock` with the Dockerfile's uv version:

```
cd bt-service && uvx --from uv==0.9.26 uv lock
```

Newer uv releases write a newer lock format that the production image may not read. If a Dependabot uv PR rewrites the lock, re-lock it with 0.9.26 before merging, or close it. CI does not enforce this.

## Test rules (ADR-17 and `coord/TM2_SOLO.md`)

- Developers never edit existing tests. Only the test writer updates pinned tests, including ones a brief changes on purpose. Add new tests if the brief asks; do not change old ones to make them pass.
- Tests that place NSE orders must pin the clock (`RiskEngine` takes `now`). The risk engine refuses orders outside NSE hours, so an unpinned test fails at night and on weekends.
- POSIX-only tests (symlinks, file permissions) use `skipIf(win32)` with a reason, for example `it.skipIf(IS_WIN)(...)` in `trade-mcp/test/tm2_46_datadir_lock.edge.test.ts`.
- CI runs on Linux, so it catches tests that pass only on Windows or only in one order.

## Pull requests

1. One branch per task, named `tm2/<ID>` (or `own/<ID>` for owner tasks), from the latest `main`. The brief is `coord/tasks/<ID>.md`.
2. Touch only the files the brief lists.
3. Write your report to `coord/reports/<ID>.md`.
4. Open a PR to `main`. CI must be green: all four jobs (trade-mcp, agent-runner, bt-service, deploy).
5. A separate reviewer and test writer check the PR. Rebase onto the latest `main` and re-run before merging.
6. Merge only your own PR, pinned to the tested commit:

```
gh pr merge <n> --merge --match-head-commit <sha>
```

Never push to `main` directly (doc-only board updates by the maintainers excepted), never force-push, and never use a bare `git stash`.

## Windows notes

- `TZ=Asia/Kolkata` does not work in Git Bash (`hand-off.md`). The repo documents no cause. Compute IST in Python instead, for example `python -c "from zoneinfo import ZoneInfo; from datetime import datetime; print(datetime.now(ZoneInfo('Asia/Kolkata')))"`. Prefer pinned clocks in tests anyway.
- CRLF warnings from git (`LF will be replaced by CRLF`) are harmless.
- Under load Windows can fail with exit code 0xC0000142; `--lf` re-runs only the failures for the pytest suites (bt-service, deploy); vitest has no `--lf`, so re-run the failing file with `npx vitest run <file>`.
- Smoke cleanup uses `taskkill /T /F` on Windows automatically.

## Security

- Never commit secrets: no API keys, tokens (`MCP_TOKEN`, `MCP_TOKEN_READONLY`), OAuth data, `.env` files or broker credentials. Use `deploy/.env.example` for placeholders only.
- The repo is public: no emails, personal names or hostnames in code, docs or reports.
- Do not touch `MODE=live`, broker keys or safety rules (kill switch, risk caps, audit fail-closed, read-only token) without the owner.
- Report vulnerabilities privately through GitHub Security Advisories, as described in [SECURITY.md](SECURITY.md).
