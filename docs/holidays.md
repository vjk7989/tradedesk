# Syncing exchange holidays

`deploy/sync_holidays.py` copies exchange holidays from OpenAlgo into the
`marketHolidays` key of `deploy/risk.json` (schema `trade-mcp/src/config.ts`: `{ NSE?: date[], MCX?: date[] }`, real `YYYY-MM-DD` dates).

```
export OPENALGO_URL=http://127.0.0.1:5000
export OPENALGO_API_KEY=...            # never printed or logged
python deploy/sync_holidays.py --risk deploy/risk.json [--year 2027] [--dry-run]
```

Source: `POST {OPENALGO_URL}/api/v1/market/holidays` with JSON body
`{"apikey", "year"?}` (year 2020-2050, default current year). Docs:
https://docs.openalgo.in/api-documentation/v1/utilities-api/holidays.md
## Mapping rule

Only `closed_exchanges` ("completely closed") counts. `open_exchanges`
(special sessions, e.g. MCX evening session on an NSE holiday, Muhurat) never
counts as a closure for that exchange.

- any of NSE, BSE, NFO, BFO, CDS fully closed -> `NSE` group
- MCX fully closed -> `MCX` group
- other exchanges (BCD, NCO, CRYPTO) are ignored; an exchange listed in both
  lists for a date is treated as open.
## Merge and write

- Union with existing dates, sorted, de-duplicated. `NSE`/`MCX` are written
  only if non-empty or already present.
- Any malformed date (or status other than `success`, HTTP error, non-JSON,
  unreadable risk.json) -> non-zero exit, file untouched.
- Only the `marketHolidays` value is replaced textually (it is located with a
  JSON scanner, so strings and brackets are respected); every other byte of
  the file is preserved, including inline arrays. The new value is compact
  one-line JSON. If the key is missing it is appended as the last key using
  the file's detected indent and line endings.
- Atomic: temp file in the same directory + `os.replace`; the previous file is
  copied to `risk.json.bak` first. If nothing changes, nothing is written
  (idempotent, no `.bak` churn).
- `--dry-run` prints the dates that would be added per group and writes nothing.
- After a real write, run `docker compose restart trade-mcp` (bind mount keeps old inode).
