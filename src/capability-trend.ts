import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { CapabilityCheck, CapabilityReport } from "./capability-report.js";

export interface CapabilityTrendCheckSample {
  id: string;
  status: string;
  score: number;
  providerCalls: number;
  toolCallCount: number;
  regressions: number;
}

export interface CapabilityTrendSample {
  generatedAt: string;
  status: string;
  score: number;
  total: number;
  passed: number;
  failed: number;
  providerCalls: number;
  toolCallCount: number;
  regressions: number;
  checks: CapabilityTrendCheckSample[];
}

export interface CapabilityTrendDelta {
  score: number;
  passed: number;
  failed: number;
  providerCalls: number;
  toolCallCount: number;
  regressions: number;
}

export interface CapabilityTrendEfficiencyBudget {
  providerCalls: EfficiencyDeltaBudget;
  toolCallCount: EfficiencyDeltaBudget;
  checkProviderCalls: EfficiencyDeltaBudget;
  checkToolCallCount: EfficiencyDeltaBudget;
}

export interface EfficiencyDeltaBudget {
  absolute: number;
  relative: number;
}

export interface CapabilityTrendReport {
  version: 1;
  name: "capability-trend";
  generatedAt: string;
  status: "passed" | "failed";
  current: CapabilityTrendSample;
  previous?: CapabilityTrendSample;
  delta?: CapabilityTrendDelta;
  efficiencyBudget: CapabilityTrendEfficiencyBudget;
  failures: string[];
  observations: string[];
  historyCount: number;
}

export const DEFAULT_CAPABILITY_TREND_EFFICIENCY_BUDGET: CapabilityTrendEfficiencyBudget = {
  providerCalls: { absolute: 20, relative: 0.35 },
  toolCallCount: { absolute: 100, relative: 0.35 },
  checkProviderCalls: { absolute: 10, relative: 0.5 },
  checkToolCallCount: { absolute: 60, relative: 0.5 }
};

export function buildCapabilityTrendReport(input: {
  current: CapabilityReport;
  history?: CapabilityTrendSample[];
  generatedAt?: Date;
  efficiencyBudget?: PartialCapabilityTrendEfficiencyBudget;
}): CapabilityTrendReport {
  const current = sampleFromCapabilityReport(input.current);
  const previous = latestSample(input.history ?? []);
  const efficiencyBudget = normalizeEfficiencyBudget(input.efficiencyBudget);
  const failures: string[] = [];
  const observations: string[] = [];
  let delta: CapabilityTrendDelta | undefined;
  if (previous) {
    delta = {
      score: current.score - previous.score,
      passed: current.passed - previous.passed,
      failed: current.failed - previous.failed,
      providerCalls: current.providerCalls - previous.providerCalls,
      toolCallCount: current.toolCallCount - previous.toolCallCount,
      regressions: current.regressions - previous.regressions
    };
    if (delta.score < 0) failures.push(`scoreDelta=${formatSigned(delta.score)}`);
    if (delta.passed < 0) failures.push(`passedDelta=${formatSigned(delta.passed)}`);
    if (delta.failed > 0) failures.push(`failedDelta=${formatSigned(delta.failed)}`);
    if (delta.regressions > 0) failures.push(`regressionsDelta=${formatSigned(delta.regressions)}`);
    if (delta.providerCalls !== 0) {
      observations.push(`providerCallsDelta=${formatSigned(delta.providerCalls)}`);
    }
    if (delta.toolCallCount !== 0) {
      observations.push(`toolCallCountDelta=${formatSigned(delta.toolCallCount)}`);
    }
    failures.push(
      ...checkEfficiencyBudget({
        current,
        previous,
        delta,
        budget: efficiencyBudget
      })
    );
  }
  if (current.status !== "passed") failures.push(`status=${current.status}`);
  if (current.regressions > 0) failures.push(`regressions=${current.regressions}`);
  return {
    version: 1,
    name: "capability-trend",
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    status: failures.length === 0 ? "passed" : "failed",
    current,
    previous,
    delta,
    efficiencyBudget,
    failures,
    observations,
    historyCount: input.history?.length ?? 0
  };
}

export function readCapabilityTrendHistory(file: string): CapabilityTrendSample[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as { samples?: unknown }).samples)
    ) {
      return [];
    }
    return (parsed as { samples: unknown[] }).samples
      .map(readSample)
      .filter((sample): sample is CapabilityTrendSample => sample !== undefined);
  } catch {
    return [];
  }
}

export function writeCapabilityTrendReport(file: string, report: CapabilityTrendReport): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

export function appendCapabilityTrendHistory(input: {
  file: string;
  report: CapabilityTrendReport;
  maxSamples?: number;
}): CapabilityTrendSample[] {
  const existing = readCapabilityTrendHistory(input.file);
  const samples = [...existing, input.report.current].slice(-(input.maxSamples ?? 20));
  mkdirSync(path.dirname(input.file), { recursive: true });
  writeFileSync(input.file, `${JSON.stringify({ version: 1, samples }, null, 2)}\n`, "utf8");
  return samples;
}

export function formatCapabilityTrendReport(report: CapabilityTrendReport): string {
  const lines = [
    `Capability trend: ${report.status}`,
    `score: ${report.current.score.toFixed(2)}`,
    `checks: ${report.current.passed}/${report.current.total}`,
    `providerCalls: ${report.current.providerCalls}`,
    `toolCalls: ${report.current.toolCallCount}`,
    `regressions: ${report.current.regressions}`
  ];
  if (report.delta) {
    lines.push(
      `delta: score ${formatSigned(report.delta.score)}, passed ${formatSigned(report.delta.passed)}, failed ${formatSigned(report.delta.failed)}, providerCalls ${formatSigned(report.delta.providerCalls)}, toolCalls ${formatSigned(report.delta.toolCallCount)}, regressions ${formatSigned(report.delta.regressions)}`
    );
  }
  if (report.observations.length > 0) {
    lines.push(`observations: ${report.observations.join("; ")}`);
  }
  if (report.failures.length > 0) {
    lines.push(`failures: ${report.failures.join("; ")}`);
  }
  return lines.join("\n");
}

function sampleFromCapabilityReport(report: CapabilityReport): CapabilityTrendSample {
  let providerCalls = 0;
  let toolCallCount = 0;
  let regressions = 0;
  const checks = report.checks.map(sampleCheck);
  for (const check of checks) {
    providerCalls += check.providerCalls;
    toolCallCount += check.toolCallCount;
    regressions += check.regressions;
  }
  return {
    generatedAt: report.generatedAt,
    status: report.status,
    score: report.summary.score,
    total: report.summary.total,
    passed: report.summary.passed,
    failed: report.summary.failed,
    providerCalls,
    toolCallCount,
    regressions,
    checks
  };
}

function sampleCheck(check: CapabilityCheck): CapabilityTrendCheckSample {
  return {
    id: check.id,
    status: check.status,
    score: check.score,
    providerCalls: readNumber(check.metrics.providerCalls),
    toolCallCount: readNumber(check.metrics.toolCallCount),
    regressions: readNumber(check.metrics.regressions)
  };
}

function readSample(value: unknown): CapabilityTrendSample | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const generatedAt = typeof record.generatedAt === "string" ? record.generatedAt : undefined;
  const status = typeof record.status === "string" ? record.status : undefined;
  if (!generatedAt || !status) return undefined;
  const checks = Array.isArray(record.checks)
    ? record.checks
        .map(readCheckSample)
        .filter((check): check is CapabilityTrendCheckSample => check !== undefined)
    : [];
  return {
    generatedAt,
    status,
    score: readNumber(record.score),
    total: readNumber(record.total, checks.length),
    passed: readNumber(record.passed),
    failed: readNumber(record.failed),
    providerCalls: readNumber(record.providerCalls),
    toolCallCount: readNumber(record.toolCallCount),
    regressions: readNumber(record.regressions),
    checks
  };
}

function readCheckSample(value: unknown): CapabilityTrendCheckSample | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : undefined;
  const status = typeof record.status === "string" ? record.status : undefined;
  if (!id || !status) return undefined;
  return {
    id,
    status,
    score: readNumber(record.score),
    providerCalls: readNumber(record.providerCalls),
    toolCallCount: readNumber(record.toolCallCount),
    regressions: readNumber(record.regressions)
  };
}

function latestSample(samples: CapabilityTrendSample[]): CapabilityTrendSample | undefined {
  return samples.at(-1);
}

type PartialCapabilityTrendEfficiencyBudget = Partial<{
  [K in keyof CapabilityTrendEfficiencyBudget]: Partial<EfficiencyDeltaBudget>;
}>;

function normalizeEfficiencyBudget(
  input?: PartialCapabilityTrendEfficiencyBudget
): CapabilityTrendEfficiencyBudget {
  return {
    providerCalls: normalizeDeltaBudget(
      input?.providerCalls,
      DEFAULT_CAPABILITY_TREND_EFFICIENCY_BUDGET.providerCalls
    ),
    toolCallCount: normalizeDeltaBudget(
      input?.toolCallCount,
      DEFAULT_CAPABILITY_TREND_EFFICIENCY_BUDGET.toolCallCount
    ),
    checkProviderCalls: normalizeDeltaBudget(
      input?.checkProviderCalls,
      DEFAULT_CAPABILITY_TREND_EFFICIENCY_BUDGET.checkProviderCalls
    ),
    checkToolCallCount: normalizeDeltaBudget(
      input?.checkToolCallCount,
      DEFAULT_CAPABILITY_TREND_EFFICIENCY_BUDGET.checkToolCallCount
    )
  };
}

function normalizeDeltaBudget(
  input: Partial<EfficiencyDeltaBudget> | undefined,
  fallback: EfficiencyDeltaBudget
): EfficiencyDeltaBudget {
  return {
    absolute: readPositiveNumber(input?.absolute, fallback.absolute),
    relative: readNonNegativeNumber(input?.relative, fallback.relative)
  };
}

function checkEfficiencyBudget(input: {
  current: CapabilityTrendSample;
  previous: CapabilityTrendSample;
  delta: CapabilityTrendDelta;
  budget: CapabilityTrendEfficiencyBudget;
}): string[] {
  const failures: string[] = [];
  pushBudgetFailure(
    failures,
    "providerCallsBudget",
    input.delta.providerCalls,
    allowedDelta(input.previous.providerCalls, input.budget.providerCalls)
  );
  pushBudgetFailure(
    failures,
    "toolCallCountBudget",
    input.delta.toolCallCount,
    allowedDelta(input.previous.toolCallCount, input.budget.toolCallCount)
  );

  const previousChecks = new Map(input.previous.checks.map((check) => [check.id, check]));
  for (const currentCheck of input.current.checks) {
    const previousCheck = previousChecks.get(currentCheck.id);
    if (!previousCheck) continue;
    pushBudgetFailure(
      failures,
      `${currentCheck.id}.providerCallsBudget`,
      currentCheck.providerCalls - previousCheck.providerCalls,
      allowedDelta(previousCheck.providerCalls, input.budget.checkProviderCalls)
    );
    pushBudgetFailure(
      failures,
      `${currentCheck.id}.toolCallCountBudget`,
      currentCheck.toolCallCount - previousCheck.toolCallCount,
      allowedDelta(previousCheck.toolCallCount, input.budget.checkToolCallCount)
    );
  }
  return failures;
}

function pushBudgetFailure(
  failures: string[],
  label: string,
  delta: number,
  allowed: number
): void {
  if (delta > allowed) {
    failures.push(`${label}=${formatSigned(delta)}>+${allowed}`);
  }
}

function allowedDelta(previous: number, budget: EfficiencyDeltaBudget): number {
  return Math.max(budget.absolute, Math.ceil(previous * budget.relative));
}

function readNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function readNonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function formatSigned(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}
