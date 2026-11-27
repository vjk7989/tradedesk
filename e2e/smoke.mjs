// End-to-end smoke: fake OpenAlgo -> trade-mcp (paper) -> bt-service; MCP client calls search/execute.
// Usage: node e2e/smoke.mjs
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MCP_DIR = path.join(ROOT, "trade-mcp");
const STEP_MS = 120_000;
const API_KEY = "e2e-openalgo-key-" + "k".repeat(16);
const BT_TOKEN = "b".repeat(32);
const MCP_TOKEN = "m".repeat(32);
const MCP_RO = "r".repeat(32);

const tmp = mkdtempSync(path.join(tmpdir(), "e2e-"));
const children = [];
let failed = 0;

function cleanup() {
  for (const c of children) {
    if (c.exitCode !== null || !c.pid) continue;
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" });
    else c.kill("SIGKILL");
  }
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}

function start(name, cmd, args, env) {
  const c = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  c.log = "";
  for (const s of [c.stdout, c.stderr]) s.on("data", (d) => (c.log += d));
  c.on("error", (e) => (c.log += `spawn error: ${e.message}`));
  c.pname = name;
  children.push(c);
  return c;
}

async function waitHealth(url, child, ms = STEP_MS) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`${child.pname} exited early:\n${child.log.slice(-1500)}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timeout waiting for ${url}\n${child.log.slice(-1500)}`);
}

async function step(name, fn) {
  let t;
  try {
    await Promise.race([fn(), new Promise((_, rej) => (t = setTimeout(() => rej(new Error("step timeout 120s")), STEP_MS)))]);
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message : e}`);
  } finally {
    clearTimeout(t);
  }
}

const assert = (c, m) => {
  if (!c) throw new Error(m);
};

const SMA = `
import pandas as pd

class SignalEngine:
    def generate(self, data_map):
        out = {}
        for code, df in data_map.items():
            fast = df["close"].rolling(20).mean()
            slow = df["close"].rolling(50).mean()
            out[code] = (fast > slow).astype(float)
        return out
`;

const SMA_P = SMA.replace(
  "    def generate",
  "    def __init__(self, fast=20, slow=50):\n        self.fast, self.slow = fast, slow\n\n    def generate",
).replace("rolling(20)", "rolling(self.fast)").replace("rolling(50)", "rolling(self.slow)");

async function main() {
  const [oaPort, btPort, mcpPort] = [await freePort(), await freePort(), await freePort()];
  const dataDir = path.join(tmp, "data");
  mkdirSync(dataDir);
  const recordFile = path.join(tmp, "placed.json");
  const placed = () => JSON.parse(readFileSync(recordFile, "utf8"));

  const fixture = path.join(ROOT, "bt-service", "tests", "fixtures", "aapl.csv").split(path.sep).join("/");
  const localCfg = path.join(tmp, "local.yaml");
  writeFileSync(localCfg, `sources:\n  - symbol: "AAPL.US"\n    type: csv\n    path: "${fixture}"\n    date_format: "%Y-%m-%d"\n`);
  const riskCfg = path.join(tmp, "risk.json");
  writeFileSync(riskCfg, JSON.stringify({ allowedExchanges: ["NSE"], maxQtyPerOrder: 10 }));

  const tsc = path.join(MCP_DIR, "node_modules", "typescript", "bin", "tsc");
  const b = spawnSync(process.execPath, [tsc, "-p", "tsconfig.json"], { cwd: MCP_DIR, encoding: "utf8" });
  if (b.status !== 0) throw new Error("trade-mcp build failed:\n" + (b.stdout + b.stderr).slice(-1500));

  const oa = start("fake-openalgo", process.execPath, [path.join(ROOT, "e2e", "fake_openalgo.mjs"), String(oaPort), recordFile], {});
  const bt = start("bt-service", "uv", ["run", "--project", "bt-service", "uvicorn", "bt_service.app:app", "--port", String(btPort)], {
    BT_TOKEN,
    BT_RUNS_DIR: path.join(tmp, "runs"),
    BT_LOCAL_DATA_CONFIG: localCfg,
    VIBE_TRADING_DATA_CACHE: "false",
  });
  const mcp = start("trade-mcp", process.execPath, [path.join(MCP_DIR, "dist", "src", "index.js")], {
    OPENALGO_URL: `http://127.0.0.1:${oaPort}`,
    OPENALGO_API_KEY: API_KEY,
    MCP_TOKEN,
    MCP_TOKEN_READONLY: MCP_RO,
    BT_URL: `http://127.0.0.1:${btPort}`,
    BT_TOKEN,
    MODE: "paper",
    DATA_DIR: dataDir,
    RISK_CONFIG: riskCfg,
    PORT: String(mcpPort),
    HOST: "127.0.0.1",
  });
  await waitHealth(`http://127.0.0.1:${oaPort}/healthz`, oa);
  await waitHealth(`http://127.0.0.1:${btPort}/healthz`, bt);
  await waitHealth(`http://127.0.0.1:${mcpPort}/healthz`, mcp);
  console.log(`up: openalgo=${oaPort} bt=${btPort} mcp=${mcpPort}`);

  const req = createRequire(path.join(MCP_DIR, "package.json"));
  const { Client } = await import(pathToFileURL(req.resolve("@modelcontextprotocol/sdk/client/index.js")).href);
  const { StreamableHTTPClientTransport } = await import(pathToFileURL(req.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")).href);
  const connect = async (token) => {
    const c = new Client({ name: "e2e", version: "0.0.0" });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    return c;
  };
  const textOf = (r) => r.content.map((x) => x.text ?? "").join("\n");
  const exec = async (c, code) => {
    const t = textOf(await c.callTool({ name: "execute", arguments: { code } }));
    return JSON.parse(t.slice(t.indexOf("\n") + 1));
  };

  const full = await connect(MCP_TOKEN);
  const order = (qty) =>
    `return await trade.place({symbol:"RELIANCE",exchange:"NSE",side:"BUY",quantity:${qty},product:"CNC",priceType:"LIMIT",price:100});`;

  await step("1 tools/list == [execute, search]", async () => {
    const names = (await full.listTools()).tools.map((t) => t.name).sort();
    assert(JSON.stringify(names) === '["execute","search"]', JSON.stringify(names));
  });
  await step("2 search(backtest) mentions SignalEngine", async () => {
    const t = textOf(await full.callTool({ name: "search", arguments: { query: "backtest" } }));
    assert(t.includes("SignalEngine"), t.slice(0, 300));
  });
  await step("3 account.funds()", async () => {
    const r = await exec(full, "return await account.funds()");
    assert(r.ok, JSON.stringify(r));
  });
  await step("4 paper LIMIT order within limits -> 1 placeorder", async () => {
    const r = await exec(full, order(5));
    assert(r.ok, JSON.stringify(r));
    assert(placed().length === 1, `placeorder count ${placed().length}`);
  });
  await step("5 order over maxQtyPerOrder -> risk denied, no new placeorder", async () => {
    const r = await exec(full, order(1000));
    assert(!r.ok && /risk denied/.test(r.error ?? ""), JSON.stringify(r));
    assert(placed().length === 1, `placeorder count ${placed().length}`);
  });
  await step("6 backtest.run 20/50 SMA", async () => {
    const r = await exec(
      full,
      `return await backtest.run({code:${JSON.stringify(SMA)},symbols:["AAPL.US"],start:"2024-01-02",end:"2024-06-14",source:"local"});`,
    );
    assert(r.ok && r.result && r.result.ok === true && Object.keys(r.result.metrics ?? {}).length > 0, JSON.stringify(r).slice(0, 600));
  });
  await step("7 readonly token: typeof trade === undefined", async () => {
    const ro = await connect(MCP_RO);
    const r = await exec(ro, "return typeof trade");
    assert(r.ok && r.result === "undefined", JSON.stringify(r));
    await ro.close();
  });
  await step("8 audit.jsonl exists, no secrets", async () => {
    const f = path.join(dataDir, "audit.jsonl");
    assert(existsSync(f), "audit.jsonl missing");
    const t = readFileSync(f, "utf8");
    assert(t.trim().length > 0, "audit.jsonl empty");
    for (const s of [API_KEY, BT_TOKEN, MCP_TOKEN, MCP_RO]) assert(!t.includes(s), "secret found in audit log");
  });
  const wf = (cands) =>
    `return await backtest.walkForward({code:${JSON.stringify(SMA_P)},symbols:["AAPL.US"],start:"2024-01-02",end:"2024-02-29",trainDays:30,testDays:10,candidates:${JSON.stringify(cands)},source:"local"});`;
  const C2 = [{ fast: 5, slow: 20 }, { fast: 10, slow: 30 }];
  await step("9 backtest.walkForward 2 candidates (full token)", async () => {
    const r = await exec(full, wf(C2));
    const w = r.result;
    assert(r.ok && w && w.ok === true, JSON.stringify(r).slice(0, 600));
    assert(w.folds.length >= 1 && w.oosEquity.length >= 1, `folds ${w.folds.length} oos ${w.oosEquity.length}`);
  });
  await step("10 OAuth disabled: metadata 404, /mcp no token 401 w/o resource_metadata", async () => {
    const base = `http://127.0.0.1:${mcpPort}`;
    const m = await fetch(`${base}/.well-known/oauth-authorization-server`);
    assert(m.status === 404, `metadata status ${m.status}`);
    const p = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert(p.status === 401, `/mcp status ${p.status}`);
    const h = p.headers.get("www-authenticate") ?? "";
    assert(!h.includes("resource_metadata"), `WWW-Authenticate: ${h}`);
  });
  await step("11 readonly token walkForward 1 candidate", async () => {
    const ro = await connect(MCP_RO);
    try {
      const r = await exec(ro, wf([{ fast: 5, slow: 20 }]));
      assert(r.ok && r.result && r.result.ok === true, JSON.stringify(r).slice(0, 600));
    } finally {
      await ro.close();
    }
  });
  await full.close();
}

try {
  await main();
} catch (e) {
  failed++;
  console.log(`FAIL setup: ${e instanceof Error ? e.message : e}`);
} finally {
  cleanup();
}
console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
