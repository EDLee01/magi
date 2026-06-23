import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { atomicWrite } from "./fs-utils.js";
import { MagiPaths } from "./paths.js";

export type GoalStatus = "active" | "completed" | "blocked" | "cancelled";

const GOAL_MANAGEMENT_COMMANDS = new Set([
  "status",
  "show",
  "list",
  "done",
  "complete",
  "completed",
  "blocked",
  "block",
  "cancel",
  "cancelled",
  "clear",
  "reset",
  "stop"
]);

export interface ThreadGoal {
  id: string;
  sessionId: string;
  objective: string;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  blockedAt?: string;
  cancelledAt?: string;
  note?: string;
  setupCommand?: string;
  checkCommand?: string;
  maxChecks?: number;
}

interface GoalStoreData {
  version: 1;
  goals: ThreadGoal[];
}

export function goalStorePath(paths: MagiPaths): string {
  return path.join(paths.stateRoot, "goals.json");
}

export function getGoal(paths: MagiPaths, sessionId: string): ThreadGoal | undefined {
  return readGoalStore(paths).goals.find(
    (goal) => goal.sessionId === sessionId && goal.status === "active"
  );
}

export function listGoals(paths: MagiPaths, sessionId?: string): ThreadGoal[] {
  const goals = readGoalStore(paths).goals;
  return (sessionId ? goals.filter((goal) => goal.sessionId === sessionId) : goals)
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function createGoal(
  paths: MagiPaths,
  input: {
    sessionId: string;
    objective: string;
    setupCommand?: string;
    checkCommand?: string;
    maxChecks?: number;
  }
): ThreadGoal {
  const objective = input.objective.trim();
  if (!objective) {
    throw new Error("Goal objective must not be empty");
  }
  const data = readGoalStore(paths);
  const now = new Date().toISOString();
  for (const goal of data.goals) {
    if (goal.sessionId === input.sessionId && goal.status === "active") {
      goal.status = "cancelled";
      goal.cancelledAt = now;
      goal.updatedAt = now;
      goal.note = "Replaced by a new active goal";
    }
  }
  const goal: ThreadGoal = {
    id: randomUUID(),
    sessionId: input.sessionId,
    objective,
    status: "active",
    createdAt: now,
    updatedAt: now,
    setupCommand: input.setupCommand?.trim() || undefined,
    checkCommand: input.checkCommand?.trim() || undefined,
    maxChecks:
      typeof input.maxChecks === "number" && input.maxChecks > 0
        ? Math.floor(input.maxChecks)
        : undefined
  };
  data.goals.push(goal);
  writeGoalStore(paths, data);
  return goal;
}

export function updateGoalStatus(
  paths: MagiPaths,
  input: {
    sessionId: string;
    status: Exclude<GoalStatus, "active">;
    note?: string;
  }
): ThreadGoal | undefined {
  const data = readGoalStore(paths);
  const goal = data.goals.find(
    (candidate) => candidate.sessionId === input.sessionId && candidate.status === "active"
  );
  if (!goal) return undefined;
  const now = new Date().toISOString();
  goal.status = input.status;
  goal.updatedAt = now;
  goal.note = input.note?.trim() || undefined;
  if (input.status === "completed") goal.completedAt = now;
  if (input.status === "blocked") goal.blockedAt = now;
  if (input.status === "cancelled") goal.cancelledAt = now;
  writeGoalStore(paths, data);
  return goal;
}

export function clearGoal(
  paths: MagiPaths,
  sessionId: string,
  note = "Cancelled by user"
): ThreadGoal | undefined {
  return updateGoalStatus(paths, { sessionId, status: "cancelled", note });
}

export function formatGoal(goal: ThreadGoal | undefined): string {
  if (!goal) return "No active goal. Use /goal <objective> to start one.";
  return [
    `Goal: ${goal.objective}`,
    `Status: ${formatGoalStatus(goal.status)}`,
    `Session: ${goal.sessionId}`,
    `Created: ${goal.createdAt}`,
    goal.completedAt ? `Completed: ${goal.completedAt}` : undefined,
    goal.blockedAt ? `Blocked: ${goal.blockedAt}` : undefined,
    goal.cancelledAt ? `Cancelled: ${goal.cancelledAt}` : undefined,
    goal.note ? `Note: ${goal.note}` : undefined
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function formatGoalStatus(status: GoalStatus): string {
  if (status === "active") return "active";
  return status;
}

export function formatGoalBadge(goal: ThreadGoal | undefined): string | undefined {
  if (!goal || goal.status !== "active") {
    return undefined;
  }
  const objective =
    goal.objective.length > 96 ? `${goal.objective.slice(0, 93)}...` : goal.objective;
  return `goal active · ${objective}`;
}

export function isGoalCreationArgs(args: string[]): boolean {
  const sub = args[0]?.toLowerCase();
  return Boolean(sub && !GOAL_MANAGEMENT_COMMANDS.has(sub));
}

export function formatGoalContext(goal: ThreadGoal | undefined): string | undefined {
  if (!goal || goal.status !== "active") return undefined;
  return [
    "<active_thread_goal>",
    "Continue working toward this session goal unless the user redirects or explicitly changes it.",
    `Objective: ${goal.objective}`,
    "Keep progress aligned with the full objective. Do not mark it done unless current evidence proves completion.",
    "</active_thread_goal>"
  ].join("\n");
}

function readGoalStore(paths: MagiPaths): GoalStoreData {
  const file = goalStorePath(paths);
  if (!existsSync(file)) {
    return { version: 1, goals: [] };
  }
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<GoalStoreData>;
  return {
    version: 1,
    goals: Array.isArray(parsed.goals)
      ? parsed.goals.map(normalizeGoal).filter((goal): goal is ThreadGoal => Boolean(goal))
      : []
  };
}

function writeGoalStore(paths: MagiPaths, data: GoalStoreData): void {
  mkdirSync(paths.stateRoot, { recursive: true });
  atomicWrite(goalStorePath(paths), `${JSON.stringify(data, null, 2)}\n`);
}

function normalizeGoal(value: unknown): ThreadGoal | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const status = normalizeStoredGoalStatus(record.status);
  if (
    !(
      typeof record.id === "string" &&
      typeof record.sessionId === "string" &&
      typeof record.objective === "string" &&
      status &&
      typeof record.createdAt === "string" &&
      typeof record.updatedAt === "string"
    )
  ) {
    return undefined;
  }
  return {
    id: record.id,
    sessionId: record.sessionId,
    objective: record.objective,
    status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: typeof record.completedAt === "string" ? record.completedAt : undefined,
    blockedAt: typeof record.blockedAt === "string" ? record.blockedAt : undefined,
    cancelledAt: typeof record.cancelledAt === "string" ? record.cancelledAt : undefined,
    note: typeof record.note === "string" ? record.note : undefined,
    setupCommand: typeof record.setupCommand === "string" ? record.setupCommand : undefined,
    checkCommand: typeof record.checkCommand === "string" ? record.checkCommand : undefined,
    maxChecks:
      typeof record.maxChecks === "number" && record.maxChecks > 0
        ? Math.floor(record.maxChecks)
        : undefined
  };
}

function normalizeStoredGoalStatus(value: unknown): GoalStatus | undefined {
  if (value === "complete") return "completed";
  if (value === "active" || value === "completed" || value === "blocked" || value === "cancelled") {
    return value;
  }
  return undefined;
}
