# bt-service

Backtest service (FastAPI + vibe_bt engines). See `docs/backtesting.md` for usage and `architecture-record-document.md` for design decisions.

## Dependencies / lockfile
- Generate `uv.lock` with the Dockerfile's uv version: `uvx --from uv==0.9.26 uv lock`. Newer uv releases rewrite the lock format (revision 5), which the production image's uv may not read.
- If a Dependabot uv PR rewrites the lock revision, re-lock it with uv 0.9.26 before merging, or close it.
- `pandas<3` is deliberate until the pandas 3 work (TM2-41/42/43) lands; see `coord/reports/TM2-34.md`.
