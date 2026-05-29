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
        filePatchCalls: 10,
        fileEditCalls: 1,
        fileWriteCalls: 0,
        recoverySeen: true,
        conflictExplanationSeen: true,
        rollbackVerified: true,
        toolSearchRankedFilePatch: true,
        approvalDiffPreviewSeen: true,
        patchUsageRate: 10 / 11
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
        conflictExplanationSeen: false,
        rollbackVerified: false,
        finalDiffQualityVerified: false,
        unrelatedFilePreserved: false,
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
        "FilePatch calls < 10",
        "FileWrite used",
        "recoveryScenarioCount=1",
        "multiFileRecoverySeen=false",
        "conflictExplanationSeen=false",
        "rollbackVerified=false",
        "finalDiffQualityVerified=false",
        "unrelatedFilePreserved=false",
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
        filePatchCalls: 10,
        fileEditCalls: 1,
        fileWriteCalls: 0,
        recoverySeen: true,
        conflictExplanationSeen: true,
        rollbackVerified: true,
        toolSearchRankedFilePatch: true,
        approvalDiffPreviewSeen: true,
        patchUsageRate: 10 / 11
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
        longCycleFeedbackTrendSeen: false,
        crossNodeRecommendationSeen: false,
        projectCaseRecallSeen: false,
        multiProjectConflictRecallSeen: false,
        multiNodeSupersededCleanupSeen: false,
        maintenanceConfigBoundarySeen: false,
        assertions: 4,
        filesVerified: 1
      }),
      patch: patchReport({
        filePatchCalls: 10,
        fileEditCalls: 1,
        fileWriteCalls: 0,
        recoverySeen: true,
        toolSearchRankedFilePatch: true,
        approvalDiffPreviewSeen: true,
        patchUsageRate: 10 / 11
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
    expect(output).toContain("longCycleFeedbackTrendSeen=false");
    expect(output).toContain("crossNodeRecommendationSeen=false");
    expect(output).toContain("projectCaseRecallSeen=false");
    expect(output).toContain("multiProjectConflictRecallSeen=false");
    expect(output).toContain("multiNodeSupersededCleanupSeen=false");
    expect(output).toContain("maintenanceConfigBoundarySeen=false");
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
        filePatchCalls: 10,
        fileEditCalls: 1,
        fileWriteCalls: 0,
        recoverySeen: true,
        toolSearchRankedFilePatch: true,
        approvalDiffPreviewSeen: true,
        patchUsageRate: 10 / 11
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
        "dependencyRefactorTask=false",
        "continuousPatchRecoveryTask=false",
        "apiMigrationTask=false",
        "monorepoGeneratedBoundaryTask=false",
        "patchStrategyFilePatchCalls < 1",
        "patchStrategyFileEditCalls != 1",
        "patchStrategyRate=0",
        "continuousPatchFailedAttempts < 2",
        "continuousPatchFilePatchCalls < 3",
        "continuousPatchFileReadCalls < 2",
        "continuousPatchBashCalls != 2",
        "reReadAfterRepeatedPatchFailures=false",
        "finalDiffQualityVerified=false",
        "unrelatedFileUnchanged=false",
        "apiMigrationBashCalls != 2",
        "apiMigrationToolSearchCalls != 1",
        "apiMigrationFileMoveCalls != 1",
        "apiMigrationFilePatchCalls < 3",
        "fileMoveRevealed=false",
        "movedFileVerified=false",
        "oldPathRemoved=false",
        "batchApiMigrationVerified=false",
        "monorepoGeneratedBoundaryBashCalls != 2",
        "monorepoGeneratedBoundaryToolSearchCalls != 1",
        "monorepoGeneratedBoundaryFileMoveCalls != 1",
        "monorepoGeneratedBoundaryFilePatchCalls < 3",
        "monorepoGeneratedBoundaryFileMoveRevealed=false",
        "sourcePackageMoved=false",
        "oldSourcePackagePathRemoved=false",
        "generatedFileUntouched=false",
        "monorepoPackageMigrationVerified=false",
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
        filePatchCalls: 10,
        fileEditCalls: 1,
        fileWriteCalls: 0,
        recoverySeen: true,
        toolSearchRankedFilePatch: true,
        approvalDiffPreviewSeen: true,
        patchUsageRate: 10 / 11
      }),
      goalPlan: goalPlanReport({
        completedGoalSuppressed: false,
        blockedGoalPersisted: false,
        planReviewPersisted: false,
        crossSessionPlanReviewListed: false,
        planRevisionFeedbackSeen: false,
        planRevisionPersisted: false,
        multiRoundPlanFeedbackSeen: false,
        secondPlanRevisionPersisted: false,
        planApprovalSeen: false,
        planApprovalPersisted: false,
        planRevisionChainLinked: false,
        planRevisionChainViewListed: false,
        inheritedPlanContextSeen: false,
        inheritedPlanExecutionFollowed: false,
        inheritedPlanDeviationCorrected: false,
        repeatedPlanDeviationBlocked: false,
        multiStepPlanDeviationRecovered: false,
        migrationPlanExecutionVerified: false,
        crossSessionPlanAdopted: false,
        crossSessionAdoptedPlanContextSeen: false,
        parallelPlanIsolationSeen: false,
        parallelPlanConflictRejected: false,
        parallelPlanAdoptedExplicitly: false,
        mergedPlanCreated: false,
        mergedPlanContextSeen: false,
        conflictedMergeNeedsRevision: false,
        conflictedMergeContextSeen: false,
        conflictedMergeResolved: false,
        resolvedMergeContextSeen: false,
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
        "multiRoundPlanFeedbackSeen=false",
        "secondPlanRevisionPersisted=false",
        "planApprovalSeen=false",
        "planApprovalPersisted=false",
        "planRevisionChainLinked=false",
        "planRevisionChainViewListed=false",
        "inheritedPlanContextSeen=false",
        "inheritedPlanExecutionFollowed=false",
        "inheritedPlanDeviationCorrected=false",
        "repeatedPlanDeviationBlocked=false",
        "multiStepPlanDeviationRecovered=false",
        "migrationPlanExecutionVerified=false",
        "crossSessionPlanAdopted=false",
        "crossSessionAdoptedPlanContextSeen=false",
        "parallelPlanIsolationSeen=false",
        "parallelPlanConflictRejected=false",
        "parallelPlanAdoptedExplicitly=false",
        "mergedPlanCreated=false",
        "mergedPlanContextSeen=false",
        "conflictedMergeNeedsRevision=false",
        "conflictedMergeContextSeen=false",
        "conflictedMergeResolved=false",
        "resolvedMergeContextSeen=false"
      ])
    );
  });

  it("fails tool discovery alignment when reveal or usage feedback evidence is incomplete", () => {
    const report = buildCapabilityReport({
      blackbox: harnessReport({ name: "blackbox-e2e", scenarios: 9, providerCalls: 118 }),
      modelTasks: modelTaskReport(),
      memory: memoryReport({ failed: 0, thresholdPassed: true, score: 1 }),
      patch: patchReport({
        filePatchCalls: 10,
        fileEditCalls: 1,
        fileWriteCalls: 0,
        recoverySeen: true,
        toolSearchRankedFilePatch: true,
        approvalDiffPreviewSeen: true,
        patchUsageRate: 10 / 11
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
        longCycleWorkspaceNoiseInjected: false,
        longCycleRepeatedWorkspaceStable: false,
        longCycleRepeatedBrowserStable: false,
        longCycleRepeatedFileEditStable: false,
        longCycleRepeatedMemoryCorrectStable: false,
        longCycleRepeatedMemoryRecallStable: false,
        longCycleRepeatedSkillStable: false,
        longCycleRepeatedAgentStable: false,
        longCycleStrategyDriftStable: false,
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
        "longCycleWorkspaceNoiseInjected=false",
        "longCycleRepeatedWorkspaceStable=false",
        "longCycleRepeatedBrowserStable=false",
        "longCycleRepeatedFileEditStable=false",
        "longCycleRepeatedMemoryCorrectStable=false",
        "longCycleRepeatedMemoryRecallStable=false",
        "longCycleRepeatedSkillStable=false",
        "longCycleRepeatedAgentStable=false",
        "longCycleStrategyDriftStable=false",
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
        filePatchCalls: 10,
        fileEditCalls: 1,
        fileWriteCalls: 0,
        recoverySeen: true,
        toolSearchRankedFilePatch: true,
        approvalDiffPreviewSeen: true,
        patchUsageRate: 10 / 11
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
        lanSmokeBoundAllInterfaces: false,
        lanSmokeHealthSeen: false,
        lanSmokePanelLoaded: false,
        lanSmokeAuthenticatedApiSeen: false,
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
        peerRemotePermissionModeInherited: false,
        peerRemoteFileWritten: false,
        peerLocalFileNotWritten: false,
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
        "lanSmokeBoundAllInterfaces=false",
        "lanSmokeHealthSeen=false",
        "lanSmokePanelLoaded=false",
        "lanSmokeAuthenticatedApiSeen=false",
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
        "peerRemotePermissionModeInherited=false",
        "peerRemoteFileWritten=false",
        "peerLocalFileNotWritten=false",
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
    continuousPatchRecovery: {
      failedPatchAttempts: number;
      filePatchCalls: number;
      fileReadCalls: number;
      bashCalls: number;
      fileWriteCalls: number;
      fileEditCalls: number;
      reReadAfterRepeatedPatchFailures: boolean;
      finalDiffQualityVerified: boolean;
      unrelatedFileUnchanged: boolean;
    };
    apiMigration: {
      bashCalls: number;
      toolSearchCalls: number;
      fileMoveCalls: number;
      filePatchCalls: number;
      fileWriteCalls: number;
      fileMoveRevealed: boolean;
      movedFileVerified: boolean;
      oldPathRemoved: boolean;
      batchApiMigrationVerified: boolean;
    };
    monorepoGeneratedBoundary: {
      bashCalls: number;
      toolSearchCalls: number;
      fileMoveCalls: number;
      filePatchCalls: number;
      fileWriteCalls: number;
      fileEditCalls: number;
      fileMoveRevealed: boolean;
      sourcePackageMoved: boolean;
      oldSourcePackagePathRemoved: boolean;
      generatedFileUntouched: boolean;
      monorepoPackageMigrationVerified: boolean;
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
    "dependency_refactor",
    "test_driven_recovery",
    "continuous_patch_recovery",
    "api_migration",
    "monorepo_generated_boundary"
  ];
  const patchStrategy = overrides.patchStrategy ?? {
    filePatchCalls: 1,
    fileEditCalls: 1,
    fileWriteCalls: 0,
    patchUsageRate: 0.5
  };
  const continuousPatchRecovery = overrides.continuousPatchRecovery ?? {
    failedPatchAttempts: 2,
    filePatchCalls: 3,
    fileReadCalls: 2,
    bashCalls: 2,
    fileWriteCalls: 0,
    fileEditCalls: 0,
    reReadAfterRepeatedPatchFailures: true,
    finalDiffQualityVerified: true,
    unrelatedFileUnchanged: true
  };
  const apiMigration = overrides.apiMigration ?? {
    bashCalls: 2,
    toolSearchCalls: 1,
    fileMoveCalls: 1,
    filePatchCalls: 3,
    fileWriteCalls: 0,
    fileMoveRevealed: true,
    movedFileVerified: true,
    oldPathRemoved: true,
    batchApiMigrationVerified: true
  };
  const monorepoGeneratedBoundary = overrides.monorepoGeneratedBoundary ?? {
    bashCalls: 2,
    toolSearchCalls: 1,
    fileMoveCalls: 1,
    filePatchCalls: 3,
    fileWriteCalls: 0,
    fileEditCalls: 0,
    fileMoveRevealed: true,
    sourcePackageMoved: true,
    oldSourcePackagePathRemoved: true,
    generatedFileUntouched: true,
    monorepoPackageMigrationVerified: true
  };
  const total = overrides.scenarios ?? taskClasses.length;
  const report = harnessReport({
    name: "model-task-benchmark",
    scenarios: total,
    providerCalls: overrides.providerCalls ?? 14,
    assertions: overrides.assertions ?? 64,
    filesVerified: overrides.filesVerified ?? 25,
    toolCallCount: overrides.toolCallCount ?? 60,
    uniqueToolCount: overrides.uniqueToolCount ?? 9,
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
          : {}),
        ...(taskClasses[index] === "continuous_patch_recovery"
          ? {
              toolCounts: {
                FilePatch: continuousPatchRecovery.filePatchCalls,
                FileRead: continuousPatchRecovery.fileReadCalls,
                Bash: continuousPatchRecovery.bashCalls,
                FileWrite: continuousPatchRecovery.fileWriteCalls,
                FileEdit: continuousPatchRecovery.fileEditCalls
              },
              failedPatchAttempts: continuousPatchRecovery.failedPatchAttempts,
              reReadAfterRepeatedPatchFailures:
                continuousPatchRecovery.reReadAfterRepeatedPatchFailures,
              finalDiffQualityVerified: continuousPatchRecovery.finalDiffQualityVerified,
              unrelatedFileUnchanged: continuousPatchRecovery.unrelatedFileUnchanged
            }
          : {}),
        ...(taskClasses[index] === "api_migration"
          ? {
              toolCounts: {
                Bash: apiMigration.bashCalls,
                ToolSearch: apiMigration.toolSearchCalls,
                FileMove: apiMigration.fileMoveCalls,
                FilePatch: apiMigration.filePatchCalls,
                FileWrite: apiMigration.fileWriteCalls
              },
              fileMoveRevealed: apiMigration.fileMoveRevealed,
              movedFileVerified: apiMigration.movedFileVerified,
              oldPathRemoved: apiMigration.oldPathRemoved,
              batchApiMigrationVerified: apiMigration.batchApiMigrationVerified
            }
          : {}),
        ...(taskClasses[index] === "monorepo_generated_boundary"
          ? {
              toolCounts: {
                Bash: monorepoGeneratedBoundary.bashCalls,
                ToolSearch: monorepoGeneratedBoundary.toolSearchCalls,
                FileMove: monorepoGeneratedBoundary.fileMoveCalls,
                FilePatch: monorepoGeneratedBoundary.filePatchCalls,
                FileWrite: monorepoGeneratedBoundary.fileWriteCalls,
                FileEdit: monorepoGeneratedBoundary.fileEditCalls
              },
              fileMoveRevealed: monorepoGeneratedBoundary.fileMoveRevealed,
              sourcePackageMoved: monorepoGeneratedBoundary.sourcePackageMoved,
              oldSourcePackagePathRemoved: monorepoGeneratedBoundary.oldSourcePackagePathRemoved,
              generatedFileUntouched: monorepoGeneratedBoundary.generatedFileUntouched,
              monorepoPackageMigrationVerified:
                monorepoGeneratedBoundary.monorepoPackageMigrationVerified
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
  longCycleFeedbackTrendSeen?: boolean;
  crossNodeRecommendationSeen?: boolean;
  projectCaseRecallSeen?: boolean;
  multiProjectConflictRecallSeen?: boolean;
  multiNodeSupersededCleanupSeen?: boolean;
  maintenanceConfigBoundarySeen?: boolean;
  assertions?: number;
  filesVerified?: number;
}): Record<string, unknown> {
  const names = [
    "linked workflow retrieves project neighbor",
    ...(input.workflowGraphRecallSeen === false ? [] : ["workflow graph recalls second-hop habit"]),
    "corrected preference replaces stale memory",
    "durable user identity survives graph recall",
    ...(input.maintenanceRecallSeen === false ? [] : ["protected workflow survives maintenance"]),
    ...(input.crossNodeRecommendationSeen === false
      ? []
      : ["feedback trend recalls workflow neighborhood"]),
    ...(input.multiProjectConflictRecallSeen === false
      ? []
      : [
          "multi-project Magi release rule wins in Magi context",
          "multi-project Kira support rule wins in Kira context"
        ])
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
        ...(input.longCycleFeedbackTrendSeen === false
          ? []
          : [
              "long-cycle feedback trend persisted across CLI process",
              "long-cycle feedback trend recalled hot workflow"
            ]),
        ...(input.crossNodeRecommendationSeen === false
          ? []
          : ["cross-node workflow recommendation surfaced related habit"]),
        ...(input.projectCaseRecallSeen === false
          ? []
          : [
              "project-level release owner recall passed",
              "project-level incident handoff recall passed"
            ]),
        ...(input.multiProjectConflictRecallSeen === false
          ? []
          : [
              "multi-project wiki sources indexed into sqlite",
              "multi-project conflict edges linked project rules",
              "multi-project Magi rule recalled without Kira rule",
              "multi-project Kira rule recalled without Magi rule",
              "shared user preference recalled across project rules"
            ]),
        ...(input.multiNodeSupersededCleanupSeen === false
          ? []
          : [
              "multi-node superseded cleanup candidates listed disputed nodes",
              "Dream multi-node cleanup archived superseded project nodes",
              "post-cleanup project recall excluded archived superseded nodes"
            ]),
        ...(input.maintenanceConfigBoundarySeen === false
          ? []
          : [
              "maintenance config boundary values were clamped",
              "maintenance config invalid values were rejected"
            ]),
        ...Array.from(
          { length: input.assertions ?? 40 },
          (_, index) => `memory assertion ${index + 1}`
        )
      ],
      filesVerified: Array.from(
        { length: input.filesVerified ?? 7 },
        (_, index) => `memory-file-${index + 1}.json`
      ),
      conflictGroupViewSeen: input.conflictGroupViewSeen !== false,
      dreamConflictGroupLifecycleSeen: input.dreamConflictGroupLifecycleSeen !== false,
      longCycleFeedbackTrendSeen: input.longCycleFeedbackTrendSeen !== false,
      crossNodeRecommendationSeen: input.crossNodeRecommendationSeen !== false,
      projectCaseRecallSeen: input.projectCaseRecallSeen !== false,
      multiProjectConflictRecallSeen: input.multiProjectConflictRecallSeen !== false,
      multiNodeSupersededCleanupSeen: input.multiNodeSupersededCleanupSeen !== false,
      maintenanceConfigBoundarySeen: input.maintenanceConfigBoundarySeen !== false
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
  conflictExplanationSeen?: boolean;
  rollbackVerified?: boolean;
  finalDiffQualityVerified?: boolean;
  unrelatedFilePreserved?: boolean;
  toolSearchRankedFilePatch: boolean;
  approvalDiffPreviewSeen: boolean;
  patchUsageRate: number;
}): Record<string, unknown> {
  const scenarioCount = input.multiFileRecoverySeen === false ? 1 : 4;
  const conflictExplanationSeen = input.conflictExplanationSeen !== false;
  const rollbackVerified = input.rollbackVerified !== false;
  const finalDiffQualityVerified = input.finalDiffQualityVerified !== false;
  const unrelatedFilePreserved = input.unrelatedFilePreserved !== false;
  return {
    ...harnessReport({ name: "patch-engine-eval", scenarios: scenarioCount, providerCalls: 5 }),
    details: {
      filePatchCalls: input.filePatchCalls,
      fileEditCalls: input.fileEditCalls,
      fileWriteCalls: input.fileWriteCalls,
      patchUsageRate: input.patchUsageRate,
      recoveryScenarioCount:
        input.recoveryScenarioCount ??
        (input.recoverySeen && input.multiFileRecoverySeen !== false ? 4 : 0),
      multiFileRecoverySeen: input.multiFileRecoverySeen !== false,
      conflictExplanationSeen,
      rollbackVerified,
      finalDiffQualityVerified,
      unrelatedFilePreserved,
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
          ]),
      ...(input.multiFileRecoverySeen === false
        ? []
        : [
            {
              name: "patch conflict explanation workflow",
              status: "passed",
              durationMs: 300,
              score: 1,
              failureKind: null,
              details: {
                provider: { callCount: 3 },
                toolCounts: {
                  FilePatch: 1,
                  FileWrite: input.fileWriteCalls
                },
                patchUsageRate: input.patchUsageRate,
                recoverySeen: input.recoverySeen,
                conflictExplanationSeen,
                rollbackVerified
              }
            }
          ]),
      ...(input.multiFileRecoverySeen === false
        ? []
        : [
            {
              name: "patch rollback final diff quality workflow",
              status: "passed",
              durationMs: 300,
              score: 1,
              failureKind: null,
              details: {
                provider: { callCount: 4 },
                toolCounts: {
                  FilePatch: 3,
                  FileWrite: input.fileWriteCalls
                },
                patchUsageRate: input.patchUsageRate,
                recoverySeen: input.recoverySeen,
                finalDiffQualityVerified,
                unrelatedFilePreserved
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
    multiRoundPlanFeedbackSeen: boolean;
    secondPlanRevisionPersisted: boolean;
    planApprovalSeen: boolean;
    planApprovalPersisted: boolean;
    planRevisionChainLinked: boolean;
    planRevisionChainViewListed: boolean;
    inheritedPlanContextSeen: boolean;
    inheritedPlanExecutionFollowed: boolean;
    inheritedPlanDeviationCorrected: boolean;
    repeatedPlanDeviationBlocked: boolean;
    multiStepPlanDeviationRecovered: boolean;
    migrationPlanExecutionVerified: boolean;
    crossSessionPlanAdopted: boolean;
    crossSessionAdoptedPlanContextSeen: boolean;
    parallelPlanIsolationSeen: boolean;
    parallelPlanConflictRejected: boolean;
    parallelPlanAdoptedExplicitly: boolean;
    mergedPlanCreated: boolean;
    mergedPlanContextSeen: boolean;
    conflictedMergeNeedsRevision: boolean;
    conflictedMergeContextSeen: boolean;
    conflictedMergeResolved: boolean;
    resolvedMergeContextSeen: boolean;
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
      assertions: overrides.assertions ?? 36,
      filesVerified: overrides.filesVerified ?? 4,
      toolCallCount: overrides.toolCallCount ?? 10,
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
            { length: overrides.assertions ?? 36 },
            (_, index) => `goal-plan assertion ${index + 1}`
          ),
          filesVerified: Array.from(
            { length: overrides.filesVerified ?? 4 },
            (_, index) => `goal-plan-file-${index + 1}.json`
          ),
          toolCounts: {
            FileWrite: 3,
            ExitPlanMode: 4,
            FileRead: 2,
            FilePatch: 1
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
          multiRoundPlanFeedbackSeen: true,
          secondPlanRevisionPersisted: true,
          planApprovalSeen: true,
          planApprovalPersisted: true,
          planRevisionChainLinked: true,
          planRevisionChainViewListed: true,
          inheritedPlanContextSeen: true,
          inheritedPlanExecutionFollowed: true,
          inheritedPlanDeviationCorrected: true,
          repeatedPlanDeviationBlocked: true,
          multiStepPlanDeviationRecovered: true,
          migrationPlanExecutionVerified: true,
          crossSessionPlanAdopted: true,
          crossSessionAdoptedPlanContextSeen: true,
          parallelPlanIsolationSeen: true,
          parallelPlanConflictRejected: true,
          parallelPlanAdoptedExplicitly: true,
          mergedPlanCreated: true,
          mergedPlanContextSeen: true,
          conflictedMergeNeedsRevision: true,
          conflictedMergeContextSeen: true,
          conflictedMergeResolved: true,
          resolvedMergeContextSeen: true,
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
    longCycleWorkspaceNoiseInjected: boolean;
    longCycleRepeatedWorkspaceStable: boolean;
    longCycleRepeatedBrowserStable: boolean;
    longCycleRepeatedFileEditStable: boolean;
    longCycleRepeatedMemoryCorrectStable: boolean;
    longCycleRepeatedMemoryRecallStable: boolean;
    longCycleRepeatedSkillStable: boolean;
    longCycleRepeatedAgentStable: boolean;
    longCycleStrategyDriftStable: boolean;
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
          longCycleWorkspaceNoiseInjected: true,
          longCycleRepeatedWorkspaceStable: true,
          longCycleRepeatedBrowserStable: true,
          longCycleRepeatedFileEditStable: true,
          longCycleRepeatedMemoryCorrectStable: true,
          longCycleRepeatedMemoryRecallStable: true,
          longCycleRepeatedSkillStable: true,
          longCycleRepeatedAgentStable: true,
          longCycleStrategyDriftStable: true,
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
    lanSmokeBoundAllInterfaces: boolean;
    lanSmokeHealthSeen: boolean;
    lanSmokePanelLoaded: boolean;
    lanSmokeAuthenticatedApiSeen: boolean;
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
    peerRemotePermissionModeInherited: boolean;
    peerRemoteFileWritten: boolean;
    peerLocalFileNotWritten: boolean;
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
      assertions: overrides.assertions ?? 42,
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
            { length: overrides.assertions ?? 42 },
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
          lanSmokeBoundAllInterfaces: true,
          lanSmokeHealthSeen: true,
          lanSmokePanelLoaded: true,
          lanSmokeAuthenticatedApiSeen: true,
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
          peerRemotePermissionModeInherited: true,
          peerRemoteFileWritten: true,
          peerLocalFileNotWritten: true,
          peerDispatchAuditPersisted: true,
          ...overrides
        }
      }
    ]
  };
}
