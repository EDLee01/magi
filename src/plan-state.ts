import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { atomicWrite } from "./fs-utils.js";

export type PlanReviewStatus = "submitted" | "approved" | "needs_revision";

export interface PlanReviewRecord {
  id: string;
  sessionId: string;
  jobId?: string;
  toolUseId?: string;
  plan: string;
  status: PlanReviewStatus;
  createdAt: string;
  updatedAt: string;
  response?: string;
  revisesPlanId?: string;
  revisedByPlanId?: string;
  rootPlanId?: string;
}

interface PlanStoreData {
  version: 1;
  plans: PlanReviewRecord[];
}

export function planStorePath(stateRoot: string): string {
  return path.join(stateRoot, "plans.json");
}

export function recordPlanReview(input: {
  stateRoot: string;
  sessionId: string;
  jobId?: string;
  toolUseId?: string;
  plan: string;
  status?: PlanReviewStatus;
  response?: string;
  revisesPlanId?: string;
}): PlanReviewRecord {
  const plan = input.plan.trim();
  if (!plan) {
    throw new Error("Plan content must not be empty");
  }
  const data = readPlanStore(input.stateRoot);
  const now = new Date().toISOString();
  const revisesPlanId = input.revisesPlanId?.trim() || undefined;
  const predecessor = revisesPlanId
    ? data.plans.find((candidate) => candidate.id === revisesPlanId)
    : undefined;
  if (revisesPlanId && !predecessor) {
    throw new Error(`Cannot revise unknown plan: ${revisesPlanId}`);
  }
  if (predecessor?.revisedByPlanId) {
    throw new Error(`Plan already revised by ${predecessor.revisedByPlanId}`);
  }
  const record: PlanReviewRecord = {
    id: randomUUID(),
    sessionId: input.sessionId,
    jobId: input.jobId,
    toolUseId: input.toolUseId,
    plan,
    status: input.status ?? "submitted",
    createdAt: now,
    updatedAt: now,
    response: input.response?.trim() || undefined,
    revisesPlanId,
    rootPlanId: predecessor ? (predecessor.rootPlanId ?? predecessor.id) : undefined
  };
  if (predecessor) {
    predecessor.revisedByPlanId = record.id;
  }
  data.plans.push(record);
  writePlanStore(input.stateRoot, data);
  return record;
}

export function updatePlanReviewStatus(
  stateRoot: string,
  id: string,
  input: { status: PlanReviewStatus; response?: string }
): PlanReviewRecord | undefined {
  const data = readPlanStore(stateRoot);
  const record = data.plans.find((item) => item.id === id);
  if (!record) return undefined;
  record.status = input.status;
  record.updatedAt = new Date().toISOString();
  record.response = input.response?.trim() || record.response;
  writePlanStore(stateRoot, data);
  return record;
}

export function listPlanReviews(stateRoot: string, sessionId?: string): PlanReviewRecord[] {
  const plans = readPlanStore(stateRoot).plans;
  return plans
    .map((plan, index) => ({ plan, index }))
    .filter(({ plan }) => !sessionId || plan.sessionId === sessionId)
    .sort((a, b) => b.plan.updatedAt.localeCompare(a.plan.updatedAt) || b.index - a.index)
    .map(({ plan }) => plan);
}

export function getLatestPlanReview(
  stateRoot: string,
  sessionId?: string
): PlanReviewRecord | undefined {
  return listPlanReviews(stateRoot, sessionId)[0];
}

export function getPlanReview(stateRoot: string, id: string): PlanReviewRecord | undefined {
  return readPlanStore(stateRoot).plans.find((plan) => plan.id === id);
}

export function getLatestPlanReviewNeedingRevision(
  stateRoot: string,
  sessionId: string
): PlanReviewRecord | undefined {
  return listPlanReviews(stateRoot, sessionId).find(
    (plan) => plan.status === "needs_revision" && !plan.revisedByPlanId
  );
}

export function getPlanReviewChain(stateRoot: string, id: string): PlanReviewRecord[] {
  const plans = readPlanStore(stateRoot).plans;
  const byId = new Map(plans.map((plan) => [plan.id, plan]));
  const start = byId.get(id);
  if (!start) return [];
  let head = start;
  const seen = new Set<string>();
  while (head.revisesPlanId && !seen.has(head.id)) {
    seen.add(head.id);
    const previous = byId.get(head.revisesPlanId);
    if (!previous) break;
    head = previous;
  }
  const chain: PlanReviewRecord[] = [];
  let current: PlanReviewRecord | undefined = head;
  seen.clear();
  while (current && !seen.has(current.id)) {
    chain.push(current);
    seen.add(current.id);
    current = current.revisedByPlanId ? byId.get(current.revisedByPlanId) : undefined;
  }
  return chain;
}

export function formatPlanReview(record: PlanReviewRecord | undefined): string {
  if (!record) return "No submitted plan.";
  return [
    `Plan: ${record.id}`,
    `Status: ${record.status}`,
    `Session: ${record.sessionId}`,
    record.jobId ? `Job: ${record.jobId}` : undefined,
    record.toolUseId ? `Tool use: ${record.toolUseId}` : undefined,
    record.revisesPlanId ? `Revises plan: ${record.revisesPlanId}` : undefined,
    record.revisedByPlanId ? `Revised by plan: ${record.revisedByPlanId}` : undefined,
    record.rootPlanId ? `Root plan: ${record.rootPlanId}` : undefined,
    `Updated: ${record.updatedAt}`,
    record.response ? `Response: ${record.response}` : undefined,
    "",
    "Implementation plan:",
    record.plan
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function formatPlanReviewChain(records: PlanReviewRecord[]): string {
  if (records.length === 0) return "No submitted plan chain.";
  return [
    `Plan chain: ${records[0].rootPlanId ?? records[0].id}`,
    ...records.map((record, index) =>
      [
        `${index + 1}. ${record.status} ${record.id}`,
        `   Session: ${record.sessionId}`,
        record.revisesPlanId ? `   Revises: ${record.revisesPlanId}` : undefined,
        record.revisedByPlanId ? `   Revised by: ${record.revisedByPlanId}` : undefined,
        record.response ? `   Response: ${record.response}` : undefined,
        `   Plan: ${firstLine(record.plan)}`
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n")
    )
  ].join("\n");
}

export function formatPlanReviewList(records: PlanReviewRecord[]): string {
  if (records.length === 0) return "No submitted plans.";
  return [
    "Submitted plans:",
    ...records.map(
      (record) =>
        `- ${record.status.padEnd(14)} ${record.id} ${record.updatedAt}${formatPlanReviewLinks(record)} ${firstLine(record.plan)}`
    )
  ].join("\n");
}

function readPlanStore(stateRoot: string): PlanStoreData {
  const file = planStorePath(stateRoot);
  if (!existsSync(file)) {
    return { version: 1, plans: [] };
  }
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<PlanStoreData>;
  return {
    version: 1,
    plans: Array.isArray(parsed.plans)
      ? parsed.plans
          .map(normalizePlanReview)
          .filter((plan): plan is PlanReviewRecord => Boolean(plan))
      : []
  };
}

function writePlanStore(stateRoot: string, data: PlanStoreData): void {
  mkdirSync(stateRoot, { recursive: true });
  atomicWrite(planStorePath(stateRoot), `${JSON.stringify(data, null, 2)}\n`);
}

function normalizePlanReview(value: unknown): PlanReviewRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const status = normalizeStatus(record.status);
  if (
    !(
      typeof record.id === "string" &&
      typeof record.sessionId === "string" &&
      typeof record.plan === "string" &&
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
    jobId: typeof record.jobId === "string" ? record.jobId : undefined,
    toolUseId: typeof record.toolUseId === "string" ? record.toolUseId : undefined,
    plan: record.plan,
    status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    response: typeof record.response === "string" ? record.response : undefined,
    revisesPlanId: typeof record.revisesPlanId === "string" ? record.revisesPlanId : undefined,
    revisedByPlanId:
      typeof record.revisedByPlanId === "string" ? record.revisedByPlanId : undefined,
    rootPlanId: typeof record.rootPlanId === "string" ? record.rootPlanId : undefined
  };
}

function normalizeStatus(value: unknown): PlanReviewStatus | undefined {
  if (value === "submitted" || value === "approved" || value === "needs_revision") {
    return value;
  }
  return undefined;
}

function firstLine(text: string): string {
  const line =
    text
      .split(/\r?\n/)
      .find((item) => item.trim())
      ?.trim() ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

function formatPlanReviewLinks(record: PlanReviewRecord): string {
  const links = [
    record.revisesPlanId ? `revises:${record.revisesPlanId}` : undefined,
    record.revisedByPlanId ? `revised-by:${record.revisedByPlanId}` : undefined
  ].filter((link): link is string => Boolean(link));
  return links.length > 0 ? ` ${links.join(" ")}` : "";
}
