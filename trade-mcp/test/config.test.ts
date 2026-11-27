import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, ConfigError } from "../src/config.js";

const base = {
  OPENALGO_URL: "http://localhost:5000/",
  OPENALGO_API_KEY: "secret-api-key-value",
  MCP_TOKEN: "t".repeat(24),
};

function riskFile(content: string): string {
  const p = path.join(mkdtempSync(path.join(tmpdir(), "cfg-")), "risk.json");
  writeFileSync(p, content);
  return p;
}

describe("loadConfig", () => {
  it("happy path with overrides", () => {
    const c = loadConfig({ ...base, PORT: "9000", MODE: "live", DATA_DIR: "d", BT_URL: "http://bt" });
    expect(c.openalgoUrl).toBe("http://localhost:5000");
    expect(c.port).toBe(9000);
    expect(c.mode).toBe("live");
    expect(c.btUrl).toBe("http://bt");
  });

  it("defaults", () => {
    const c = loadConfig(base);
    expect(c.port).toBe(8787);
    expect(c.host).toBe("127.0.0.1");
    expect(c.dataDir).toBe("./runtime");
    expect(c.killSwitchFile).toBe(path.join("./runtime", "KILL"));
    expect(c.mode).toBe("paper");
    expect(c.risk.maxOrdersPerRun).toBe(5);
    expect(c.risk.allowedExchanges).toEqual(["NSE", "BSE", "NFO", "CRYPTO"]);
  });

  it("missing key names the key, short token hides value", () => {
    expect(() => loadConfig({ ...base, OPENALGO_API_KEY: undefined })).toThrow(/OPENALGO_API_KEY/);
    try {
      loadConfig({ ...base, MCP_TOKEN: "short-secret" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toMatch(/MCP_TOKEN/);
      expect((e as Error).message).not.toContain("short-secret");
    }
  });

  it("bad MODE", () => {
    expect(() => loadConfig({ ...base, MODE: "yolo" })).toThrow(/MODE/);
  });

  it("risk file merges over defaults", () => {
    const c = loadConfig({ ...base, RISK_CONFIG: riskFile('{"maxQtyPerOrder": 7}') });
    expect(c.risk.maxQtyPerOrder).toBe(7);
    expect(c.risk.maxOrdersPerDay).toBe(20);
  });

  it("bad risk file: zero, unknown key", () => {
    expect(() => loadConfig({ ...base, RISK_CONFIG: riskFile('{"maxQtyPerOrder": 0}') })).toThrow(/maxQtyPerOrder/);
    expect(() => loadConfig({ ...base, RISK_CONFIG: riskFile('{"bogus": 1}') })).toThrow(ConfigError);
  });
});
