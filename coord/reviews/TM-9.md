# TM-9 review
## Code review (Sonnet)
Verdict: approve (minor nits)

1. smoke.mjs:101-104 (info): SMA_P is correct. It injects __init__(fast, slow) with defaults, so the no-arg contract still holds. Candidate keys fast/slow match, and step 6 is untouched. The `.replace` calls are silent no-ops if SMA is reformatted.
2. smoke.mjs:216-220 (low): the asserts only check ok, folds>=1 and oosEquity>=1. Nothing proves the candidates reach the engine, because a SignalEngine that ignored kwargs would still pass. Add an assert that folds[0].chosen is one of the candidates. Step 11 could also assert folds.length.
3. smoke.mjs:222-232 (info): step 10 is right. Metadata is 404, /mcp is 401, and no resource_metadata appears in WWW-Authenticate. The fetches have no per-call timeout and rely on the 120 s step cap.
4. smoke.mjs:234-241 (info): step 11 closes ro in finally. The existing cleanup (kill tree, outer finally) covers failure paths. Windows taskkill is used.
5. No secrets are printed. Failure output is sliced to 600 characters and could include response bodies, but those hold no tokens. No product code is changed (only e2e/ and README). Reported runtime is about 70 s.
6. The walk-forward window is narrowed (Jan-Feb) for runtime. That is acceptable and documented. The execute-timeout finding in the report is a good follow-up.

## Test run (Haiku)

Branch review-pr7 (origin/tm/TM-9) merged with origin/main: clean, no conflicts.

| command | result | time |
|---|---|---|
| git merge -q --no-edit origin/main (pr7 worktree) | clean merge, d7d36da | <1s |
| npm ci (trade-mcp) | PASS, 155 packages, 0 vulns | 7s |
| uv sync (bt-service) | PASS | — |
| node e2e/smoke.mjs (run 1) | PASS 11/11 | 1m30s |
| node e2e/smoke.mjs (run 2, cleanup check) | PASS 11/11 | 1m18s |

Full log: G:\uday-demos\reports\TM-9.md
Overall: GREEN

## Verdict (Opus)
PR #7 merged as 737402d. Sonnet approved; Haiku: smoke 11/11 twice (cleanup OK).
Follow-up (low, not blocking): in step 9, assert that folds[0].chosen is one of the candidates.
