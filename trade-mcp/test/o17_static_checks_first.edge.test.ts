import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RiskEngine } from "../src/risk/engine.js";
import type { RiskConfig } from "../src/config.js";
import { createBindings } from "../src/sdk/bindings.js";

// Pinned clock (IST = UTC+5:30). 2026-01-05 is a Monday.
const MON_10AM_IST = new Date("2026-01-05T04:30:00Z");
const MON_8AM_IST = new Date("2026-01-05T02:30:00Z");
const MON_1529_IST = new Date("2026-01-05T09:59:00Z");
const MON_1530_IST = new Date("2026-01-05T10:00:00Z");
const SUN_3AM_IST = new Date("2026-01-03T21:30:00Z");
const TODAY = "2026-01-05";

const BASE_RISK: RiskConfig = {
  allowedExchanges: ["CRYPTO", "NSE", "NFO"],
  allowedProducts: ["NRML", "MIS"],
  symbolAllow: [],
  symbolDeny: ["BADCOIN"],
  maxQtyPerOrder: 100,
  maxNotionalPerOrder: 50000,
  maxNotionalPerOrderUsd: 500,
  maxOrdersPerDay: 20,
  maxNotionalPerDay: 200000,
  maxDailyLoss: 5000,
  maxOrdersPerRun: 50,
  maxShortOptionQtyPerOrder: 50,
};

const BASE_ARGS = { symbol: "BTCUSDFUT", exchange: "CRYPTO", side: "BUY", quantity: 1, product: "NRML", priceType: "MARKET" };

type Handlers = Record<string, (...a: any[]) => unknown>;

/** Spy client: records every method call; throws on any method without a handler. */
function spyClient(handlers: Handlers = {}) {
  const calls: string[] = [];
  const client: any = new Proxy(
    {},
    {
      get: (_t, k) => {
        if (typeof k === "symbol" || k === "then") return undefined;
        return (...a: unknown[]) => {
          calls.push(String(k));
          const h = handlers[String(k)];
          if (!h) throw new Error(`unexpected client call: ${String(k)}`);
          return h(...a);
        };
      },
    },
  );
  return { client, calls };
}

const OK_HANDLERS: Handlers = {
  quotes: async () => ({ status: "success", data: { ltp: 1 } }),
  analyzerStatus: async () => ({ status: "success", data: { analyze_mode: true } }),
  pnl: async () => ({ total_pnl: 0 }),
  placeOrder: async () => ({ status: "success", orderid: "OID1" }),
  modifyOrder: async () => ({ status: "success", orderid: "1" }),
  cancelOrder: async () => ({ status: "success", orderid: "1" }),
  closePosition: async () => ({ status: "success", message: "closed" }),
};

let clock = MON_10AM_IST;

interface HOpts {
  risk?: Partial<RiskConfig>;
  now?: Date;
  mode?: "paper" | "live";
  handlers?: Handlers;
  dayState?: { orders: number; notional: number };
}

function harness(opts: HOpts = {}) {
  clock = opts.now ?? MON_10AM_IST;
  const dir = mkdtempSync(path.join(tmpdir(), "o17e-"));
  const kill = path.join(dir, "KILL");
  const auditFile = path.join(dir, "audit.jsonl");
  const stateFile = path.join(dir, "state.json");
  if (opts.dayState) writeFileSync(stateFile, JSON.stringify({ date: TODAY, ...opts.dayState }));
  const risk = { ...BASE_RISK, ...opts.risk } as RiskConfig;
  const mode = opts.mode ?? "paper";
  const engine = new RiskEngine(risk, { mode, killSwitchFile: kill, stateFile, now: () => clock });
  const spy = spyClient(opts.handlers ?? {});
  const b = createBindings({ client: spy.client, risk: engine, cfg: { mode, risk } as any, auditFile }, { id: "r" });
  const audit = (): any[] =>
    existsSync(auditFile) ? readFileSync(auditFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const stateRaw = () => (existsSync(stateFile) ? readFileSync(stateFile, "utf8") : null);
  return { b, engine, calls: spy.calls, kill, auditFile, stateFile, audit, stateRaw, dir };
}

const call = (h: ReturnType<typeof harness>, fn: "place" | "modify", args: Record<string, unknown>) =>
  (h.b.trade as any)[fn](fn === "modify" ? { ...args, orderId: "1" } : args);

// The clock is pinned via the RiskEngine `now` seam only. The global Date is not faked: audit
// rotation compares the real file mtime with new Date(), so a faked Date would rotate the file away.

interface DenyCase {
  name: string;
  opts?: HOpts;
  args?: Record<string, unknown>;
  prep?: (h: ReturnType<typeof harness>) => void | Promise<void>;
  text: string;
}

const DENY_CASES: DenyCase[] = [
  { name: "qty max+1", args: { quantity: 101 }, text: "risk denied: quantity 101 exceeds maxQtyPerOrder 100" },
  { name: "qty far above max (incident size)", args: { quantity: 500 }, text: "risk denied: quantity 500 exceeds maxQtyPerOrder 100" },
  { name: "qty 0", args: { quantity: 0 }, text: "risk denied: quantity must be a positive integer" },
  { name: "qty negative", args: { quantity: -1 }, text: "risk denied: quantity must be a positive integer" },
  { name: "qty fractional", args: { quantity: 1.5 }, text: "risk denied: quantity must be a positive integer" },
  { name: "kill switch on", prep: (h) => writeFileSync(h.kill, "x"), text: "risk denied: kill switch active" },
  {
    name: "market closed (weekend)",
    opts: { now: SUN_3AM_IST },
    args: { symbol: "RELIANCE", exchange: "NSE", product: "MIS" },
    text: "risk denied: market closed for NSE",
  },
  {
    name: "market closed (before open)",
    opts: { now: MON_8AM_IST },
    args: { symbol: "RELIANCE", exchange: "NSE", product: "MIS" },
    text: "risk denied: market closed for NSE",
  },
  {
    name: "market closed (15:30 boundary)",
    opts: { now: MON_1530_IST },
    args: { symbol: "RELIANCE", exchange: "NSE", product: "MIS" },
    text: "risk denied: market closed for NSE",
  },
  {
    name: "NSE holiday",
    opts: { risk: { marketHolidays: { NSE: [TODAY] } } },
    args: { symbol: "RELIANCE", exchange: "NSE", product: "MIS" },
    text: "risk denied: market closed for NSE",
  },
  {
    name: "NSE holiday applies to NFO",
    opts: { risk: { marketHolidays: { NSE: [TODAY] } } },
    args: { symbol: "NIFTY26JANFUT", exchange: "NFO" },
    text: "risk denied: market closed for NFO",
  },
  { name: "exchange not allowed (MCX, market open)", args: { symbol: "GOLD", exchange: "MCX" }, text: "risk denied: exchange MCX not allowed" },
  {
    name: "unknown exchange (not allowed + closed)",
    args: { exchange: "BINANCE" },
    text: "risk denied: exchange BINANCE not allowed; market closed for BINANCE",
  },
  { name: "product not allowed", args: { product: "CNC" }, text: "risk denied: product CNC not allowed" },
  { name: "symbol on deny list", args: { symbol: "BADCOIN" }, text: "risk denied: symbol BADCOIN is denied" },
  { name: "symbol on deny list (case-insensitive)", args: { symbol: "badcoin" }, text: "risk denied: symbol badcoin is denied" },
  {
    name: "symbol missing from allow list",
    opts: { risk: { symbolAllow: ["BTCUSDFUT"] } },
    args: { symbol: "ETHUSDFUT" },
    text: "risk denied: symbol ETHUSDFUT not in allow list",
  },
  {
    name: "short option CE SELL above maxShortOptionQtyPerOrder",
    args: { symbol: "NIFTY26JAN24000CE", exchange: "NFO", side: "SELL", quantity: 51 },
    text: "risk denied: short option qty 51 exceeds maxShortOptionQtyPerOrder 50",
  },
  {
    name: "short option PE SELL above maxShortOptionQtyPerOrder",
    args: { symbol: "NIFTY26JAN24000PE", exchange: "NFO", side: "SELL", quantity: 51 },
    text: "risk denied: short option qty 51 exceeds maxShortOptionQtyPerOrder 50",
  },
  {
    name: "maxOrdersPerDay exhausted",
    opts: { dayState: { orders: 20, notional: 0 } },
    text: "risk denied: maxOrdersPerDay 20 reached",
  },
  {
    name: "maxOrdersPerRun exhausted (after one real order)",
    opts: { risk: { maxOrdersPerRun: 1 }, handlers: OK_HANDLERS },
    prep: async (h) => {
      await (h.b.trade as any).place(BASE_ARGS);
      h.calls.length = 0;
    },
    text: "risk denied: maxOrdersPerRun 1 reached",
  },
  {
    name: "LIMIT with price also denied statically (no analyzer call)",
    args: { priceType: "LIMIT", price: 10, quantity: 101 },
    text: "risk denied: quantity 101 exceeds maxQtyPerOrder 100",
  },
];

describe("O-17 edge: static denials make zero client calls", () => {
  for (const fn of ["place", "modify"] as const) {
    for (const mode of ["paper", "live"] as const) {
      for (const c of DENY_CASES) {
        it(`${fn}/${mode}: ${c.name}`, async () => {
          const h = harness({ mode, ...c.opts });
          await c.prep?.(h);
          const auditBefore = h.audit().length;
          const todayBefore = h.engine.status().today;
          const stateBefore = h.stateRaw();

          await expect(call(h, fn, { ...BASE_ARGS, ...c.args })).rejects.toThrow(c.text);
          // exact text, not a prefix match
          await call(h, fn, { ...BASE_ARGS, ...c.args }).catch((e: Error) => expect(e.message).toBe(c.text));

          expect(h.calls).toEqual([]);
          const entries = h.audit().slice(auditBefore);
          expect(entries).toHaveLength(2);
          for (const e of entries) {
            expect(e.action).toBe(`trade.${fn}`);
            expect(e.decision).toBe("denied");
            expect(e.error).toBe(c.text);
            expect(e.riskReasons).toEqual(c.text.slice("risk denied: ".length).split("; "));
          }
          expect(h.engine.status().today).toEqual(todayBefore);
          expect(h.stateRaw()).toBe(stateBefore);
        });
      }
    }
  }

  it("denials do not consume the per-run counter: after many denials one valid order still passes with maxOrdersPerRun=1", async () => {
    const h = harness({ risk: { maxOrdersPerRun: 1 }, handlers: OK_HANDLERS });
    for (const a of [{ quantity: 101 }, { product: "CNC" }, { symbol: "BADCOIN" }, { exchange: "MCX", symbol: "GOLD" }]) {
      await expect(call(h, "place", { ...BASE_ARGS, ...a })).rejects.toThrow(/^risk denied: /);
      await expect(call(h, "modify", { ...BASE_ARGS, ...a })).rejects.toThrow(/^risk denied: /);
    }
    expect(h.calls).toEqual([]);
    expect(h.engine.status().today.orders).toBe(0);
    await expect(call(h, "place", BASE_ARGS)).resolves.toMatchObject({ status: "success" });
    expect(h.engine.status().today.orders).toBe(1);
  });
});

describe("O-17 edge: boundary values that pass static checks reach the quote", () => {
  const ALLOW: { name: string; opts?: HOpts; args: Record<string, unknown> }[] = [
    { name: "qty == maxQtyPerOrder", args: { quantity: 100 } },
    { name: "qty 1", args: { quantity: 1 } },
    { name: "short option SELL == maxShortOptionQtyPerOrder", args: { symbol: "NIFTY26JAN24000CE", exchange: "NFO", side: "SELL", quantity: 50 } },
    { name: "option BUY above short cap (cap is SELL-only)", args: { symbol: "NIFTY26JAN24000CE", exchange: "NFO", side: "BUY", quantity: 51 } },
    { name: "future SELL above short cap (not CE/PE)", args: { symbol: "NIFTY26JANFUT", exchange: "NFO", side: "SELL", quantity: 51 } },
    { name: "NSE at 15:29 IST", opts: { now: MON_1529_IST }, args: { symbol: "RELIANCE", exchange: "NSE", product: "MIS" } },
    { name: "day orders at max-1", opts: { dayState: { orders: 19, notional: 0 } }, args: {} },
    { name: "holiday list has other dates only", opts: { risk: { marketHolidays: { NSE: ["2026-01-26"] } } }, args: { symbol: "RELIANCE", exchange: "NSE", product: "MIS" } },
  ];
  for (const fn of ["place", "modify"] as const) {
    for (const c of ALLOW) {
      it(`${fn}: ${c.name}`, async () => {
        const h = harness({ ...c.opts, handlers: OK_HANDLERS });
        await expect(call(h, fn, { ...BASE_ARGS, ...c.args })).resolves.toMatchObject({ status: "success" });
        expect(h.calls).toEqual(["quotes", "analyzerStatus", fn === "place" ? "placeOrder" : "modifyOrder"]);
        expect(h.audit().at(-1).decision).toBe("allowed");
      });
    }
  }
});

describe("O-17 edge: valid-size order runs the quote and notional checks", () => {
  for (const fn of ["place", "modify"] as const) {
    it(`${fn}: notional over the USD per-order limit gives the existing notional denial`, async () => {
      const h = harness({ handlers: { ...OK_HANDLERS, quotes: async () => ({ status: "success", data: { ltp: 100 } }) } });
      const text = "risk denied: notional 1000 exceeds per-order limit 500";
      await expect(call(h, fn, { ...BASE_ARGS, quantity: 10 })).rejects.toThrow(text);
      expect(h.calls).toEqual(["quotes", "analyzerStatus"]);
      const last = h.audit().at(-1);
      expect(last.decision).toBe("denied");
      expect(last.error).toBe(text);
      expect(h.engine.status().today.orders).toBe(0);
      expect(h.stateRaw()).toBeNull();
    });

    it(`${fn}: NSE notional over the INR per-order limit gives the existing notional denial`, async () => {
      const h = harness({ handlers: { ...OK_HANDLERS, quotes: async () => ({ status: "success", data: { ltp: 1000 } }) } });
      const text = "risk denied: notional 51000 exceeds per-order limit 50000";
      await expect(call(h, fn, { ...BASE_ARGS, symbol: "RELIANCE", exchange: "NSE", product: "MIS", quantity: 51 })).rejects.toThrow(text);
      expect(h.calls).toEqual(["quotes", "analyzerStatus"]);
    });

    it(`${fn}: LIMIT order with explicit price skips the quote but still runs notional`, async () => {
      const h = harness({ handlers: OK_HANDLERS });
      await expect(call(h, fn, { ...BASE_ARGS, priceType: "LIMIT", price: 100, quantity: 10 })).rejects.toThrow(
        "risk denied: notional 1000 exceeds per-order limit 500",
      );
      expect(h.calls).toEqual(["analyzerStatus"]);
    });

    it(`${fn}: live mode daily loss still enforced after the quote`, async () => {
      const h = harness({ mode: "live", handlers: { ...OK_HANDLERS, pnl: async () => ({ total_pnl: -5000 }) } });
      await expect(call(h, fn, BASE_ARGS)).rejects.toThrow("risk denied: daily loss limit 5000 hit");
      expect(h.calls).toEqual(["quotes", "pnl"]);
    });

    it(`${fn}: client 403 on the quote fails closed as error, counters untouched`, async () => {
      const h = harness({
        risk: { maxOrdersPerRun: 1 },
        handlers: {
          quotes: async () => {
            throw new Error("HTTP 403: Invalid openalgo apikey");
          },
        },
      });
      await expect(call(h, fn, BASE_ARGS)).rejects.toThrow("HTTP 403: Invalid openalgo apikey");
      expect(h.calls).toEqual(["quotes"]);
      const last = h.audit().at(-1);
      expect(last.decision).toBe("error");
      expect(last.error).toBe("HTTP 403: Invalid openalgo apikey");
      expect(h.engine.status().today.orders).toBe(0);
      expect(h.stateRaw()).toBeNull();
    });
  }

  it("place: 403 on the quote does not consume the run slot (maxOrdersPerRun=1)", async () => {
    let fail = true;
    const h = harness({
      risk: { maxOrdersPerRun: 1 },
      handlers: {
        ...OK_HANDLERS,
        quotes: async () => {
          if (fail) throw new Error("HTTP 403: Invalid openalgo apikey");
          return { status: "success", data: { ltp: 1 } };
        },
      },
    });
    await expect(call(h, "place", BASE_ARGS)).rejects.toThrow("HTTP 403");
    fail = false;
    await expect(call(h, "place", BASE_ARGS)).resolves.toMatchObject({ status: "success" });
  });
});

describe("O-17 edge: concurrency with maxOrdersPerRun=1", () => {
  it("two concurrent valid orders: exactly one passes, counters consistent", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({
      risk: { maxOrdersPerRun: 1 },
      handlers: {
        ...OK_HANDLERS,
        quotes: async () => {
          await gate;
          return { status: "success", data: { ltp: 1 } };
        },
      },
    });
    const p1 = call(h, "place", BASE_ARGS);
    const p2 = call(h, "place", BASE_ARGS);
    // both are past the static check (ordersThisRun was 0 for both) and waiting on the quote
    await Promise.resolve();
    release();
    const rs = await Promise.allSettled([p1, p2]);
    const ok = rs.filter((r) => r.status === "fulfilled");
    const bad = rs.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0].reason.message).toBe("risk denied: maxOrdersPerRun 1 reached");
    expect(h.calls.filter((c) => c === "placeOrder")).toHaveLength(1);
    expect(h.calls.filter((c) => c === "quotes")).toHaveLength(2);
    expect(h.engine.status().today.orders).toBe(1);
    expect(JSON.parse(h.stateRaw()!).orders).toBe(1);
    expect(h.audit().map((e) => e.decision).sort()).toEqual(["allowed", "denied"]);

    // the third is now refused statically, with zero client calls
    h.calls.length = 0;
    await expect(call(h, "place", BASE_ARGS)).rejects.toThrow("risk denied: maxOrdersPerRun 1 reached");
    expect(h.calls).toEqual([]);
  });

  it("winner's broker failure releases the slot; counters return to zero", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({
      risk: { maxOrdersPerRun: 1 },
      handlers: {
        ...OK_HANDLERS,
        quotes: async () => {
          await gate;
          return { status: "success", data: { ltp: 1 } };
        },
        placeOrder: async () => ({ status: "error", message: "rejected" }),
      },
    });
    const ps = [call(h, "place", BASE_ARGS), call(h, "place", BASE_ARGS)];
    release();
    const rs = await Promise.allSettled(ps);
    const msgs = rs.map((r) => (r as PromiseRejectedResult).reason?.message).sort();
    expect(msgs).toEqual(["broker rejected: rejected", "risk denied: maxOrdersPerRun 1 reached"]);
    expect(h.engine.status().today.orders).toBe(0);
    expect(h.stateRaw()).toBeNull();
  });
});

describe("O-17 edge: kill-switch exemptions unchanged", () => {
  it("trade.cancel is allowed under the kill switch and passes the client result through", async () => {
    const h = harness({ handlers: OK_HANDLERS });
    writeFileSync(h.kill, "x");
    await expect((h.b.trade as any).cancel({ orderId: "1" })).resolves.toEqual({ status: "success", orderid: "1" });
    expect(h.calls).toEqual(["cancelOrder"]);
    expect(h.audit().at(-1)).toMatchObject({ action: "trade.cancel", decision: "allowed" });
  });

  it("trade.closePosition is allowed under the kill switch and passes the client result through", async () => {
    const h = harness({ handlers: OK_HANDLERS });
    writeFileSync(h.kill, "x");
    await expect((h.b.trade as any).closePosition({})).resolves.toEqual({ status: "success", message: "closed" });
    expect(h.calls).toEqual(["closePosition"]);
    expect(h.audit().at(-1)).toMatchObject({ action: "trade.closePosition", decision: "allowed" });
  });

  it("cancel / closePosition errors stay audited as error, not denied", async () => {
    const h = harness({
      handlers: {
        cancelOrder: async () => {
          throw new Error("HTTP 403: Invalid openalgo apikey");
        },
      },
    });
    writeFileSync(h.kill, "x");
    await expect((h.b.trade as any).cancel({ orderId: "1" })).rejects.toThrow("HTTP 403");
    await expect((h.b.trade as any).closePosition()).rejects.toThrow("unexpected client call: closePosition");
    expect(h.audit().map((e) => e.decision)).toEqual(["error", "error"]);
  });
});

describe("O-17 edge: the incident", () => {
  for (const mode of ["paper", "live"] as const) {
    for (const fn of ["place", "modify"] as const) {
      it(`${fn}/${mode}: MARKET BUY 500 BTCUSDFUT on CRYPTO, maxQtyPerOrder=100, every client method 403s`, async () => {
        clock = MON_10AM_IST;
        const dir = mkdtempSync(path.join(tmpdir(), "o17i-"));
        const auditFile = path.join(dir, "a.jsonl");
        const calls: string[] = [];
        const client: any = new Proxy(
          {},
          {
            get: (_t, k) =>
              typeof k === "symbol" || k === "then"
                ? undefined
                : (..._a: unknown[]) => {
                    calls.push(String(k));
                    throw new Error("HTTP 403: Invalid openalgo apikey");
                  },
          },
        );
        const risk = { ...BASE_RISK, allowedExchanges: ["CRYPTO"], maxQtyPerOrder: 100 };
        const engine = new RiskEngine(risk, {
          mode,
          killSwitchFile: path.join(dir, "KILL"),
          stateFile: path.join(dir, "s.json"),
          now: () => clock,
        });
        const b = createBindings({ client, risk: engine, cfg: { mode, risk } as any, auditFile }, { id: "r" });
        const args = { symbol: "BTCUSDFUT", exchange: "CRYPTO", side: "BUY", quantity: 500, product: "NRML", priceType: "MARKET" };
        const err = await (b.trade as any)[fn](fn === "modify" ? { ...args, orderId: "1" } : args).catch((e: Error) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toBe("risk denied: quantity 500 exceeds maxQtyPerOrder 100");
        expect(calls).toEqual([]);
        const lines = readFileSync(auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({ action: `trade.${fn}`, decision: "denied", riskReasons: ["quantity 500 exceeds maxQtyPerOrder 100"] });
        expect(existsSync(path.join(dir, "s.json"))).toBe(false);
      });
    }
  }
});
