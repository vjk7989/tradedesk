import { closeSync, existsSync, mkdirSync, openSync, statSync } from "node:fs";
import path from "node:path";

/** The single audit-file writability probe, shared by the order path and /readyz. Throws on failure. */
export function probeAuditWritable(auditFile: string): void {
  mkdirSync(path.dirname(auditFile), { recursive: true });
  if (existsSync(auditFile) && statSync(auditFile).isDirectory()) throw new Error("audit path is a directory");
  closeSync(openSync(auditFile, "a"));
}
