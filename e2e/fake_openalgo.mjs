// Tiny fake OpenAlgo: canned success JSON; records placeorder bodies to a JSON file.
// Usage: node e2e/fake_openalgo.mjs <port> <recordFile>
import http from "node:http";
import { writeFileSync } from "node:fs";

const [port, recordFile] = [Number(process.argv[2]), process.argv[3]];
const placed = [];
writeFileSync(recordFile, "[]");

const CANNED = {
  quotes: { ltp: 100, open: 99, high: 101, low: 98, prev_close: 99, volume: 1000 },
  funds: { availablecash: "100000.00", collateral: "0.00", utiliseddebits: "0.00" },
  positionbook: [],
  orderbook: { orders: [], statistics: {} },
  analyzer: { analyze_mode: true, mode: "analyze", total_logs: 0 },
  history: [],
  "pnl/symbols": { total_pnl: 0 },
};

http
  .createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const m = /^\/api\/v1\/(.+)$/.exec((req.url ?? "").split("?")[0]);
      const send = (code, body) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "GET" && req.url === "/healthz") return send(200, { ok: true });
      if (req.method !== "POST" || !m) return send(404, { status: "error", message: "not found" });
      const ep = m[1];
      if (ep === "placeorder") {
        let body = {};
        try {
          body = JSON.parse(raw);
        } catch {}
        placed.push(body);
        writeFileSync(recordFile, JSON.stringify(placed));
        return send(200, { status: "success", orderid: `FAKE-${placed.length}` });
      }
      if (ep in CANNED) return send(200, { status: "success", data: CANNED[ep] });
      send(404, { status: "error", message: `unknown endpoint ${ep}` });
    });
  })
  .listen(port, "127.0.0.1");
