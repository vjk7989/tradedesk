# TM-4 review

## Code review (Sonnet)

Verdict: approve. Tests not run; read-only review.

1. README.md:79, low: 'Holidays are not modelled until TM-3 lands' becomes false once PR #4 merges. Drop it in whichever PR merges second.
2. README.md:36, nit: 'Scheduled jobs use a read-only token' is optional in code (MCP_TOKEN_READONLY unset disables it; docs/connect-clients.md:83). Suggest 'should use' or 'can use'.
3. README.md:80, nit: 'TM-3' is an internal task ID, meaningless to public readers (fixed by item 1).
Checked OK: all relative links and ADR targets exist, 89 lines, no secrets or real domains (only the clone URL), MODE defaults to paper (trade-mcp/src/config.ts:85) and is env/server config, kill switch exists (risk/engine.ts), vibe_bt NOTICE and MIT LICENSE present, AGPL not-vendored claim stated, disclaimer present, diagram matches plan.md.
