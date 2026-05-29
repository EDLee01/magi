import { execSync } from "node:child_process";
import os from "node:os";

export type MonitorScope = "quick" | "full";

export interface MonitorInput {
  scope?: MonitorScope;
}

export interface MonitorResult {
  cpus: number;
  loadAvg: number[];
  memoryUsed: number;
  memoryTotal: number;
  memoryPercent: number;
  freeDiskPercent: string;
  hostname: string;
  platform: string;
  uptime: number;
}

export const MonitorInputSchema = {
  type: "object",
  properties: {
    scope: { type: "string", enum: ["quick", "full"] }
  },
  required: [],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseMonitorInput(input: Record<string, unknown>): MonitorInput {
  const scope = input.scope;
  if (scope !== undefined && scope !== "quick" && scope !== "full") {
    return { scope: "quick" };
  }
  return { scope: scope ?? "quick" };
}

export function getMonitorData(): MonitorResult {
  const cpus = os.cpus().length;
  const loadAvg = os.loadavg();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPercent = totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0;

  let freeDiskPercent = "unknown";
  try {
    const df = execSync("df -P / | tail -1", { encoding: "utf8", timeout: 5000 });
    const parts = df.trim().split(/\s+/);
    if (parts.length >= 5) {
      const capacity = parts[4]; // e.g. "12%"
      freeDiskPercent = `${100 - parseInt(capacity, 10)}%`;
    }
  } catch {
    // df failed, skip disk info
  }

  return {
    cpus,
    loadAvg,
    memoryUsed: usedMem,
    memoryTotal: totalMem,
    memoryPercent: memPercent,
    freeDiskPercent,
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    uptime: os.uptime()
  };
}

export function formatMonitorResult(data: MonitorResult, scope: MonitorScope): string {
  const lines: string[] = [];

  lines.push(`CPU cores: ${data.cpus}`);
  lines.push(`Load avg (1/5/15m): ${data.loadAvg.map((v) => v.toFixed(2)).join(", ")}`);
  lines.push(
    `Memory: ${formatBytes(data.memoryUsed)} / ${formatBytes(data.memoryTotal)} (${data.memoryPercent}%)`
  );
  lines.push(`Free disk (/): ${data.freeDiskPercent}`);

  if (scope === "full") {
    lines.push(`Hostname: ${data.hostname}`);
    lines.push(`Platform: ${data.platform}`);
    lines.push(`Uptime: ${formatUptime(data.uptime)}`);
  }

  return lines.join("\n");
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${days}d ${hours}h ${mins}m`;
}
