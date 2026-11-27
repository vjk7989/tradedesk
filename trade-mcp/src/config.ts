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

const isoDate = z.string().refine((v) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
});

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
    contractValues: z.record(z.string(), posNum).default({}),
    marketHolidays: z
      .record(z.string(), z.array(isoDate))
      .refine((m) => Object.keys(m).every((k) => k === "NSE" || k === "MCX"))
      .default({}),
  })
  .strict();

type RiskParsed = z.infer<typeof riskSchema>;
// contractValues/marketHolidays are optional on the type so hand-built configs may omit them (parsing always fills {}).
export type RiskConfig = Omit<RiskParsed, "contractValues" | "marketHolidays"> &
  Partial<Pick<RiskParsed, "contractValues" | "marketHolidays">>;

export interface Config {
  openalgoUrl: string;
  openalgoApiKey: string;
  mcpToken: string;
  mcpTokenReadonly?: string;
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
  const mcpTokenReadonly = env.MCP_TOKEN_READONLY?.trim() ? env.MCP_TOKEN_READONLY.trim() : undefined;
  if (mcpTokenReadonly !== undefined) {
    if (mcpTokenReadonly.trim().length < 24) throw new ConfigError("MCP_TOKEN_READONLY must be at least 24 characters");
    if (mcpTokenReadonly === mcpToken.trim()) throw new ConfigError("MCP_TOKEN_READONLY must differ from MCP_TOKEN");
  }

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
      .map((i) => `${i.path.length ? String(i.path[0]) : "(root)"} (${i.code})`);
    const parts = [...(fields.length ? [`invalid field ${fields.join(", ")}`] : []), ...(unknown ? ["unknown key(s) present"] : [])];
    throw new ConfigError(`RISK_CONFIG: ${parts.join("; ")}`);
  }

  const cv: Record<string, number> = {};
  for (const [k, v] of Object.entries(parsed.data.contractValues)) {
    const key = k.trim().toUpperCase();
    if (key in cv) throw new ConfigError("RISK_CONFIG: duplicate symbol in contractValues");
    cv[key] = v;
  }
  parsed.data.contractValues = cv;

  return {
    openalgoUrl,
    openalgoApiKey,
    mcpToken,
    mcpTokenReadonly,
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
