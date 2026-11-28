# Security policy

TradeDesk is a personal project maintained on a best-effort basis. There is no SLA, no bug bounty and no guaranteed response time. It can place real orders when its operator switches it to live mode, so please read the limits below before you deploy it.

## Reporting a vulnerability

Please report privately through GitHub Security Advisories: open the **Security** tab of this repository and choose **Report a vulnerability**. Do not open a public issue or pull request for a vulnerability. Include the affected component, a minimal reproduction and the impact. Reports are handled when time allows.

## Scope

In scope: `trade-mcp`, `bt-service`, `agent-runner`, the `deploy/` files and the docs that describe how to run them. Upstream projects (OpenAlgo, Caddy, QuickJS, the brokers) should be reported to their own maintainers.

Assets the design protects:

- Broker sessions and broker or Delta API keys (held by OpenAlgo).
- The OpenAlgo API key (held only by trade-mcp, [ADR-2](architecture-record-document.md)).
- `MCP_TOKEN` (full access) and `MCP_TOKEN_READONLY` (no `trade` namespace).
- OAuth access and refresh tokens, and the OAuth login password hash.
- The audit log.

## Threat model and controls

**1. Untrusted AI-written code runs through `execute`.**
- Code runs in a QuickJS (WASM) sandbox with no network, filesystem or process access ([ADR-3](architecture-record-document.md)). It is parsed on the host first, so it cannot close its wrapper ([ADR-8](architecture-record-document.md)).
- No ArrayBuffer, typed arrays or WebAssembly in the guest; WASM heap ceiling; binding arguments capped at 1 MB, 64 calls in flight and `memoryBytes` of pending bytes; binding results capped ([ADR-18](architecture-record-document.md)).
- Code size is capped at 100 KB, and a time limit applies (60 s default, `EXECUTE_TIMEOUT_MS`, clamped to 5-900 s).
- Concurrent `execute` runs are capped (`EXECUTE_MAX_CONCURRENT`, default 4, max 32).
- Known gap: the in-run memory check can miss a tight native or `JSON.parse` loop until the run ends, when the post-run heap check catches it (host growth stays bounded by the binding caps). The fix (O-13) is in progress and not yet merged.

**2. Prompt injection leading to trading.** Whatever the model is told, orders pass a server-side risk engine that sandbox code cannot change ([ADR-5](architecture-record-document.md)):
- Caps on quantity, notional, orders per run and per day, and an optional cap on short option quantity.
- Market-hours and exchange-holiday checks, and a file-based kill switch.
- Orders are reserved before placing, and refused if the audit log is unwritable ([ADR-9](architecture-record-document.md)).
- Paper is the default mode. Paper mode refuses to trade unless OpenAlgo's analyzer is on, and the SDK has no way to toggle the analyzer.
- A read-only token removes the `trade` namespace from the sandbox entirely.
- `semi_auto` (human approval in OpenAlgo's Action Center) is OpenAlgo configuration set by the operator, not enforced by this code. The runbook recommends it for the first live days.

**3. Credential leakage.**
- Audit entries redact values by key name. `audit.recent` additionally scrubs the configured secret values.
- Responses from `search` and `execute` have configured secret values replaced with `[redacted]` (this includes the backtest-service token). Audit entries and `audit.recent` use `[REDACTED]`. `/readyz` returns fixed enum strings only, never URLs, keys or error text.
- Errors from the OpenAlgo client have its API key redacted (the backtest client does the same for its token).
- `agent-runner --dry-run` and `--history` redact all known secret env values from their output; `--check` prints only env var names and set/missing state.

**4. The network.**
- Only Caddy publishes ports (80 and 443). trade-mcp, OpenAlgo and bt-service are `expose`d on the compose network only. Caddy forwards only a fixed path allowlist to trade-mcp. Note that Caddy also proxies the OpenAlgo web UI on its own subdomain; protect it with OpenAlgo's login and a strong password.
- Orders must come from the static IP registered with the broker and with Delta ([runbook](docs/vps-runbook.md)).
- Static bearer tokens are compared in constant time.
- OAuth (for ChatGPT and claude.ai): PKCE, a client-registration allowlist for redirect hosts, refresh-token rotation where reuse of a rotated token revokes the whole token family, and an operator `oauth:revoke-all` command that refuses to run while the server is up (runbook section 13). Static tokens are not covered by it; rotate them in `.env`.

**5. Supply chain.** CI actions are pinned to commit SHAs with read-only permissions. Dependabot opens weekly update PRs with no auto-merge. Python lockfiles are meant to be generated with the uv version pinned to the production image; this is a documented convention ([bt-service README](bt-service/README.md)), not enforced by CI.

## Known limits (accepted)

- One trade-mcp process per `DATA_DIR`. Concurrent processes are not supported; a lock file guards the revoke command.
- The sandbox is defense in depth, not a hard security boundary. A zero-day in QuickJS or WASM could escape it. Run TradeDesk on a dedicated VPS holding nothing else.
- Between a broker call and the audit write, a crash can leave no audit line ([ADR-9](architecture-record-document.md)); OpenAlgo's order book is the secondary record.
- Live trading needs the operator's own readiness checklist ([runbook section 10](docs/vps-runbook.md)). Nothing here is financial advice, and losses are the operator's responsibility.
