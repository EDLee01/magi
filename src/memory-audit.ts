import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { atomicWrite } from "./fs-utils.js";
import { memoryRoot, MemoryRootOptions } from "./memory-files.js";

export interface MemoryAuditInput extends MemoryRootOptions {
  action: string;
  target?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export function recordMemoryAudit(input: MemoryAuditInput): void {
  const root = memoryRoot(input);
  const logDir = path.join(root, "logs");
  mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, "audit.jsonl");
  const entry = {
    timestamp: new Date().toISOString(),
    actor: "agent",
    action: input.action,
    target: input.target,
    sessionId: input.sessionId,
    metadata: input.metadata ?? {}
  };
  let existing = "";
  try {
    existing = readFileSync(logFile, "utf8");
  } catch {}
  atomicWrite(logFile, `${existing}${JSON.stringify(entry)}\n`);
}
