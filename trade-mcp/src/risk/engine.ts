import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RiskConfig } from "../config.js";
import { isMarketOpen, istParts } from "./hours.js";

export interface RiskOrder {
  symbol: string;
  exchange: string;
  product: string;
  quantity: number;
  price?: number; // ltp or limit
  side: "BUY" | "SELL";
}

export interface RiskOpts {
  mode: "paper" | "live";
  killSwitchFile: string;
  stateFile: string;
  now?: () => Date;
}

interface Day {
  date: string;
  orders: number;
  notional: number;
}

export interface ReserveToken {
  date: string;
  notional: number;
  done: boolean;
}

const norm = (s: string) => s.trim().toUpperCase();
const minor = (n: number) => Math.round(n * 100);

/** Notional the engine enforces: CRYPTO is qty * contractValues[SYMBOL] (default 1) * price. */
export function orderNotional(cfg: RiskConfig, o: { symbol: string; exchange: string; quantity: number }, price: number): number {
  if (o.exchange.trim().toUpperCase() !== "CRYPTO") return o.quantity * price;
  const sym = norm(o.symbol);
  let cv = 1;
  for (const [k, v] of Object.entries(cfg.contractValues ?? {})) if (norm(k) === sym) cv = v;
  return o.quantity * cv * price;
}

export class RiskEngine {
  private day: Day;

  constructor(private readonly cfg: RiskConfig, private readonly opts: RiskOpts) {
    this.day = this.load();
  }

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }

  private load(): Day {
    const date = istParts(this.now()).date;
    try {
      const j = JSON.parse(readFileSync(this.opts.stateFile, "utf8"));
      if (j && j.date === date && Number.isFinite(j.orders) && Number.isFinite(j.notional)) {
        return { date, orders: j.orders, notional: j.notional };
      }
    } catch {
      /* missing or corrupt: start at zero */
    }
    return { date, orders: 0, notional: 0 };
  }

  private roll(): void {
    const date = istParts(this.now()).date;
    if (this.day.date !== date) this.day = { date, orders: 0, notional: 0 };
  }

  private save(): void {
    const dir = path.dirname(this.opts.stateFile);
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.opts.stateFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.day));
    renameSync(tmp, this.opts.stateFile);
  }

  /** Checks that need no market data (no price, no P&L). Safe to run before any broker/quote call. */
  checkStatic(o: RiskOrder, run: { ordersThisRun: number }): { allow: boolean; reasons: string[] } {
    return this.evaluate(o, run, undefined, true);
  }

  /** Product must always be in allowedProducts, CRYPTO included. */
  checkOrder(
    o: RiskOrder,
    run: { ordersThisRun: number },
    dayPnl?: number,
  ): { allow: boolean; reasons: string[] } {
    return this.evaluate(o, run, dayPnl, false);
  }

  private evaluate(
    o: RiskOrder,
    run: { ordersThisRun: number },
    dayPnl: number | undefined,
    staticOnly: boolean,
  ): { allow: boolean; reasons: string[] } {
    this.roll();
    const c = this.cfg;
    const r: string[] = [];
    const ex = o.exchange.trim().toUpperCase();
    const sym = norm(o.symbol);
    const product = o.product.trim();
    const crypto = ex === "CRYPTO";

    if (existsSync(this.opts.killSwitchFile)) r.push("kill switch active");
    if (!c.allowedExchanges.some((e) => e.toUpperCase() === ex)) r.push(`exchange ${o.exchange} not allowed`);
    if (!c.allowedProducts.includes(product)) r.push(`product ${o.product} not allowed`);
    if (c.symbolDeny.some((s) => norm(s) === sym)) r.push(`symbol ${o.symbol} is denied`);
    if (c.symbolAllow.length > 0 && !c.symbolAllow.some((s) => norm(s) === sym)) {
      r.push(`symbol ${o.symbol} not in allow list`);
    }
    if (!Number.isInteger(o.quantity) || o.quantity <= 0) r.push("quantity must be a positive integer");
    else if (o.quantity > c.maxQtyPerOrder) r.push(`quantity ${o.quantity} exceeds maxQtyPerOrder ${c.maxQtyPerOrder}`);

    // Optional, off by default: cap quantity on SELLs of NFO/BFO options (...CE / ...PE).
    // Cannot tell whether the SELL closes a long position, so closing sells are capped too.
    if (
      c.maxShortOptionQtyPerOrder !== undefined &&
      String(o.side).trim().toUpperCase() === "SELL" &&
      (ex === "NFO" || ex === "BFO") &&
      /(CE|PE)$/.test(sym) &&
      Number.isFinite(o.quantity) &&
      o.quantity > c.maxShortOptionQtyPerOrder
    ) {
      r.push(`short option qty ${o.quantity} exceeds maxShortOptionQtyPerOrder ${c.maxShortOptionQtyPerOrder}`);
    }

    if (staticOnly) {
      /* notional checks need a price: skipped */
    } else if (o.price === undefined || !Number.isFinite(o.price) || o.price <= 0) {
      r.push("price required for notional check");
    } else if (Number.isFinite(o.quantity)) {
      const n = orderNotional(c, o, o.price);
      const cap = crypto ? c.maxNotionalPerOrderUsd : c.maxNotionalPerOrder;
      if (minor(n) > minor(cap)) r.push(`notional ${n} exceeds per-order limit ${cap}`);
      if (!crypto && minor(this.day.notional + n) > minor(c.maxNotionalPerDay)) {
        r.push(`day notional ${this.day.notional + n} exceeds maxNotionalPerDay ${c.maxNotionalPerDay}`);
      }
    }

    if (this.day.orders + 1 > c.maxOrdersPerDay) r.push(`maxOrdersPerDay ${c.maxOrdersPerDay} reached`);
    if (run.ordersThisRun + 1 > c.maxOrdersPerRun) r.push(`maxOrdersPerRun ${c.maxOrdersPerRun} reached`);
    if (!staticOnly && dayPnl !== undefined) {
      if (!Number.isFinite(dayPnl)) r.push("day P&L unavailable/invalid");
      else if (dayPnl <= -c.maxDailyLoss) r.push(`daily loss limit ${c.maxDailyLoss} hit`);
    }
    if (!isMarketOpen(ex, this.now(), c.marketHolidays)) r.push(`market closed for ${o.exchange}`);

    return { allow: r.length === 0, reasons: r };
  }

  /**
   * Synchronous check + immediate reservation of the order count and notional,
   * so concurrent callers cannot slip past the caps. commit() persists,
   * release() undoes the reservation.
   */
  reserve(
    o: RiskOrder,
    run: { ordersThisRun: number },
    dayPnl?: number,
  ): { allow: boolean; reasons: string[]; token?: ReserveToken } {
    const d = this.checkOrder(o, run, dayPnl);
    if (!d.allow) return d;
    const notional = o.exchange.trim().toUpperCase() === "CRYPTO" ? 0 : o.quantity * (o.price as number);
    this.day.orders += 1;
    this.day.notional += notional;
    return { ...d, token: { date: this.day.date, notional, done: false } };
  }

  release(t: ReserveToken): void {
    if (t.done) return;
    t.done = true;
    if (t.date !== this.day.date) return;
    this.day.orders = Math.max(0, this.day.orders - 1);
    this.day.notional = Math.max(0, this.day.notional - t.notional);
  }

  commit(t: ReserveToken): void {
    if (t.done) return;
    t.done = true;
    this.save();
  }

  recordOrder(o: RiskOrder, notional: number): void {
    this.roll();
    this.day.orders += 1;
    if (o.exchange.toUpperCase() !== "CRYPTO") this.day.notional += notional;
    this.save();
  }

  /**
   * Snapshot for the AI. limits has every riskSchema key with its effective value; unset optional
   * keys are null (never omitted). marketHolidays is summarised as counts plus the next NSE holiday
   * on/after today (IST), contractValues as a count. today.remainingOrders / remainingNotional use the
   * same counters as checkOrder (CRYPTO is not counted in notional), floored at 0.
   */
  status() {
    this.roll();
    const c = this.cfg;
    const nse = c.marketHolidays?.NSE ?? [];
    const mcx = c.marketHolidays?.MCX ?? [];
    const upcoming = nse.filter((d) => d >= this.day.date).sort();
    return {
      mode: this.opts.mode,
      killSwitch: existsSync(this.opts.killSwitchFile),
      limits: {
        allowedExchanges: [...c.allowedExchanges],
        allowedProducts: [...c.allowedProducts],
        symbolAllow: [...c.symbolAllow],
        symbolDeny: [...c.symbolDeny],
        maxQtyPerOrder: c.maxQtyPerOrder,
        maxNotionalPerOrder: c.maxNotionalPerOrder,
        maxNotionalPerOrderUsd: c.maxNotionalPerOrderUsd,
        maxOrdersPerDay: c.maxOrdersPerDay,
        maxNotionalPerDay: c.maxNotionalPerDay,
        maxDailyLoss: c.maxDailyLoss,
        maxOrdersPerRun: c.maxOrdersPerRun,
        maxShortOptionQtyPerOrder: c.maxShortOptionQtyPerOrder ?? null,
        contractValues: Object.keys(c.contractValues ?? {}).length,
        marketHolidays: { NSE: nse.length, MCX: mcx.length, nextNSE: upcoming[0] ?? null },
      },
      today: {
        date: this.day.date,
        orders: this.day.orders,
        notional: this.day.notional,
        remainingOrders: Math.max(0, c.maxOrdersPerDay - this.day.orders),
        remainingNotional: Math.max(0, c.maxNotionalPerDay - this.day.notional),
      },
    };
  }
}
