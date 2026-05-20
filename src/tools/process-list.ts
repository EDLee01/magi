import { execSync } from "node:child_process";
import os from "node:os";

export interface ProcessInfo { pid: number; name: string; cpuPercent: string; memPercent: string; state: string }
export const ProcessListInputSchema = { type: "object", properties: { filter: { type: "string" }, sort_by: { type: "string", enum: ["cpu", "mem", "pid", "name"] }, limit: { type: "number" } }, required: [], additionalProperties: false } satisfies Record<string, unknown>;

export function parseProcessListInput(input: Record<string, unknown>): { filter?: string; sortBy: string; limit: number } {
  return {
    filter: typeof input.filter === "string" ? input.filter : undefined,
    sortBy: input.sort_by === "cpu" ? "cpu" : input.sort_by === "mem" ? "mem" : input.sort_by === "pid" ? "pid" : "cpu",
    limit: typeof input.limit === "number" ? Math.min(input.limit, 100) : 20
  };
}

export function executeProcessList(input: { filter?: string; sortBy: string; limit: number }): ProcessInfo[] {
  // macOS uses -r for reverse CPU sort, Linux uses --sort=-%cpu
  const isMac = os.platform() === "darwin";
  const sortFlag = isMac
    ? (input.sortBy === "mem" ? "-m" : input.sortBy === "pid" ? "" : "-r")
    : `--sort=-${input.sortBy === "mem" ? "%mem" : input.sortBy === "pid" ? "pid" : "%cpu"}`;
  const sortPart = sortFlag ? ` ${sortFlag}` : "";
  const filter = input.filter ? ` | awk 'tolower($0) ~ /${input.filter.toLowerCase().replace(/[^a-z0-9]/g, "")}/'` : "";
  const raw = execSync(`ps aux${sortPart}${filter}`, { encoding: "utf8", timeout: 5000 });
  const lines = raw.trim().split("\n");
  // Skip header, take limit
  const dataLines = lines.slice(1, input.limit + 1);
  return dataLines.map(line => {
    const parts = line.split(/\s+/);
    const pid = parseInt(parts[1] ?? "0", 10);
    const cpu = parts[2] ?? "0";
    const mem = parts[3] ?? "0";
    const state = parts[7] ?? "?";
    const name = parts.slice(10).join(" ") || "unknown";
    return { pid, name, cpuPercent: cpu, memPercent: mem, state };
  });
}

export function formatProcessListResult(processes: ProcessInfo[]): string {
  if (processes.length === 0) return "No matching processes";
  const lines = ["PID      CPU%  MEM%  NAME"];
  for (const p of processes) {
    lines.push(`${String(p.pid).padEnd(8)} ${p.cpuPercent.padEnd(5)} ${p.memPercent.padEnd(5)} ${p.name.slice(0, 60)}`);
  }
  return lines.join("\n");
}
