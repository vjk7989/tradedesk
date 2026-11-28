# PB-5: deploy fixes found on first GCP deploy

## Bugs
1. bt-service could not write `/runs`: the tmpfs was root-owned (755) while the image runs as uid 1000 (`bt-service/Dockerfile`: `useradd -r -u 1000 app`, `USER app`). Every backtest failed with `PermissionError: [Errno 13]`.
2. OpenAlgo could not read `openalgo.env`: bind-mounted read-write as `/app/.env`, container runs as uid 1000, operator-owned mode-600 file is unreadable, so OpenAlgo restart-loops with ".env file not found".

## Fixes
- `deploy/docker-compose.yml`: bt-service tmpfs `- /runs:uid=1000,gid=1000,mode=0700`.
- `docs/vps-runbook.md` section 5: `sudo chown 1000 openalgo.env` after the chmod, with a one-line explanation; replaced the "unverified" note.

## Verification of uid 1000
- bt-service/Dockerfile: confirmed (uid 1000).
- OpenAlgo at pinned commit f83592a (upstream Dockerfile, `vendor/` not present): `useradd --uid 1000 appuser`, `USER appuser`. Confirmed.

## Tests
`uv run --with pytest --with pyyaml --with bcrypt pytest -q deploy/`: 366 passed, 4 skipped, no failures, no pinned failures. Tests not edited.

## Notes
Runbook section 6 still says the readability check is "unverified until you run this"; left unchanged (check remains a valid smoke test).
