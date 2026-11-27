# Fincept Terminal setup

## 1. What Fincept is in this stack
Fincept Terminal is a desktop app (Qt) that you run on your own Windows PC. In this stack it is the **cockpit**: charts, research and an AI chat. The trading core (OpenAlgo, trade-mcp, risk limits, scheduled jobs) stays on the VPS. Fincept reaches it only through the TradeDesk MCP endpoint, so nothing in Fincept is required for the VPS to keep working.

## 2. Install v4.5.3 on Windows
1. Download the installer: https://github.com/Fincept-Corporation/FinceptTerminal/releases/download/v4.5.3/FinceptTerminal-4.5.3-windows-x64-setup.exe
2. Run it, then launch `FinceptTerminal.exe`.

(Release page: https://github.com/Fincept-Corporation/FinceptTerminal/releases/tag/v4.5.3. The README does not state the download or disk size.)

## 3. Connect Fincept's AI to TradeDesk (MCP)
Fincept's MCP client is stdio-only, so it cannot call `https://mcp.<DOMAIN>/mcp` directly. Use `mcp-remote` as a bridge. Node.js (for `npx`) must be installed on the PC.

1. In Fincept: Settings -> MCP Servers -> **OPEN MCP SERVERS** -> **ADD CUSTOM MCP SERVER**.
2. Fill in the dialog:
   - Name: `tradedesk`
   - Command: `npx`
   - Arguments: `-y mcp-remote https://mcp.<DOMAIN>/mcp --header Authorization:${AUTH}`
   - Environment variable: `AUTH` = `Bearer <token>`
3. Save, then check the server shows its tools.

This is the same syntax as in `docs/connect-clients.md`. The no-space `Authorization:${AUTH}` form avoids an argument-with-space bug on Windows. (Verify field names in your Fincept version; they were read from the v4.5.3 source, not from a running app.)

**Which token.** Use the read-only token (`MCP_TOKEN_READONLY`) unless you want Fincept's AI to place trades. With it, `market`, `account`, `backtest` and `risk` work, and `trade.place` fails. Using `MCP_TOKEN` gives full access, including trading. See "Read-only token" in `docs/connect-clients.md`.

## 4. Claude Code inside Fincept
1. Install Claude Code on the PC and confirm `claude` runs in a terminal.
2. Set `ANTHROPIC_API_KEY` as a Windows user environment variable (an API key from the Anthropic Console), then restart Fincept so it inherits it.
3. In Fincept, enable the Claude Code harness in Settings (the LLM / harness section; verify the exact menu name in your version) and accept the one-time consent dialog.

Why an API key: Fincept refuses to run terminal AI (AI Chat, Quick Chat and similar) on a consumer subscription login, because vendor terms forbid third-party products routing through subscription credentials. With a subscription sign-in, Claude Code is available in the Workbench only ("Workbench only - sign in with an API key").

API usage is billed per token to your Anthropic account.

## 5. Fincept's own brokers are separate (warning)
Fincept has its own broker screens (Zerodha and others). They are independent of OpenAlgo.
- Trading **through TradeDesk** (MCP -> trade-mcp -> OpenAlgo) goes through the risk limits.
- Trading **through Fincept's broker screens** talks to the broker directly and **bypasses those limits**.

If you want the limits to apply, do not connect a broker inside Fincept, or use it for viewing only.

## 6. Licence
Fincept's open edition is AGPL-3.0-or-later. Personal, non-distributed use carries no obligations. If you distribute a modified build, or run one as a service other people reach, you must publish your changes under the same licence. Do not redistribute or rebrand it as part of this stack. This repo only documents how to install and connect the upstream app.
