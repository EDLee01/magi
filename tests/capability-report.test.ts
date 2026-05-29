import { describe, expect, it } from "vitest";

import { buildCapabilityReport, formatCapabilityReport } from "../src/capability-report.js";

describe("capability report", () => {
  it("passes when blackbox, memory, patch, and goal-plan eval reports meet the gates", () => {
    const report = buildCapabilityReport({
      generatedAt: new Date("2026-05-29T00:00:00.000Z"),
      blackbox: harnessReport({ name: "blackbox-e2e", scenarios: 9, providerCalls: 118 }),
      memory: memoryReport({ failed: 0, thresholdPassed: true, score: 1 }),
      patch: patchReport({
        filePatchCalls: 2,
        fileEditCalls: 1,
        fileWriteCalls: 0,
        recoverySeen: true,
        toolSearchRankedFilePatch: true,
        patchUsageRate: 2 / 3
      }),
      goalPlan: goalPlanReport()
    });

    expect(report).toMatchObject({
      status: "passed",
      summary: { total: 4, passed: 4, failed: 0, score: 1 },
      checks: [
        { id: "blackbox", status: "passed" },
        { id: "memory", status: "passed" },
        { id: "patch", status: "passed" },
        { id: "goal-plan", status: "passed" }
      ]
    });
  });

  it("fails patch alignment when existing file edits bypass FilePatch", () => {
    const report = buildCapabilityReport({
      blackbox: harnessReport({ name: "blackbox-e2e", scenarios: 9, providerCalls: 118 }),
      memory: memoryReport({ failed: 0, thresholdPassed: true, score: 1 }),
      patch: patchReport({
        filePatchCalls: 1,
        fileEditCalls: 1,
        fileWriteCalls: 1,
        recoverySeen: false,
        toolSearchRankedFilePatch: false,
        patchUsageRate: 1 / 3
      }),
      goalPlan: goalPlanReport()
    });

    const patch = report.checks.find((check) => check.id === "patch");
    expect(report.status).toBe("failed");
    expect(patch?.failures).toEqual(
      expect.arrayContaining([
        "FilePatch calls < 2",
        "FileWrite used",
        "recoverySeen=false",
        "toolSearchRankedFilePatch=false",
        "patchUsageRate=0.3333333333333333"
      ])
    );
  });

  it("fails memory alignment when recall misses the threshold", () => {
    const report = buildCapabilityReport({
      blackbox: harnessReport({ name: "blackbox-e2e", scenarios: 9, providerCalls: 118 }),
      memory: memoryReport({ failed: 1, thresholdPassed: false, score: 0.67 }),
      patch: patchReport({
        filePatchCalls: 2,
        fileEditCalls: 1,
        fileWriteCalls: 0,
        recoverySeen: true,
        toolSearchRankedFilePatch: true,
        patchUsageRate: 2 / 3
      }),
      goalPlan: goalPlanReport()
    });

    const output = formatCapabilityReport(report);
    expect(report.status).toBe("failed");
    expect(output).toContain("- memory: failed");
    expect(output).toContain("thresholdPassed=false");
  });

  it("fails goal-plan alignment when the lifecycle evidence is incomplete", () => {
    const report = buildCapabilityReport({
      blackbox: harnessReport({ name: "blackbox-e2e", scenarios: 9, providerCalls: 118 }),
      memory: memoryReport({ failed: 0, thresholdPassed: true, score: 1 }),
      patch: patchReport({
        filePatchCalls: 2,
        fileEditCalls: 1,
        fileWriteCalls: 0,
        recoverySeen: true,
        toolSearchRankedFilePatch: true,
        patchUsageRate: 2 / 3
      }),
      goalPlan: goalPlanReport({ completedGoalSuppressed: false, planReviewPersisted: false })
    });

    const goalPlan = report.checks.find((check) => check.id === "goal-plan");
    expect(report.status).toBe("failed");
    expect(goalPlan?.failures).toEqual(
      expect.arrayContaining(["completedGoalSuppressed=false", "planReviewPersisted=false"])
    );
  });
});

function harnessReport(input: {
  name: string;
  scenarios: number;
  providerCalls: number;
}): Record<string, unknown> {
  return {
    version: 1,
    name: input.name,
    status: "passed",
    summary: {
      total: input.scenarios,
      passed: input.scenarios,
      failed: 0,
      successRate: 1,
      score: 1,
      providerCalls: input.providerCalls
    },
    scenarios: []
  };
}

function memoryReport(input: {
  failed: number;
  thresholdPassed: boolean;
  score: number;
}): Record<string, unknown> {
  return {
    version: 1,
    name: "memory business recall",
    total: 3,
    passed: 3 - input.failed,
    failed: input.failed,
    score: input.score,
    minScore: 1,
    thresholdPassed: input.thresholdPassed
  };
}

function patchReport(input: {
  filePatchCalls: number;
  fileEditCalls: number;
  fileWriteCalls: number;
  recoverySeen: boolean;
  toolSearchRankedFilePatch: boolean;
  patchUsageRate: number;
}): Record<string, unknown> {
  return {
    ...harnessReport({ name: "patch-engine-eval", scenarios: 1, providerCalls: 5 }),
    scenarios: [
      {
        name: "filepatch recovery workflow",
        status: "passed",
        durationMs: 300,
        score: 1,
        failureKind: null,
        details: {
          provider: { callCount: 5 },
          toolCounts: {
            FilePatch: input.filePatchCalls,
            FileEdit: input.fileEditCalls,
            FileWrite: input.fileWriteCalls
          },
          patchUsageRate: input.patchUsageRate,
          recoverySeen: input.recoverySeen,
          toolSearchRankedFilePatch: input.toolSearchRankedFilePatch
        }
      }
    ]
  };
}

function goalPlanReport(
  overrides: Partial<{
    activeGoalContextSeen: boolean;
    completedGoalSuppressed: boolean;
    writeDeniedInPlanMode: boolean;
    planSubmittedToModel: boolean;
    planReviewPersisted: boolean;
    goalCompleted: boolean;
  }> = {}
): Record<string, unknown> {
  return {
    ...harnessReport({ name: "goal-plan-eval", scenarios: 1, providerCalls: 5 }),
    scenarios: [
      {
        name: "goal-plan lifecycle workflow",
        status: "passed",
        durationMs: 300,
        score: 1,
        failureKind: null,
        details: {
          provider: { callCount: 5 },
          activeGoalContextSeen: true,
          completedGoalSuppressed: true,
          writeDeniedInPlanMode: true,
          planSubmittedToModel: true,
          planReviewPersisted: true,
          goalCompleted: true,
          ...overrides
        }
      }
    ]
  };
}
