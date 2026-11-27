import { z } from "zod";
import { readFileSync } from "node:fs";
import path from "node:path";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const posInt = z.number().int().positive();
const posNum = z.number().positive();

const riskSchema = z
  .object({
    allowedExchanges: z.array(z.string()).default(["NSE", "BSE", "NFO", "CRYPTO"]),
    allowedProducts: z.array(z.string()).default(["CNC", "MIS", "NRML"]),
    symbolAllow: z.array(z.string()).default([]),
    symbolDeny: z.array(z.string()).default([]),
    maxQtyPerOrder: posInt.default(100),
    maxNotionalPerOrder: posNum.default(50000),
    maxNotionalPerOrderUsd: posNum.default(500),
    maxOrdersPerDay: posInt.default(20),
    maxNotionalPerDay: posNum.default(200000),
    maxDailyLoss: posNum.default(5000),
    maxOrdersPerRun: posInt.default(5),
  })
  .strict();

export type RiskConfig = z.infer<typeof riskSchema>;

export interface Config {
  openalgoUrl: string;
  openalgoApiKey: string;
  mcpToken: string;
  btUrl?: string;
  btToken?: string;
  port: number;
  host: string;
  dataDir: string;
  killSwitchFile: string;
  mode: "paper" | "live";
  risk: RiskConfig;
}

function req(env: Record<string, string | undefined>, key: string): string {
  const v = env[key];
  if (v === undefined || v.trim() === "") throw new ConfigError(`${key} is required`);
  return v;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const rawUrl = req(env, "OPENALGO_URL");
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new ConfigError("OPENALGO_URL must be a valid http/https URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new ConfigError("OPENALGO_URL must be a valid http/https URL");
  }
  const openalgoUrl = rawUrl.replace(/\/+$/, "");

  const openalgoApiKey = req(env, "OPENALGO_API_KEY");
  const mcpToken = req(env, "MCP_TOKEN");
  if (mcpToken.trim().length < 24) throw new ConfigError("MCP_TOKEN must be at least 24 characters");

  const portRaw = env.PORT ?? "8787";
  const port = Number(portRaw);
  if (!/^\d+$/.test(portRaw) || port < 1 || port > 65535) {
    throw new ConfigError("PORT must be an integer between 1 and 65535");
  }

  const mode = env.MODE ?? "paper";
  if (mode !== "paper" && mode !== "live") throw new ConfigError('MODE must be "paper" or "live"');

  const dataDir = env.DATA_DIR || "./runtime";
  const killSwitchFile = env.KILL_SWITCH_FILE || path.join(dataDir, "KILL");

  let riskRaw: unknown = {};
  if (env.RISK_CONFIG) {
    try {
      riskRaw = JSON.parse(readFileSync(env.RISK_CONFIG, "utf8"));
    } catch {
      throw new ConfigError("RISK_CONFIG file is unreadable or not valid JSON");
    }
  }
  const parsed = riskSchema.safeParse(riskRaw);
  if (!parsed.success) {
    const unknown = parsed.error.issues.some((i) => i.code === "unrecognized_keys");
    const fields = parsed.error.issues
      .filter((i) => i.code !== "unrecognized_keys")
      .map((i) => `${i.path.join(".") || "(root)"} (${i.code})`);
    const parts = [...(fields.length ? [`invalid field ${fields.join(", ")}`] : []), ...(unknown ? ["unknown key(s) present"] : [])];
    throw new ConfigError(`RISK_CONFIG: ${parts.join("; ")}`);
  }

  return {
    openalgoUrl,
    openalgoApiKey,
    mcpToken,
    btUrl: env.BT_URL || undefined,
    btToken: env.BT_TOKEN || undefined,
    port,
    host: env.HOST || "127.0.0.1",
    dataDir,
    killSwitchFile,
    mode,
    risk: parsed.data,
  };
}
