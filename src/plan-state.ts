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
  adoptedFromPlanId?: string;
  adoptedFromSessionId?: string;
  mergedFromPlanIds?: string[];
  mergedFromSessionIds?: string[];
  mergeConflicts?: PlanMergeConflict[];
  resolvedFromPlanId?: string;
  resolvedChoicePlanId?: string;
  resolvedConflictTargets?: string[];
}

export interface PlanMergeConflict {
  target: string;
  steps: PlanMergeConflictStep[];
}

export interface PlanMergeConflictStep {
  planId: string;
  sessionId: string;
  step: string;
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
  adoptedFromPlanId?: string;
  adoptedFromSessionId?: string;
  mergedFromPlanIds?: string[];
  mergedFromSessionIds?: string[];
  mergeConflicts?: PlanMergeConflict[];
  resolvedFromPlanId?: string;
  resolvedChoicePlanId?: string;
  resolvedConflictTargets?: string[];
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
    rootPlanId: predecessor ? (predecessor.rootPlanId ?? predecessor.id) : undefined,
    adoptedFromPlanId: input.adoptedFromPlanId,
    adoptedFromSessionId: input.adoptedFromSessionId,
    mergedFromPlanIds: cleanStringList(input.mergedFromPlanIds),
    mergedFromSessionIds: cleanStringList(input.mergedFromSessionIds),
    mergeConflicts: normalizeMergeConflicts(input.mergeConflicts),
    resolvedFromPlanId: input.resolvedFromPlanId,
    resolvedChoicePlanId: input.resolvedChoicePlanId,
    resolvedConflictTargets: cleanStringList(input.resolvedConflictTargets)
  };
  if (predecessor) {
    predecessor.revisedByPlanId = record.id;
  }
  data.plans.push(record);
  writePlanStore(input.stateRoot, data);
  return record;
}

export function adoptPlanReview(input: {
  stateRoot: string;
  sourcePlanId: string;
  targetSessionId: string;
  response?: string;
  force?: boolean;
}): PlanReviewRecord {
  const source = getPlanReview(input.stateRoot, input.sourcePlanId);
  if (!source) {
    throw new Error(`Cannot adopt unknown plan: ${input.sourcePlanId}`);
  }
  if (source.status !== "approved") {
    throw new Error(`Can only adopt approved plans: ${input.sourcePlanId}`);
  }
  assertNoActivePlanConflict(input.stateRoot, input.targetSessionId, input.force, "adopt");
  return recordPlanReview({
    stateRoot: input.stateRoot,
    sessionId: input.targetSessionId,
    plan: source.plan,
    status: "approved",
    response: input.response ?? `Adopted from plan ${source.id}`,
    adoptedFromPlanId: source.id,
    adoptedFromSessionId: source.sessionId,
    revisesPlanId: undefined
  });
}

export function mergePlanReviews(input: {
  stateRoot: string;
  sourcePlanIds: string[];
  targetSessionId: string;
  response?: string;
  force?: boolean;
}): PlanReviewRecord {
  const sourcePlanIds = uniqueStringList(input.sourcePlanIds);
  if (sourcePlanIds.length < 2) {
    throw new Error("Merging plans requires at least two distinct plan ids");
  }
  const sources = sourcePlanIds.map((id) => {
    const plan = getPlanReview(input.stateRoot, id);
    if (!plan) {
      throw new Error(`Cannot merge unknown plan: ${id}`);
    }
    if (plan.status !== "approved") {
      throw new Error(`Can only merge approved plans: ${id}`);
    }
    return plan;
  });
  assertNoActivePlanConflict(input.stateRoot, input.targetSessionId, input.force, "merge");
  const conflicts = detectPlanMergeConflicts(sources);
  return recordPlanReview({
    stateRoot: input.stateRoot,
    sessionId: input.targetSessionId,
    plan: formatMergedPlanText(sources, conflicts),
    status: conflicts.length > 0 ? "needs_revision" : "approved",
    response:
      input.response ??
      (conflicts.length > 0
        ? `Merged plan needs revision: ${conflicts.length} conflict(s) detected`
        : `Merged from plans ${sourcePlanIds.join(", ")}`),
    mergedFromPlanIds: sourcePlanIds,
    mergedFromSessionIds: uniqueStringList(sources.map((source) => source.sessionId)),
    mergeConflicts: conflicts
  });
}

export function resolvePlanReviewConflicts(input: {
  stateRoot: string;
  conflictedPlanId: string;
  choicePlanId: string;
  targetSessionId?: string;
  response?: string;
}): PlanReviewRecord {
  const conflicted = getPlanReview(input.stateRoot, input.conflictedPlanId);
  if (!conflicted) {
    throw new Error(`Cannot resolve unknown plan: ${input.conflictedPlanId}`);
  }
  if (conflicted.status !== "needs_revision" || !conflicted.mergeConflicts?.length) {
    throw new Error(`Plan has no merge conflicts to resolve: ${input.conflictedPlanId}`);
  }
  const choice = getPlanReview(input.stateRoot, input.choicePlanId);
  if (!choice) {
    throw new Error(`Cannot resolve with unknown plan: ${input.choicePlanId}`);
  }
  const chosenConflictSteps = conflicted.mergeConflicts.map((conflict) => {
    const step = conflict.steps.find((candidate) => candidate.planId === choice.id);
    if (!step) {
      throw new Error(`Choice plan does not resolve conflict target: ${conflict.target}`);
    }
    return { target: conflict.target, step };
  });
  const resolvedPlan = formatResolvedPlanText(conflicted, choice, chosenConflictSteps);
  return recordPlanReview({
    stateRoot: input.stateRoot,
    sessionId: input.targetSessionId ?? conflicted.sessionId,
    plan: resolvedPlan,
    status: "approved",
    response:
      input.response ?? `Resolved merge conflicts from plan ${conflicted.id} using ${choice.id}`,
    revisesPlanId: conflicted.id,
    mergedFromPlanIds: conflicted.mergedFromPlanIds,
    mergedFromSessionIds: conflicted.mergedFromSessionIds,
    resolvedFromPlanId: conflicted.id,
    resolvedChoicePlanId: choice.id,
    resolvedConflictTargets: conflicted.mergeConflicts.map((conflict) => conflict.target)
  });
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

export function getLatestActivePlanReview(
  stateRoot: string,
  sessionId: string
): PlanReviewRecord | undefined {
  return listPlanReviews(stateRoot, sessionId).find(
    (plan) => plan.status === "approved" || plan.status === "submitted"
  );
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
    record.adoptedFromPlanId ? `Adopted from plan: ${record.adoptedFromPlanId}` : undefined,
    record.adoptedFromSessionId
      ? `Adopted from session: ${record.adoptedFromSessionId}`
      : undefined,
    record.mergedFromPlanIds?.length
      ? `Merged from plans: ${record.mergedFromPlanIds.join(", ")}`
      : undefined,
    record.mergedFromSessionIds?.length
      ? `Merged from sessions: ${record.mergedFromSessionIds.join(", ")}`
      : undefined,
    record.mergeConflicts?.length ? `Merge conflicts: ${record.mergeConflicts.length}` : undefined,
    ...formatMergeConflictLines(record.mergeConflicts),
    record.resolvedFromPlanId ? `Resolved from plan: ${record.resolvedFromPlanId}` : undefined,
    record.resolvedChoicePlanId
      ? `Resolved with choice plan: ${record.resolvedChoicePlanId}`
      : undefined,
    record.resolvedConflictTargets?.length
      ? `Resolved conflict targets: ${record.resolvedConflictTargets.join(", ")}`
      : undefined,
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

export function formatPlanContext(record: PlanReviewRecord | undefined): string | undefined {
  if (!record) return undefined;
  return [
    "<session_plan_context>",
    "Latest submitted plan for this session. Treat it as historical implementation guidance; current user instructions can override it.",
    `Plan id: ${record.id}`,
    `Status: ${record.status}`,
    record.revisesPlanId ? `Revises plan: ${record.revisesPlanId}` : undefined,
    record.revisedByPlanId ? `Revised by plan: ${record.revisedByPlanId}` : undefined,
    record.rootPlanId ? `Root plan: ${record.rootPlanId}` : undefined,
    record.adoptedFromPlanId ? `Adopted from plan: ${record.adoptedFromPlanId}` : undefined,
    record.adoptedFromSessionId
      ? `Adopted from session: ${record.adoptedFromSessionId}`
      : undefined,
    record.mergedFromPlanIds?.length
      ? `Merged from plans: ${record.mergedFromPlanIds.join(", ")}`
      : undefined,
    record.mergedFromSessionIds?.length
      ? `Merged from sessions: ${record.mergedFromSessionIds.join(", ")}`
      : undefined,
    record.mergeConflicts?.length ? `Merge conflicts: ${record.mergeConflicts.length}` : undefined,
    ...formatMergeConflictLines(record.mergeConflicts),
    record.resolvedFromPlanId ? `Resolved from plan: ${record.resolvedFromPlanId}` : undefined,
    record.resolvedChoicePlanId
      ? `Resolved with choice plan: ${record.resolvedChoicePlanId}`
      : undefined,
    record.resolvedConflictTargets?.length
      ? `Resolved conflict targets: ${record.resolvedConflictTargets.join(", ")}`
      : undefined,
    record.response ? `Last user response: ${record.response}` : undefined,
    "Implementation plan:",
    record.plan,
    "</session_plan_context>"
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
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
    rootPlanId: typeof record.rootPlanId === "string" ? record.rootPlanId : undefined,
    adoptedFromPlanId:
      typeof record.adoptedFromPlanId === "string" ? record.adoptedFromPlanId : undefined,
    adoptedFromSessionId:
      typeof record.adoptedFromSessionId === "string" ? record.adoptedFromSessionId : undefined,
    mergedFromPlanIds: normalizeStringList(record.mergedFromPlanIds),
    mergedFromSessionIds: normalizeStringList(record.mergedFromSessionIds),
    mergeConflicts: normalizeMergeConflicts(record.mergeConflicts),
    resolvedFromPlanId:
      typeof record.resolvedFromPlanId === "string" ? record.resolvedFromPlanId : undefined,
    resolvedChoicePlanId:
      typeof record.resolvedChoicePlanId === "string" ? record.resolvedChoicePlanId : undefined,
    resolvedConflictTargets: normalizeStringList(record.resolvedConflictTargets)
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
    record.revisedByPlanId ? `revised-by:${record.revisedByPlanId}` : undefined,
    record.adoptedFromPlanId ? `adopted-from:${record.adoptedFromPlanId}` : undefined,
    record.mergedFromPlanIds?.length
      ? `merged-from:${record.mergedFromPlanIds.join(",")}`
      : undefined,
    record.mergeConflicts?.length ? `merge-conflicts:${record.mergeConflicts.length}` : undefined,
    record.resolvedFromPlanId ? `resolved-from:${record.resolvedFromPlanId}` : undefined
  ].filter((link): link is string => Boolean(link));
  return links.length > 0 ? ` ${links.join(" ")}` : "";
}

function assertNoActivePlanConflict(
  stateRoot: string,
  targetSessionId: string,
  force: boolean | undefined,
  action: "adopt" | "merge"
): void {
  const existing = getLatestActivePlanReview(stateRoot, targetSessionId);
  if (existing && !force) {
    throw new Error(
      `Session already has an approved or submitted plan: ${existing.id}. Use --force to ${action} anyway.`
    );
  }
}

function formatMergedPlanText(
  records: PlanReviewRecord[],
  conflicts: PlanMergeConflict[] = []
): string {
  const conflictStepKeys = new Set(
    conflicts.flatMap((conflict) =>
      conflict.steps.map((step) => `${step.planId}\n${normalizePlanStepText(step.step)}`)
    )
  );
  const compatibleSteps = uniquePlanSteps(
    records.flatMap((record) =>
      extractPlanSteps(record.plan)
        .filter((step) => !conflictStepKeys.has(`${record.id}\n${normalizePlanStepText(step)}`))
        .map((step) => ({
          planId: record.id,
          sessionId: record.sessionId,
          step
        }))
    )
  );
  return [
    `Merged implementation plan from ${records.length} approved plans.`,
    "",
    "Compatible steps:",
    ...(compatibleSteps.length > 0
      ? compatibleSteps.map((item, index) => `${index + 1}. ${item.step}`)
      : ["- No compatible steps detected."]),
    ...(conflicts.length > 0
      ? [
          "",
          "Merge conflicts requiring revision:",
          ...conflicts.flatMap((conflict, index) => [
            `${index + 1}. Target: ${conflict.target}`,
            ...conflict.steps.map(
              (step) => `   - plan ${step.planId} (${step.sessionId}): ${step.step}`
            )
          ])
        ]
      : [])
  ]
    .join("\n")
    .trim();
}

function formatResolvedPlanText(
  conflicted: PlanReviewRecord,
  choice: PlanReviewRecord,
  chosenConflictSteps: Array<{ target: string; step: PlanMergeConflictStep }>
): string {
  const conflictedSteps = new Set(
    (conflicted.mergeConflicts ?? []).flatMap((conflict) =>
      conflict.steps.map((step) => normalizePlanStepText(step.step))
    )
  );
  const compatibleSteps = extractMergedCompatibleSteps(conflicted.plan).filter(
    (step) => !conflictedSteps.has(normalizePlanStepText(step))
  );
  return [
    `Resolved merged implementation plan from ${conflicted.id}.`,
    `Conflict choice plan: ${choice.id} (${choice.sessionId})`,
    "",
    "Compatible steps:",
    ...(compatibleSteps.length > 0
      ? compatibleSteps.map((step, index) => `${index + 1}. ${step}`)
      : ["- No compatible steps detected."]),
    "",
    "Resolved conflict steps:",
    ...chosenConflictSteps.map((item, index) => `${index + 1}. ${item.target}: ${item.step.step}`)
  ].join("\n");
}

function extractMergedCompatibleSteps(plan: string): string[] {
  const lines = plan.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "Compatible steps:");
  if (start < 0) return extractPlanSteps(plan);
  const result: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === "Merge conflicts requiring revision:") break;
    if (trimmed.startsWith("- No compatible steps")) continue;
    result.push(trimmed.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim());
  }
  return result.filter(Boolean);
}

function detectPlanMergeConflicts(records: PlanReviewRecord[]): PlanMergeConflict[] {
  const byTarget = new Map<string, PlanMergeConflictStep[]>();
  for (const record of records) {
    for (const step of extractPlanSteps(record.plan)) {
      const target = mutablePlanStepTarget(step);
      if (!target) continue;
      const current = byTarget.get(target) ?? [];
      current.push({ planId: record.id, sessionId: record.sessionId, step });
      byTarget.set(target, current);
    }
  }
  const conflicts: PlanMergeConflict[] = [];
  for (const [target, steps] of byTarget) {
    const uniqueSteps = uniquePlanSteps(steps);
    const distinctSources = new Set(uniqueSteps.map((step) => step.planId));
    const distinctTexts = new Set(uniqueSteps.map((step) => normalizePlanStepText(step.step)));
    if (distinctSources.size > 1 && distinctTexts.size > 1) {
      conflicts.push({ target, steps: uniqueSteps });
    }
  }
  return conflicts;
}

function extractPlanSteps(plan: string): string[] {
  return plan
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
}

function mutablePlanStepTarget(step: string): string | undefined {
  if (!/\b(patch|edit|update|write|replace|change|modify|delete|remove)\b/i.test(step)) {
    return undefined;
  }
  const fileMatch = step.match(
    /[`'"]?([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.[A-Za-z0-9_-]+)[`'"]?/
  );
  if (fileMatch) return fileMatch[1].toLowerCase();
  const targetMatch = step.match(
    /\b(?:patch|edit|update|write|replace|change|modify|delete|remove)\s+(.+?)(?:\s+(?:to|with|after|before|from)\b|$)/i
  );
  return targetMatch?.[1]?.trim().toLowerCase();
}

function uniquePlanSteps<T extends { planId: string; step: string }>(steps: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const step of steps) {
    const key = `${step.planId}\n${normalizePlanStepText(step.step)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(step);
  }
  return result;
}

function normalizePlanStepText(step: string): string {
  return step.toLowerCase().replace(/\s+/g, " ").trim();
}

function uniqueStringList(values: string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values ?? []) {
    const item = value.trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function cleanStringList(values: string[] | undefined): string[] | undefined {
  const result = uniqueStringList(values);
  return result.length > 0 ? result : undefined;
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return cleanStringList(value.filter((item): item is string => typeof item === "string"));
}

function normalizeMergeConflicts(value: unknown): PlanMergeConflict[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const conflicts = value.flatMap((item): PlanMergeConflict[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const target = typeof record.target === "string" ? record.target.trim() : "";
    const steps = Array.isArray(record.steps)
      ? record.steps.flatMap((step): PlanMergeConflictStep[] => {
          if (!step || typeof step !== "object" || Array.isArray(step)) return [];
          const candidate = step as Record<string, unknown>;
          if (
            typeof candidate.planId !== "string" ||
            typeof candidate.sessionId !== "string" ||
            typeof candidate.step !== "string"
          ) {
            return [];
          }
          return [
            {
              planId: candidate.planId,
              sessionId: candidate.sessionId,
              step: candidate.step
            }
          ];
        })
      : [];
    return target && steps.length > 0 ? [{ target, steps }] : [];
  });
  return conflicts.length > 0 ? conflicts : undefined;
}

function formatMergeConflictLines(conflicts: PlanMergeConflict[] | undefined): string[] {
  return (conflicts ?? []).flatMap((conflict) => [
    `- Conflict target: ${conflict.target}`,
    ...conflict.steps.map((step) => `  ${step.planId} (${step.sessionId}): ${step.step}`)
  ]);
}
