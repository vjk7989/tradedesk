import type { spawn } from "node:child_process";

export type Backend = "claude" | "codex" | "gemini" | "api" | "api-openai";

export interface McpSpec {
  name: string;
  url: string;
  /** Name of the env var holding the bearer token (the token itself is never passed in argv). */
  tokenEnv: string;
}

export interface RunOptions {
  backend: Backend;
  prompt: string;
  mcp: McpSpec;
  timeoutMs?: number;
  cwd?: string;
  spawnImpl?: typeof spawn;
}

export interface RunResult {
  ok: boolean;
  text: string;
  costUsd?: number;
  error?: string;
  exitCode: number | null;
}
