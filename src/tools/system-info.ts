import { execSync } from "node:child_process";
import os from "node:os";

export interface SystemInfoResult {
  hostname: string;
  platform: string;
  uptime: string;
  loadAvg: string;
  users: number;
  processes: number;
}
export const SystemInfoInputSchema = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseSystemInfoInput(): Record<string, never> {
  return {};
}

export function executeSystemInfo(): SystemInfoResult {
  const uptimeSecs = os.uptime();
  const days = Math.floor(uptimeSecs / 86400);
  const hours = Math.floor((uptimeSecs % 86400) / 3600);
  const mins = Math.floor((uptimeSecs % 3600) / 60);
  const uptimeStr = `${days}d ${hours}h ${mins}m`;
  const loadAvg = os
    .loadavg()
    .map((v) => v.toFixed(2))
    .join(", ");
  let users = 0;
  let processes = 0;
  try {
    const who = execSync("who | wc -l", { encoding: "utf8", timeout: 3000 });
    users = parseInt(who.trim(), 10) || 0;
    const ps = execSync("ps aux | wc -l", { encoding: "utf8", timeout: 3000 });
    processes = parseInt(ps.trim(), 10) || 0;
  } catch {
    /* best effort */
  }
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    uptime: uptimeStr,
    loadAvg,
    users,
    processes
  };
}

export function formatSystemInfoResult(result: SystemInfoResult): string {
  return [
    `Hostname: ${result.hostname}`,
    `Platform: ${result.platform}`,
    `Uptime:   ${result.uptime}`,
    `Load avg: ${result.loadAvg}`,
    `Users:    ${result.users}`,
    `Processes: ${result.processes}`
  ].join("\n");
}
