import { execSync } from "node:child_process";
import os from "node:os";

import { ToolError } from "./errors.js";

export interface KillProcessResult { pid: number; signal: string; success: boolean }

export const KillProcessInputSchema = { type: "object", properties: { pid: { type: "number" }, name: { type: "string" }, signal: { type: "string" } }, required: [], additionalProperties: false } satisfies Record<string, unknown>;

export function parseKillProcessInput(input: Record<string, unknown>): { pid?: number; name?: string; signal: string } {
  const pid = typeof input.pid === "number" ? input.pid : undefined;
  const name = typeof input.name === "string" ? input.name : undefined;
  if (!pid && !name) throw new ToolError("Provide pid or name", "bad-input");
  const validSignals = ["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SIGSTOP", "SIGCONT"];
  const signal = typeof input.signal === "string" && validSignals.includes(input.signal) ? input.signal : "SIGTERM";
  return { pid, name, signal };
}

export function executeKillProcess(input: { pid?: number; name?: string; signal: string }): KillProcessResult[] {
  const results: KillProcessResult[] = [];
  if (input.pid) {
    try {
      process.kill(input.pid, input.signal as NodeJS.Signals);
      results.push({ pid: input.pid, signal: input.signal, success: true });
    } catch (err) {
      throw new ToolError(`Failed to kill PID ${input.pid}: ${(err as Error).message}`, "command-failed");
    }
  }
  if (input.name) {
    const isMac = os.platform() === "darwin";
    const cmd = isMac
      ? `pgrep -f "${input.name.replace(/"/g, '\\"')}"`
      : `pgrep -f "${input.name.replace(/"/g, '\\"')}"`;
    try {
      const pids = execSync(cmd, { encoding: "utf8", timeout: 5000 }).trim().split("\n").map(Number).filter(n => n > 0);
      for (const pid of pids) {
        try {
          process.kill(pid, input.signal as NodeJS.Signals);
          results.push({ pid, signal: input.signal, success: true });
        } catch { /* process already gone */ }
      }
    } catch {
      throw new ToolError(`No processes found matching: ${input.name}`, "not-found");
    }
  }
  if (results.length === 0) throw new ToolError("No processes killed", "command-failed");
  return results;
}

export function formatKillProcessResult(results: KillProcessResult[]): string {
  return results.map(r => `Sent ${r.signal} to PID ${r.pid}${r.success ? " ✓" : " ✗"}`).join("\n");
}
