# DEP-52 review: bt-service minor/patch group (yfinance, ccxt)

Verdict: HOLD
Head SHA: 0b8deedf7442b80a13a3c96a10a0d2fd2b8ea600
CI: bt-service FAIL; agent-runner, deploy, trade-mcp pass

## Changes
- yfinance 1.7.0 -> 1.8.0 (minor)
- ccxt 4.5.94 -> 4.5.64 (this is a DOWNGRADE, though the PR title and body present it as a bump)
- Only bt-service/uv.lock changes; pyproject.toml is untouched, so no constraints are loosened.
- Lockfile also changes: revision 3 -> 5, which splits the requires-python marker at 3.14.
- Transitive churn:
  - added: aiodns, pycares, setuptools
  - removed: aiohttp-fast-zlib, multitasking, orjson, uvloop, winloop, zlib-ng
  - bumped: curl-cffi 0.16.3 -> 0.17.0, cffi 2.0.0 -> 2.1.1
- All registries are pypi.org and files.pythonhosted.org.

## Why hold
1. ccxt goes backward (4.5.94 -> 4.5.64). That is not a minor/patch bump, and main currently locks 4.5.94.
2. CI bt-service fails: 1 failed, 1858 passed, 1 skipped.
   - Failing test: tests/test_crypto_backtest.py::test_at_crypto_symbol_auto_falls_back_to_local_without_network.
   - Cause: importing ccxt 4.5.64 runs ccxt/static_dependencies/toolz/_version.py, which calls git via subprocess.Popen. bt_service/_child.py blocks that with "blocked by sandbox: subprocess.Popen".
   - This is very likely a consequence of the ccxt downgrade. I did not confirm that main is green on the same test; the latest main CI run was still in progress or cancelled.

## Upstream notes
- yfinance 1.8.0 (from the PR body): forces curl_cffi >= 0.17 for security updates, adds Tickers.info and calendar, drops the multitasking dependency, fixes price-repair, news and DST issues. No breaking changes listed; the curl_cffi floor explains the 0.17.0 bump.
- ccxt: a changelog for a downgrade is not meaningful. Release notes for 4.5.65 through 4.5.94 are not reviewed.

## Recommendation
Do not merge. Close and let Dependabot re-resolve, or regenerate the lock so that ccxt stays at 4.5.94 or newer. A yfinance-only bump is fine in principle.
