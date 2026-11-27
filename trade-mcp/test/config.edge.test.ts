import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, ConfigError } from "../src/config.js";

const API_KEY = "SECRET-API-KEY-zz91";
const TOKEN = "SECRET-TOKEN-abcdefghijk"; // 24 chars
const base = { OPENALGO_URL: "http://localhost:5000/", OPENALGO_API_KEY: API_KEY, MCP_TOKEN: TOKEN };

function riskFile(content: string): string {
  const p = path.join(mkdtempSync(path.join(tmpdir(), "cfg-edge-")), "risk.json");
  writeFileSync(p, content);
  return p;
}

function err(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return e as ConfigError;
  }
  throw new Error("expected ConfigError");
}

function noLeak(e: Error, ...secrets: string[]) {
  for (const s of [API_KEY, TOKEN, ...secrets]) {
    expect(e.message).not.toContain(s);
    expect(String(e.stack ?? "")).not.toContain(s);
  }
}

describe("required keys", () => {
  it.each(["OPENALGO_URL", "OPENALGO_API_KEY", "MCP_TOKEN"])("missing %s names key", (k) => {
    const e = err({ ...base, [k]: undefined });
    expect(e.message).toContain(k);
    noLeak(e);
  });
  it.each(["OPENALGO_URL", "OPENALGO_API_KEY", "MCP_TOKEN"])("empty %s names key", (k) => {
    expect(err({ ...base, [k]: "" }).message).toContain(k);
  });
  it.each(["OPENALGO_URL", "OPENALGO_API_KEY", "MCP_TOKEN"])("whitespace-only %s rejected", (k) => {
    const v = k === "MCP_TOKEN" ? " ".repeat(30) : "   ";
    expect(err({ ...base, [k]: v }).message).toContain(k);
  });
  it("empty env object", () => {
    expect(err({}).message).toContain("OPENALGO_URL");
  });
});

describe("OPENALGO_URL", () => {
  it.each(["ftp://host", "file:///etc/passwd", "javascript:alert(1)", "ws://host", "localhost:5000", "not a url"])(
    "rejects %s",
    (u) => {
      const e = err({ ...base, OPENALGO_URL: u });
      expect(e.message).toContain("OPENALGO_URL");
      noLeak(e);
    },
  );
  it("accepts https", () => {
    expect(loadConfig({ ...base, OPENALGO_URL: "https://x.example/api/" }).openalgoUrl).toBe("https://x.example/api");
  });
  it("strips multiple trailing slashes", () => {
    expect(loadConfig({ ...base, OPENALGO_URL: "http://h:1/a///" }).openalgoUrl).toBe("http://h:1/a");
  });
  it("no trailing slash unchanged", () => {
    expect(loadConfig({ ...base, OPENALGO_URL: "http://h" }).openalgoUrl).toBe("http://h");
  });
  it("credentials embedded in bad URL are not echoed", () => {
    noLeak(err({ ...base, OPENALGO_URL: "ftp://user:SECRETPW@host" }), "SECRETPW");
  });
});

describe("MCP_TOKEN length", () => {
  it("23 chars rejected without leaking", () => {
    const t = "Q".repeat(23);
    const e = err({ ...base, MCP_TOKEN: t });
    expect(e.message).toContain("MCP_TOKEN");
    noLeak(e, t);
  });
  it("24 chars accepted", () => {
    expect(loadConfig({ ...base, MCP_TOKEN: "Q".repeat(24) }).mcpToken).toBe("Q".repeat(24));
  });
});

describe("optionals", () => {
  it("BT_URL/BT_TOKEN absent -> undefined", () => {
    const c = loadConfig(base);
    expect(c.btUrl).toBeUndefined();
    expect(c.btToken).toBeUndefined();
  });
  it("PORT boundaries", () => {
    expect(loadConfig({ ...base, PORT: "1" }).port).toBe(1);
    expect(loadConfig({ ...base, PORT: "65535" }).port).toBe(65535);
    for (const p of ["0", "65536", "-1", "80.5", "abc", " 80", ""]) {
      expect(() => loadConfig({ ...base, PORT: p }), p).toThrow(ConfigError);
    }
  });
  it("KILL_SWITCH_FILE derives from DATA_DIR, override respected", () => {
    expect(loadConfig({ ...base, DATA_DIR: "/srv/d" }).killSwitchFile).toBe(path.join("/srv/d", "KILL"));
    expect(loadConfig({ ...base, KILL_SWITCH_FILE: "/k" }).killSwitchFile).toBe("/k");
  });
  it("Windows DATA_DIR", () => {
    const c = loadConfig({ ...base, DATA_DIR: "C:\\trade\\runtime" });
    expect(c.dataDir).toBe("C:\\trade\\runtime");
    expect(c.killSwitchFile).toBe(path.join("C:\\trade\\runtime", "KILL"));
  });
  it.each(["paper", "live"])("MODE %s ok", (m) => {
    expect(loadConfig({ ...base, MODE: m }).mode).toBe(m);
  });
  it.each(["PAPER", "Live", "LIVE", " paper", "paper ", "", "demo"])("MODE %j rejected", (m) => {
    expect(err({ ...base, MODE: m }).message).toContain("MODE");
  });
});

describe("RISK_CONFIG", () => {
  it("absent -> full defaults", () => {
    expect(loadConfig(base).risk).toEqual({
      allowedExchanges: ["NSE", "BSE", "NFO", "CRYPTO"],
      allowedProducts: ["CNC", "MIS", "NRML"],
      symbolAllow: [],
      symbolDeny: [],
      maxQtyPerOrder: 100,
      maxNotionalPerOrder: 50000,
      maxNotionalPerOrderUsd: 500,
      maxOrdersPerDay: 20,
      maxNotionalPerDay: 200000,
      maxDailyLoss: 5000,
      maxOrdersPerRun: 5,
      contractValues: {},
      marketHolidays: {},
    });
  });
  it("partial merge over defaults", () => {
    const r = loadConfig({ ...base, RISK_CONFIG: riskFile('{"maxQtyPerOrder":7,"symbolDeny":["X"]}') }).risk;
    expect(r.maxQtyPerOrder).toBe(7);
    expect(r.symbolDeny).toEqual(["X"]);
    expect(r.maxOrdersPerDay).toBe(20);
    expect(r.allowedProducts).toEqual(["CNC", "MIS", "NRML"]);
  });
  it("empty object -> defaults", () => {
    expect(loadConfig({ ...base, RISK_CONFIG: riskFile("{}") }).risk.maxDailyLoss).toBe(5000);
  });
  it.each([
    "maxQtyPerOrder",
    "maxNotionalPerOrder",
    "maxNotionalPerOrderUsd",
    "maxOrdersPerDay",
    "maxNotionalPerDay",
    "maxDailyLoss",
    "maxOrdersPerRun",
  ])("%s zero and negative rejected", (k) => {
    for (const v of [0, -1]) {
      expect(err({ ...base, RISK_CONFIG: riskFile(JSON.stringify({ [k]: v })) }).message).toContain(k);
    }
  });
  it("smallest positive accepted for non-int fields", () => {
    expect(loadConfig({ ...base, RISK_CONFIG: riskFile('{"maxDailyLoss":0.01}') }).risk.maxDailyLoss).toBe(0.01);
  });
  it.each(["maxQtyPerOrder", "maxOrdersPerDay", "maxOrdersPerRun"])("%s non-integer rejected", (k) => {
    expect(err({ ...base, RISK_CONFIG: riskFile(JSON.stringify({ [k]: 1.5 })) }).message).toContain(k);
  });
  it("numeric string rejected", () => {
    expect(() => loadConfig({ ...base, RISK_CONFIG: riskFile('{"maxQtyPerOrder":"10"}') })).toThrow(ConfigError);
  });
  it("unknown key rejected", () => {
    expect(err({ ...base, RISK_CONFIG: riskFile('{"maxQtyPerOrdr":5}') }).message).toContain("RISK_CONFIG");
  });
  it.each(["", "not json", "[1,2]", "null", "42"])("bad content %j rejected", (c) => {
    expect(() => loadConfig({ ...base, RISK_CONFIG: riskFile(c) })).toThrow(ConfigError);
  });
  it("missing file rejected", () => {
    expect(() => loadConfig({ ...base, RISK_CONFIG: path.join(tmpdir(), "nope-xyz-404.json") })).toThrow(ConfigError);
  });
  it("Windows-style RISK_CONFIG path", () => {
    if (process.platform === "win32") {
      const p = riskFile('{"maxOrdersPerRun":2}').replace(/\//g, "\\");
      expect(loadConfig({ ...base, RISK_CONFIG: p }).risk.maxOrdersPerRun).toBe(2);
    } else {
      expect(() => loadConfig({ ...base, RISK_CONFIG: "C:\\nope\\risk.json" })).toThrow(ConfigError);
    }
  });
});

describe("secret leakage in error paths", () => {
  it("invalid JSON containing secrets", () => {
    noLeak(err({ ...base, RISK_CONFIG: riskFile(`{"k": "${API_KEY}" ${TOKEN}`) }));
  });
  it("bad values that are secret strings", () => {
    noLeak(err({ ...base, RISK_CONFIG: riskFile(JSON.stringify({ maxQtyPerOrder: API_KEY, symbolAllow: TOKEN })) }));
  });
  it("unknown key whose name is a secret", () => {
    noLeak(err({ ...base, RISK_CONFIG: riskFile(JSON.stringify({ [API_KEY]: 1 })) }));
  });
  it("nested array element containing secret", () => {
    noLeak(err({ ...base, RISK_CONFIG: riskFile(JSON.stringify({ allowedExchanges: [{ x: TOKEN }] })) }));
  });
  it("secret in RISK_CONFIG path not echoed", () => {
    noLeak(err({ ...base, RISK_CONFIG: path.join(tmpdir(), API_KEY, "r.json") }));
  });
  it("every env error path hides api key and token", () => {
    const envs: Record<string, string>[] = [
      { ...base, OPENALGO_URL: "ftp://x" },
      { ...base, MCP_TOKEN: API_KEY.slice(0, 10) },
      { ...base, PORT: "x" },
      { ...base, MODE: "x" },
    ];
    for (const env of envs) noLeak(err(env), env.MCP_TOKEN);
  });
});
