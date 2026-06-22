import { spawnSync } from "node:child_process";

import { ToolError } from "./errors.js";

export interface ProcessInfo {
  pid: number;
  name: string;
  cpuPercent: string;
  memPercent: string;
  state: string;
}
export const ProcessListInputSchema = {
  type: "object",
  properties: {
    filter: { type: "string" },
    sort_by: { type: "string", enum: ["cpu", "mem", "pid", "name"] },
    limit: { type: "number" }
  },
  required: [],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseProcessListInput(input: Record<string, unknown>): {
  filter?: string;
  sortBy: string;
  limit: number;
} {
  return {
    filter: typeof input.filter === "string" ? input.filter : undefined,
    sortBy:
      input.sort_by === "cpu"
        ? "cpu"
        : input.sort_by === "mem"
          ? "mem"
          : input.sort_by === "pid"
            ? "pid"
            : input.sort_by === "name"
              ? "name"
              : "cpu",
    limit: typeof input.limit === "number" ? Math.min(input.limit, 100) : 20
  };
}

export function executeProcessList(input: {
  filter?: string;
  sortBy: string;
  limit: number;
}): ProcessInfo[] {
  const result = spawnSync("ps", ["aux"], { encoding: "utf8", timeout: 5000 });
  if (result.error || result.status !== 0) {
    throw new ToolError(
      `Failed to list processes: ${result.error?.message ?? result.stderr.trim() ?? "unknown error"}`,
      "command-failed"
    );
  }
  const raw = result.stdout;
  const lines = raw.trim().split("\n");
  const filter = input.filter?.toLocaleLowerCase();
  const processes = lines.slice(1).flatMap((line) => {
    const parts = line.trim().split(/\s+/);
    const pid = Number.parseInt(parts[1] ?? "", 10);
    if (!Number.isFinite(pid)) {
      return [];
    }
    const process = {
      pid,
      name: parts.slice(10).join(" ") || "unknown",
      cpuPercent: parts[2] ?? "0",
      memPercent: parts[3] ?? "0",
      state: parts[7] ?? "?"
    };
    return !filter || process.name.toLocaleLowerCase().includes(filter) ? [process] : [];
  });
  processes.sort((left, right) => {
    if (input.sortBy === "pid") return left.pid - right.pid;
    if (input.sortBy === "name") return left.name.localeCompare(right.name);
    const field = input.sortBy === "mem" ? "memPercent" : "cpuPercent";
    return Number.parseFloat(right[field]) - Number.parseFloat(left[field]);
  });
  return processes.slice(0, Math.max(0, Math.min(Math.trunc(input.limit), 100)));
}

export function formatProcessListResult(processes: ProcessInfo[]): string {
  if (processes.length === 0) return "No matching processes";
  const lines = ["PID      CPU%  MEM%  NAME"];
  for (const p of processes) {
    lines.push(
      `${String(p.pid).padEnd(8)} ${p.cpuPercent.padEnd(5)} ${p.memPercent.padEnd(5)} ${p.name.slice(0, 60)}`
    );
  }
  return lines.join("\n");
}
