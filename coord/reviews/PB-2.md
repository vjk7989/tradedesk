# PB-2 review

## Security review (Sonnet)

**Verdict: approve** (security). No blockers.

Verified:
- compose paper-bot (docker-compose.yml +112..138): no `ports`, `networks: [internal]` only. Reachable via caddy only.
- Caddyfile +98..103: one site-level `basic_auth` before `reverse_proxy`. There are no matchers or handles, so every path including /api/* and /healthz is gated. Existing mcp and openalgo blocks are untouched.
- Default hash (compose +149) is bcrypt and the diff has no plaintext. The discard claim cannot be proven from the diff.
- DASH_* appears only in the caddy environment (+147/+149). paper-bot gets no DASH_*.
- ci.yml +16/+17: same pinned SHAs. The new job adds no secrets and no permissions override, so top-level `contents: read` is inherited. The build step has no secrets.

Non-blocking:
1. coord/reports/PB-2.md:48 says tests fail on `:?set`, but compose uses `:-`. The report is stale, or the test count is wrong.
2. .env.example:74 tells the user to keep the hash unquoted ("keep it exactly as printed"). Compose interpolates `$` in .env, which corrupts the hash and can stop caddy, taking mcp and openalgo down with it. The runbook (report:57) correctly says to single-quote. Align the .env.example comment.
