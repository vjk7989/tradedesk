import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { OpenAlgoClient } from "./openalgo/client.js";
import { BacktestClient } from "./backtest/client.js";
import { RiskEngine } from "./risk/engine.js";
import { createMcpServer } from "./server.js";
import { createHttpServer } from "./http.js";
import { acquireLock, startHeartbeat } from "./datadir-lock.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("trade-mcp: MCP server (search + execute). Usage: node dist/src/index.js [--stdio]. Configure via environment variables.");
    return;
  }
  const cfg = loadConfig();
  const client = new OpenAlgoClient({ baseUrl: cfg.openalgoUrl, apiKey: cfg.openalgoApiKey });
  const risk = new RiskEngine(cfg.risk, {
    mode: cfg.mode,
    killSwitchFile: cfg.killSwitchFile,
    stateFile: path.join(cfg.dataDir, "risk-state.json"),
  });
  const bt = cfg.btUrl && cfg.btToken ? new BacktestClient({ baseUrl: cfg.btUrl, token: cfg.btToken }) : undefined;
  const deps = { cfg, client, bt, risk, executeTimeoutMs: cfg.executeTimeoutMs, auditFile: path.join(cfg.dataDir, "audit.jsonl") };

  if (args.includes("--stdio")) {
    await createMcpServer(deps).connect(new StdioServerTransport());
    console.error(`trade-mcp started (stdio) mode=${cfg.mode}`);
    return;
  }
  const releaseLock = acquireLock(cfg.dataDir, (m) => console.error(m));
  process.on("exit", releaseLock);
  let heartbeatStop: (() => void) | undefined;
  let http: ReturnType<typeof createHttpServer> | undefined;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    heartbeatStop?.();
    if (http?.listening) {
      http.close(() => process.exit(0));
      http.closeAllConnections();
    } else {
      process.exit(0);
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  heartbeatStop = startHeartbeat(cfg.dataDir, (m) => console.error(m));
  http = createHttpServer(deps);
  const server = http;
  await new Promise<void>((resolve) => server.listen(cfg.port, cfg.host, resolve));
  console.error(`trade-mcp started mode=${cfg.mode} host=${cfg.host} port=${cfg.port}`);
}

main().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
