import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { atomicWrite } from "./fs-utils.js";

export interface ToolUsageRecord {
  toolName: string;
  attempts: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  lastUsedAt?: string;
  lastSucceededAt?: string;
  lastFailedAt?: string;
}

export interface ToolUsageStats {
  version: 1;
  tools: Record<string, ToolUsageRecord>;
}

export function toolUsageStatsPath(stateRoot: string): string {
  return path.join(stateRoot, "tool-usage-stats.json");
}

export function loadToolUsageStats(stateRoot?: string): ToolUsageStats {
  if (!stateRoot) {
    return emptyStats();
  }
  const file = toolUsageStatsPath(stateRoot);
  if (!existsSync(file)) {
    return emptyStats();
  }
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  return normalizeStats(parsed);
}

export function recordToolUsage(input: {
  stateRoot?: string;
  toolName: string;
  success: boolean;
  now?: Date;
}): ToolUsageRecord | undefined {
  if (!input.stateRoot) {
    return undefined;
  }
  const stats = loadToolUsageStats(input.stateRoot);
  const now = (input.now ?? new Date()).toISOString();
  const current = stats.tools[input.toolName] ?? {
    toolName: input.toolName,
    attempts: 0,
    successes: 0,
    failures: 0,
    consecutiveFailures: 0
  };
  const next: ToolUsageRecord = {
    ...current,
    attempts: current.attempts + 1,
    successes: current.successes + (input.success ? 1 : 0),
    failures: current.failures + (input.success ? 0 : 1),
    consecutiveFailures: input.success ? 0 : current.consecutiveFailures + 1,
    lastUsedAt: now,
    lastSucceededAt: input.success ? now : current.lastSucceededAt,
    lastFailedAt: input.success ? current.lastFailedAt : now
  };
  stats.tools[input.toolName] = next;
  writeToolUsageStats(input.stateRoot, stats);
  return next;
}

export function toolUsageScore(record: ToolUsageRecord | undefined): number {
  if (!record || record.attempts <= 0) {
    return 0;
  }
  const successRate = record.successes / record.attempts;
  const confidence = Math.min(1, record.attempts / 8);
  const successBoost = Math.round(36 * successRate * confidence);
  const reliabilityPenalty = Math.round(42 * (1 - successRate) * confidence);
  const streakPenalty = Math.min(60, record.consecutiveFailures * 18);
  return Math.max(-90, Math.min(55, successBoost - reliabilityPenalty - streakPenalty));
}

export function formatToolUsageReason(record: ToolUsageRecord | undefined): string | undefined {
  const score = toolUsageScore(record);
  if (!record || score === 0) {
    return undefined;
  }
  const rate = Math.round((record.successes / Math.max(1, record.attempts)) * 100);
  const sign = score > 0 ? "+" : "";
  return `usage:${sign}${score} (${record.successes}/${record.attempts} success, ${rate}%)`;
}

export function writeToolUsageStats(stateRoot: string, stats: ToolUsageStats): void {
  mkdirSync(stateRoot, { recursive: true });
  atomicWrite(toolUsageStatsPath(stateRoot), `${JSON.stringify(normalizeStats(stats), null, 2)}\n`);
}

function emptyStats(): ToolUsageStats {
  return { version: 1, tools: {} };
}

function normalizeStats(value: unknown): ToolUsageStats {
  if (!isRecord(value)) {
    return emptyStats();
  }
  const tools: Record<string, ToolUsageRecord> = {};
  if (isRecord(value.tools)) {
    for (const [name, raw] of Object.entries(value.tools)) {
      const record = normalizeRecord(name, raw);
      if (record) {
        tools[record.toolName] = record;
      }
    }
  }
  return { version: 1, tools };
}

function normalizeRecord(name: string, value: unknown): ToolUsageRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const toolName = typeof value.toolName === "string" ? value.toolName : name;
  if (!toolName) {
    return undefined;
  }
  return {
    toolName,
    attempts: readCount(value.attempts),
    successes: readCount(value.successes),
    failures: readCount(value.failures),
    consecutiveFailures: readCount(value.consecutiveFailures),
    lastUsedAt: readOptionalString(value.lastUsedAt),
    lastSucceededAt: readOptionalString(value.lastSucceededAt),
    lastFailedAt: readOptionalString(value.lastFailedAt)
  };
}

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
