import { describe, expect, it } from "vitest";

import { buildCapabilityReport, formatCapabilityReport } from "../src/capability-report.js";

describe("capability report", () => {
  it("passes when all capability eval reports meet the gates", () => {
    const report = buildCapabilityReport({
      generatedAt: new Date("2026-05-29T00:00:00.000Z"),
      blackbox: harnessReport({ name: "blackbox-e2e", scenarios: 9, providerCalls: 118 }),
      modelTasks: modelTaskReport(),
      memory: memoryReport({ failed: 0, thresholdPassed: true, score: 1 }),
      patch: patchReport({
        filePatchCalls: 5,
        fileEditCalls: 1,
        fileWriteCalls: 0,
        recoverySeen: true,
        toolSearchRankedFilePatch: true,
        approvalDiffPreviewSeen: true,
        patchUsageRate: 5 / 6
      }),
      goalPlan: goalPlanReport(),
      toolDiscovery: toolDiscoveryReport(),
      controlApi: controlApiReport()
    });

    expect(report).toMatchObject({
      status: "passed",
      summary: { total: 7, passed: 7, failed: 0, score: 1 },
      checks: [
        { id: "blackbox", status: "passed" },
        { id: "model-tasks", status: "passed" },
        { id: "memory", status: "passed" },
        { id: "patch", status: "passed" },
        { id: "goal-plan", status: "passed" },
        { id: "tool-discovery", status: "passed" },
        { id: "control-api", status: "passed" }
      ]
    });
  });

  it("fails patch alignment when existing file edits bypass FilePatch", () => {
    const report = buildCapabilityReport({
      blackbox: harnessReport({ name: "blackbox-e2e", scenarios: 9, providerCalls: 118 }),
      modelTasks: modelTaskReport(),
      memory: memoryReport({ failed: 0, thresholdPassed: true, score: 1 }),
      patch: patchReport({
        filePatchCalls: 1,
        fileEditCalls: 1,
        fileWriteCalls: 1,
        recoverySeen: false,
        recoveryScenarioCount: 1,
        multiFileRecoverySeen: false,
        toolSearchRankedFilePatch: false,
        approvalDiffPreviewSeen: false,
        patchUsageRate: 1 / 3
      }),
      goalPlan: goalPlanReport(),
      toolDiscovery: toolDiscoveryReport(),
      controlApi: controlApiReport()
    });

    const patch = report.checks.find((check) => check.id === "patch");
    expect(report.status).toBe("failed");
    expect(patch?.failures).toEqual(
      expect.arrayContaining([
        "scenarios=1",
        "FilePatch calls < 5",
        "FileWrite used",
        "recoveryScenarioCount=1",
        "multiFileRecoverySeen=false",
        "toolSearchRankedFilePatch=false",
        "approvalDiffPreviewSeen=false",
        "patchUsageRate=0.3333333333333333"
      ])
    );
  });

  it("fails blackbox alignment when scorer evidence is too thin", () => {
    const report = buildCapabilityReport({
      blackbox: harnessReport({
        name: "blackbox-e2e",
        scenarios: 9,
        providerCalls: 118,
        assertions: 4,
        filesVerified: 0,
        toolCallCount: 3,
        uniqueToolCount: 2,
        regressions: 1
      }),
      modelTasks: modelTaskReport(),
      memory: memoryReport({ failed: 0, thresholdPassed: true, score: 1 }),
      patch: patchReport({
        filePatchCalls: 5,
        fileEditCalls: 1,
        fileWriteCalls: 0,
        recoverySeen: true,
        toolSearchRankedFilePatch: true,
        approvalDiffPreviewSeen: true,
        patchUsageRate: 5 / 6
      }),
      goalPlan: goalPlanReport(),
      toolDiscovery: toolDiscoveryReport(),
      controlApi: controlApiReport()
    });

    const blackbox = report.checks.find((check) => check.id === "blackbox");
    expect(report.status).toBe("failed");
    expect(blackbox?.failures).toEqual(
      expect.arrayContaining([
        "assertions=4",
        "filesVerified=0",
        "toolCallCount=3",
        "uniqueToolCount=2",
        "regressions=1"
      ])
    );
  });

  it("fails memory alignment when recall misses the threshold", () => {
    const report = buildCapabilityReport({
      blackbox: harnessReport({ name: "blackbox-e2e", scenarios: 9, providerCalls: 118 }),
      modelTasks: modelTaskReport(),
      memory: memoryReport({
        failed: 1,
        thresholdPassed: false,
        score: 0.67,
        maintenanceRecallSeen: false,
        workflowGraphRecallSeen: false,
        conflictGroupViewSeen: false,
        dreamConflictGroupLifecycleSeen: false,
        naturalLanguageCorrectionSeen: false,
        graphEdgeReinforcementSeen: false,
        userFeedbackTrendSeen: false,
        assertions: 4,
        filesVerified: 1
      }),
      patch: patchReport({
        filePatchCalls: 5,
        fileEditCalls: 1,
        fileWriteCalls: 0,
        recoverySeen: true,
        toolSearchRankedFilePatch: true,
        approvalDiffPreviewSeen: true,
        patchUsageRate: 5 / 6
      }),
      goalPlan: goalPlanReport(),
      toolDiscovery: toolDiscoveryReport(),
      controlApi: controlApiReport()
    });

    const output = formatCapabilityReport(report);
    expect(report.status).toBe("failed");
    expect(output).toContain("- memory: failed");
    expect(output).toContain("thresholdPassed=false");
    expect(output).toContain("assertions=4");
    expect(output).toContain("filesVerified=1");
    expect(output).toContain("maintenanceRecallSeen=false");
    expect(output).toContain("workflowGraphRecallSeen=false");
    expect(output).toContain("conflictGroupViewSeen=false");
    expect(output).toContain("dreamConflictGroupLifecycleSeen=false");
    expect(output).toContain("naturalLanguageCorrectionSeen=false");
    expect(output).toContain("graphEdgeReinforcementSeen=false");
    expect(output).toContain("userFeedbackTrendSeen=false");
  });

  it("fails model task alignment when task coverage or scorer evidence is too thin", () => {
    const report = buildCapabilityReport({
      blackbox: harnessReport({ name: "blackbox-e2e", scenarios: 9, providerCalls: 118 }),
      modelTasks: modelTaskReport({
        scenarios: 3,
        assertions: 4,
        filesVerified: 1,
        toolCallCount: 3,
        uniqueToolCount: 2,
        taskClasses: ["project_edit", "memory_driven", "tool_discovery"],
        patchStrategy: {
          filePatchCalls: 0,
          fileEditCalls: 0,
          fileWriteCalls: 1,
          patchUsageRate: 0
        },
        regressions: 1
      }),
      memory: memoryReport({ failed: 0, thresholdPassed: true, score: 1 }),
      patch: patchReport({
        filePatchCalls: 5,
        fileEditCalls: 1,
        fileWriteCalls: 0,
        recoverySeen: true,
        toolSearchRankedFilePatch: true,
        approvalDiffPreviewSeen: true,
        patchUsageRate: 5 / 6
      }),
      goalPlan: goalPlanReport(),
      toolDiscovery: toolDiscoveryReport(),
      controlApi: controlApiReport()
    });

    const modelTasks = report.checks.find((check) => check.id === "model-tasks");
    expect(report.status).toBe("failed");
    expect(modelTasks?.failures).toEqual(
      expect.arrayContaining([
        "scenarios=3",
        "taskClasses=3",
        "assertions=4",
        "filesVerified=1",
        "toolCallCount=3",
        "uniqueToolCount=2",
        "patchStrategyTask=false",
        "testDrivenRecoveryTask=false",
        "patchStrategyFilePatchCalls < 1",
        "patchStrategyFileEditCalls != 1",
        "patchStrategyRate=0",
        "regressions=1"
      ])
    );
  });

  it("fails goal-plan alignment when the lifecycle evidence is incomplete", () => {
    const report = buildCapabilityReport({
      blackbox: harnessReport({ name: "blackbox-e2e", scenarios: 9, providerCalls: 118 }),
      modelTasks: modelTaskReport(),
      memory: memoryReport({ failed: 0, thresholdPassed: true, score: 1 }),
      patch: patchReport({
        filePatchCalls: 5,
        fileEditCalls: 1,
        fileWriteCalls: 0,
        recoverySeen: true,
        toolSearchRankedFilePatch: true,
        approvalDiffPreviewSeen: true,
        patchUsageRate: 5 / 6
      }),
      goalPlan: goalPlanReport({
        completedGoalSuppressed: false,
        blockedGoalPersisted: false,
        planReviewPersisted: false,
        crossSessionPlanReviewListed: false,
        planRevisionFeedbackSeen: false,
        planRevisionPersisted: false,
        planApprovalSeen: false,
        planApprovalPersisted: false,
        planRevisionChainLinked: false,
        planRevisionChainViewListed: false,
        inheritedPlanContextSeen: false,
        inheritedPlanExecutionFollowed: false,
        inheritedPlanDeviationCorrected: false,
        crossSessionPlanAdopted: false,
        crossSessionAdoptedPlanContextSeen: false,
        assertions: 3,
        filesVerified: 1,
        toolCallCount: 2,
        uniqueToolCount: 1
      }),
      toolDiscovery: toolDiscoveryReport(),
      controlApi: controlApiReport()
    });

    const goalPlan = report.checks.find((check) => check.id === "goal-plan");
    expect(report.status).toBe("failed");
    expect(goalPlan?.failures).toEqual(
      expect.arrayContaining([
        "assertions=3",
        "filesVerified=1",
        "toolCallCount=2",
        "uniqueToolCount=1",
        "completedGoalSuppressed=false",
        "blockedGoalPersisted=false",
        "planReviewPersisted=false",
        "crossSessionPlanReviewListed=false",
        "planRevisionFeedbackSeen=false",
        "planRevisionPersisted=false",
        "planApprovalSeen=false",
        "planApprovalPersisted=false",
        "planRevisionChainLinked=false",
        "planRevisionChainViewListed=false",
        "inheritedPlanContextSeen=false",
        "inheritedPlanExecutionFollowed=false",
        "inheritedPlanDeviationCorrected=false",
        "crossSessionPlanAdopted=false",
        "crossSessionAdoptedPlanContextSeen=false"
      ])
    );
  });

  it("fails tool discovery alignment when reveal or usage feedback evidence is incomplete", () => {
    const report = buildCapabilityReport({
      blackbox: harnessReport({ name: "blackbox-e2e", scenarios: 9, providerCalls: 118 }),
      modelTasks: modelTaskReport(),
      memory: memoryReport({ failed: 0, thresholdPassed: true, score: 1 }),
      patch: patchReport({
        filePatchCalls: 5,
        fileEditCalls: 1,
        fileWriteCalls: 0,
        recoverySeen: true,
        toolSearchRankedFilePatch: true,
        approvalDiffPreviewSeen: true,
        patchUsageRate: 5 / 6
      }),
      goalPlan: goalPlanReport(),
      toolDiscovery: toolDiscoveryReport({
        learningDraftRevealed: false,
        feedbackRankingUsedUsage: false,
        intentScopedUsageRecorded: false,
        failureKindRecorded: false,
        failureKindShownInRanking: false,
        failureRecoverySuggested: false,
        crossTaskRecoveryRankingSeen: false,
        crossTaskRecoveryGuidanceSeen: false,
        crossTaskIntentScopedRankingSeen: false,
        crossTaskUnrelatedIntentIsolated: false,
        crossTaskProviderCalls: 0,
        longCycleProviderCalls: 0,
        assertions: 5,
        filesVerified: 0,
        toolCallCount: 8,
        uniqueToolCount: 2,
        revealedToolCount: 21,
        grepFailures: 2,
        grepIntentFailures: 2,
        grepPathFailures: 2,
        grepIntentPathFailures: 2
      }),
      controlApi: controlApiReport()
    });

    const toolDiscovery = report.checks.find((check) => check.id === "tool-discovery");
    expect(report.status).toBe("failed");
    expect(toolDiscovery?.failures).toEqual(
      expect.arrayContaining([
        "assertions=5",
        "filesVerified=0",
        "toolCallCount=8",
        "uniqueToolCount=2",
        "learningDraftRevealed=false",
        "feedbackRankingUsedUsage=false",
        "intentScopedUsageRecorded=false",
        "failureKindRecorded=false",
        "failureKindShownInRanking=false",
        "failureRecoverySuggested=false",
        "crossTaskRecoveryRankingSeen=false",
        "crossTaskRecoveryGuidanceSeen=false",
        "crossTaskIntentScopedRankingSeen=false",
        "crossTaskUnrelatedIntentIsolated=false",
        "crossTaskProviderCalls=0",
        "longCycleProviderCalls=0",
        "grepFailures < 4",
        "grepIntentFailures < 4",
        "grepPathFailures < 4",
        "grepIntentPathFailures < 4",
        "revealedToolCount did not increase"
      ])
    );
  });

  it("fails control API alignment when mobile workflow evidence is incomplete", () => {
    const report = buildCapabilityReport({
      blackbox: harnessReport({ name: "blackbox-e2e", scenarios: 9, providerCalls: 118 }),
      modelTasks: modelTaskReport(),
      memory: memoryReport({ failed: 0, thresholdPassed: true, score: 1 }),
      patch: patchReport({
        filePatchCalls: 5,
        fileEditCalls: 1,
        fileWriteCalls: 0,
        recoverySeen: true,
        toolSearchRankedFilePatch: true,
        approvalDiffPreviewSeen: true,
        patchUsageRate: 5 / 6
      }),
      goalPlan: goalPlanReport(),
      toolDiscovery: toolDiscoveryReport(),
      controlApi: controlApiReport({
        pairingUrlGenerated: false,
        pairingUrlTokenHandoffSeen: false,
        mdnsPeerDiscovered: false,
        approvalSseSeen: false,
        jobCancelled: false,
        cancelledApprovalDidNotWrite: false,
        resumedSessionContextSeen: false,
        panelClientContractValid: false,
        panelUiApprovalControlsSeen: false,
        panelUiCancelControlSeen: false,
        panelSseJobStreamSeen: false,
        mobileBrowserViewportSeen: false,
        mobileBrowserStreamRendered: false,
        mobileBrowserCancelRendered: false,
        peerCredentialsSaved: false,
        peerSavedListed: false,
        peerAgentToolSearched: false,
        peerAgentSchemaRevealed: false,
        peerAgentDispatched: false,
        peerDispatchSingleAgentCall: false,
        peerDispatchCompleted: false,
        peerDispatchResultReturned: false,
        peerRemoteSessionCreated: false,
        peerRemoteJobCompleted: false,
        peerDispatchAuditPersisted: false,
        assertions: 8,
        filesVerified: 2,
        toolCallCount: 2,
        uniqueToolCount: 2
      })
    });

    const controlApi = report.checks.find((check) => check.id === "control-api");
    expect(report.status).toBe("failed");
    expect(controlApi?.failures).toEqual(
      expect.arrayContaining([
        "assertions=8",
        "filesVerified=2",
        "toolCallCount=2",
        "uniqueToolCount=2",
        "pairingUrlGenerated=false",
        "pairingUrlTokenHandoffSeen=false",
        "mdnsPeerDiscovered=false",
        "approvalSseSeen=false",
        "jobCancelled=false",
        "cancelledApprovalDidNotWrite=false",
        "resumedSessionContextSeen=false",
        "panelClientContractValid=false",
        "panelUiApprovalControlsSeen=false",
        "panelUiCancelControlSeen=false",
        "panelSseJobStreamSeen=false",
        "mobileBrowserViewportSeen=false",
        "mobileBrowserStreamRendered=false",
        "mobileBrowserCancelRendered=false",
        "peerCredentialsSaved=false",
        "peerSavedListed=false",
        "peerAgentToolSearched=false",
        "peerAgentSchemaRevealed=false",
        "peerAgentDispatched=false",
        "peerDispatchSingleAgentCall=false",
        "peerDispatchCompleted=false",
        "peerDispatchResultReturned=false",
        "peerRemoteSessionCreated=false",
        "peerRemoteJobCompleted=false",
        "peerDispatchAuditPersisted=false"
      ])
    );
  });
});

function harnessReport(input: {
  name: string;
  scenarios: number;
  providerCalls: number;
  assertions?: number;
  filesVerified?: number;
  toolCallCount?: number;
  uniqueToolCount?: number;
  regressions?: number;
}): Record<string, unknown> {
  const regressions = Array.from({ length: input.regressions ?? 0 }, (_, index) => ({
    scenario: `regression ${index + 1}`,
    failureKind: "assertion"
  }));
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
      providerCalls: input.providerCalls,
      providerCallsPerScenario: input.providerCalls / input.scenarios,
      assertions: input.assertions ?? 36,
      filesVerified: input.filesVerified ?? 4,
      toolEfficiency: {
        toolCallCount: input.toolCallCount ?? 42,
        uniqueToolCount: input.uniqueToolCount ?? 12,
        toolCallsPerScenario: (input.toolCallCount ?? 42) / input.scenarios,
        topTools: [
          { name: "FilePatch", count: 5 },
          { name: "ToolSearch", count: 5 }
        ]
      },
      regressions
    },
    scenarios: []
  };
}

function modelTaskReport(
  overrides: Partial<{
    scenarios: number;
    providerCalls: number;
    assertions: number;
    filesVerified: number;
    toolCallCount: number;
    uniqueToolCount: number;
    taskClasses: string[];
    patchStrategy: {
      filePatchCalls: number;
      fileEditCalls: number;
      fileWriteCalls: number;
      patchUsageRate: number;
    };
    regressions: number;
  }> = {}
): Record<string, unknown> {
  const taskClasses = overrides.taskClasses ?? [
    "project_edit",
    "memory_driven",
    "tool_discovery",
    "cross_file_verified_edit",
    "patch_strategy",
    "test_driven_recovery"
  ];
  const patchStrategy = overrides.patchStrategy ?? {
    filePatchCalls: 1,
    fileEditCalls: 1,
    fileWriteCalls: 0,
    patchUsageRate: 0.5
  };
  const total = overrides.scenarios ?? taskClasses.length;
  const report = harnessReport({
    name: "model-task-benchmark",
    scenarios: total,
    providerCalls: overrides.providerCalls ?? 14,
    assertions: overrides.assertions ?? 26,
    filesVerified: overrides.filesVerified ?? 10,
    toolCallCount: overrides.toolCallCount ?? 22,
    uniqueToolCount: overrides.uniqueToolCount ?? 6,
    regressions: overrides.regressions ?? 0
  });
  return {
    ...report,
    scenarios: Array.from({ length: total }, (_, index) => ({
      name: `${taskClasses[index] ?? "missing"} task`,
      status: "passed",
      durationMs: 300,
      score: 1,
      failureKind: null,
      details: {
        taskClass: taskClasses[index],
        provider: { callCount: 2 },
        ...(taskClasses[index] === "patch_strategy"
          ? {
              toolCounts: {
                FilePatch: patchStrategy.filePatchCalls,
                FileEdit: patchStrategy.fileEditCalls,
                FileWrite: patchStrategy.fileWriteCalls
              },
              patchUsageRate: patchStrategy.patchUsageRate
            }
          : {})
      }
    }))
  };
}

function memoryReport(input: {
  failed: number;
  thresholdPassed: boolean;
  score: number;
  maintenanceRecallSeen?: boolean;
  workflowGraphRecallSeen?: boolean;
  conflictGroupViewSeen?: boolean;
  dreamConflictGroupLifecycleSeen?: boolean;
  naturalLanguageCorrectionSeen?: boolean;
  graphEdgeReinforcementSeen?: boolean;
  userFeedbackTrendSeen?: boolean;
  assertions?: number;
  filesVerified?: number;
}): Record<string, unknown> {
  const names = [
    "linked workflow retrieves project neighbor",
    ...(input.workflowGraphRecallSeen === false ? [] : ["workflow graph recalls second-hop habit"]),
    "corrected preference replaces stale memory",
    "durable user identity survives graph recall",
    ...(input.maintenanceRecallSeen === false ? [] : ["protected workflow survives maintenance"])
  ];
  const total = names.length;
  const results = [...names.map((name) => ({ name, passed: true }))];
  return {
    version: 1,
    name: "memory business recall",
    total,
    passed: total - input.failed,
    failed: input.failed,
    score: input.score,
    minScore: 1,
    thresholdPassed: input.thresholdPassed,
    results,
    details: {
      assertions: [
        ...(input.naturalLanguageCorrectionSeen === false
          ? []
          : [
              "natural-language correction disputed stale memory",
              "natural-language correction recalled replacement only",
              "natural-language correction persisted agent audit"
            ]),
        ...(input.graphEdgeReinforcementSeen === false
          ? []
          : ["memory graph recall reinforced traversed edges"]),
        ...(input.userFeedbackTrendSeen === false
          ? []
          : [
              "user feedback increased useful memory weight",
              "user feedback persisted memory trend metadata",
              "user feedback trend view rendered useful memory"
            ]),
        ...Array.from(
          { length: input.assertions ?? 16 },
          (_, index) => `memory assertion ${index + 1}`
        )
      ],
      filesVerified: Array.from(
        { length: input.filesVerified ?? 5 },
        (_, index) => `memory-file-${index + 1}.json`
      ),
      conflictGroupViewSeen: input.conflictGroupViewSeen !== false,
      dreamConflictGroupLifecycleSeen: input.dreamConflictGroupLifecycleSeen !== false
    }
  };
}

function patchReport(input: {
  filePatchCalls: number;
  fileEditCalls: number;
  fileWriteCalls: number;
  recoverySeen: boolean;
  recoveryScenarioCount?: number;
  multiFileRecoverySeen?: boolean;
  toolSearchRankedFilePatch: boolean;
  approvalDiffPreviewSeen: boolean;
  patchUsageRate: number;
}): Record<string, unknown> {
  const scenarioCount = input.multiFileRecoverySeen === false ? 1 : 2;
  return {
    ...harnessReport({ name: "patch-engine-eval", scenarios: scenarioCount, providerCalls: 5 }),
    details: {
      filePatchCalls: input.filePatchCalls,
      fileEditCalls: input.fileEditCalls,
      fileWriteCalls: input.fileWriteCalls,
      patchUsageRate: input.patchUsageRate,
      recoveryScenarioCount:
        input.recoveryScenarioCount ??
        (input.recoverySeen && input.multiFileRecoverySeen !== false ? 2 : 0),
      multiFileRecoverySeen: input.multiFileRecoverySeen !== false,
      toolSearchRankedFilePatch: input.toolSearchRankedFilePatch,
      approvalDiffPreviewSeen: input.approvalDiffPreviewSeen
    },
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
          toolSearchRankedFilePatch: input.toolSearchRankedFilePatch,
          approvalDiffPreviewSeen: input.approvalDiffPreviewSeen
        }
      },
      ...(input.multiFileRecoverySeen === false
        ? []
        : [
            {
              name: "multi-file patch recovery workflow",
              status: "passed",
              durationMs: 300,
              score: 1,
              failureKind: null,
              details: {
                provider: { callCount: 3 },
                toolCounts: {
                  FilePatch: Math.max(0, input.filePatchCalls - 2),
                  FileWrite: input.fileWriteCalls
                },
                patchUsageRate: input.patchUsageRate,
                multiFileRecoverySeen: true
              }
            }
          ])
    ]
  };
}

function goalPlanReport(
  overrides: Partial<{
    activeGoalContextSeen: boolean;
    completedGoalSuppressed: boolean;
    blockedGoalSuppressed: boolean;
    writeDeniedInPlanMode: boolean;
    planSubmittedToModel: boolean;
    planReviewPersisted: boolean;
    crossSessionPlanReviewListed: boolean;
    planRevisionFeedbackSeen: boolean;
    planRevisionPersisted: boolean;
    planApprovalSeen: boolean;
    planApprovalPersisted: boolean;
    planRevisionChainLinked: boolean;
    planRevisionChainViewListed: boolean;
    inheritedPlanContextSeen: boolean;
    inheritedPlanExecutionFollowed: boolean;
    inheritedPlanDeviationCorrected: boolean;
    crossSessionPlanAdopted: boolean;
    crossSessionAdoptedPlanContextSeen: boolean;
    blockedGoalPersisted: boolean;
    goalCompleted: boolean;
    assertions: number;
    filesVerified: number;
    toolCallCount: number;
    uniqueToolCount: number;
  }> = {}
): Record<string, unknown> {
  return {
    ...harnessReport({
      name: "goal-plan-eval",
      scenarios: 1,
      providerCalls: 5,
      assertions: overrides.assertions ?? 22,
      filesVerified: overrides.filesVerified ?? 4,
      toolCallCount: overrides.toolCallCount ?? 7,
      uniqueToolCount: overrides.uniqueToolCount ?? 3
    }),
    scenarios: [
      {
        name: "goal-plan lifecycle workflow",
        status: "passed",
        durationMs: 300,
        score: 1,
        failureKind: null,
        details: {
          provider: { callCount: 5 },
          assertions: Array.from(
            { length: overrides.assertions ?? 22 },
            (_, index) => `goal-plan assertion ${index + 1}`
          ),
          filesVerified: Array.from(
            { length: overrides.filesVerified ?? 4 },
            (_, index) => `goal-plan-file-${index + 1}.json`
          ),
          toolCounts: {
            FileWrite: 3,
            ExitPlanMode: 3,
            FileRead: 1
          },
          activeGoalContextSeen: true,
          completedGoalSuppressed: true,
          blockedGoalSuppressed: true,
          writeDeniedInPlanMode: true,
          planSubmittedToModel: true,
          planReviewPersisted: true,
          crossSessionPlanReviewListed: true,
          planRevisionFeedbackSeen: true,
          planRevisionPersisted: true,
          planApprovalSeen: true,
          planApprovalPersisted: true,
          planRevisionChainLinked: true,
          planRevisionChainViewListed: true,
          inheritedPlanContextSeen: true,
          inheritedPlanExecutionFollowed: true,
          inheritedPlanDeviationCorrected: true,
          crossSessionPlanAdopted: true,
          crossSessionAdoptedPlanContextSeen: true,
          blockedGoalPersisted: true,
          goalCompleted: true,
          ...overrides
        }
      }
    ]
  };
}

function toolDiscoveryReport(
  overrides: Partial<{
    coreToolsExposed: boolean;
    deferredToolsHidden: boolean;
    fileEditIntentRankedFilePatch: boolean;
    browserAutomationRankedBrowser: boolean;
    learningDraftRevealed: boolean;
    feedbackResultsReturned: boolean;
    feedbackRankingUsedUsage: boolean;
    intentScopedUsageRecorded: boolean;
    failureKindRecorded: boolean;
    failureKindShownInRanking: boolean;
    failureRecoverySuggested: boolean;
    crossTaskRecoveryRankingSeen: boolean;
    crossTaskRecoveryGuidanceSeen: boolean;
    crossTaskIntentScopedRankingSeen: boolean;
    crossTaskUnrelatedIntentIsolated: boolean;
    crossTaskProviderCalls: number;
    longCycleProviderCalls: number;
    initialToolCount: number;
    revealedToolCount: number;
    grepFailures: number;
    globSuccesses: number;
    grepIntentFailures: number;
    globIntentSuccesses: number;
    grepPathFailures: number;
    grepIntentPathFailures: number;
    assertions: number;
    filesVerified: number;
    toolCallCount: number;
    uniqueToolCount: number;
  }> = {}
): Record<string, unknown> {
  return {
    ...harnessReport({
      name: "tool-discovery-eval",
      scenarios: 1,
      providerCalls: 4,
      assertions: overrides.assertions ?? 16,
      filesVerified: overrides.filesVerified ?? 1,
      toolCallCount: overrides.toolCallCount ?? 16,
      uniqueToolCount: overrides.uniqueToolCount ?? 3
    }),
    scenarios: [
      {
        name: "tool discovery ranking and feedback workflow",
        status: "passed",
        durationMs: 300,
        score: 1,
        failureKind: null,
        details: {
          provider: { callCount: 4 },
          assertions: Array.from(
            { length: overrides.assertions ?? 16 },
            (_, index) => `tool-discovery assertion ${index + 1}`
          ),
          filesVerified: Array.from(
            { length: overrides.filesVerified ?? 1 },
            (_, index) => `tool-discovery-file-${index + 1}.json`
          ),
          toolCounts: {
            ToolSearch: 8,
            Grep: 4,
            Glob: 4
          },
          coreToolsExposed: true,
          deferredToolsHidden: true,
          fileEditIntentRankedFilePatch: true,
          browserAutomationRankedBrowser: true,
          learningDraftRevealed: true,
          feedbackResultsReturned: true,
          feedbackRankingUsedUsage: true,
          intentScopedUsageRecorded: true,
          failureKindRecorded: true,
          failureKindShownInRanking: true,
          failureRecoverySuggested: true,
          crossTaskRecoveryRankingSeen: true,
          crossTaskRecoveryGuidanceSeen: true,
          crossTaskIntentScopedRankingSeen: true,
          crossTaskUnrelatedIntentIsolated: true,
          crossTaskProviderCalls: 2,
          longCycleProviderCalls: 2,
          initialToolCount: 21,
          revealedToolCount: 22,
          grepFailures: 4,
          globSuccesses: 4,
          grepIntentFailures: 4,
          globIntentSuccesses: 4,
          grepPathFailures: 4,
          grepIntentPathFailures: 4,
          ...overrides
        }
      }
    ]
  };
}

function controlApiReport(
  overrides: Partial<{
    controlServeStarted: boolean;
    pairingSucceeded: boolean;
    pairingUrlGenerated: boolean;
    pairingUrlTokenHandoffSeen: boolean;
    mdnsPeerDiscovered: boolean;
    approvalSseSeen: boolean;
    approvalResolved: boolean;
    approvalFileWritten: boolean;
    backgroundJobCompleted: boolean;
    approvalAuditPersisted: boolean;
    streamDeltaSeen: boolean;
    jobCancelRequested: boolean;
    jobCancelled: boolean;
    queryCancelledAuditPersisted: boolean;
    approvalCancelResolved: boolean;
    cancelledApprovalDidNotWrite: boolean;
    approvalCancelledAuditPersisted: boolean;
    sessionCreatedForResume: boolean;
    panelPayloadAccepted: boolean;
    resumedSessionContextSeen: boolean;
    resumedSessionMessagesPersisted: boolean;
    panelHtmlServed: boolean;
    panelClientContractValid: boolean;
    panelUiApprovalControlsSeen: boolean;
    panelUiCancelControlSeen: boolean;
    panelClientCreateSessionUnwrapped: boolean;
    panelClientStartJobAccepted: boolean;
    panelSseJobStreamSeen: boolean;
    mobileBrowserViewportSeen: boolean;
    mobileBrowserTokenStored: boolean;
    mobileBrowserTokenUrlCleaned: boolean;
    mobileBrowserMessageSent: boolean;
    mobileBrowserStreamRendered: boolean;
    mobileBrowserCancelRequested: boolean;
    mobileBrowserCancelRendered: boolean;
    peerCredentialsSaved: boolean;
    peerSavedListed: boolean;
    peerAgentToolSearched: boolean;
    peerAgentSchemaRevealed: boolean;
    peerAgentDispatched: boolean;
    peerDispatchSingleAgentCall: boolean;
    peerDispatchCompleted: boolean;
    peerDispatchResultReturned: boolean;
    peerRemoteSessionCreated: boolean;
    peerRemoteJobCompleted: boolean;
    peerDispatchAuditPersisted: boolean;
    assertions: number;
    filesVerified: number;
    toolCallCount: number;
    uniqueToolCount: number;
  }> = {}
): Record<string, unknown> {
  return {
    ...harnessReport({
      name: "control-api-eval",
      scenarios: 1,
      providerCalls: 5,
      assertions: overrides.assertions ?? 38,
      filesVerified: overrides.filesVerified ?? 7,
      toolCallCount: overrides.toolCallCount ?? 4,
      uniqueToolCount: overrides.uniqueToolCount ?? 3
    }),
    scenarios: [
      {
        name: "mobile control approval, stream, and cancel workflow",
        status: "passed",
        durationMs: 300,
        score: 1,
        failureKind: null,
        details: {
          provider: { callCount: 5 },
          assertions: Array.from(
            { length: overrides.assertions ?? 38 },
            (_, index) => `control-api assertion ${index + 1}`
          ),
          filesVerified: Array.from(
            { length: overrides.filesVerified ?? 7 },
            (_, index) => `control-api-file-${index + 1}.json`
          ),
          toolCounts: {
            FileWrite: 2,
            ToolSearch: 1,
            Agent: 1
          },
          controlServeStarted: true,
          pairingSucceeded: true,
          pairingUrlGenerated: true,
          pairingUrlTokenHandoffSeen: true,
          mdnsPeerDiscovered: true,
          approvalSseSeen: true,
          approvalResolved: true,
          approvalFileWritten: true,
          backgroundJobCompleted: true,
          approvalAuditPersisted: true,
          streamDeltaSeen: true,
          jobCancelRequested: true,
          jobCancelled: true,
          queryCancelledAuditPersisted: true,
          approvalCancelResolved: true,
          cancelledApprovalDidNotWrite: true,
          approvalCancelledAuditPersisted: true,
          sessionCreatedForResume: true,
          panelPayloadAccepted: true,
          resumedSessionContextSeen: true,
          resumedSessionMessagesPersisted: true,
          panelHtmlServed: true,
          panelClientContractValid: true,
          panelUiApprovalControlsSeen: true,
          panelUiCancelControlSeen: true,
          panelClientCreateSessionUnwrapped: true,
          panelClientStartJobAccepted: true,
          panelSseJobStreamSeen: true,
          mobileBrowserViewportSeen: true,
          mobileBrowserTokenStored: true,
          mobileBrowserTokenUrlCleaned: true,
          mobileBrowserMessageSent: true,
          mobileBrowserStreamRendered: true,
          mobileBrowserCancelRequested: true,
          mobileBrowserCancelRendered: true,
          peerCredentialsSaved: true,
          peerSavedListed: true,
          peerAgentToolSearched: true,
          peerAgentSchemaRevealed: true,
          peerAgentDispatched: true,
          peerDispatchSingleAgentCall: true,
          peerDispatchCompleted: true,
          peerDispatchResultReturned: true,
          peerRemoteSessionCreated: true,
          peerRemoteJobCompleted: true,
          peerDispatchAuditPersisted: true,
          ...overrides
        }
      }
    ]
  };
}
