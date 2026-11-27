# TM-4 report
Status: done
Branch: tm/TM-4   Commit: 0a034da
Files: README.md (+89/-0, new)
Verify: brief's link check → printed nothing; 89 lines (≤150)
Decisions:
- Test commands use (cd <pkg> && …) subshells from the repo root; deploy uses the compose config check plus `uv run --with pytest --with pyyaml pytest -q deploy/test_deploy.py`.
- "Known limits" are copied verbatim from hand-off.md, followed by "Verify rates and lot sizes before live trading". One limit reads "Holidays are not modelled until TM-3 lands"; it becomes stale once TM-3 merges, so the owner may want to drop that line when merging TM-3.
- Added a `coord/` row to the repo layout table.
- The only external URL is the clone URL. The domain placeholder is `<DOMAIN>`. No secrets or personal data.
developers: 1 sonnet, fix rounds: 1 (deploy test command)
