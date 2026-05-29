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
        filePatchCalls: 2,
        fileEditCalls: 1,
        fileWriteCalls: 0,
        recoverySeen: true,
        toolSearchRankedFilePatch: true,
        approvalDiffPreviewSeen: true,
        patchUsageRate: 2 / 3
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
        "FilePatch calls < 2",
        "FileWrite used",
        "recoverySeen=false",
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
        filePatchCalls: 2,
        fileEditCalls: 1,
        fileWriteCalls: 0,
        recoverySeen: true,
        toolSearchRankedFilePatch: true,
        approvalDiffPreviewSeen: true,
        patchUsageRate: 2 / 3
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
        maintenanceRecallSeen: false
      }),
      patch: patchReport({
        filePatchCalls: 2,
        fileEditCalls: 1,
        fileWriteCalls: 0,
        recoverySeen: true,
        toolSearchRankedFilePatch: true,
        approvalDiffPreviewSeen: true,
        patchUsageRate: 2 / 3
      }),
      goalPlan: goalPlanReport(),
      toolDiscovery: toolDiscoveryReport(),
      controlApi: controlApiReport()
    });

    const output = formatCapabilityReport(report);
    expect(report.status).toBe("failed");
    expect(output).toContain("- memory: failed");
    expect(output).toContain("thresholdPassed=false");
    expect(output).toContain("maintenanceRecallSeen=false");
  });

  it("fails model task alignment when task coverage or scorer evidence is too thin", () => {
    const report = buildCapabilityReport({
      blackbox: harnessReport({ name: "blackbox-e2e", scenarios: 9, providerCalls: 118 }),
      modelTasks: modelTaskReport({
        scenarios: 2,
        assertions: 4,
        filesVerified: 1,
        toolCallCount: 3,
        uniqueToolCount: 2,
        taskClasses: ["project_edit", "memory_driven"],
        regressions: 1
      }),
      memory: memoryReport({ failed: 0, thresholdPassed: true, score: 1 }),
      patch: patchReport({
        filePatchCalls: 2,
        fileEditCalls: 1,
        fileWriteCalls: 0,
        recoverySeen: true,
        toolSearchRankedFilePatch: true,
        approvalDiffPreviewSeen: true,
        patchUsageRate: 2 / 3
      }),
      goalPlan: goalPlanReport(),
      toolDiscovery: toolDiscoveryReport(),
      controlApi: controlApiReport()
    });

    const modelTasks = report.checks.find((check) => check.id === "model-tasks");
    expect(report.status).toBe("failed");
    expect(modelTasks?.failures).toEqual(
      expect.arrayContaining([
        "scenarios=2",
        "taskClasses=2",
        "assertions=4",
        "filesVerified=1",
        "toolCallCount=3",
        "uniqueToolCount=2",
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
        filePatchCalls: 2,
        fileEditCalls: 1,
        fileWriteCalls: 0,
        recoverySeen: true,
        toolSearchRankedFilePatch: true,
        approvalDiffPreviewSeen: true,
        patchUsageRate: 2 / 3
      }),
      goalPlan: goalPlanReport({
        completedGoalSuppressed: false,
        blockedGoalPersisted: false,
        planReviewPersisted: false,
        planRevisionFeedbackSeen: false,
        planRevisionPersisted: false,
        planApprovalSeen: false,
        planApprovalPersisted: false
      }),
      toolDiscovery: toolDiscoveryReport(),
      controlApi: controlApiReport()
    });

    const goalPlan = report.checks.find((check) => check.id === "goal-plan");
    expect(report.status).toBe("failed");
    expect(goalPlan?.failures).toEqual(
      expect.arrayContaining([
        "completedGoalSuppressed=false",
        "blockedGoalPersisted=false",
        "planReviewPersisted=false",
        "planRevisionFeedbackSeen=false",
        "planRevisionPersisted=false",
        "planApprovalSeen=false",
        "planApprovalPersisted=false"
      ])
    );
  });

  it("fails tool discovery alignment when reveal or usage feedback evidence is incomplete", () => {
    const report = buildCapabilityReport({
      blackbox: harnessReport({ name: "blackbox-e2e", scenarios: 9, providerCalls: 118 }),
      modelTasks: modelTaskReport(),
      memory: memoryReport({ failed: 0, thresholdPassed: true, score: 1 }),
      patch: patchReport({
        filePatchCalls: 2,
        fileEditCalls: 1,
        fileWriteCalls: 0,
        recoverySeen: true,
        toolSearchRankedFilePatch: true,
        approvalDiffPreviewSeen: true,
        patchUsageRate: 2 / 3
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
        crossTaskProviderCalls: 0,
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
        "learningDraftRevealed=false",
        "feedbackRankingUsedUsage=false",
        "intentScopedUsageRecorded=false",
        "failureKindRecorded=false",
        "failureKindShownInRanking=false",
        "failureRecoverySuggested=false",
        "crossTaskRecoveryRankingSeen=false",
        "crossTaskRecoveryGuidanceSeen=false",
        "crossTaskProviderCalls=0",
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
        filePatchCalls: 2,
        fileEditCalls: 1,
        fileWriteCalls: 0,
        recoverySeen: true,
        toolSearchRankedFilePatch: true,
        approvalDiffPreviewSeen: true,
        patchUsageRate: 2 / 3
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
        peerDispatchAuditPersisted: false
      })
    });

    const controlApi = report.checks.find((check) => check.id === "control-api");
    expect(report.status).toBe("failed");
    expect(controlApi?.failures).toEqual(
      expect.arrayContaining([
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
    regressions: number;
  }> = {}
): Record<string, unknown> {
  const taskClasses = overrides.taskClasses ?? ["project_edit", "memory_driven", "tool_discovery"];
  const total = overrides.scenarios ?? taskClasses.length;
  const report = harnessReport({
    name: "model-task-benchmark",
    scenarios: total,
    providerCalls: overrides.providerCalls ?? 8,
    assertions: overrides.assertions ?? 9,
    filesVerified: overrides.filesVerified ?? 3,
    toolCallCount: overrides.toolCallCount ?? 7,
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
        provider: { callCount: 2 }
      }
    }))
  };
}

function memoryReport(input: {
  failed: number;
  thresholdPassed: boolean;
  score: number;
  maintenanceRecallSeen?: boolean;
}): Record<string, unknown> {
  const total = input.maintenanceRecallSeen === false ? 3 : 4;
  const results = [
    "linked workflow retrieves project neighbor",
    "corrected preference replaces stale memory",
    "durable user identity survives graph recall",
    ...(input.maintenanceRecallSeen === false ? [] : ["protected workflow survives maintenance"])
  ].map((name) => ({ name, passed: true }));
  return {
    version: 1,
    name: "memory business recall",
    total,
    passed: total - input.failed,
    failed: input.failed,
    score: input.score,
    minScore: 1,
    thresholdPassed: input.thresholdPassed,
    results
  };
}

function patchReport(input: {
  filePatchCalls: number;
  fileEditCalls: number;
  fileWriteCalls: number;
  recoverySeen: boolean;
  toolSearchRankedFilePatch: boolean;
  approvalDiffPreviewSeen: boolean;
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
          toolSearchRankedFilePatch: input.toolSearchRankedFilePatch,
          approvalDiffPreviewSeen: input.approvalDiffPreviewSeen
        }
      }
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
    planRevisionFeedbackSeen: boolean;
    planRevisionPersisted: boolean;
    planApprovalSeen: boolean;
    planApprovalPersisted: boolean;
    blockedGoalPersisted: boolean;
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
          blockedGoalSuppressed: true,
          writeDeniedInPlanMode: true,
          planSubmittedToModel: true,
          planReviewPersisted: true,
          planRevisionFeedbackSeen: true,
          planRevisionPersisted: true,
          planApprovalSeen: true,
          planApprovalPersisted: true,
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
    crossTaskProviderCalls: number;
    initialToolCount: number;
    revealedToolCount: number;
    grepFailures: number;
    globSuccesses: number;
    grepIntentFailures: number;
    globIntentSuccesses: number;
    grepPathFailures: number;
    grepIntentPathFailures: number;
  }> = {}
): Record<string, unknown> {
  return {
    ...harnessReport({ name: "tool-discovery-eval", scenarios: 1, providerCalls: 4 }),
    scenarios: [
      {
        name: "tool discovery ranking and feedback workflow",
        status: "passed",
        durationMs: 300,
        score: 1,
        failureKind: null,
        details: {
          provider: { callCount: 4 },
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
          crossTaskProviderCalls: 2,
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
  }> = {}
): Record<string, unknown> {
  return {
    ...harnessReport({ name: "control-api-eval", scenarios: 1, providerCalls: 5 }),
    scenarios: [
      {
        name: "mobile control approval, stream, and cancel workflow",
        status: "passed",
        durationMs: 300,
        score: 1,
        failureKind: null,
        details: {
          provider: { callCount: 5 },
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
