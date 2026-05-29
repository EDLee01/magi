import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { atomicWrite } from "./fs-utils.js";

export interface ToolUsageRecord {
  toolName: string;
  attempts: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  failureKinds: Record<string, number>;
  lastUsedAt?: string;
  lastSucceededAt?: string;
  lastFailedAt?: string;
  intents: Record<string, ToolUsageIntentRecord>;
}

export interface ToolUsageIntentRecord {
  intent: string;
  attempts: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  failureKinds: Record<string, number>;
  lastUsedAt?: string;
  lastSucceededAt?: string;
  lastFailedAt?: string;
}

export interface ToolUsageStats {
  version: 1;
  tools: Record<string, ToolUsageRecord>;
}

export interface ToolSearchContext {
  query: string;
  intents: string[];
  toolNames: string[];
  createdAt: string;
}

export interface ToolUsageContextStore {
  version: 1;
  contexts: ToolSearchContext[];
}

export function toolUsageStatsPath(stateRoot: string): string {
  return path.join(stateRoot, "tool-usage-stats.json");
}

export function toolUsageContextPath(stateRoot: string): string {
  return path.join(stateRoot, "tool-usage-context.json");
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
  intents?: string[];
  failureKind?: string;
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
    consecutiveFailures: 0,
    failureKinds: {},
    intents: {}
  };
  const next = updateUsageRecord(current, input.success, now, input.failureKind);
  for (const intent of uniqueIntents(input.intents ?? [])) {
    const currentIntent = next.intents[intent] ?? {
      intent,
      attempts: 0,
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      failureKinds: {}
    };
    next.intents[intent] = updateIntentRecord(currentIntent, input.success, now, input.failureKind);
  }
  stats.tools[input.toolName] = next;
  writeToolUsageStats(input.stateRoot, stats);
  return next;
}

export function recordToolSearchContext(input: {
  stateRoot?: string;
  query: string;
  intents: string[];
  toolNames: string[];
  now?: Date;
}): void {
  if (!input.stateRoot || input.intents.length === 0 || input.toolNames.length === 0) {
    return;
  }
  const store = loadToolUsageContext(input.stateRoot);
  const context: ToolSearchContext = {
    query: input.query,
    intents: uniqueIntents(input.intents),
    toolNames: Array.from(new Set(input.toolNames.filter((name) => name.trim()))),
    createdAt: (input.now ?? new Date()).toISOString()
  };
  store.contexts = [context, ...store.contexts].slice(0, 20);
  writeToolUsageContext(input.stateRoot, store);
}

export function toolUsageIntentsForTool(input: {
  stateRoot?: string;
  toolName: string;
  now?: Date;
  maxAgeMs?: number;
}): string[] {
  if (!input.stateRoot) {
    return [];
  }
  const nowMs = (input.now ?? new Date()).getTime();
  const maxAgeMs = input.maxAgeMs ?? 10 * 60 * 1000;
  const intents: string[] = [];
  for (const context of loadToolUsageContext(input.stateRoot).contexts) {
    const createdMs = Date.parse(context.createdAt);
    if (!Number.isFinite(createdMs) || nowMs - createdMs > maxAgeMs) {
      continue;
    }
    if (!context.toolNames.includes(input.toolName)) {
      continue;
    }
    intents.push(...context.intents);
  }
  return uniqueIntents(intents);
}

export function toolUsageScore(
  record: ToolUsageRecord | ToolUsageIntentRecord | undefined
): number {
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

export function formatToolUsageReason(
  record: ToolUsageRecord | ToolUsageIntentRecord | undefined,
  intent?: string,
  recoveryIntent?: string
): string | undefined {
  const score = toolUsageScore(record);
  if (!record || score === 0) {
    return undefined;
  }
  const rate = Math.round((record.successes / Math.max(1, record.attempts)) * 100);
  const sign = score > 0 ? "+" : "";
  const scope = intent ? ` intent:${intent}` : "";
  const failureKind = dominantFailureKind(record);
  const failureSuffix = failureKind ? `, failure:${failureKind}` : "";
  const recovery = failureKind
    ? toolFailureRecoverySuggestion(failureKind, recoveryIntent ?? intent)
    : undefined;
  const recoverySuffix = recovery ? `, recovery:${failureKind}=${recovery}` : "";
  return `usage:${sign}${score}${scope} (${record.successes}/${record.attempts} success, ${rate}%${failureSuffix}${recoverySuffix})`;
}

export function writeToolUsageStats(stateRoot: string, stats: ToolUsageStats): void {
  mkdirSync(stateRoot, { recursive: true });
  atomicWrite(toolUsageStatsPath(stateRoot), `${JSON.stringify(normalizeStats(stats), null, 2)}\n`);
}

function emptyStats(): ToolUsageStats {
  return { version: 1, tools: {} };
}

function emptyContextStore(): ToolUsageContextStore {
  return { version: 1, contexts: [] };
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
  const intents: Record<string, ToolUsageIntentRecord> = {};
  if (isRecord(value.intents)) {
    for (const [intent, raw] of Object.entries(value.intents)) {
      const record = normalizeIntentRecord(intent, raw);
      if (record) {
        intents[record.intent] = record;
      }
    }
  }
  return {
    toolName,
    attempts: readCount(value.attempts),
    successes: readCount(value.successes),
    failures: readCount(value.failures),
    consecutiveFailures: readCount(value.consecutiveFailures),
    failureKinds: readFailureKinds(value.failureKinds),
    lastUsedAt: readOptionalString(value.lastUsedAt),
    lastSucceededAt: readOptionalString(value.lastSucceededAt),
    lastFailedAt: readOptionalString(value.lastFailedAt),
    intents
  };
}

function normalizeIntentRecord(
  fallbackIntent: string,
  value: unknown
): ToolUsageIntentRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const intent =
    typeof value.intent === "string" && value.intent.trim() ? value.intent : fallbackIntent;
  if (!intent) {
    return undefined;
  }
  return {
    intent,
    attempts: readCount(value.attempts),
    successes: readCount(value.successes),
    failures: readCount(value.failures),
    consecutiveFailures: readCount(value.consecutiveFailures),
    failureKinds: readFailureKinds(value.failureKinds),
    lastUsedAt: readOptionalString(value.lastUsedAt),
    lastSucceededAt: readOptionalString(value.lastSucceededAt),
    lastFailedAt: readOptionalString(value.lastFailedAt)
  };
}

function loadToolUsageContext(stateRoot: string): ToolUsageContextStore {
  const file = toolUsageContextPath(stateRoot);
  if (!existsSync(file)) {
    return emptyContextStore();
  }
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  return normalizeContextStore(parsed);
}

function writeToolUsageContext(stateRoot: string, store: ToolUsageContextStore): void {
  mkdirSync(stateRoot, { recursive: true });
  atomicWrite(
    toolUsageContextPath(stateRoot),
    `${JSON.stringify(normalizeContextStore(store), null, 2)}\n`
  );
}

function normalizeContextStore(value: unknown): ToolUsageContextStore {
  if (!isRecord(value) || !Array.isArray(value.contexts)) {
    return emptyContextStore();
  }
  return {
    version: 1,
    contexts: value.contexts.flatMap((raw): ToolSearchContext[] => {
      if (!isRecord(raw)) {
        return [];
      }
      const query = readOptionalString(raw.query);
      const createdAt = readOptionalString(raw.createdAt);
      const intents = readStringList(raw.intents);
      const toolNames = readStringList(raw.toolNames);
      if (!query || !createdAt || intents.length === 0 || toolNames.length === 0) {
        return [];
      }
      return [{ query, intents: uniqueIntents(intents), toolNames, createdAt }];
    })
  };
}

function updateUsageRecord(
  current: ToolUsageRecord,
  success: boolean,
  now: string,
  failureKind?: string
): ToolUsageRecord {
  return {
    ...current,
    intents: { ...current.intents },
    attempts: current.attempts + 1,
    successes: current.successes + (success ? 1 : 0),
    failures: current.failures + (success ? 0 : 1),
    consecutiveFailures: success ? 0 : current.consecutiveFailures + 1,
    failureKinds: updateFailureKinds(current.failureKinds, success, failureKind),
    lastUsedAt: now,
    lastSucceededAt: success ? now : current.lastSucceededAt,
    lastFailedAt: success ? current.lastFailedAt : now
  };
}

function updateIntentRecord(
  current: ToolUsageIntentRecord,
  success: boolean,
  now: string,
  failureKind?: string
): ToolUsageIntentRecord {
  return {
    ...current,
    attempts: current.attempts + 1,
    successes: current.successes + (success ? 1 : 0),
    failures: current.failures + (success ? 0 : 1),
    consecutiveFailures: success ? 0 : current.consecutiveFailures + 1,
    failureKinds: updateFailureKinds(current.failureKinds, success, failureKind),
    lastUsedAt: now,
    lastSucceededAt: success ? now : current.lastSucceededAt,
    lastFailedAt: success ? current.lastFailedAt : now
  };
}

function uniqueIntents(intents: string[]): string[] {
  return Array.from(new Set(intents.map((intent) => intent.trim()).filter(Boolean)));
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function readFailureKinds(value: unknown): Record<string, number> {
  if (!isRecord(value)) {
    return {};
  }
  const result: Record<string, number> = {};
  for (const [kind, count] of Object.entries(value)) {
    const normalized = normalizeFailureKind(kind);
    const valueCount = readCount(count);
    if (normalized && valueCount > 0) {
      result[normalized] = (result[normalized] ?? 0) + valueCount;
    }
  }
  return result;
}

function updateFailureKinds(
  current: Record<string, number> | undefined,
  success: boolean,
  failureKind?: string
): Record<string, number> {
  const base = { ...(current ?? {}) };
  if (success) {
    return base;
  }
  const normalized = normalizeFailureKind(failureKind);
  base[normalized] = (base[normalized] ?? 0) + 1;
  return base;
}

function dominantFailureKind(
  record: ToolUsageRecord | ToolUsageIntentRecord | undefined
): string | undefined {
  const entries = Object.entries(record?.failureKinds ?? {});
  if (entries.length === 0) {
    return undefined;
  }
  entries.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  return entries[0][0];
}

function toolFailureRecoverySuggestion(kind: string, intent?: string): string {
  if (kind === "path" && intent === "workspace-search") {
    return "use Glob for broad search or pass a workspace-relative path";
  }
  const suggestions: Record<string, string> = {
    path: "pass a workspace-relative path",
    permission: "ask for approval or switch to an allowed plan",
    input: "check the selected tool schema before retrying",
    "not-found": "verify the target exists before retrying",
    timeout: "narrow the scope or raise the timeout",
    command: "inspect the exit output before retrying",
    binary: "use a binary-safe read or metadata tool",
    runtime: "read the error and try an alternate tool",
    unknown: "read the error and choose a safer retry"
  };
  return suggestions[kind] ?? suggestions.runtime;
}

function normalizeFailureKind(kind: unknown): string {
  if (typeof kind !== "string") {
    return "unknown";
  }
  const normalized = kind
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "unknown";
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
