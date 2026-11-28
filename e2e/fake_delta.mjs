// Tiny fake Delta India candles API with a scripted SMA crossover.
// Usage: node e2e/fake_delta.mjs <port> [periodSec=60]
//
// Real shape (PB-1 report, verified against the live API; parsed by paper-bot/paper_bot/data.py):
//   GET /v2/history/candles?symbol=..&resolution=..&start=<unix>&end=<unix>
//   -> {"success":true,"result":[{"time","open","high","low","close","volume"}, ...]}  newest FIRST,
//   `time` = candle OPEN time (unix s); the newest row may be the still-forming candle.
//
// Script (counted per candles request; paper-bot is run with SYMBOLS=BTCUSD, FAST=2, SLOW=5, 1m candles):
//   request 1   closed closes 100 x6, 90 x3  -> fast(2)=90 < slow(5)=94..96, already below: no cross -> hold
//   request 2+  same series plus one new closed candle at 120 -> fast crosses above slow -> open long
// Candle times: the closed grid is anchored once at server start (A = floor(now/period)*period), so request 1's
// newest closed candle is A-2p and request 2+'s is A-p (a NEW candle, else paper-bot answers "already processed").
// Both are closed relative to "now" (time + period <= now). A forming candle (open time = current period, close
// 1000) is always included first; a bot that forgot to drop it would cross on request 1.
import http from "node:http";

const port = Number(process.argv[2]);
const period = Number(process.argv[3] ?? 60);
const A = Math.floor(Date.now() / 1000 / period) * period;
const BASE = [100, 100, 100, 100, 100, 100, 90, 90, 90];
let requests = 0;

function closedSeries(n) {
  // oldest -> newest closes, ending at time A-2p (n=1) or A-p (n>=2)
  const closes = n >= 2 ? [...BASE, 120] : BASE;
  const newest = n >= 2 ? A - period : A - 2 * period;
  return closes.map((close, i) => ({ time: newest - (closes.length - 1 - i) * period, close }));
}

http
  .createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (u.pathname === "/healthz") return send(200, { ok: true });
    if (req.method !== "GET" || u.pathname !== "/v2/history/candles") return send(404, { success: false });
    const q = u.searchParams;
    const start = Number(q.get("start")), end = Number(q.get("end"));
    if (!q.get("symbol") || !/^\d+[smhdw]$/.test(q.get("resolution") ?? "") || !Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      return send(400, { success: false, error: { code: "bad_schema" } });
    }
    requests++;
    const rows = closedSeries(requests).map(({ time, close }) => ({ time, open: close, high: close + 1, low: close - 1, close, volume: 1000 }));
    const forming = { time: Math.floor(Date.now() / 1000 / period) * period, open: 1000, high: 1001, low: 999, close: 1000, volume: 1 };
    send(200, { success: true, result: [forming, ...rows.reverse()] });
  })
  .listen(port, "127.0.0.1");
