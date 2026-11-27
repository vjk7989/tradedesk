// TEST-ONLY preload (node --require), used by e2e/smoke.mjs for the trade-mcp process alone.
// Shifts "now" to a fixed trading moment so the risk engine's market-hours check is deterministic.
// Wednesday 2026-12-02 11:00 IST (05:30Z). Not a holiday: the smoke risk config has no marketHolidays.
const Real = Date;
const offset = Real.UTC(2026, 11, 2, 5, 30, 0) - Real.now(); // fixed at load; time still advances
const shifted = () => Real.now() + offset;
globalThis.Date = new Proxy(Real, {
  construct: (target, args, nt) => (args.length === 0 ? new target(shifted()) : Reflect.construct(target, args, nt)),
  apply: (target, _this, args) => (args.length === 0 ? new target(shifted()).toString() : target(...args)),
  get: (target, prop, recv) => (prop === "now" ? shifted : Reflect.get(target, prop, target)),
});
