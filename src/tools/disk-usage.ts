import { execSync } from "node:child_process";
import os from "node:os";

export interface DiskUsageResult { filesystem: string; size: string; used: string; avail: string; usePercent: string; mount: string }
export const DiskUsageInputSchema = { type: "object", properties: { path: { type: "string" }, human_readable: { type: "boolean" } }, required: [], additionalProperties: false } satisfies Record<string, unknown>;

export function parseDiskUsageInput(input: Record<string, unknown>): { path: string; humanReadable: boolean } {
  return { path: typeof input.path === "string" ? input.path : "/", humanReadable: input.human_readable !== false };
}

export function executeDiskUsage(input: { path: string; humanReadable: boolean }): DiskUsageResult[] {
  const h = input.humanReadable ? "-h" : "";
  const raw = execSync(`df ${h} "${input.path}"`, { encoding: "utf8", timeout: 5000 });
  const lines = raw.trim().split("\n").slice(1); // skip header
  return lines.map(line => {
    const parts = line.split(/\s+/);
    return { filesystem: parts[0] ?? "", size: parts[1] ?? "", used: parts[2] ?? "", avail: parts[3] ?? "", usePercent: parts[4] ?? "", mount: parts[5] ?? "" };
  });
}

export function formatDiskUsageResult(results: DiskUsageResult[]): string {
  const lines = ["FILESYSTEM         SIZE     USED     AVAIL   USE%  MOUNTED ON"];
  for (const r of results) {
    lines.push(`${r.filesystem.padEnd(18)} ${r.size.padEnd(8)} ${r.used.padEnd(8)} ${r.avail.padEnd(8)} ${r.usePercent.padEnd(5)} ${r.mount}`);
  }
  return lines.join("\n");
}
