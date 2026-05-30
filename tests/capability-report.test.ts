import { describe, expect, it } from "vitest";

import { buildCapabilityReport, formatCapabilityReport } from "../src/capability-report.js";

const BASE_PROVIDER_TOOLS = [
  "AskUserQuestion",
  "Bash",
  "Brief",
  "EnterPlanMode",
  "ExitPlanMode",
  "FileEdit",
  "FilePatch",
  "FileRead",
  "FileWrite",
  "GitDiff",
  "GitLog",
  "GitShow",
  "GitStatus",
  "GitSummary",
  "Glob",
  "Grep",
  "ListMcpResources",
  "Memorize",
  "MemoryCorrect",
  "ReadMcpResource",
  "SendUserMessage",
  "ToolSearch",
  "WorkspaceDiagnostics"
];

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
      controlApi: controlApiReport(),
      complexHarness: complexHarnessReport()
    });

    expect(report).toMatchObject({
      status: "passed",
      summary: { total: 8, passed: 8, failed: 0, score: 1 },
      checks: [
        { id: "blackbox", status: "passed" },
        { id: "model-tasks", status: "passed" },
        { id: "memory", status: "passed" },
        { id: "patch", status: "passed" },
        { id: "goal-plan", status: "passed" },
        { id: "tool-discovery", status: "passed" },
        { id: "control-api", status: "passed" },
        { id: "complex-harness", status: "passed" }
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
        rollbackQualitySeen: false,
        finalDiffQualityVerified: false,
        unrelatedFilePreserved: false,
        toolSearchRankedFilePatch: false,
        approvalDiffPreviewSeen: false,
        patchUsageRate: 1 / 3
      }),
      goalPlan: goalPlanReport(),
      toolDiscovery: toolDiscoveryReport(),
      controlApi: controlApiReport(),
      complexHarness: complexHarnessReport()
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
        "rollbackQualitySeen=false",
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
        regressions: 1,
        complexWorkflowSeen: false,
        learningDraftApplySeen: false,
        skillLearningApplySeen: false,
        skillPatchLearningSeen: false,
        skillCorrectionSeen: false,
        longCycleSkillIterationSeen: false,
        harnessCiTuiGuardSeen: false,
        helpShapeSeen: false,
        textOutputProtocolSeen: false,
        streamJsonProtocolSeen: false,
        streamJsonExtendedProtocolSeen: false,
        jsonOutputProtocolSeen: false,
        barePromptHeadlessSeen: false,
        headlessDefaultPermissionDeniedSeen: false,
        headlessPlanModeSeen: false,
        controlApprovalFlowSeen: false,
        providerRetryFallbackSeen: false,
        toolFeedbackRankingSeen: false,
        memoryGraphLinkSeen: false,
        memoryCorrectionMaintenanceSeen: false,
        tuiRequiresTtySeen: false,
        resumePickerTtySeen: false,
        slashResumeSearchTtySeen: false,
        resumePickerSearchFieldsSeen: false,
        resumePickerVisualContractSeen: false,
        toolPolicySeen: false,
        dangerousPermissionMatrixSeen: false,
        slashSuggestionPromptSeen: false,
        tuiVisualContractSeen: false,
        tuiKeyboardInputSeen: false,
        tuiPromptHistorySeen: false,
        tuiBracketedPasteSeen: false,
        tuiStatefulPickersSeen: false,
        tuiPickerKeyboardNavigationSeen: false,
        tuiApprovalPickerSeen: false,
        tuiApprovalAllowPickerSeen: false,
        tuiApprovalAlwaysPickerSeen: false
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
      controlApi: controlApiReport(),
      complexHarness: complexHarnessReport()
    });

    const blackbox = report.checks.find((check) => check.id === "blackbox");
    expect(report.status).toBe("failed");
    expect(blackbox?.failures).toEqual(
      expect.arrayContaining([
        "assertions=4",
        "filesVerified=0",
        "complexWorkflowSeen=false",
        "learningDraftApplySeen=false",
        "skillLearningApplySeen=false",
        "skillPatchLearningSeen=false",
        "skillCorrectionSeen=false",
        "longCycleSkillIterationSeen=false",
        "harnessCiTuiGuardSeen=false",
        "helpShapeSeen=false",
        "textOutputProtocolSeen=false",
        "streamJsonProtocolSeen=false",
        "streamJsonExtendedProtocolSeen=false",
        "jsonOutputProtocolSeen=false",
        "barePromptHeadlessSeen=false",
        "headlessDefaultPermissionDeniedSeen=false",
        "headlessPlanModeSeen=false",
        "controlApprovalFlowSeen=false",
        "providerRetryFallbackSeen=false",
        "toolFeedbackRankingSeen=false",
        "memoryGraphLinkSeen=false",
        "memoryCorrectionMaintenanceSeen=false",
        "tuiRequiresTtySeen=false",
        "resumePickerTtySeen=false",
        "slashResumeSearchTtySeen=false",
        "resumePickerSearchFieldsSeen=false",
        "resumePickerVisualContractSeen=false",
        "toolPolicySeen=false",
        "dangerousPermissionMatrixSeen=false",
        "slashSuggestionPromptSeen=false",
        "tuiVisualContractSeen=false",
        "tuiKeyboardInputSeen=false",
        "tuiPromptHistorySeen=false",
        "tuiBracketedPasteSeen=false",
        "tuiStatefulPickersSeen=false",
        "tuiPickerKeyboardNavigationSeen=false",
        "tuiApprovalPickerSeen=false",
        "tuiApprovalAllowPickerSeen=false",
        "tuiApprovalAlwaysPickerSeen=false",
        "toolCallCount=3",
        "uniqueToolCount=2",
        "regressions=1"
      ])
    );
  });

  it("fails blackbox alignment when complex workflow evidence is incomplete", () => {
    const report = buildCapabilityReport({
      blackbox: harnessReport({
        name: "blackbox-e2e",
        scenarios: 9,
        providerCalls: 118,
        complexWorkflowSeen: false
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
      controlApi: controlApiReport(),
      complexHarness: complexHarnessReport()
    });

    const blackbox = report.checks.find((check) => check.id === "blackbox");
    expect(report.status).toBe("failed");
    expect(blackbox?.failures).toEqual(expect.arrayContaining(["complexWorkflowSeen=false"]));
    expect(blackbox?.failures).not.toContain("learningDraftApplySeen=false");
  });

  it("fails blackbox alignment when provider tool surface evidence is incomplete", () => {
    const report = buildCapabilityReport({
      blackbox: harnessReport({
        name: "blackbox-e2e",
        scenarios: 9,
        providerCalls: 118,
        providerToolSurfaceSeen: false
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
      controlApi: controlApiReport(),
      complexHarness: complexHarnessReport()
    });

    const blackbox = report.checks.find((check) => check.id === "blackbox");
    expect(report.status).toBe("failed");
    expect(blackbox?.failures).toEqual(
      expect.arrayContaining([
        "providerToolSurfaceCount=0",
        "providerToolSurfaceBadCount=9",
        "complexWorkflowLearningDraftExposed=false"
      ])
    );
  });

  it("fails blackbox alignment when provider model routing evidence is incomplete", () => {
    const report = buildCapabilityReport({
      blackbox: harnessReport({
        name: "blackbox-e2e",
        scenarios: 9,
        providerCalls: 118,
        providerModelsSeen: false
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
      controlApi: controlApiReport(),
      complexHarness: complexHarnessReport()
    });

    const blackbox = report.checks.find((check) => check.id === "blackbox");
    expect(report.status).toBe("failed");
    expect(blackbox?.failures).toEqual(
      expect.arrayContaining([
        "providerModelCoverageSeen=false",
        "retryFallbackModelsSeen=false",
        "tuiModelPickerModelsSeen=false"
      ])
    );
  });

  it("fails blackbox alignment when control stream event evidence is incomplete", () => {
    const report = buildCapabilityReport({
      blackbox: harnessReport({
        name: "blackbox-e2e",
        scenarios: 9,
        providerCalls: 118,
        controlEventCount: 3
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
      controlApi: controlApiReport(),
      complexHarness: complexHarnessReport()
    });

    const blackbox = report.checks.find((check) => check.id === "blackbox");
    expect(report.status).toBe("failed");
    expect(blackbox?.failures).toEqual(expect.arrayContaining(["controlApprovalEventCount=3"]));
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
        conversationIdentityRecallSeen: false,
        dreamConflictGroupLifecycleSeen: false,
        naturalLanguageCorrectionSeen: false,
        correctedMemoryConversationRecallSeen: false,
        graphEdgeReinforcementSeen: false,
        userFeedbackTrendSeen: false,
        longCycleFeedbackTrendSeen: false,
        longProjectFeedbackConvergenceSeen: false,
        longProjectLearningDraftRecallSeen: false,
        autonomousLearningCycleSeen: false,
        staleKnowledgeDemotionSeen: false,
        crossNodeRecommendationSeen: false,
        projectCaseRecallSeen: false,
        multiProjectConflictRecallSeen: false,
        multilingualProjectRecallSeen: false,
        multiNodeSupersededCleanupSeen: false,
        maintenanceConfigBoundarySeen: false,
        resultEvidenceSeen: false,
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
      controlApi: controlApiReport(),
      complexHarness: complexHarnessReport()
    });

    const output = formatCapabilityReport(report);
    expect(report.status).toBe("failed");
    expect(output).toContain("- memory: failed");
    expect(output).toContain("thresholdPassed=false");
    expect(output).toContain("memoryResultEvidenceCount=2");
    expect(output).toContain("assertions=4");
    expect(output).toContain("filesVerified=1");
    expect(output).toContain("maintenanceRecallSeen=false");
    expect(output).toContain("workflowGraphRecallSeen=false");
    expect(output).toContain("conflictGroupViewSeen=false");
    expect(output).toContain("conversationIdentityRecallSeen=false");
    expect(output).toContain("dreamConflictGroupLifecycleSeen=false");
    expect(output).toContain("naturalLanguageCorrectionSeen=false");
    expect(output).toContain("correctedMemoryConversationRecallSeen=false");
    expect(output).toContain("graphEdgeReinforcementSeen=false");
    expect(output).toContain("userFeedbackTrendSeen=false");
    expect(output).toContain("longCycleFeedbackTrendSeen=false");
    expect(output).toContain("longProjectFeedbackConvergenceSeen=false");
    expect(output).toContain("longProjectLearningDraftRecallSeen=false");
    expect(output).toContain("autonomousLearningCycleSeen=false");
    expect(output).toContain("staleKnowledgeDemotionSeen=false");
    expect(output).toContain("crossNodeRecommendationSeen=false");
    expect(output).toContain("projectCaseRecallSeen=false");
    expect(output).toContain("multiProjectConflictRecallSeen=false");
    expect(output).toContain("multilingualProjectRecallSeen=false");
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
          patchUsageRate: 0,
          fileWriteAvoided: false
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
      controlApi: controlApiReport(),
      complexHarness: complexHarnessReport()
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
        "workspacePolicyMigrationTask=false",
        "mixedLanguageContractMigrationTask=false",
        "largeRepoLongChainMigrationTask=false",
        "pluginApiCompatibilityMigrationTask=false",
        "ossStyleOpenSourceMigrationTask=false",
        "securityMiddlewarePolicyMigrationTask=false",
        "ossIssueRegressionFixTask=false",
        "patchStrategyFilePatchCalls < 1",
        "patchStrategyFileEditCalls != 1",
        "patchStrategyRate=0",
        "fileEditAvoidedTaskCount=0",
        "fileWriteAvoidedTaskCount=0",
        "patchStrategyFileWriteAvoided=false",
        "dependencyRefactorBashCalls != 2",
        "dependencyRefactorFileReadCalls < 2",
        "dependencyRefactorFilePatchCalls < 2",
        "dependencyRefactorFileWriteAvoided=false",
        "testDrivenRecoveryBashCalls != 2",
        "testDrivenRecoveryFileReadCalls < 1",
        "testDrivenRecoveryFilePatchCalls < 2",
        "testDrivenRecoveryFileWriteCalls != 1",
        "testDrivenRecoverySeen=false",
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
        "workspacePolicyMigrationBashCalls != 2",
        "workspacePolicyMigrationFileReadCalls != 8",
        "workspacePolicyMigrationFilePatchCalls < 6",
        "workspacePolicyConfigMigrated=false",
        "workspacePolicyPackageScriptsMigrated=false",
        "workspacePolicySourceMigrated=false",
        "workspacePolicyDocsMigrated=false",
        "workspacePolicyGeneratedFileUntouched=false",
        "workspacePolicyVendorFileUntouched=false",
        "workspacePolicyMigrationVerified=false",
        "mixedLanguageContractMigrationBashCalls != 2",
        "mixedLanguageContractMigrationFileReadCalls != 4",
        "mixedLanguageContractMigrationFilePatchCalls < 3",
        "mixedLanguageTsContractMigrated=false",
        "mixedLanguagePythonContractMigrated=false",
        "mixedLanguageDocsContractMigrated=false",
        "mixedLanguageGeneratedClientUntouched=false",
        "mixedLanguageContractVerified=false",
        "largeRepoLongChainMigrationBashCalls != 2",
        "largeRepoLongChainMigrationGlobCalls != 1",
        "largeRepoLongChainMigrationGrepCalls != 1",
        "largeRepoLongChainMigrationFileReadCalls != 12",
        "largeRepoLongChainMigrationFilePatchCalls < 9",
        "largeRepoDiscoveryVerified=false",
        "largeRepoSourceContractsMigrated=false",
        "largeRepoDocsMigrated=false",
        "largeRepoOldOwnedReferencesRemoved=false",
        "largeRepoGeneratedClientUntouched=false",
        "largeRepoVendorShimUntouched=false",
        "largeRepoLongChainVerified=false",
        "pluginApiCompatibilityMigrationBashCalls != 2",
        "pluginApiCompatibilityMigrationGlobCalls != 1",
        "pluginApiCompatibilityMigrationGrepCalls != 1",
        "pluginApiCompatibilityMigrationFileReadCalls != 10",
        "pluginApiCompatibilityMigrationFilePatchCalls < 7",
        "pluginApiRepoDiscoveryVerified=false",
        "pluginRuntimeMigrated=false",
        "firstPartyPluginsMigrated=false",
        "legacyAdapterCompatibilityPreserved=false",
        "pluginApiExamplesDocsChangelogMigrated=false",
        "oldOwnedHookReferencesRemoved=false",
        "generatedPluginTypesUntouched=false",
        "vendorPluginShimUntouched=false",
        "pluginApiCompatibilityVerified=false",
        "ossStyleOpenSourceMigrationBashCalls != 2",
        "ossStyleOpenSourceMigrationGlobCalls != 1",
        "ossStyleOpenSourceMigrationGrepCalls != 1",
        "ossStyleOpenSourceMigrationFileReadCalls != 10",
        "ossStyleOpenSourceMigrationFilePatchCalls < 7",
        "ossRepoDiscoveryVerified=false",
        "ossCoreContractsMigrated=false",
        "ossPluginContractsMigrated=false",
        "ossExamplesDocsChangelogMigrated=false",
        "ossOldOwnedOptionReferencesRemoved=false",
        "ossGeneratedOptionsUntouched=false",
        "ossVendorOptionsUntouched=false",
        "ossStyleMigrationVerified=false",
        "securityMiddlewarePolicyMigrationBashCalls != 2",
        "securityMiddlewarePolicyMigrationGlobCalls != 1",
        "securityMiddlewarePolicyMigrationGrepCalls != 1",
        "securityMiddlewarePolicyMigrationFileReadCalls != 10",
        "securityMiddlewarePolicyMigrationFilePatchCalls < 7",
        "securityPolicyRepoDiscoveryVerified=false",
        "securityPolicyConfigMigrated=false",
        "securityMiddlewareMigrated=false",
        "securityClientMigrated=false",
        "securityExamplesDocsChangelogMigrated=false",
        "oldOwnedSecurityReferencesRemoved=false",
        "generatedSecuritySchemaUntouched=false",
        "vendorSecurityShimUntouched=false",
        "securityMiddlewarePolicyVerified=false",
        "ossIssueRegressionFixBashCalls != 2",
        "ossIssueRegressionFixGlobCalls != 1",
        "ossIssueRegressionFixGrepCalls != 1",
        "ossIssueRegressionFixFileReadCalls != 9",
        "ossIssueRegressionFixFilePatchCalls < 5",
        "ossIssueReportReadBeforePatch=false",
        "ossIssueRegressionTaskSeen=false",
        "ossIssueRegressionReproduced=false",
        "ossIssueCoreUrlEncodingFixed=false",
        "ossIssueClientUrlEncodingFixed=false",
        "ossIssuePluginUrlEncodingFixed=false",
        "ossIssueDocsChangelogUpdated=false",
        "ossIssueGeneratedOpenapiUntouched=false",
        "ossIssueVendorRouteUntouched=false",
        "ossIssueRegressionVerified=false",
        "ossSecurityAdvisoryFixTask=false",
        "ossSecurityAdvisoryFixBashCalls != 2",
        "ossSecurityAdvisoryFixGlobCalls != 1",
        "ossSecurityAdvisoryFixGrepCalls != 1",
        "ossSecurityAdvisoryFixFileReadCalls != 9",
        "ossSecurityAdvisoryFixFilePatchCalls < 5",
        "ossSecurityAdvisoryReadBeforePatch=false",
        "ossSecurityAdvisoryReproduced=false",
        "ossSecuritySessionCookieDefaultsHardened=false",
        "ossSecurityClientCookieSummaryUpdated=false",
        "ossSecuritySessionExampleUpdated=false",
        "ossSecurityDocsChangelogUpdated=false",
        "ossSecurityGeneratedCookieSchemaUntouched=false",
        "ossSecurityVendorCookieShimUntouched=false",
        "ossSecurityAdvisoryVerified=false",
        "ciFailureDiagnosisFixTask=false",
        "ciFailureDiagnosisFixBashCalls != 2",
        "ciFailureDiagnosisFixGlobCalls != 1",
        "ciFailureDiagnosisFixGrepCalls != 1",
        "ciFailureDiagnosisFixFileReadCalls != 8",
        "ciFailureDiagnosisFixFilePatchCalls < 3",
        "ciWorkflowReadBeforePatch=false",
        "ciFailureLogReadBeforePatch=false",
        "ciFailureReproduced=false",
        "ciReleaseSlugFixed=false",
        "ciProjectPathEncodingFixed=false",
        "ciDocsChangelogUpdated=false",
        "ciGeneratedRouteSchemaUntouched=false",
        "ciVendorSlugShimUntouched=false",
        "ciFailureVerified=false",
        "regressions=1"
      ])
    );
  });

  it("fails model task alignment when foundational task evidence is incomplete", () => {
    const report = buildCapabilityReport({
      blackbox: harnessReport({ name: "blackbox-e2e", scenarios: 9, providerCalls: 118 }),
      modelTasks: modelTaskReport({
        patchStrategy: {
          filePatchCalls: 1,
          fileEditCalls: 1,
          fileWriteCalls: 0,
          patchUsageRate: 0.5,
          fileWriteAvoided: false
        },
        dependencyRefactor: {
          bashCalls: 1,
          fileReadCalls: 1,
          filePatchCalls: 1,
          fileWriteCalls: 1,
          fileEditCalls: 1,
          fileWriteAvoided: false
        },
        testDrivenRecovery: {
          bashCalls: 1,
          fileReadCalls: 0,
          filePatchCalls: 1,
          fileWriteCalls: 0,
          fileEditCalls: 1,
          recoverySeen: false
        }
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
      controlApi: controlApiReport(),
      complexHarness: complexHarnessReport()
    });

    const modelTasks = report.checks.find((check) => check.id === "model-tasks");
    expect(report.status).toBe("failed");
    expect(modelTasks?.failures).toEqual(
      expect.arrayContaining([
        "patchStrategyFileWriteAvoided=false",
        "dependencyRefactorBashCalls != 2",
        "dependencyRefactorFileReadCalls < 2",
        "dependencyRefactorFilePatchCalls < 2",
        "dependencyRefactorFileWrite used",
        "dependencyRefactorFileEdit used",
        "dependencyRefactorFileWriteAvoided=false",
        "testDrivenRecoveryBashCalls != 2",
        "testDrivenRecoveryFileReadCalls < 1",
        "testDrivenRecoveryFilePatchCalls < 2",
        "testDrivenRecoveryFileWriteCalls != 1",
        "testDrivenRecoveryFileEdit used",
        "testDrivenRecoverySeen=false"
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
        planReviewPreviewShown: false,
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
        multiBranchConvergenceCreated: false,
        multiBranchConvergenceContextSeen: false,
        multiBranchConvergenceExecuted: false,
        conflictedMergeNeedsRevision: false,
        conflictedMergeContextSeen: false,
        conflictedMergeResolved: false,
        resolvedMergeContextSeen: false,
        multiObjectiveConflictDetected: false,
        multiObjectiveUserChoiceResolved: false,
        multiObjectiveChoiceContextSeen: false,
        multiObjectiveRejectedBranchExcluded: false,
        multiObjectiveCompatibleBranchPreserved: false,
        multiObjectiveReadBeforeWriteGuardSeen: false,
        multiObjectiveReleaseFilesUpdated: false,
        multiObjectiveExecutionVerified: false,
        longProjectRetrospectiveContextSeen: false,
        longProjectRetrospectiveGenerated: false,
        longProjectRetrospectiveVerified: false,
        assertions: 3,
        filesVerified: 1,
        toolCallCount: 2,
        uniqueToolCount: 1
      }),
      toolDiscovery: toolDiscoveryReport(),
      controlApi: controlApiReport(),
      complexHarness: complexHarnessReport()
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
        "planReviewPreviewShown=false",
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
        "multiBranchConvergenceCreated=false",
        "multiBranchConvergenceContextSeen=false",
        "multiBranchConvergenceExecuted=false",
        "conflictedMergeNeedsRevision=false",
        "conflictedMergeContextSeen=false",
        "conflictedMergeResolved=false",
        "resolvedMergeContextSeen=false",
        "multiObjectiveConflictDetected=false",
        "multiObjectiveUserChoiceResolved=false",
        "multiObjectiveChoiceContextSeen=false",
        "multiObjectiveRejectedBranchExcluded=false",
        "multiObjectiveCompatibleBranchPreserved=false",
        "multiObjectiveReadBeforeWriteGuardSeen=false",
        "multiObjectiveReleaseFilesUpdated=false",
        "multiObjectiveExecutionVerified=false",
        "longProjectRetrospectiveContextSeen=false",
        "longProjectRetrospectiveGenerated=false",
        "longProjectRetrospectiveVerified=false"
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
        mixedIntentFileEditRanked: false,
        mixedIntentBrowserRanked: false,
        mixedIntentMemoryRecallRanked: false,
        mixedIntentAgentRanked: false,
        mixedIntentSchemasRevealed: false,
        mixedIntentDynamicExpansionSeen: false,
        crossTurnMixedIntentInitialDeferredSeen: false,
        crossTurnMixedIntentFileEditStable: false,
        crossTurnMixedIntentBrowserStable: false,
        crossTurnMixedIntentMemoryRecallStable: false,
        crossTurnMixedIntentAgentStable: false,
        crossTurnMixedIntentSchemaIsolationSeen: false,
        largeRepoInitialDeferredSeen: false,
        largeRepoMemoryCorrectCoreAvailable: false,
        largeRepoWorkspaceRanked: false,
        largeRepoFileEditRanked: false,
        largeRepoBrowserRanked: false,
        largeRepoArchiveRanked: false,
        largeRepoMemoryCorrectRanked: false,
        largeRepoMemoryRecallRanked: false,
        largeRepoLearningDraftRanked: false,
        largeRepoAgentRanked: false,
        largeRepoSchemasRevealed: false,
        largeRepoSchemaIsolationSeen: false,
        toolSearchContextPersisted: false,
        toolSearchContextIntentCoverage: 3,
        crossTaskProviderCalls: 0,
        longCycleProviderCalls: 0,
        mixedIntentProviderCalls: 0,
        crossTurnMixedIntentProviderCalls: 0,
        largeRepoProviderCalls: 0,
        largeRepoSelectedToolCount: 2,
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
      controlApi: controlApiReport(),
      complexHarness: complexHarnessReport()
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
        "mixedIntentFileEditRanked=false",
        "mixedIntentBrowserRanked=false",
        "mixedIntentMemoryRecallRanked=false",
        "mixedIntentAgentRanked=false",
        "mixedIntentSchemasRevealed=false",
        "mixedIntentDynamicExpansionSeen=false",
        "crossTurnMixedIntentInitialDeferredSeen=false",
        "crossTurnMixedIntentFileEditStable=false",
        "crossTurnMixedIntentBrowserStable=false",
        "crossTurnMixedIntentMemoryRecallStable=false",
        "crossTurnMixedIntentAgentStable=false",
        "crossTurnMixedIntentSchemaIsolationSeen=false",
        "largeRepoInitialDeferredSeen=false",
        "largeRepoMemoryCorrectCoreAvailable=false",
        "largeRepoWorkspaceRanked=false",
        "largeRepoFileEditRanked=false",
        "largeRepoBrowserRanked=false",
        "largeRepoArchiveRanked=false",
        "largeRepoMemoryCorrectRanked=false",
        "largeRepoMemoryRecallRanked=false",
        "largeRepoLearningDraftRanked=false",
        "largeRepoAgentRanked=false",
        "largeRepoSchemasRevealed=false",
        "largeRepoSchemaIsolationSeen=false",
        "toolSearchContextPersisted=false",
        "toolSearchContextIntentCoverage < 8",
        "crossTaskProviderCalls=0",
        "longCycleProviderCalls=0",
        "mixedIntentProviderCalls=0",
        "crossTurnMixedIntentProviderCalls=0",
        "largeRepoProviderCalls=0",
        "largeRepoSelectedToolCount < 5",
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
        sseDisconnectSimulated: false,
        sseReconnectUsedAfterId: false,
        sseReconnectCompletionSeen: false,
        sseReconnectNoDuplicateReplay: false,
        sseReconnectAuditPersisted: false,
        sseJitterMultipleDisconnectsSimulated: false,
        sseJitterRepeatedAfterCursorUsed: false,
        sseJitterCompletionSeen: false,
        sseJitterNoDuplicateReplay: false,
        sseJitterAuditPersisted: false,
        restartServeStarted: false,
        restartDeviceAuthPersisted: false,
        restartSessionPersisted: false,
        restartSessionContextSeen: false,
        restartJobPersisted: false,
        restartJobAuditPersisted: false,
        mobileBrowserViewportSeen: false,
        mobileBrowserStreamRendered: false,
        mobileBrowserCancelRendered: false,
        lanSmokeBoundAllInterfaces: false,
        lanSmokeHealthSeen: false,
        lanSmokePanelLoaded: false,
        lanSmokeAuthenticatedApiSeen: false,
        lanSmoke: {
          usedLoopbackFallback: false,
          healthOk: false,
          panelOk: false,
          authOk: false
        },
        peerCredentialsSaved: false,
        peerSavedListed: false,
        peerDispatchBoundAllInterfaces: false,
        peerDispatchExternalUrlReachable: false,
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
        peerLongAgentDispatched: false,
        peerLongDispatchRunningObserved: false,
        peerLongDispatchCompleted: false,
        peerLongDispatchResultReturned: false,
        peerLongDispatchSecondAgentCall: false,
        peerLongRemoteFileWritten: false,
        peerLongRemoteFileIsolated: false,
        peerLongRemoteJobCompleted: false,
        peerLongRemoteAuditPersisted: false,
        assertions: 8,
        filesVerified: 2,
        toolCallCount: 2,
        uniqueToolCount: 2
      }),
      complexHarness: complexHarnessReport()
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
        "sseDisconnectSimulated=false",
        "sseReconnectUsedAfterId=false",
        "sseReconnectCompletionSeen=false",
        "sseReconnectNoDuplicateReplay=false",
        "sseReconnectAuditPersisted=false",
        "sseJitterMultipleDisconnectsSimulated=false",
        "sseJitterRepeatedAfterCursorUsed=false",
        "sseJitterCompletionSeen=false",
        "sseJitterNoDuplicateReplay=false",
        "sseJitterAuditPersisted=false",
        "restartServeStarted=false",
        "restartDeviceAuthPersisted=false",
        "restartSessionPersisted=false",
        "restartSessionContextSeen=false",
        "restartJobPersisted=false",
        "restartJobAuditPersisted=false",
        "mobileBrowserViewportSeen=false",
        "mobileBrowserStreamRendered=false",
        "mobileBrowserCancelRendered=false",
        "lanSmokeBoundAllInterfaces=false",
        "lanSmokeHealthSeen=false",
        "lanSmokePanelLoaded=false",
        "lanSmokeAuthenticatedApiSeen=false",
        "lanSmokeHealthOk=false",
        "lanSmokePanelOk=false",
        "lanSmokeAuthOk=false",
        "peerCredentialsSaved=false",
        "peerSavedListed=false",
        "peerDispatchBoundAllInterfaces=false",
        "peerDispatchExternalUrlReachable=false",
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
        "peerDispatchAuditPersisted=false",
        "peerLongAgentDispatched=false",
        "peerLongDispatchRunningObserved=false",
        "peerLongDispatchCompleted=false",
        "peerLongDispatchResultReturned=false",
        "peerLongDispatchSecondAgentCall=false",
        "peerLongRemoteFileWritten=false",
        "peerLongRemoteFileIsolated=false",
        "peerLongRemoteJobCompleted=false",
        "peerLongRemoteAuditPersisted=false"
      ])
    );
  });

  it("fails complex harness alignment when H1 business evidence is incomplete", () => {
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
      controlApi: controlApiReport(),
      complexHarness: complexHarnessReport({
        status: "failed",
        score: 0.3,
        successRate: 0,
        taskClass: "thin_demo",
        includeH2: false,
        includeH3: false,
        includeH4: false,
        includeH5: false,
        includeH6: false,
        includeH7: false,
        includeH8: false,
        includeH9: false,
        includeH10: false,
        assertions: 2,
        filesVerified: 1,
        toolCallCount: 2,
        uniqueToolCount: 2,
        fileReadCalls: 1,
        filePatchCalls: 0,
        bashCalls: 1,
        fileWriteCalls: 1,
        fileEditCalls: 1,
        checksPassed: false,
        streamJsonLifecycleVerified: false,
        changedFiles: ["src/discount.ts", "tests/discount.test.mjs"],
        forbiddenChanges: ["tests/discount.test.mjs"],
        sessionMessages: 1,
        auditEvents: 0,
        withinTime: false,
        withinCommands: false,
        withinFileChanges: false,
        regressions: 1
      })
    });

    const complex = report.checks.find((check) => check.id === "complex-harness");
    expect(report.status).toBe("failed");
    expect(complex?.failures).toEqual(
      expect.arrayContaining([
        "status=failed",
        "successRate=0",
        "score=0.3",
        "scenarios=1",
        "singleFileBugFixTask=false",
        "multiFileFeatureTask=false",
        "behaviorPreservingRefactorTask=false",
        "repositoryInvestigationFixTask=false",
        "permissionBoundaryTask=false",
        "resumeAfterInterruptionTask=false",
        "streamJsonAutomationTask=false",
        "multiAgentConflictTask=false",
        "bashApprovalControlTask=false",
        "H2=false",
        "H3=false",
        "H4=false",
        "H5=false",
        "H6=false",
        "H7=false",
        "H7AssistantMessage=false",
        "H8=false",
        "H9=false",
        "H10=false",
        "H10AssistantMessage=false",
        "H10FallbackFromProviderMismatch",
        "H10FallbackErrorKindMismatch",
        "H10RetryAttemptsMismatch",
        "assertions=2",
        "filesVerified=1",
        "toolCallCount=2",
        "uniqueToolCount=2",
        "normalStreamDiagnosticsCount=1",
        "H1FileReadCalls < 2",
        "H1FilePatchCalls < 2",
        "H1BashCalls != 2",
        "H1FileWrite used",
        "H1FileEdit used",
        "H1ChecksPassed=false",
        "H1StreamJsonLifecycle=false",
        'H1ChangedFiles=["src/discount.ts","tests/discount.test.mjs"]',
        "H1ForbiddenChanges=1",
        "H1Assertions=2",
        "H1SessionMessages < 2",
        "H1AuditEvents < 1",
        "H1WithinTime=false",
        "H1WithinCommands=false",
        "H1WithinFileChanges=false",
        "regressions=1"
      ])
    );
  });

  it("fails complex harness alignment when H7 normal stream has provider retry diagnostics", () => {
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
      controlApi: controlApiReport(),
      complexHarness: complexHarnessReport({
        h7ProviderRetrySeen: true,
        h7ProviderRetryCount: 1,
        h7ProviderFallbackSeen: true
      })
    });

    const complex = report.checks.find((check) => check.id === "complex-harness");
    expect(report.status).toBe("failed");
    expect(complex?.failures).toEqual(
      expect.arrayContaining([
        "H7ProviderRetrySeen=true",
        "H7ProviderRetryStreamCount != 0",
        "H7ProviderFallbackSeen=true",
        "normalStreamDiagnosticsCount=7"
      ])
    );
  });

  it("fails complex harness alignment when provider tool surface evidence is incomplete", () => {
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
      controlApi: controlApiReport(),
      complexHarness: complexHarnessReport({ providerToolSurfaceSeen: false })
    });

    const complex = report.checks.find((check) => check.id === "complex-harness");
    expect(report.status).toBe("failed");
    expect(complex?.failures).toEqual(
      expect.arrayContaining(["providerToolSurfaceCount=0", "providerToolSurfaceBadCount=10"])
    );
  });

  it("fails complex harness alignment when stream event and audit id evidence is incomplete", () => {
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
      controlApi: controlApiReport(),
      complexHarness: complexHarnessReport({
        h5FailedToolCallId: "wrong-tool-call",
        h10EventCount: 0
      })
    });

    const complex = report.checks.find((check) => check.id === "complex-harness");
    expect(report.status).toBe("failed");
    expect(complex?.failures).toEqual(
      expect.arrayContaining(["streamEventCountEvidenceCount=8", "H5OutsideWriteToolCallIdMissing"])
    );
  });

  it("fails complex harness alignment when H8/H9 structured evidence is incomplete", () => {
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
      controlApi: controlApiReport(),
      complexHarness: complexHarnessReport({
        h8TaskPrompts: ["update left module"],
        h8Tasks: [
          {
            id: "h8-left-worker",
            role: "assistant",
            prompt: "update left module",
            status: "completed",
            writeFiles: ["src/left.txt"]
          }
        ],
        h8Claims: [
          {
            taskId: "h8-left-worker",
            filePath: "src/left.txt",
            ownerRole: "assistant"
          }
        ],
        h9PendingToolUseId: "h9-other-bash",
        h9CompletedBashToolCount: 2,
        h9CompletedToolIds: ["h9-readonly-pwd", "h9-run-approved-bash"]
      })
    });

    const complex = report.checks.find((check) => check.id === "complex-harness");
    expect(report.status).toBe("failed");
    expect(complex?.failures).toEqual(
      expect.arrayContaining([
        'H8TaskPrompts=["update left module"]',
        "H8WorkerTaskEvidenceMissing",
        "H8ClaimOwnerEvidenceMissing",
        "H9CompletedBashToolCount < 3",
        "H9PendingToolUseIdMismatch",
        'H9CompletedToolIds=["h9-readonly-pwd","h9-run-approved-bash"]'
      ])
    );
  });
});

function providerSurface(input: {
  callCount: number;
  learningDraft?: boolean;
  models?: string[];
  toolCounts?: Record<string, number>;
  broken?: boolean;
}): Record<string, unknown> {
  const exposedTools = input.broken
    ? ["Bash"]
    : [...BASE_PROVIDER_TOOLS, ...(input.learningDraft ? ["LearningDraft"] : [])];
  return {
    callCount: input.callCount,
    exposedToolCount: exposedTools.length,
    exposedTools,
    ...(input.models ? { models: input.models } : {}),
    ...(input.toolCounts ? { toolCounts: input.toolCounts } : {})
  };
}

function harnessReport(input: {
  name: string;
  scenarios: number;
  providerCalls: number;
  assertions?: number;
  filesVerified?: number;
  toolCallCount?: number;
  uniqueToolCount?: number;
  regressions?: number;
  complexWorkflowSeen?: boolean;
  learningDraftApplySeen?: boolean;
  skillLearningApplySeen?: boolean;
  skillPatchLearningSeen?: boolean;
  skillCorrectionSeen?: boolean;
  longCycleSkillIterationSeen?: boolean;
  harnessCiTuiGuardSeen?: boolean;
  helpShapeSeen?: boolean;
  textOutputProtocolSeen?: boolean;
  streamJsonProtocolSeen?: boolean;
  streamJsonExtendedProtocolSeen?: boolean;
  jsonOutputProtocolSeen?: boolean;
  barePromptHeadlessSeen?: boolean;
  headlessDefaultPermissionDeniedSeen?: boolean;
  headlessPlanModeSeen?: boolean;
  controlApprovalFlowSeen?: boolean;
  providerRetryFallbackSeen?: boolean;
  toolFeedbackRankingSeen?: boolean;
  memoryGraphLinkSeen?: boolean;
  memoryCorrectionMaintenanceSeen?: boolean;
  tuiRequiresTtySeen?: boolean;
  resumePickerTtySeen?: boolean;
  slashResumeSearchTtySeen?: boolean;
  resumePickerSearchFieldsSeen?: boolean;
  resumePickerVisualContractSeen?: boolean;
  toolPolicySeen?: boolean;
  dangerousPermissionMatrixSeen?: boolean;
  providerToolSurfaceSeen?: boolean;
  providerModelsSeen?: boolean;
  controlEventCount?: number;
  slashSuggestionPromptSeen?: boolean;
  tuiVisualContractSeen?: boolean;
  tuiKeyboardInputSeen?: boolean;
  tuiPromptHistorySeen?: boolean;
  tuiBracketedPasteSeen?: boolean;
  tuiStatefulPickersSeen?: boolean;
  tuiPickerKeyboardNavigationSeen?: boolean;
  tuiApprovalPickerSeen?: boolean;
  tuiApprovalAllowPickerSeen?: boolean;
  tuiApprovalAlwaysPickerSeen?: boolean;
}): Record<string, unknown> {
  const regressions = Array.from({ length: input.regressions ?? 0 }, (_, index) => ({
    scenario: `regression ${index + 1}`,
    failureKind: "assertion"
  }));
  const providerToolSurfaceBroken = input.providerToolSurfaceSeen === false;
  const providerModelsBroken = input.providerModelsSeen === false;
  const mainModels = ["mock-main"];
  const retryModels = providerModelsBroken ? mainModels : ["mock-backup", "mock-main"];
  const pickerModels = providerModelsBroken ? mainModels : ["mock-fast"];
  const genericProviderScenarios = Array.from(
    { length: Math.max(0, Math.min(input.scenarios, 23) - 6) },
    (_, index) => ({
      name: `provider tool surface ${index + 1}`,
      status: "passed",
      durationMs: 300,
      score: 1,
      failureKind: null,
      details: {
        assertions: [],
        provider: providerSurface({
          callCount: 1,
          models: mainModels,
          broken: providerToolSurfaceBroken
        })
      }
    })
  );
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
      assertions: input.assertions ?? 188,
      filesVerified: input.filesVerified ?? 6,
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
    scenarios: [
      {
        name: "complex workflow",
        status: "passed",
        durationMs: 300,
        score: 1,
        failureKind: null,
        details: {
          provider:
            input.complexWorkflowSeen === false
              ? { callCount: 0, toolCounts: {} }
              : providerSurface({
                  callCount: 11,
                  learningDraft: true,
                  models: mainModels,
                  broken: providerToolSurfaceBroken,
                  toolCounts: {
                    ToolSearch: 2,
                    WorkspaceDiagnostics: 1,
                    FileWrite: 1,
                    TodoWrite: 1,
                    Memorize: 2,
                    FilePatch: 2,
                    LearningDraft: 1,
                    SendUserMessage: 1
                  }
                }),
          assertions: [
            ...complexWorkflowAssertions(input),
            "learning draft listed",
            ...(input.learningDraftApplySeen === false
              ? []
              : [
                  "learning draft review showed evidence",
                  "learning draft applied to memory",
                  "applied learning indexed into memory graph"
                ]),
            ...skillLearningAssertions(input),
            ...harnessGuardAssertions(input),
            ...helpShapeAssertions(input),
            ...textOutputProtocolAssertions(input),
            ...streamJsonProtocolAssertions(input),
            ...streamJsonExtendedProtocolAssertions(input),
            ...jsonOutputProtocolAssertions(input),
            ...barePromptHeadlessAssertions(input),
            ...headlessDefaultPermissionDeniedAssertions(input),
            ...headlessPlanModeAssertions(input),
            ...controlApprovalFlowAssertions(input),
            ...providerRetryFallbackAssertions(input),
            ...toolFeedbackRankingAssertions(input),
            ...memoryGraphLinkAssertions(input),
            ...memoryCorrectionMaintenanceAssertions(input),
            ...tuiRequiresTtyAssertions(input),
            ...resumePickerTtyAssertions(input),
            ...slashResumeSearchTtyAssertions(input),
            ...resumePickerSearchFieldsAssertions(input),
            ...resumePickerVisualContractAssertions(input),
            ...toolPolicyAssertions(input),
            ...dangerousPermissionMatrixAssertions(input),
            ...slashSuggestionPromptAssertions(input),
            ...tuiVisualContractAssertions(input),
            ...tuiKeyboardInputAssertions(input),
            ...tuiPromptHistoryAssertions(input),
            ...tuiBracketedPasteAssertions(input),
            ...tuiStatefulPickersAssertions(input),
            ...tuiPickerKeyboardNavigationAssertions(input),
            ...tuiApprovalPickerAssertions(input),
            ...tuiApprovalAllowPickerAssertions(input),
            ...tuiApprovalAlwaysPickerAssertions(input)
          ],
          filesVerified: [
            ...(input.complexWorkflowSeen === false
              ? []
              : ["reports/e2e-result.md", "state/todos.json"]),
            ...(input.learningDraftApplySeen === false
              ? []
              : ["memory/workflows/focused-cli-e2e.md"]),
            ...(input.skillLearningApplySeen === false ? [] : ["skills/blackbox-verify/SKILL.md"])
          ]
        }
      },
      {
        name: "retry fallback",
        status: "passed",
        durationMs: 300,
        score: 1,
        failureKind: null,
        details: {
          assertions: providerRetryFallbackAssertions(input),
          provider:
            input.providerRetryFallbackSeen === false
              ? { callCount: 0 }
              : providerSurface({
                  callCount: 4,
                  models: retryModels,
                  broken: providerToolSurfaceBroken
                }),
          retry:
            input.providerRetryFallbackSeen === false
              ? { primaryCalls: 0, backupCalls: 0 }
              : { primaryCalls: 3, backupCalls: 1 }
        }
      },
      {
        name: "tool feedback ranking",
        status: "passed",
        durationMs: 300,
        score: 1,
        failureKind: null,
        details: {
          assertions: toolFeedbackRankingAssertions(input),
          provider:
            input.toolFeedbackRankingSeen === false
              ? { callCount: 0, toolCounts: {} }
              : providerSurface({
                  callCount: 3,
                  models: mainModels,
                  broken: providerToolSurfaceBroken,
                  toolCounts: { Grep: 4, Glob: 4, ToolSearch: 1 }
                }),
          toolFeedback:
            input.toolFeedbackRankingSeen === false
              ? { grepFailures: 0, globSuccesses: 0, recoveryGuidanceSeen: false }
              : { grepFailures: 4, globSuccesses: 4, recoveryGuidanceSeen: true },
          filesVerified:
            input.toolFeedbackRankingSeen === false ? [] : ["state/tool-usage-stats.json"]
        }
      },
      {
        name: "TUI stateful pickers",
        status: "passed",
        durationMs: 300,
        score: 1,
        failureKind: null,
        details: {
          assertions: tuiStatefulPickersAssertions(input),
          provider: providerSurface({
            callCount: 2,
            models: pickerModels,
            broken: providerToolSurfaceBroken
          })
        }
      },
      {
        name: "TUI picker keyboard navigation",
        status: "passed",
        durationMs: 300,
        score: 1,
        failureKind: null,
        details: {
          assertions: tuiPickerKeyboardNavigationAssertions(input),
          provider: providerSurface({
            callCount: 2,
            models: pickerModels,
            broken: providerToolSurfaceBroken
          })
        }
      },
      {
        name: "control approval flow",
        status: "passed",
        durationMs: 300,
        score: 1,
        failureKind: null,
        details: {
          assertions: controlApprovalFlowAssertions(input),
          provider: providerSurface({
            callCount: 2,
            models: mainModels,
            broken: providerToolSurfaceBroken
          }),
          control: {
            eventCount: input.controlEventCount ?? 18
          }
        }
      },
      ...genericProviderScenarios
    ]
  };
}

function complexWorkflowAssertions(input: { complexWorkflowSeen?: boolean }): string[] {
  return input.complexWorkflowSeen === false
    ? []
    : [
        "goal context loaded",
        "hot and relevant memory loaded",
        "deferred tool revealed",
        "report file written and patched",
        "todo state persisted",
        "memory search found learned workflow",
        "Dream archived duplicate workflow memory",
        "Dream redirected duplicate workflow graph edge",
        "Dream fused duplicate workflow weight",
        "memory merge audit listed duplicate workflow",
        "memory recall quality eval passed"
      ];
}

function complexHarnessReport(
  overrides: {
    status?: "passed" | "failed";
    score?: number;
    successRate?: number;
    taskClass?: string;
    includeH2?: boolean;
    includeH3?: boolean;
    includeH4?: boolean;
    includeH5?: boolean;
    includeH6?: boolean;
    includeH7?: boolean;
    includeH8?: boolean;
    includeH9?: boolean;
    includeH10?: boolean;
    assertions?: number;
    filesVerified?: number;
    toolCallCount?: number;
    uniqueToolCount?: number;
    fileReadCalls?: number;
    filePatchCalls?: number;
    bashCalls?: number;
    fileWriteCalls?: number;
    fileEditCalls?: number;
    checksPassed?: boolean;
    streamJsonLifecycleVerified?: boolean;
    h7ProviderRetrySeen?: boolean;
    h7ProviderRetryCount?: number;
    h7ProviderFallbackSeen?: boolean;
    h7EventCount?: number;
    h8TaskPrompts?: string[];
    h8Tasks?: Record<string, unknown>[];
    h8Claims?: Record<string, unknown>[];
    h9PendingToolUseId?: string;
    h9CompletedBashToolCount?: number;
    h9CompletedToolIds?: string[];
    h5FailedToolCallId?: string;
    h10EventCount?: number;
    providerToolSurfaceSeen?: boolean;
    changedFiles?: string[];
    forbiddenChanges?: string[];
    sessionMessages?: number;
    auditEvents?: number;
    withinTime?: boolean;
    withinCommands?: boolean;
    withinFileChanges?: boolean;
    regressions?: number;
  } = {}
): Record<string, unknown> {
  const status = overrides.status ?? "passed";
  const includeH2 = overrides.includeH2 ?? true;
  const includeH3 = overrides.includeH3 ?? true;
  const includeH4 = overrides.includeH4 ?? true;
  const includeH5 = overrides.includeH5 ?? true;
  const includeH6 = overrides.includeH6 ?? true;
  const includeH7 = overrides.includeH7 ?? true;
  const includeH8 = overrides.includeH8 ?? true;
  const includeH9 = overrides.includeH9 ?? true;
  const includeH10 = overrides.includeH10 ?? true;
  const h1Assertions = overrides.assertions ?? 10;
  const h2Assertions = includeH2 ? 12 : 0;
  const h3Assertions = includeH3 ? 13 : 0;
  const h4Assertions = includeH4 ? 14 : 0;
  const h5Assertions = includeH5 ? 14 : 0;
  const h6Assertions = includeH6 ? 15 : 0;
  const h7Assertions = includeH7 ? 16 : 0;
  const h8Assertions = includeH8 ? 16 : 0;
  const h9Assertions = includeH9 ? 17 : 0;
  const h10Assertions = includeH10 ? 18 : 0;
  const assertions =
    h1Assertions +
    h2Assertions +
    h3Assertions +
    h4Assertions +
    h5Assertions +
    h6Assertions +
    h7Assertions +
    h8Assertions +
    h9Assertions +
    h10Assertions;
  const h1FilesVerified = overrides.filesVerified ?? 4;
  const h2FilesVerified = includeH2 ? 6 : 0;
  const h3FilesVerified = includeH3 ? 6 : 0;
  const h4FilesVerified = includeH4 ? 6 : 0;
  const h5FilesVerified = includeH5 ? 5 : 0;
  const h6FilesVerified = includeH6 ? 5 : 0;
  const h7FilesVerified = includeH7 ? 5 : 0;
  const h8FilesVerified = includeH8 ? 5 : 0;
  const h9FilesVerified = includeH9 ? 6 : 0;
  const h10FilesVerified = includeH10 ? 5 : 0;
  const filesVerified =
    h1FilesVerified +
    h2FilesVerified +
    h3FilesVerified +
    h4FilesVerified +
    h5FilesVerified +
    h6FilesVerified +
    h7FilesVerified +
    h8FilesVerified +
    h9FilesVerified +
    h10FilesVerified;
  const h1ToolCounts = {
    FileRead: overrides.fileReadCalls ?? 2,
    FilePatch: overrides.filePatchCalls ?? 2,
    Bash: overrides.bashCalls ?? 2,
    FileWrite: overrides.fileWriteCalls ?? 0,
    FileEdit: overrides.fileEditCalls ?? 0
  };
  const h2ToolCounts = includeH2
    ? {
        FileRead: 4,
        FilePatch: 4,
        Bash: 2,
        FileWrite: 0,
        FileEdit: 0
      }
    : {};
  const h3ToolCounts = includeH3
    ? {
        FileRead: 3,
        FilePatch: 2,
        Bash: 2,
        FileWrite: 1,
        FileEdit: 0
      }
    : {};
  const h4ToolCounts = includeH4
    ? {
        Glob: 1,
        Grep: 1,
        FileRead: 4,
        FilePatch: 1,
        Bash: 2,
        FileWrite: 0,
        FileEdit: 0
      }
    : {};
  const h5ToolCounts = includeH5
    ? {
        FileRead: 2,
        FileWrite: 1,
        FilePatch: 1,
        Bash: 2,
        FileEdit: 0
      }
    : {};
  const h6ToolCounts = includeH6
    ? {
        FileRead: 4,
        FileWrite: 1,
        FilePatch: 1,
        Bash: 2,
        FileEdit: 0
      }
    : {};
  const h7ToolCounts = includeH7
    ? {
        FileWrite: 1,
        FileRead: 0,
        FilePatch: 0,
        Bash: 0,
        FileEdit: 0
      }
    : {};
  const h8ToolCounts = includeH8
    ? {
        FileRead: 1,
        Bash: 1,
        FileWrite: 1,
        FilePatch: 0,
        FileEdit: 0
      }
    : {};
  const h9ToolCounts = includeH9
    ? {
        FileRead: 1,
        Bash: 1,
        FileWrite: 1,
        FilePatch: 0,
        FileEdit: 0
      }
    : {};
  const h10ToolCounts = includeH10
    ? {
        FileRead: 1,
        FileWrite: 1,
        Bash: 0,
        FilePatch: 0,
        FileEdit: 0
      }
    : {};
  const h8Tasks = overrides.h8Tasks ?? [
    {
      id: "h8-left-worker",
      role: "worker",
      prompt: "update left module",
      status: "completed",
      writeFiles: ["src/left.txt"]
    },
    {
      id: "h8-right-worker",
      role: "worker",
      prompt: "update right module",
      status: "completed",
      writeFiles: ["src/right.txt"]
    }
  ];
  const h8Claims = overrides.h8Claims ?? [
    {
      taskId: "h8-left-worker",
      filePath: "src/left.txt",
      ownerRole: "worker"
    },
    {
      taskId: "h8-right-worker",
      filePath: "src/right.txt",
      ownerRole: "worker"
    }
  ];
  const toolCallCount =
    overrides.toolCallCount ??
    Object.values(h1ToolCounts).reduce((sum, count) => sum + count, 0) +
      Object.values(h2ToolCounts).reduce((sum, count) => sum + count, 0) +
      Object.values(h3ToolCounts).reduce((sum, count) => sum + count, 0) +
      Object.values(h4ToolCounts).reduce((sum, count) => sum + count, 0) +
      Object.values(h5ToolCounts).reduce((sum, count) => sum + count, 0) +
      Object.values(h6ToolCounts).reduce((sum, count) => sum + count, 0) +
      Object.values(h7ToolCounts).reduce((sum, count) => sum + count, 0) +
      Object.values(h8ToolCounts).reduce((sum, count) => sum + count, 0) +
      Object.values(h9ToolCounts).reduce((sum, count) => sum + count, 0) +
      Object.values(h10ToolCounts).reduce((sum, count) => sum + count, 0);
  const uniqueToolCount = overrides.uniqueToolCount ?? (includeH4 ? 6 : includeH3 ? 4 : 3);
  const scenarioCount =
    1 +
    (includeH2 ? 1 : 0) +
    (includeH3 ? 1 : 0) +
    (includeH4 ? 1 : 0) +
    (includeH5 ? 1 : 0) +
    (includeH6 ? 1 : 0) +
    (includeH7 ? 1 : 0) +
    (includeH8 ? 1 : 0) +
    (includeH9 ? 1 : 0) +
    (includeH10 ? 1 : 0);
  const passed = status === "passed" ? scenarioCount : 0;
  const failed = status === "passed" ? 0 : scenarioCount;
  const normalStream = (eventCount: number) => ({
    providerRetrySeen: false,
    providerRetryCount: 0,
    providerFallbackSeen: false,
    sessionErrorSeen: false,
    completedStatus: "completed",
    eventCount
  });
  const harnessProvider = (callCount: number) =>
    providerSurface({ callCount, broken: overrides.providerToolSurfaceSeen === false });
  const scenarios: Record<string, unknown>[] = [
    {
      name: "H1 single-file bug fix",
      status,
      durationMs: 400,
      score: overrides.score ?? (status === "passed" ? 1 : 0),
      failureKind: status === "passed" ? null : "assertion",
      details: {
        taskId: "H1",
        taskClass: overrides.taskClass ?? "single_file_bug_fix",
        toolCounts: h1ToolCounts,
        provider: harnessProvider(5),
        assertions: Array.from({ length: h1Assertions }, (_, index) => `H1 assertion ${index + 1}`),
        filesVerified: Array.from(
          { length: h1FilesVerified },
          (_, index) => `H1 file ${index + 1}`
        ),
        changedFiles: overrides.changedFiles ?? ["src/discount.ts"],
        forbiddenChanges: overrides.forbiddenChanges ?? [],
        checksPassed: overrides.checksPassed ?? true,
        streamJsonLifecycleVerified: overrides.streamJsonLifecycleVerified ?? true,
        stream: normalStream(54),
        session: {
          messageCount: overrides.sessionMessages ?? 3,
          auditEventCount: overrides.auditEvents ?? 8
        },
        limitResults: {
          withinTime: overrides.withinTime ?? true,
          withinCommands: overrides.withinCommands ?? true,
          withinFileChanges: overrides.withinFileChanges ?? true
        }
      }
    }
  ];
  if (includeH2) {
    scenarios.push({
      name: "H2 multi-file dry-run feature",
      status,
      durationMs: 600,
      score: overrides.score ?? (status === "passed" ? 1 : 0),
      failureKind: status === "passed" ? null : "assertion",
      details: {
        taskId: "H2",
        taskClass: "multi_file_feature",
        toolCounts: h2ToolCounts,
        provider: harnessProvider(4),
        assertions: Array.from({ length: h2Assertions }, (_, index) => `H2 assertion ${index + 1}`),
        filesVerified: Array.from(
          { length: h2FilesVerified },
          (_, index) => `H2 file ${index + 1}`
        ),
        changedFiles: ["README.md", "src/cli.js", "src/store.js", "tests/cli.test.mjs"],
        forbiddenChanges: [],
        checksPassed: true,
        streamJsonLifecycleVerified: true,
        stream: normalStream(66),
        session: {
          messageCount: 3,
          auditEventCount: 8
        },
        limitResults: {
          withinTime: true,
          withinCommands: true,
          withinFileChanges: true
        }
      }
    });
  }
  if (includeH3) {
    scenarios.push({
      name: "H3 refactor behavior preservation",
      status,
      durationMs: 700,
      score: overrides.score ?? (status === "passed" ? 1 : 0),
      failureKind: status === "passed" ? null : "assertion",
      details: {
        taskId: "H3",
        taskClass: "behavior_preserving_refactor",
        toolCounts: h3ToolCounts,
        provider: harnessProvider(4),
        assertions: Array.from({ length: h3Assertions }, (_, index) => `H3 assertion ${index + 1}`),
        filesVerified: Array.from(
          { length: h3FilesVerified },
          (_, index) => `H3 file ${index + 1}`
        ),
        changedFiles: ["src/inventory.js", "src/parse.js", "src/sales.js"],
        forbiddenChanges: [],
        checksPassed: true,
        streamJsonLifecycleVerified: true,
        stream: normalStream(58),
        session: {
          messageCount: 3,
          auditEventCount: 8
        },
        limitResults: {
          withinTime: true,
          withinCommands: true,
          withinFileChanges: true
        }
      }
    });
  }
  if (includeH4) {
    scenarios.push({
      name: "H4 repository investigation",
      status,
      durationMs: 800,
      score: overrides.score ?? (status === "passed" ? 1 : 0),
      failureKind: status === "passed" ? null : "assertion",
      details: {
        taskId: "H4",
        taskClass: "repository_investigation_fix",
        toolCounts: h4ToolCounts,
        provider: harnessProvider(4),
        assertions: Array.from({ length: h4Assertions }, (_, index) => `H4 assertion ${index + 1}`),
        filesVerified: Array.from(
          { length: h4FilesVerified },
          (_, index) => `H4 file ${index + 1}`
        ),
        changedFiles: ["src/config/validate.js"],
        forbiddenChanges: [],
        checksPassed: true,
        streamJsonLifecycleVerified: true,
        stream: normalStream(62),
        session: {
          messageCount: 3,
          auditEventCount: 8
        },
        limitResults: {
          withinTime: true,
          withinCommands: true,
          withinFileChanges: true
        }
      }
    });
  }
  if (includeH5) {
    scenarios.push({
      name: "H5 permission boundary",
      status,
      durationMs: 800,
      score: overrides.score ?? (status === "passed" ? 1 : 0),
      failureKind: status === "passed" ? null : "assertion",
      details: {
        taskId: "H5",
        taskClass: "permission_boundary",
        toolCounts: h5ToolCounts,
        provider: harnessProvider(4),
        assertions: Array.from({ length: h5Assertions }, (_, index) => `H5 assertion ${index + 1}`),
        filesVerified: Array.from(
          { length: h5FilesVerified },
          (_, index) => `H5 file ${index + 1}`
        ),
        changedFiles: ["src/project-config.js"],
        forbiddenChanges: [],
        checksPassed: true,
        streamJsonLifecycleVerified: true,
        stream: normalStream(50),
        session: {
          messageCount: 3,
          auditEventCount: 8,
          failedToolReasons: [
            {
              target: "FileWrite",
              toolCallId: overrides.h5FailedToolCallId ?? "h5-attempt-outside-write",
              reason: "Path ../outside-sentinel.txt is outside allowed directories"
            }
          ]
        },
        limitResults: {
          withinTime: true,
          withinCommands: true,
          withinFileChanges: true
        }
      }
    });
  }
  if (includeH6) {
    scenarios.push({
      name: "H6 resume after interruption",
      status,
      durationMs: 1000,
      score: overrides.score ?? (status === "passed" ? 1 : 0),
      failureKind: status === "passed" ? null : "assertion",
      details: {
        taskId: "H6",
        taskClass: "resume_after_interruption",
        toolCounts: h6ToolCounts,
        provider: harnessProvider(7),
        assertions: Array.from({ length: h6Assertions }, (_, index) => `H6 assertion ${index + 1}`),
        filesVerified: Array.from(
          { length: h6FilesVerified },
          (_, index) => `H6 file ${index + 1}`
        ),
        changedFiles: ["reports/invoice-investigation.md", "src/invoice.js"],
        forbiddenChanges: [],
        checksPassed: true,
        streamJsonLifecycleVerified: true,
        session: {
          messageCount: 6,
          auditEventCount: 12
        },
        resume: {
          firstSessionId: "h6-session",
          resumedSessionId: "h6-session",
          sameSession: true,
          firstJobId: "h6-first",
          resumedJobId: "h6-resumed"
        },
        limitResults: {
          withinTime: true,
          withinCommands: true,
          withinFileChanges: true
        }
      }
    });
  }
  if (includeH7) {
    scenarios.push({
      name: "H7 stream-json automation",
      status,
      durationMs: 500,
      score: overrides.score ?? (status === "passed" ? 1 : 0),
      failureKind: status === "passed" ? null : "assertion",
      details: {
        taskId: "H7",
        taskClass: "stream_json_automation",
        toolCounts: h7ToolCounts,
        provider: harnessProvider(2),
        assertions: Array.from({ length: h7Assertions }, (_, index) => `H7 assertion ${index + 1}`),
        filesVerified: Array.from(
          { length: h7FilesVerified },
          (_, index) => `H7 file ${index + 1}`
        ),
        changedFiles: ["output/automation-result.txt"],
        forbiddenChanges: [],
        checksPassed: true,
        streamJsonLifecycleVerified: true,
        stream: {
          validNdjson: true,
          stderrEmpty: true,
          startedFirst: true,
          completedLast: true,
          userMessageSeen: true,
          assistantMessageSeen: true,
          toolStartedSeen: true,
          toolCompletedSeen: true,
          rawToolUseSeen: true,
          rawToolResultSeen: true,
          providerRetrySeen: overrides.h7ProviderRetrySeen ?? false,
          providerRetryCount: overrides.h7ProviderRetryCount ?? 0,
          providerFallbackSeen: overrides.h7ProviderFallbackSeen ?? false,
          sessionErrorSeen: false,
          completedMessage: "Created output/automation-result.txt.",
          completedStatus: "completed",
          finalMessageMatched: true,
          eventCount: overrides.h7EventCount ?? 22
        },
        session: {
          messageCount: 3,
          auditEventCount: 8
        },
        limitResults: {
          withinTime: true,
          withinCommands: true,
          withinFileChanges: true
        }
      }
    });
  }
  if (includeH8) {
    scenarios.push({
      name: "H8 multi-agent conflict",
      status,
      durationMs: 800,
      score: overrides.score ?? (status === "passed" ? 1 : 0),
      failureKind: status === "passed" ? null : "assertion",
      details: {
        taskId: "H8",
        taskClass: "multi_agent_conflict",
        toolCounts: h8ToolCounts,
        provider: harnessProvider(3),
        assertions: Array.from({ length: h8Assertions }, (_, index) => `H8 assertion ${index + 1}`),
        filesVerified: Array.from(
          { length: h8FilesVerified },
          (_, index) => `H8 file ${index + 1}`
        ),
        changedFiles: ["reports/agent-conflict-report.md"],
        forbiddenChanges: [],
        checksPassed: true,
        streamJsonLifecycleVerified: true,
        stream: normalStream(34),
        session: {
          messageCount: 3,
          auditEventCount: 8
        },
        agentQueue: {
          taskCount: 2,
          completedTaskCount: 2,
          workerTaskCount: 2,
          writeClaimCount: 2,
          writeClaimFiles: ["src/left.txt", "src/right.txt"],
          taskPrompts: overrides.h8TaskPrompts ?? ["update left module", "update right module"],
          tasks: h8Tasks,
          claims: h8Claims,
          conflictRejected: true
        },
        limitResults: {
          withinTime: true,
          withinCommands: true,
          withinFileChanges: true
        }
      }
    });
  }
  if (includeH9) {
    scenarios.push({
      name: "H9 Bash approval control",
      status,
      durationMs: 900,
      score: overrides.score ?? (status === "passed" ? 1 : 0),
      failureKind: status === "passed" ? null : "assertion",
      details: {
        taskId: "H9",
        taskClass: "bash_approval_control",
        toolCounts: h9ToolCounts,
        provider: harnessProvider(6),
        assertions: Array.from({ length: h9Assertions }, (_, index) => `H9 assertion ${index + 1}`),
        filesVerified: Array.from(
          { length: h9FilesVerified },
          (_, index) => `H9 file ${index + 1}`
        ),
        changedFiles: ["reports/bash-approval-report.md"],
        forbiddenChanges: [],
        checksPassed: true,
        streamJsonLifecycleVerified: true,
        stream: normalStream(34),
        session: {
          messageCount: 3,
          auditEventCount: 8
        },
        approval: {
          pendingCount: 1,
          resolvedCount: 1,
          controlResolvedCount: 1,
          completedBashToolCount: overrides.h9CompletedBashToolCount ?? 3,
          pendingToolUseId: overrides.h9PendingToolUseId ?? "h9-run-approved-bash",
          pendingCommand: "npm test",
          pendingTimeoutMs: 7000,
          pendingCwd: "/tmp/h9-fixture",
          approved: true,
          readOnlyBashCompleted: true,
          approvedBashCompleted: true,
          completedToolIds: overrides.h9CompletedToolIds ?? [
            "h9-readonly-pwd",
            "h9-run-approved-bash",
            "h9-run-control-approval-flow"
          ]
        },
        limitResults: {
          withinTime: true,
          withinCommands: true,
          withinFileChanges: true
        }
      }
    });
  }
  if (includeH10) {
    scenarios.push({
      name: "H10 provider retry fallback",
      status,
      durationMs: 850,
      score: overrides.score ?? (status === "passed" ? 1 : 0),
      failureKind: status === "passed" ? null : "assertion",
      details: {
        taskId: "H10",
        taskClass: "provider_retry_fallback",
        toolCounts: h10ToolCounts,
        provider: harnessProvider(5),
        assertions: Array.from(
          { length: h10Assertions },
          (_, index) => `H10 assertion ${index + 1}`
        ),
        filesVerified: Array.from(
          { length: h10FilesVerified },
          (_, index) => `H10 file ${index + 1}`
        ),
        changedFiles: ["reports/provider-retry-report.md"],
        forbiddenChanges: [],
        checksPassed: true,
        streamJsonLifecycleVerified: true,
        stream: {
          assistantMessageSeen: true,
          providerRetryCount: 2,
          providerFallbackSeen: true,
          sessionErrorSeen: false,
          eventCount: overrides.h10EventCount ?? 32
        },
        session: {
          messageCount: 3,
          auditEventCount: 8
        },
        providerRouting: {
          retryCount: 2,
          retryAttempts: [1, 2],
          fallbackCount: 1,
          retryProviders: ["openai"],
          retryErrorKinds: ["server-error"],
          fallbackFromProvider: "openai",
          fallbackErrorKind: "server-error",
          fallbackToProvider: "backup"
        },
        limitResults: {
          withinTime: true,
          withinCommands: true,
          withinFileChanges: true
        }
      }
    });
  }
  return {
    version: 1,
    name: "complex-task-harness",
    status,
    summary: {
      total: scenarioCount,
      passed,
      failed,
      successRate: overrides.successRate ?? (status === "passed" ? 1 : 0),
      score: overrides.score ?? (status === "passed" ? 1 : 0),
      providerCalls: 4 * scenarioCount,
      providerCallsPerScenario: 4,
      assertions,
      filesVerified,
      toolEfficiency: {
        toolCallCount,
        uniqueToolCount,
        toolCallsPerScenario: toolCallCount / scenarioCount,
        topTools: [
          {
            name: "FilePatch",
            count:
              h1ToolCounts.FilePatch +
              (h2ToolCounts.FilePatch ?? 0) +
              (h3ToolCounts.FilePatch ?? 0) +
              (h4ToolCounts.FilePatch ?? 0) +
              (h5ToolCounts.FilePatch ?? 0) +
              (h6ToolCounts.FilePatch ?? 0) +
              (h7ToolCounts.FilePatch ?? 0) +
              (h8ToolCounts.FilePatch ?? 0) +
              (h9ToolCounts.FilePatch ?? 0) +
              (h10ToolCounts.FilePatch ?? 0)
          },
          {
            name: "FileRead",
            count:
              h1ToolCounts.FileRead +
              (h2ToolCounts.FileRead ?? 0) +
              (h3ToolCounts.FileRead ?? 0) +
              (h4ToolCounts.FileRead ?? 0) +
              (h5ToolCounts.FileRead ?? 0) +
              (h6ToolCounts.FileRead ?? 0) +
              (h7ToolCounts.FileRead ?? 0) +
              (h8ToolCounts.FileRead ?? 0) +
              (h9ToolCounts.FileRead ?? 0) +
              (h10ToolCounts.FileRead ?? 0)
          },
          {
            name: "Bash",
            count:
              h1ToolCounts.Bash +
              (h2ToolCounts.Bash ?? 0) +
              (h3ToolCounts.Bash ?? 0) +
              (h4ToolCounts.Bash ?? 0) +
              (h5ToolCounts.Bash ?? 0) +
              (h6ToolCounts.Bash ?? 0) +
              (h7ToolCounts.Bash ?? 0) +
              (h8ToolCounts.Bash ?? 0) +
              (h9ToolCounts.Bash ?? 0) +
              (h10ToolCounts.Bash ?? 0)
          },
          {
            name: "FileWrite",
            count:
              h1ToolCounts.FileWrite +
              (h3ToolCounts.FileWrite ?? 0) +
              (h5ToolCounts.FileWrite ?? 0) +
              (h6ToolCounts.FileWrite ?? 0) +
              (h7ToolCounts.FileWrite ?? 0) +
              (h8ToolCounts.FileWrite ?? 0) +
              (h9ToolCounts.FileWrite ?? 0) +
              (h10ToolCounts.FileWrite ?? 0)
          },
          { name: "Glob", count: h4ToolCounts.Glob ?? 0 },
          { name: "Grep", count: h4ToolCounts.Grep ?? 0 }
        ]
      },
      regressions: Array.from({ length: overrides.regressions ?? 0 }, (_, index) => ({
        scenario: `complex regression ${index + 1}`,
        failureKind: "assertion"
      }))
    },
    scenarios
  };
}

function skillLearningAssertions(input: {
  skillLearningApplySeen?: boolean;
  skillPatchLearningSeen?: boolean;
  skillCorrectionSeen?: boolean;
  longCycleSkillIterationSeen?: boolean;
}): string[] {
  return [
    ...(input.skillLearningApplySeen === false
      ? []
      : [
          "skill learning draft reviewed",
          "skill learning draft applied",
          "learned skill recalled in model context"
        ]),
    ...(input.skillPatchLearningSeen === false
      ? []
      : [
          "skill patch learning draft reviewed",
          "skill patch learning draft applied",
          "patched skill recalled in model context"
        ]),
    ...(input.skillCorrectionSeen === false
      ? []
      : [
          "stale skill correction draft reviewed",
          "stale skill correction applied replacement",
          "corrected skill recalled without stale guidance"
        ]),
    ...(input.longCycleSkillIterationSeen === false
      ? []
      : [
          "iterative skill patch reviewed after correction",
          "iterative skill patch applied latest guidance",
          "mature skill recalled after multiple learning cycles"
        ])
  ];
}

function harnessGuardAssertions(input: { harnessCiTuiGuardSeen?: boolean }): string[] {
  return input.harnessCiTuiGuardSeen === false
    ? []
    : [
        "CI skips interactive TUI unless forced",
        "forced CI can opt into interactive TUI",
        "local opt-in can run interactive TUI",
        "hanging child commands time out and terminate"
      ];
}

function helpShapeAssertions(input: { helpShapeSeen?: boolean }): string[] {
  return input.helpShapeSeen === false
    ? []
    : [
        "help output grouped Usage Options Commands",
        "help output documented compatibility-shaped options",
        "help output documented command families",
        "help output documented unsupported legacy paths"
      ];
}

function textOutputProtocolAssertions(input: { textOutputProtocolSeen?: boolean }): string[] {
  return input.textOutputProtocolSeen === false
    ? []
    : [
        "text output default emitted final message only",
        "text output default hid session metadata",
        "text output verbose included session metadata"
      ];
}

function streamJsonProtocolAssertions(input: { streamJsonProtocolSeen?: boolean }): string[] {
  return input.streamJsonProtocolSeen === false
    ? []
    : [
        "stream-json emitted only JSON lines",
        "stream-json emitted user and assistant message events",
        "stream-json emitted tool started and completed events",
        "stream-json preserved raw agent events",
        "stream-json completed with status and final message"
      ];
}

function streamJsonExtendedProtocolAssertions(input: {
  streamJsonExtendedProtocolSeen?: boolean;
}): string[] {
  return input.streamJsonExtendedProtocolSeen === false
    ? []
    : [
        "stream-json emitted structured request started event",
        "stream-json emitted structured usage event",
        "stream-json emitted structured message delta event",
        "stream-json emitted structured user message event",
        "stream-json emitted structured approval request event",
        "stream-json emitted structured hook completed event",
        "stream-json emitted structured query done event",
        "stream-json preserved raw extended agent events",
        "stream-json extended protocol kept denied write from mutating workspace"
      ];
}

function jsonOutputProtocolAssertions(input: { jsonOutputProtocolSeen?: boolean }): string[] {
  return input.jsonOutputProtocolSeen === false
    ? []
    : [
        "json output emitted single object",
        "json output included session job status message",
        "json output included provider model usage",
        "json error output stayed JSON",
        "json error output included failure status and kind"
      ];
}

function barePromptHeadlessAssertions(input: { barePromptHeadlessSeen?: boolean }): string[] {
  return input.barePromptHeadlessSeen === false
    ? []
    : [
        "bare prompt argument entered headless provider path",
        "bare prompt stream-json emitted valid lifecycle events",
        "bare prompt headless session completed"
      ];
}

function headlessDefaultPermissionDeniedAssertions(input: {
  headlessDefaultPermissionDeniedSeen?: boolean;
}): string[] {
  return input.headlessDefaultPermissionDeniedSeen === false
    ? []
    : [
        "approval request emitted",
        "permission denial returned to model",
        "denied write did not mutate workspace",
        "default permission denial completed two-turn provider loop"
      ];
}

function headlessPlanModeAssertions(input: { headlessPlanModeSeen?: boolean }): string[] {
  return input.headlessPlanModeSeen === false
    ? []
    : ["write denied in plan mode", "ExitPlanMode surfaced plan", "plan review persisted"];
}

function controlApprovalFlowAssertions(input: { controlApprovalFlowSeen?: boolean }): string[] {
  return input.controlApprovalFlowSeen === false
    ? []
    : [
        "magi serve started from dist CLI",
        "phone pairing returned auth headers",
        "background job exposed pending approval",
        "SSE streamed pending and resolved approval events",
        "phone approval unblocked FileWrite",
        "control job completed and persisted audit events",
        "control approval flow completed two provider turns"
      ];
}

function providerRetryFallbackAssertions(input: { providerRetryFallbackSeen?: boolean }): string[] {
  return input.providerRetryFallbackSeen === false
    ? []
    : [
        "retry attempts exhausted on primary",
        "fallback event emitted",
        "backup model recovered",
        "retry fallback used one backup provider call"
      ];
}

function toolFeedbackRankingAssertions(input: { toolFeedbackRankingSeen?: boolean }): string[] {
  return input.toolFeedbackRankingSeen === false
    ? []
    : [
        "tool failures persisted",
        "tool successes persisted",
        "ToolSearch ranking used feedback",
        "ToolSearch recovery guidance visible",
        "ToolSearch feedback returned to model",
        "tool feedback ranking completed three-turn provider loop"
      ];
}

function memoryGraphLinkAssertions(input: { memoryGraphLinkSeen?: boolean }): string[] {
  return input.memoryGraphLinkSeen === false
    ? []
    : [
        "memory draft applied",
        "graph edge created",
        "linked neighbor retrieved through graph search",
        "memory graph sqlite persisted"
      ];
}

function memoryCorrectionMaintenanceAssertions(input: {
  memoryCorrectionMaintenanceSeen?: boolean;
}): string[] {
  return input.memoryCorrectionMaintenanceSeen === false
    ? []
    : [
        "stale memory retrieved before correction",
        "memory correct disputed old node",
        "replacement memory recalled through graph search",
        "disputed stale memory excluded from search results",
        "memory conflict audit view recommends active replacement",
        "memory dream suggests corrected stale graph cleanup",
        "memory dream apply archives corrected disputed graph node",
        "memory maintenance policy persisted and reused",
        "memory maintenance decayed stale node weights",
        "memory correction and maintenance audit persisted",
        "memory correction maintenance completed CLI lifecycle"
      ];
}

function tuiRequiresTtyAssertions(input: { tuiRequiresTtySeen?: boolean }): string[] {
  return input.tuiRequiresTtySeen === false
    ? []
    : [
        "non-TTY TUI exits clearly",
        "TTY requirement message emitted",
        "non-TTY TUI returned usage exit code"
      ];
}

function resumePickerTtyAssertions(input: { resumePickerTtySeen?: boolean }): string[] {
  return input.resumePickerTtySeen === false
    ? []
    : [
        "TTY -r rendered searchable session picker",
        "TTY -r filtered sessions by typed query",
        "TTY -r resumed selected session",
        "non-TTY -r session list remains available"
      ];
}

function slashResumeSearchTtyAssertions(input: { slashResumeSearchTtySeen?: boolean }): string[] {
  return input.slashResumeSearchTtySeen === false
    ? []
    : [
        "slash /resume opened searchable session picker",
        "slash /resume initial query filtered sessions",
        "slash /resume Enter resumed selected session",
        "slash /resume no-results state rendered",
        "slash /resume Escape returned without resuming"
      ];
}

function resumePickerSearchFieldsAssertions(input: {
  resumePickerSearchFieldsSeen?: boolean;
}): string[] {
  return input.resumePickerSearchFieldsSeen === false
    ? []
    : [
        "slash /resume filtered sessions by cwd detail",
        "slash /resume cwd search showed multiple matching sessions",
        "slash /resume cwd search excluded nonmatching session",
        "slash /resume partial session id resumed target"
      ];
}

function resumePickerVisualContractAssertions(input: {
  resumePickerVisualContractSeen?: boolean;
}): string[] {
  return input.resumePickerVisualContractSeen === false
    ? []
    : [
        "resume picker visual contract bounded narrow frame",
        "resume picker visual contract rendered selection and scroll position",
        "resume picker visual contract rendered filter prompt and footer",
        "resume picker visual contract clipped long session detail"
      ];
}

function toolPolicyAssertions(input: { toolPolicySeen?: boolean }): string[] {
  return input.toolPolicySeen === false
    ? []
    : [
        "--tools allow-list filtered exposed schemas",
        "--tools allow-list denied hidden write execution",
        "--disallowed-tools filtered exposed schemas",
        "--disallowed-tools denied requested tool execution",
        "--allowed-tools scoped selector allowed matching Bash command",
        "--allowed-tools scoped selector denied non-matching Bash command",
        "dontAsk mode denied non-read-only tool without writing",
        "acceptEdits mode allowed ordinary write without approval",
        "dangerous Bash denied outside bypassPermissions",
        "bypassPermissions dangerous Bash required explicit env approval",
        "bypassPermissions dangerous Bash ran with explicit env approval"
      ];
}

function dangerousPermissionMatrixAssertions(input: {
  dangerousPermissionMatrixSeen?: boolean;
}): string[] {
  return input.dangerousPermissionMatrixSeen === false
    ? []
    : [
        "dangerous Bash denied in default mode without approval",
        "dangerous Bash denied in acceptEdits mode",
        "dangerous Bash denied in dontAsk mode",
        "dangerous Bash denied in plan mode",
        "dangerous Bash bypassPermissions required explicit env approval",
        "dangerous Bash bypassPermissions executed only with explicit env approval",
        "dangerous permission matrix preserved denied sentinels",
        "dangerous permission matrix emitted stream-json tool evidence"
      ];
}

function slashSuggestionPromptAssertions(input: { slashSuggestionPromptSeen?: boolean }): string[] {
  return input.slashSuggestionPromptSeen === false
    ? []
    : [
        "slash suggestion menu rendered for slash input",
        "slash suggestion filtered command descriptions",
        "slash suggestion arrow selection submitted command",
        "slash suggestion enter submitted filtered command",
        "slash command coverage included context rules run extensions agents",
        "slash suggestion submitted extension command",
        "slash suggestion submitted command alias"
      ];
}

function tuiVisualContractAssertions(input: { tuiVisualContractSeen?: boolean }): string[] {
  return input.tuiVisualContractSeen === false
    ? []
    : [
        "TUI startup text hat rendered",
        "TUI startup banner width bounded",
        "slash suggestion visual contract stable",
        "TUI status pending approval rendered",
        "TUI status transcript width bounded"
      ];
}

function tuiKeyboardInputAssertions(input: { tuiKeyboardInputSeen?: boolean }): string[] {
  return input.tuiKeyboardInputSeen === false
    ? []
    : [
        "TUI keyboard editing submitted corrected multiline prompt",
        "TUI keyboard editing removed stale typed characters",
        "TUI keyboard editing reached provider exactly once",
        "TUI keyboard editing returned provider response and exited"
      ];
}

function tuiPromptHistoryAssertions(input: { tuiPromptHistorySeen?: boolean }): string[] {
  return input.tuiPromptHistorySeen === false
    ? []
    : [
        "TUI prompt history recalled previous prompt",
        "TUI prompt history edit submitted revised prompt",
        "TUI prompt history reached provider twice",
        "TUI prompt history rendered both provider responses"
      ];
}

function tuiBracketedPasteAssertions(input: { tuiBracketedPasteSeen?: boolean }): string[] {
  return input.tuiBracketedPasteSeen === false
    ? []
    : [
        "TUI bracketed paste rendered paste placeholder",
        "TUI bracketed paste restored full multiline prompt",
        "TUI bracketed paste hid raw pasted body from edit surface",
        "TUI bracketed paste reached provider once and exited"
      ];
}

function tuiStatefulPickersAssertions(input: { tuiStatefulPickersSeen?: boolean }): string[] {
  return input.tuiStatefulPickersSeen === false
    ? []
    : [
        "TUI model picker switched subsequent provider route",
        "TUI permission picker switched to plan mode",
        "TUI picker-selected plan mode denied write",
        "TUI picker flow left workspace unchanged",
        "TUI picker flow returned provider response and exited"
      ];
}

function tuiPickerKeyboardNavigationAssertions(input: {
  tuiPickerKeyboardNavigationSeen?: boolean;
}): string[] {
  return input.tuiPickerKeyboardNavigationSeen === false
    ? []
    : [
        "TUI picker keyboard Tab completed model filter",
        "TUI picker keyboard arrows selected permission mode",
        "TUI picker keyboard selected model routed provider",
        "TUI picker keyboard selected plan mode denied write",
        "TUI picker keyboard flow left workspace unchanged"
      ];
}

function tuiApprovalPickerAssertions(input: { tuiApprovalPickerSeen?: boolean }): string[] {
  return input.tuiApprovalPickerSeen === false
    ? []
    : [
        "TUI approval picker rendered pending FileWrite approval",
        "TUI approval picker hotkey denial resolved interaction",
        "TUI approval denial returned to model",
        "TUI approval denial left workspace unchanged",
        "TUI approval picker flow returned provider response and exited"
      ];
}

function tuiApprovalAllowPickerAssertions(input: {
  tuiApprovalAllowPickerSeen?: boolean;
}): string[] {
  return input.tuiApprovalAllowPickerSeen === false
    ? []
    : [
        "TUI approval allow picker rendered pending FileWrite approval",
        "TUI approval allow hotkey resolved interaction",
        "TUI approval allow returned write result to model",
        "TUI approval allow wrote approved file",
        "TUI approval allow flow returned provider response and exited"
      ];
}

function tuiApprovalAlwaysPickerAssertions(input: {
  tuiApprovalAlwaysPickerSeen?: boolean;
}): string[] {
  return input.tuiApprovalAlwaysPickerSeen === false
    ? []
    : [
        "TUI approval always picker rendered persistent approval action",
        "TUI approval always hotkey persisted FileWrite rule",
        "TUI approval always wrote initial approved file",
        "TUI approval always reused rule without second prompt",
        "TUI approval always returned second write result to model",
        "TUI approval always flow returned provider response and exited"
      ];
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
      fileWriteAvoided: boolean;
    };
    dependencyRefactor: {
      bashCalls: number;
      fileReadCalls: number;
      filePatchCalls: number;
      fileWriteCalls: number;
      fileEditCalls: number;
      fileWriteAvoided: boolean;
    };
    testDrivenRecovery: {
      bashCalls: number;
      fileReadCalls: number;
      filePatchCalls: number;
      fileWriteCalls: number;
      fileEditCalls: number;
      recoverySeen: boolean;
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
      fileWriteAvoided: boolean;
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
      fileWriteAvoided: boolean;
      fileEditAvoided: boolean;
      fileMoveRevealed: boolean;
      sourcePackageMoved: boolean;
      oldSourcePackagePathRemoved: boolean;
      generatedFileUntouched: boolean;
      monorepoPackageMigrationVerified: boolean;
    };
    workspacePolicyMigration: {
      bashCalls: number;
      fileReadCalls: number;
      filePatchCalls: number;
      fileWriteCalls: number;
      fileEditCalls: number;
      fileWriteAvoided: boolean;
      fileEditAvoided: boolean;
      configMigrated: boolean;
      packageScriptsMigrated: boolean;
      sourceMigrated: boolean;
      docsMigrated: boolean;
      generatedFileUntouched: boolean;
      vendorFileUntouched: boolean;
      workspacePolicyMigrationVerified: boolean;
    };
    mixedLanguageContractMigration: {
      bashCalls: number;
      fileReadCalls: number;
      filePatchCalls: number;
      fileWriteCalls: number;
      fileEditCalls: number;
      fileWriteAvoided: boolean;
      fileEditAvoided: boolean;
      tsContractMigrated: boolean;
      pythonContractMigrated: boolean;
      docsContractMigrated: boolean;
      generatedClientUntouched: boolean;
      mixedLanguageContractVerified: boolean;
    };
    largeRepoLongChainMigration: {
      bashCalls: number;
      globCalls: number;
      grepCalls: number;
      fileReadCalls: number;
      filePatchCalls: number;
      fileWriteCalls: number;
      fileEditCalls: number;
      fileWriteAvoided: boolean;
      fileEditAvoided: boolean;
      repoDiscoveryVerified: boolean;
      sourceContractsMigrated: boolean;
      docsMigrated: boolean;
      oldOwnedReferencesRemoved: boolean;
      generatedClientUntouched: boolean;
      vendorShimUntouched: boolean;
      largeRepoLongChainVerified: boolean;
    };
    pluginApiCompatibilityMigration: {
      bashCalls: number;
      globCalls: number;
      grepCalls: number;
      fileReadCalls: number;
      filePatchCalls: number;
      fileWriteCalls: number;
      fileEditCalls: number;
      fileWriteAvoided: boolean;
      fileEditAvoided: boolean;
      pluginApiRepoDiscoveryVerified: boolean;
      pluginRuntimeMigrated: boolean;
      firstPartyPluginsMigrated: boolean;
      legacyAdapterCompatibilityPreserved: boolean;
      examplesDocsChangelogMigrated: boolean;
      oldOwnedHookReferencesRemoved: boolean;
      generatedPluginTypesUntouched: boolean;
      vendorPluginShimUntouched: boolean;
      pluginApiCompatibilityVerified: boolean;
    };
    ossStyleOpenSourceMigration: {
      bashCalls: number;
      globCalls: number;
      grepCalls: number;
      fileReadCalls: number;
      filePatchCalls: number;
      fileWriteCalls: number;
      fileEditCalls: number;
      fileWriteAvoided: boolean;
      fileEditAvoided: boolean;
      ossRepoDiscoveryVerified: boolean;
      coreContractsMigrated: boolean;
      pluginContractsMigrated: boolean;
      examplesDocsChangelogMigrated: boolean;
      oldOwnedOptionReferencesRemoved: boolean;
      generatedOptionsUntouched: boolean;
      vendorOptionsUntouched: boolean;
      ossStyleMigrationVerified: boolean;
    };
    securityMiddlewarePolicyMigration: {
      bashCalls: number;
      globCalls: number;
      grepCalls: number;
      fileReadCalls: number;
      filePatchCalls: number;
      fileWriteCalls: number;
      fileEditCalls: number;
      fileWriteAvoided: boolean;
      fileEditAvoided: boolean;
      securityPolicyRepoDiscoveryVerified: boolean;
      securityPolicyConfigMigrated: boolean;
      securityMiddlewareMigrated: boolean;
      securityClientMigrated: boolean;
      securityExamplesDocsChangelogMigrated: boolean;
      oldOwnedSecurityReferencesRemoved: boolean;
      generatedSecuritySchemaUntouched: boolean;
      vendorSecurityShimUntouched: boolean;
      securityMiddlewarePolicyVerified: boolean;
    };
    ossIssueRegressionFix: {
      bashCalls: number;
      globCalls: number;
      grepCalls: number;
      fileReadCalls: number;
      filePatchCalls: number;
      fileWriteCalls: number;
      fileEditCalls: number;
      fileWriteAvoided: boolean;
      fileEditAvoided: boolean;
      ossIssueRegressionTaskSeen: boolean;
      issueReportReadBeforePatch: boolean;
      issueRegressionReproduced: boolean;
      coreUrlEncodingFixed: boolean;
      clientUrlEncodingFixed: boolean;
      pluginUrlEncodingFixed: boolean;
      issueDocsChangelogUpdated: boolean;
      generatedOpenapiUntouched: boolean;
      vendorRouteUntouched: boolean;
      issueRegressionVerified: boolean;
    };
    ossSecurityAdvisoryFix: {
      bashCalls: number;
      globCalls: number;
      grepCalls: number;
      fileReadCalls: number;
      filePatchCalls: number;
      fileWriteCalls: number;
      fileEditCalls: number;
      fileWriteAvoided: boolean;
      fileEditAvoided: boolean;
      securityAdvisoryReadBeforePatch: boolean;
      securityAdvisoryReproduced: boolean;
      sessionCookieDefaultsHardened: boolean;
      clientCookieSummaryUpdated: boolean;
      sessionExampleUpdated: boolean;
      sessionSecurityDocsChangelogUpdated: boolean;
      generatedCookieSchemaUntouched: boolean;
      vendorCookieShimUntouched: boolean;
      securityAdvisoryVerified: boolean;
    };
    ciFailureDiagnosisFix: {
      bashCalls: number;
      globCalls: number;
      grepCalls: number;
      fileReadCalls: number;
      filePatchCalls: number;
      fileWriteCalls: number;
      fileEditCalls: number;
      fileWriteAvoided: boolean;
      fileEditAvoided: boolean;
      ciWorkflowReadBeforePatch: boolean;
      ciFailureLogReadBeforePatch: boolean;
      ciFailureReproduced: boolean;
      releaseSlugFixed: boolean;
      projectPathEncodingFixed: boolean;
      ciDocsChangelogUpdated: boolean;
      generatedRouteSchemaUntouched: boolean;
      vendorSlugShimUntouched: boolean;
      ciFailureVerified: boolean;
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
    "monorepo_generated_boundary",
    "workspace_policy_migration",
    "mixed_language_contract_migration",
    "large_repo_long_chain_migration",
    "plugin_api_compatibility_migration",
    "security_middleware_policy_migration",
    "oss_security_advisory_fix",
    "ci_failure_diagnosis_fix",
    "oss_issue_regression_fix",
    "oss_style_open_source_migration"
  ];
  const patchStrategy = overrides.patchStrategy ?? {
    filePatchCalls: 1,
    fileEditCalls: 1,
    fileWriteCalls: 0,
    patchUsageRate: 0.5,
    fileWriteAvoided: true
  };
  const dependencyRefactor = overrides.dependencyRefactor ?? {
    bashCalls: 2,
    fileReadCalls: 2,
    filePatchCalls: 2,
    fileWriteCalls: 0,
    fileEditCalls: 0,
    fileWriteAvoided: true
  };
  const testDrivenRecovery = overrides.testDrivenRecovery ?? {
    bashCalls: 2,
    fileReadCalls: 1,
    filePatchCalls: 2,
    fileWriteCalls: 1,
    fileEditCalls: 0,
    recoverySeen: true
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
    fileWriteAvoided: true,
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
    fileWriteAvoided: true,
    fileEditAvoided: true,
    fileMoveRevealed: true,
    sourcePackageMoved: true,
    oldSourcePackagePathRemoved: true,
    generatedFileUntouched: true,
    monorepoPackageMigrationVerified: true
  };
  const workspacePolicyMigration = overrides.workspacePolicyMigration ?? {
    bashCalls: 2,
    fileReadCalls: 8,
    filePatchCalls: 6,
    fileWriteCalls: 0,
    fileEditCalls: 0,
    fileWriteAvoided: true,
    fileEditAvoided: true,
    configMigrated: true,
    packageScriptsMigrated: true,
    sourceMigrated: true,
    docsMigrated: true,
    generatedFileUntouched: true,
    vendorFileUntouched: true,
    workspacePolicyMigrationVerified: true
  };
  const mixedLanguageContractMigration = overrides.mixedLanguageContractMigration ?? {
    bashCalls: 2,
    fileReadCalls: 4,
    filePatchCalls: 3,
    fileWriteCalls: 0,
    fileEditCalls: 0,
    fileWriteAvoided: true,
    fileEditAvoided: true,
    tsContractMigrated: true,
    pythonContractMigrated: true,
    docsContractMigrated: true,
    generatedClientUntouched: true,
    mixedLanguageContractVerified: true
  };
  const largeRepoLongChainMigration = overrides.largeRepoLongChainMigration ?? {
    bashCalls: 2,
    globCalls: 1,
    grepCalls: 1,
    fileReadCalls: 12,
    filePatchCalls: 9,
    fileWriteCalls: 0,
    fileEditCalls: 0,
    fileWriteAvoided: true,
    fileEditAvoided: true,
    repoDiscoveryVerified: true,
    sourceContractsMigrated: true,
    docsMigrated: true,
    oldOwnedReferencesRemoved: true,
    generatedClientUntouched: true,
    vendorShimUntouched: true,
    largeRepoLongChainVerified: true
  };
  const pluginApiCompatibilityMigration = overrides.pluginApiCompatibilityMigration ?? {
    bashCalls: 2,
    globCalls: 1,
    grepCalls: 1,
    fileReadCalls: 10,
    filePatchCalls: 7,
    fileWriteCalls: 0,
    fileEditCalls: 0,
    fileWriteAvoided: true,
    fileEditAvoided: true,
    pluginApiRepoDiscoveryVerified: true,
    pluginRuntimeMigrated: true,
    firstPartyPluginsMigrated: true,
    legacyAdapterCompatibilityPreserved: true,
    examplesDocsChangelogMigrated: true,
    oldOwnedHookReferencesRemoved: true,
    generatedPluginTypesUntouched: true,
    vendorPluginShimUntouched: true,
    pluginApiCompatibilityVerified: true
  };
  const ossStyleOpenSourceMigration = overrides.ossStyleOpenSourceMigration ?? {
    bashCalls: 2,
    globCalls: 1,
    grepCalls: 1,
    fileReadCalls: 10,
    filePatchCalls: 7,
    fileWriteCalls: 0,
    fileEditCalls: 0,
    fileWriteAvoided: true,
    fileEditAvoided: true,
    ossRepoDiscoveryVerified: true,
    coreContractsMigrated: true,
    pluginContractsMigrated: true,
    examplesDocsChangelogMigrated: true,
    oldOwnedOptionReferencesRemoved: true,
    generatedOptionsUntouched: true,
    vendorOptionsUntouched: true,
    ossStyleMigrationVerified: true
  };
  const securityMiddlewarePolicyMigration = overrides.securityMiddlewarePolicyMigration ?? {
    bashCalls: 2,
    globCalls: 1,
    grepCalls: 1,
    fileReadCalls: 10,
    filePatchCalls: 7,
    fileWriteCalls: 0,
    fileEditCalls: 0,
    fileWriteAvoided: true,
    fileEditAvoided: true,
    securityPolicyRepoDiscoveryVerified: true,
    securityPolicyConfigMigrated: true,
    securityMiddlewareMigrated: true,
    securityClientMigrated: true,
    securityExamplesDocsChangelogMigrated: true,
    oldOwnedSecurityReferencesRemoved: true,
    generatedSecuritySchemaUntouched: true,
    vendorSecurityShimUntouched: true,
    securityMiddlewarePolicyVerified: true
  };
  const ossIssueRegressionFix = overrides.ossIssueRegressionFix ?? {
    bashCalls: 2,
    globCalls: 1,
    grepCalls: 1,
    fileReadCalls: 9,
    filePatchCalls: 5,
    fileWriteCalls: 0,
    fileEditCalls: 0,
    fileWriteAvoided: true,
    fileEditAvoided: true,
    ossIssueRegressionTaskSeen: true,
    issueReportReadBeforePatch: true,
    issueRegressionReproduced: true,
    coreUrlEncodingFixed: true,
    clientUrlEncodingFixed: true,
    pluginUrlEncodingFixed: true,
    issueDocsChangelogUpdated: true,
    generatedOpenapiUntouched: true,
    vendorRouteUntouched: true,
    issueRegressionVerified: true
  };
  const ossSecurityAdvisoryFix = overrides.ossSecurityAdvisoryFix ?? {
    bashCalls: 2,
    globCalls: 1,
    grepCalls: 1,
    fileReadCalls: 9,
    filePatchCalls: 5,
    fileWriteCalls: 0,
    fileEditCalls: 0,
    fileWriteAvoided: true,
    fileEditAvoided: true,
    securityAdvisoryReadBeforePatch: true,
    securityAdvisoryReproduced: true,
    sessionCookieDefaultsHardened: true,
    clientCookieSummaryUpdated: true,
    sessionExampleUpdated: true,
    sessionSecurityDocsChangelogUpdated: true,
    generatedCookieSchemaUntouched: true,
    vendorCookieShimUntouched: true,
    securityAdvisoryVerified: true
  };
  const ciFailureDiagnosisFix = overrides.ciFailureDiagnosisFix ?? {
    bashCalls: 2,
    globCalls: 1,
    grepCalls: 1,
    fileReadCalls: 8,
    filePatchCalls: 3,
    fileWriteCalls: 0,
    fileEditCalls: 0,
    fileWriteAvoided: true,
    fileEditAvoided: true,
    ciWorkflowReadBeforePatch: true,
    ciFailureLogReadBeforePatch: true,
    ciFailureReproduced: true,
    releaseSlugFixed: true,
    projectPathEncodingFixed: true,
    ciDocsChangelogUpdated: true,
    generatedRouteSchemaUntouched: true,
    vendorSlugShimUntouched: true,
    ciFailureVerified: true
  };
  const total = overrides.scenarios ?? taskClasses.length;
  const report = harnessReport({
    name: "model-task-benchmark",
    scenarios: total,
    providerCalls: overrides.providerCalls ?? 17,
    assertions: overrides.assertions ?? 237,
    filesVerified: overrides.filesVerified ?? 107,
    toolCallCount: overrides.toolCallCount ?? 223,
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
              patchUsageRate: patchStrategy.patchUsageRate,
              fileWriteAvoided: patchStrategy.fileWriteAvoided
            }
          : {}),
        ...(taskClasses[index] === "dependency_refactor"
          ? {
              toolCounts: {
                Bash: dependencyRefactor.bashCalls,
                FileRead: dependencyRefactor.fileReadCalls,
                FilePatch: dependencyRefactor.filePatchCalls,
                FileWrite: dependencyRefactor.fileWriteCalls,
                FileEdit: dependencyRefactor.fileEditCalls
              },
              fileWriteAvoided: dependencyRefactor.fileWriteAvoided
            }
          : {}),
        ...(taskClasses[index] === "test_driven_recovery"
          ? {
              toolCounts: {
                Bash: testDrivenRecovery.bashCalls,
                FileRead: testDrivenRecovery.fileReadCalls,
                FilePatch: testDrivenRecovery.filePatchCalls,
                FileWrite: testDrivenRecovery.fileWriteCalls,
                FileEdit: testDrivenRecovery.fileEditCalls
              },
              recoverySeen: testDrivenRecovery.recoverySeen
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
              fileWriteAvoided: apiMigration.fileWriteAvoided,
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
              fileWriteAvoided: monorepoGeneratedBoundary.fileWriteAvoided,
              fileMoveRevealed: monorepoGeneratedBoundary.fileMoveRevealed,
              sourcePackageMoved: monorepoGeneratedBoundary.sourcePackageMoved,
              oldSourcePackagePathRemoved: monorepoGeneratedBoundary.oldSourcePackagePathRemoved,
              generatedFileUntouched: monorepoGeneratedBoundary.generatedFileUntouched,
              fileEditAvoided: monorepoGeneratedBoundary.fileEditAvoided,
              monorepoPackageMigrationVerified:
                monorepoGeneratedBoundary.monorepoPackageMigrationVerified
            }
          : {}),
        ...(taskClasses[index] === "workspace_policy_migration"
          ? {
              toolCounts: {
                Bash: workspacePolicyMigration.bashCalls,
                FileRead: workspacePolicyMigration.fileReadCalls,
                FilePatch: workspacePolicyMigration.filePatchCalls,
                FileWrite: workspacePolicyMigration.fileWriteCalls,
                FileEdit: workspacePolicyMigration.fileEditCalls
              },
              configMigrated: workspacePolicyMigration.configMigrated,
              packageScriptsMigrated: workspacePolicyMigration.packageScriptsMigrated,
              sourceMigrated: workspacePolicyMigration.sourceMigrated,
              docsMigrated: workspacePolicyMigration.docsMigrated,
              generatedFileUntouched: workspacePolicyMigration.generatedFileUntouched,
              vendorFileUntouched: workspacePolicyMigration.vendorFileUntouched,
              fileWriteAvoided: workspacePolicyMigration.fileWriteAvoided,
              fileEditAvoided: workspacePolicyMigration.fileEditAvoided,
              workspacePolicyMigrationVerified:
                workspacePolicyMigration.workspacePolicyMigrationVerified
            }
          : {}),
        ...(taskClasses[index] === "mixed_language_contract_migration"
          ? {
              toolCounts: {
                Bash: mixedLanguageContractMigration.bashCalls,
                FileRead: mixedLanguageContractMigration.fileReadCalls,
                FilePatch: mixedLanguageContractMigration.filePatchCalls,
                FileWrite: mixedLanguageContractMigration.fileWriteCalls,
                FileEdit: mixedLanguageContractMigration.fileEditCalls
              },
              tsContractMigrated: mixedLanguageContractMigration.tsContractMigrated,
              pythonContractMigrated: mixedLanguageContractMigration.pythonContractMigrated,
              docsContractMigrated: mixedLanguageContractMigration.docsContractMigrated,
              generatedClientUntouched: mixedLanguageContractMigration.generatedClientUntouched,
              fileWriteAvoided: mixedLanguageContractMigration.fileWriteAvoided,
              fileEditAvoided: mixedLanguageContractMigration.fileEditAvoided,
              mixedLanguageContractVerified:
                mixedLanguageContractMigration.mixedLanguageContractVerified
            }
          : {}),
        ...(taskClasses[index] === "large_repo_long_chain_migration"
          ? {
              toolCounts: {
                Bash: largeRepoLongChainMigration.bashCalls,
                Glob: largeRepoLongChainMigration.globCalls,
                Grep: largeRepoLongChainMigration.grepCalls,
                FileRead: largeRepoLongChainMigration.fileReadCalls,
                FilePatch: largeRepoLongChainMigration.filePatchCalls,
                FileWrite: largeRepoLongChainMigration.fileWriteCalls,
                FileEdit: largeRepoLongChainMigration.fileEditCalls
              },
              repoDiscoveryVerified: largeRepoLongChainMigration.repoDiscoveryVerified,
              sourceContractsMigrated: largeRepoLongChainMigration.sourceContractsMigrated,
              docsMigrated: largeRepoLongChainMigration.docsMigrated,
              oldOwnedReferencesRemoved: largeRepoLongChainMigration.oldOwnedReferencesRemoved,
              generatedClientUntouched: largeRepoLongChainMigration.generatedClientUntouched,
              vendorShimUntouched: largeRepoLongChainMigration.vendorShimUntouched,
              fileWriteAvoided: largeRepoLongChainMigration.fileWriteAvoided,
              fileEditAvoided: largeRepoLongChainMigration.fileEditAvoided,
              largeRepoLongChainVerified: largeRepoLongChainMigration.largeRepoLongChainVerified
            }
          : {}),
        ...(taskClasses[index] === "plugin_api_compatibility_migration"
          ? {
              toolCounts: {
                Bash: pluginApiCompatibilityMigration.bashCalls,
                Glob: pluginApiCompatibilityMigration.globCalls,
                Grep: pluginApiCompatibilityMigration.grepCalls,
                FileRead: pluginApiCompatibilityMigration.fileReadCalls,
                FilePatch: pluginApiCompatibilityMigration.filePatchCalls,
                FileWrite: pluginApiCompatibilityMigration.fileWriteCalls,
                FileEdit: pluginApiCompatibilityMigration.fileEditCalls
              },
              pluginApiRepoDiscoveryVerified:
                pluginApiCompatibilityMigration.pluginApiRepoDiscoveryVerified,
              pluginRuntimeMigrated: pluginApiCompatibilityMigration.pluginRuntimeMigrated,
              firstPartyPluginsMigrated: pluginApiCompatibilityMigration.firstPartyPluginsMigrated,
              legacyAdapterCompatibilityPreserved:
                pluginApiCompatibilityMigration.legacyAdapterCompatibilityPreserved,
              examplesDocsChangelogMigrated:
                pluginApiCompatibilityMigration.examplesDocsChangelogMigrated,
              oldOwnedHookReferencesRemoved:
                pluginApiCompatibilityMigration.oldOwnedHookReferencesRemoved,
              generatedPluginTypesUntouched:
                pluginApiCompatibilityMigration.generatedPluginTypesUntouched,
              vendorPluginShimUntouched: pluginApiCompatibilityMigration.vendorPluginShimUntouched,
              fileWriteAvoided: pluginApiCompatibilityMigration.fileWriteAvoided,
              fileEditAvoided: pluginApiCompatibilityMigration.fileEditAvoided,
              pluginApiCompatibilityVerified:
                pluginApiCompatibilityMigration.pluginApiCompatibilityVerified
            }
          : {}),
        ...(taskClasses[index] === "oss_style_open_source_migration"
          ? {
              toolCounts: {
                Bash: ossStyleOpenSourceMigration.bashCalls,
                Glob: ossStyleOpenSourceMigration.globCalls,
                Grep: ossStyleOpenSourceMigration.grepCalls,
                FileRead: ossStyleOpenSourceMigration.fileReadCalls,
                FilePatch: ossStyleOpenSourceMigration.filePatchCalls,
                FileWrite: ossStyleOpenSourceMigration.fileWriteCalls,
                FileEdit: ossStyleOpenSourceMigration.fileEditCalls
              },
              ossRepoDiscoveryVerified: ossStyleOpenSourceMigration.ossRepoDiscoveryVerified,
              coreContractsMigrated: ossStyleOpenSourceMigration.coreContractsMigrated,
              pluginContractsMigrated: ossStyleOpenSourceMigration.pluginContractsMigrated,
              examplesDocsChangelogMigrated:
                ossStyleOpenSourceMigration.examplesDocsChangelogMigrated,
              oldOwnedOptionReferencesRemoved:
                ossStyleOpenSourceMigration.oldOwnedOptionReferencesRemoved,
              generatedOptionsUntouched: ossStyleOpenSourceMigration.generatedOptionsUntouched,
              vendorOptionsUntouched: ossStyleOpenSourceMigration.vendorOptionsUntouched,
              fileWriteAvoided: ossStyleOpenSourceMigration.fileWriteAvoided,
              fileEditAvoided: ossStyleOpenSourceMigration.fileEditAvoided,
              ossStyleMigrationVerified: ossStyleOpenSourceMigration.ossStyleMigrationVerified
            }
          : {}),
        ...(taskClasses[index] === "security_middleware_policy_migration"
          ? {
              toolCounts: {
                Bash: securityMiddlewarePolicyMigration.bashCalls,
                Glob: securityMiddlewarePolicyMigration.globCalls,
                Grep: securityMiddlewarePolicyMigration.grepCalls,
                FileRead: securityMiddlewarePolicyMigration.fileReadCalls,
                FilePatch: securityMiddlewarePolicyMigration.filePatchCalls,
                FileWrite: securityMiddlewarePolicyMigration.fileWriteCalls,
                FileEdit: securityMiddlewarePolicyMigration.fileEditCalls
              },
              securityPolicyRepoDiscoveryVerified:
                securityMiddlewarePolicyMigration.securityPolicyRepoDiscoveryVerified,
              securityPolicyConfigMigrated:
                securityMiddlewarePolicyMigration.securityPolicyConfigMigrated,
              securityMiddlewareMigrated:
                securityMiddlewarePolicyMigration.securityMiddlewareMigrated,
              securityClientMigrated: securityMiddlewarePolicyMigration.securityClientMigrated,
              securityExamplesDocsChangelogMigrated:
                securityMiddlewarePolicyMigration.securityExamplesDocsChangelogMigrated,
              oldOwnedSecurityReferencesRemoved:
                securityMiddlewarePolicyMigration.oldOwnedSecurityReferencesRemoved,
              generatedSecuritySchemaUntouched:
                securityMiddlewarePolicyMigration.generatedSecuritySchemaUntouched,
              vendorSecurityShimUntouched:
                securityMiddlewarePolicyMigration.vendorSecurityShimUntouched,
              fileWriteAvoided: securityMiddlewarePolicyMigration.fileWriteAvoided,
              fileEditAvoided: securityMiddlewarePolicyMigration.fileEditAvoided,
              securityMiddlewarePolicyVerified:
                securityMiddlewarePolicyMigration.securityMiddlewarePolicyVerified
            }
          : {}),
        ...(taskClasses[index] === "oss_issue_regression_fix"
          ? {
              toolCounts: {
                Bash: ossIssueRegressionFix.bashCalls,
                Glob: ossIssueRegressionFix.globCalls,
                Grep: ossIssueRegressionFix.grepCalls,
                FileRead: ossIssueRegressionFix.fileReadCalls,
                FilePatch: ossIssueRegressionFix.filePatchCalls,
                FileWrite: ossIssueRegressionFix.fileWriteCalls,
                FileEdit: ossIssueRegressionFix.fileEditCalls
              },
              fileWriteAvoided: ossIssueRegressionFix.fileWriteAvoided,
              fileEditAvoided: ossIssueRegressionFix.fileEditAvoided,
              ossIssueRegressionTaskSeen: ossIssueRegressionFix.ossIssueRegressionTaskSeen,
              issueReportReadBeforePatch: ossIssueRegressionFix.issueReportReadBeforePatch,
              issueRegressionReproduced: ossIssueRegressionFix.issueRegressionReproduced,
              coreUrlEncodingFixed: ossIssueRegressionFix.coreUrlEncodingFixed,
              clientUrlEncodingFixed: ossIssueRegressionFix.clientUrlEncodingFixed,
              pluginUrlEncodingFixed: ossIssueRegressionFix.pluginUrlEncodingFixed,
              issueDocsChangelogUpdated: ossIssueRegressionFix.issueDocsChangelogUpdated,
              generatedOpenapiUntouched: ossIssueRegressionFix.generatedOpenapiUntouched,
              vendorRouteUntouched: ossIssueRegressionFix.vendorRouteUntouched,
              issueRegressionVerified: ossIssueRegressionFix.issueRegressionVerified
            }
          : {}),
        ...(taskClasses[index] === "oss_security_advisory_fix"
          ? {
              toolCounts: {
                Bash: ossSecurityAdvisoryFix.bashCalls,
                Glob: ossSecurityAdvisoryFix.globCalls,
                Grep: ossSecurityAdvisoryFix.grepCalls,
                FileRead: ossSecurityAdvisoryFix.fileReadCalls,
                FilePatch: ossSecurityAdvisoryFix.filePatchCalls,
                FileWrite: ossSecurityAdvisoryFix.fileWriteCalls,
                FileEdit: ossSecurityAdvisoryFix.fileEditCalls
              },
              fileWriteAvoided: ossSecurityAdvisoryFix.fileWriteAvoided,
              fileEditAvoided: ossSecurityAdvisoryFix.fileEditAvoided,
              securityAdvisoryReadBeforePatch:
                ossSecurityAdvisoryFix.securityAdvisoryReadBeforePatch,
              securityAdvisoryReproduced: ossSecurityAdvisoryFix.securityAdvisoryReproduced,
              sessionCookieDefaultsHardened: ossSecurityAdvisoryFix.sessionCookieDefaultsHardened,
              clientCookieSummaryUpdated: ossSecurityAdvisoryFix.clientCookieSummaryUpdated,
              sessionExampleUpdated: ossSecurityAdvisoryFix.sessionExampleUpdated,
              sessionSecurityDocsChangelogUpdated:
                ossSecurityAdvisoryFix.sessionSecurityDocsChangelogUpdated,
              generatedCookieSchemaUntouched: ossSecurityAdvisoryFix.generatedCookieSchemaUntouched,
              vendorCookieShimUntouched: ossSecurityAdvisoryFix.vendorCookieShimUntouched,
              securityAdvisoryVerified: ossSecurityAdvisoryFix.securityAdvisoryVerified
            }
          : {}),
        ...(taskClasses[index] === "ci_failure_diagnosis_fix"
          ? {
              toolCounts: {
                Bash: ciFailureDiagnosisFix.bashCalls,
                Glob: ciFailureDiagnosisFix.globCalls,
                Grep: ciFailureDiagnosisFix.grepCalls,
                FileRead: ciFailureDiagnosisFix.fileReadCalls,
                FilePatch: ciFailureDiagnosisFix.filePatchCalls,
                FileWrite: ciFailureDiagnosisFix.fileWriteCalls,
                FileEdit: ciFailureDiagnosisFix.fileEditCalls
              },
              fileWriteAvoided: ciFailureDiagnosisFix.fileWriteAvoided,
              fileEditAvoided: ciFailureDiagnosisFix.fileEditAvoided,
              ciWorkflowReadBeforePatch: ciFailureDiagnosisFix.ciWorkflowReadBeforePatch,
              ciFailureLogReadBeforePatch: ciFailureDiagnosisFix.ciFailureLogReadBeforePatch,
              ciFailureReproduced: ciFailureDiagnosisFix.ciFailureReproduced,
              releaseSlugFixed: ciFailureDiagnosisFix.releaseSlugFixed,
              projectPathEncodingFixed: ciFailureDiagnosisFix.projectPathEncodingFixed,
              ciDocsChangelogUpdated: ciFailureDiagnosisFix.ciDocsChangelogUpdated,
              generatedRouteSchemaUntouched: ciFailureDiagnosisFix.generatedRouteSchemaUntouched,
              vendorSlugShimUntouched: ciFailureDiagnosisFix.vendorSlugShimUntouched,
              ciFailureVerified: ciFailureDiagnosisFix.ciFailureVerified
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
  conversationIdentityRecallSeen?: boolean;
  dreamConflictGroupLifecycleSeen?: boolean;
  naturalLanguageCorrectionSeen?: boolean;
  correctedMemoryConversationRecallSeen?: boolean;
  graphEdgeReinforcementSeen?: boolean;
  userFeedbackTrendSeen?: boolean;
  longCycleFeedbackTrendSeen?: boolean;
  longProjectFeedbackConvergenceSeen?: boolean;
  longProjectLearningDraftRecallSeen?: boolean;
  autonomousLearningCycleSeen?: boolean;
  staleKnowledgeDemotionSeen?: boolean;
  crossNodeRecommendationSeen?: boolean;
  projectCaseRecallSeen?: boolean;
  multiProjectConflictRecallSeen?: boolean;
  multilingualProjectRecallSeen?: boolean;
  multiNodeSupersededCleanupSeen?: boolean;
  maintenanceConfigBoundarySeen?: boolean;
  resultEvidenceSeen?: boolean;
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
        ]),
    ...(input.multilingualProjectRecallSeen === false
      ? []
      : [
          "Spanish preference recalls concise verification",
          "French project rule recalls recette validation",
          "Japanese project rule recalls approval"
        ])
  ];
  const total = names.length;
  const resultEvidenceSeen = input.resultEvidenceSeen !== false;
  const results = names.map((name, index) => {
    const resultEvidencePassed = resultEvidenceSeen || index > 0;
    return {
      name,
      passed: resultEvidencePassed,
      score: resultEvidencePassed ? 1 : 0,
      expectedMatched: [name],
      expectedMissing: resultEvidencePassed ? [] : ["missing expected memory"],
      forbiddenClear: ["stale memory"],
      forbiddenFound: resultEvidencePassed ? [] : ["stale memory"],
      minResults: 1,
      resultCount: resultEvidencePassed ? 1 : 0,
      topResults: resultEvidencePassed
        ? [
            {
              title: name,
              file: `memory-${index + 1}.md`,
              score: 1,
              nodeId: `node-${index + 1}`
            }
          ]
        : []
    };
  });
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
        ...(input.correctedMemoryConversationRecallSeen === false
          ? []
          : [
              "corrected memory conversation recalled replacement hot memory",
              "corrected memory conversation excluded disputed stale memory"
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
        ...(input.conversationIdentityRecallSeen === false
          ? []
          : [
              "conversation prompt injected durable identity hot memory",
              "conversation prompt preserved identity question with memory context",
              "conversation prompt answered identity from durable memory"
            ]),
        ...(input.longCycleFeedbackTrendSeen === false
          ? []
          : [
              "long-cycle feedback trend persisted across CLI process",
              "long-cycle feedback trend recalled hot workflow"
            ]),
        ...(input.longProjectFeedbackConvergenceSeen === false
          ? []
          : [
              "long-project repeated useful feedback accumulated on focused workflow",
              "long-project irrelevant feedback cooled default workflow",
              "long-project feedback trend ranked focused workflow",
              "long-project search ranked focused workflow before default workflow"
            ]),
        ...(input.longProjectLearningDraftRecallSeen === false
          ? []
          : [
              "long-project learning draft reviewed with evidence",
              "long-project learning draft applied to memory graph",
              "rejected learning draft did not enter memory recall",
              "learned long-project workflow recalled across CLI process",
              "learned long-project workflow feedback raised weight"
            ]),
        ...(input.autonomousLearningCycleSeen === false
          ? []
          : [
              "autonomous post-task learning draft created from long project cycle",
              "autonomous learning draft review preserved project evidence",
              "autonomous learning draft applied into wiki memory",
              "autonomous learned workflow indexed into sqlite graph",
              "autonomous learned workflow linked to existing habit",
              "autonomous learned workflow recalled with graph neighbor",
              "autonomous learned workflow feedback raised weight and trend"
            ]),
        ...(input.staleKnowledgeDemotionSeen === false
          ? []
          : [
              "stale knowledge maintenance lowered old workflow weight",
              "repeated useful feedback made current workflow hot",
              "current workflow ranked before stale keyword-heavy workflow"
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
        ...(input.multilingualProjectRecallSeen === false
          ? []
          : [
              "multilingual Spanish preference recalled",
              "multilingual French project rule recalled with shared preference",
              "multilingual Japanese project rule recalled with shared preference",
              "multilingual project recall isolated unrelated project rule",
              "multilingual wiki sources indexed into sqlite",
              "multilingual project graph edges linked shared preference"
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
          { length: input.assertions ?? 45 },
          (_, index) => `memory assertion ${index + 1}`
        )
      ],
      filesVerified: Array.from(
        { length: input.filesVerified ?? 10 },
        (_, index) => `memory-file-${index + 1}.json`
      ),
      conflictGroupViewSeen: input.conflictGroupViewSeen !== false,
      conversationIdentityRecallSeen: input.conversationIdentityRecallSeen !== false,
      dreamConflictGroupLifecycleSeen: input.dreamConflictGroupLifecycleSeen !== false,
      correctedMemoryConversationRecallSeen: input.correctedMemoryConversationRecallSeen !== false,
      longCycleFeedbackTrendSeen: input.longCycleFeedbackTrendSeen !== false,
      longProjectFeedbackConvergenceSeen: input.longProjectFeedbackConvergenceSeen !== false,
      longProjectLearningDraftRecallSeen: input.longProjectLearningDraftRecallSeen !== false,
      autonomousLearningCycleSeen: input.autonomousLearningCycleSeen !== false,
      staleKnowledgeDemotionSeen: input.staleKnowledgeDemotionSeen !== false,
      crossNodeRecommendationSeen: input.crossNodeRecommendationSeen !== false,
      projectCaseRecallSeen: input.projectCaseRecallSeen !== false,
      multiProjectConflictRecallSeen: input.multiProjectConflictRecallSeen !== false,
      multilingualProjectRecallSeen: input.multilingualProjectRecallSeen !== false,
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
  rollbackQualitySeen?: boolean;
  finalDiffQualityVerified?: boolean;
  unrelatedFilePreserved?: boolean;
  toolSearchRankedFilePatch: boolean;
  approvalDiffPreviewSeen: boolean;
  patchUsageRate: number;
}): Record<string, unknown> {
  const scenarioCount = input.multiFileRecoverySeen === false ? 1 : 4;
  const conflictExplanationSeen = input.conflictExplanationSeen !== false;
  const rollbackVerified = input.rollbackVerified !== false;
  const rollbackQualitySeen = input.rollbackQualitySeen !== false;
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
      rollbackQualitySeen,
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
                rollbackQualitySeen,
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
    planReviewPreviewShown: boolean;
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
    multiBranchConvergenceCreated: boolean;
    multiBranchConvergenceContextSeen: boolean;
    multiBranchConvergenceExecuted: boolean;
    conflictedMergeNeedsRevision: boolean;
    conflictedMergeContextSeen: boolean;
    conflictedMergeResolved: boolean;
    resolvedMergeContextSeen: boolean;
    multiObjectiveConflictDetected: boolean;
    multiObjectiveUserChoiceResolved: boolean;
    multiObjectiveChoiceContextSeen: boolean;
    multiObjectiveRejectedBranchExcluded: boolean;
    multiObjectiveCompatibleBranchPreserved: boolean;
    multiObjectiveReadBeforeWriteGuardSeen: boolean;
    multiObjectiveReleaseFilesUpdated: boolean;
    multiObjectiveExecutionVerified: boolean;
    longProjectRetrospectiveContextSeen: boolean;
    longProjectRetrospectiveGenerated: boolean;
    longProjectRetrospectiveVerified: boolean;
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
      assertions: overrides.assertions ?? 51,
      filesVerified: overrides.filesVerified ?? 13,
      toolCallCount: overrides.toolCallCount ?? 37,
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
            { length: overrides.assertions ?? 44 },
            (_, index) => `goal-plan assertion ${index + 1}`
          ),
          filesVerified: Array.from(
            { length: overrides.filesVerified ?? 13 },
            (_, index) => `goal-plan-file-${index + 1}.json`
          ),
          toolCounts: {
            FileWrite: 4,
            ExitPlanMode: 16,
            FileRead: 13,
            FilePatch: 9
          },
          activeGoalContextSeen: true,
          completedGoalSuppressed: true,
          blockedGoalSuppressed: true,
          writeDeniedInPlanMode: true,
          planReviewPreviewShown: true,
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
          multiBranchConvergenceCreated: true,
          multiBranchConvergenceContextSeen: true,
          multiBranchConvergenceExecuted: true,
          conflictedMergeNeedsRevision: true,
          conflictedMergeContextSeen: true,
          conflictedMergeResolved: true,
          resolvedMergeContextSeen: true,
          multiObjectiveConflictDetected: true,
          multiObjectiveUserChoiceResolved: true,
          multiObjectiveChoiceContextSeen: true,
          multiObjectiveRejectedBranchExcluded: true,
          multiObjectiveCompatibleBranchPreserved: true,
          multiObjectiveReadBeforeWriteGuardSeen: true,
          multiObjectiveReleaseFilesUpdated: true,
          multiObjectiveExecutionVerified: true,
          longProjectRetrospectiveContextSeen: true,
          longProjectRetrospectiveGenerated: true,
          longProjectRetrospectiveVerified: true,
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
    mixedIntentFileEditRanked: boolean;
    mixedIntentBrowserRanked: boolean;
    mixedIntentMemoryRecallRanked: boolean;
    mixedIntentAgentRanked: boolean;
    mixedIntentSchemasRevealed: boolean;
    mixedIntentDynamicExpansionSeen: boolean;
    crossTurnMixedIntentInitialDeferredSeen: boolean;
    crossTurnMixedIntentFileEditStable: boolean;
    crossTurnMixedIntentBrowserStable: boolean;
    crossTurnMixedIntentMemoryRecallStable: boolean;
    crossTurnMixedIntentAgentStable: boolean;
    crossTurnMixedIntentSchemaIsolationSeen: boolean;
    crossTaskProviderCalls: number;
    longCycleProviderCalls: number;
    mixedIntentProviderCalls: number;
    crossTurnMixedIntentProviderCalls: number;
    initialToolCount: number;
    revealedToolCount: number;
    largeRepoInitialDeferredSeen: boolean;
    largeRepoMemoryCorrectCoreAvailable: boolean;
    largeRepoWorkspaceRanked: boolean;
    largeRepoFileEditRanked: boolean;
    largeRepoBrowserRanked: boolean;
    largeRepoArchiveRanked: boolean;
    largeRepoMemoryCorrectRanked: boolean;
    largeRepoMemoryRecallRanked: boolean;
    largeRepoLearningDraftRanked: boolean;
    largeRepoAgentRanked: boolean;
    largeRepoSchemasRevealed: boolean;
    largeRepoSchemaIsolationSeen: boolean;
    largeRepoProviderCalls: number;
    largeRepoSelectedToolCount: number;
    toolSearchContextPersisted: boolean;
    toolSearchContextIntentCoverage: number;
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
      providerCalls: 5,
      assertions: overrides.assertions ?? 48,
      filesVerified: overrides.filesVerified ?? 2,
      toolCallCount: overrides.toolCallCount ?? 60,
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
          provider: { callCount: 5 },
          assertions: Array.from(
            { length: overrides.assertions ?? 48 },
            (_, index) => `tool-discovery assertion ${index + 1}`
          ),
          filesVerified: Array.from(
            { length: overrides.filesVerified ?? 2 },
            (_, index) => `tool-discovery-file-${index + 1}.json`
          ),
          toolCounts: {
            ToolSearch: 15,
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
          mixedIntentFileEditRanked: true,
          mixedIntentBrowserRanked: true,
          mixedIntentMemoryRecallRanked: true,
          mixedIntentAgentRanked: true,
          mixedIntentSchemasRevealed: true,
          mixedIntentDynamicExpansionSeen: true,
          crossTurnMixedIntentInitialDeferredSeen: true,
          crossTurnMixedIntentFileEditStable: true,
          crossTurnMixedIntentBrowserStable: true,
          crossTurnMixedIntentMemoryRecallStable: true,
          crossTurnMixedIntentAgentStable: true,
          crossTurnMixedIntentSchemaIsolationSeen: true,
          largeRepoInitialDeferredSeen: true,
          largeRepoMemoryCorrectCoreAvailable: true,
          largeRepoWorkspaceRanked: true,
          largeRepoFileEditRanked: true,
          largeRepoBrowserRanked: true,
          largeRepoArchiveRanked: true,
          largeRepoMemoryCorrectRanked: true,
          largeRepoMemoryRecallRanked: true,
          largeRepoLearningDraftRanked: true,
          largeRepoAgentRanked: true,
          largeRepoSchemasRevealed: true,
          largeRepoSchemaIsolationSeen: true,
          crossTaskProviderCalls: 2,
          longCycleProviderCalls: 2,
          mixedIntentProviderCalls: 2,
          crossTurnMixedIntentProviderCalls: 2,
          largeRepoProviderCalls: 3,
          largeRepoSelectedToolCount: 5,
          toolSearchContextPersisted: true,
          toolSearchContextIntentCoverage: 8,
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
    sseDisconnectSimulated: boolean;
    sseReconnectUsedAfterId: boolean;
    sseReconnectCompletionSeen: boolean;
    sseReconnectNoDuplicateReplay: boolean;
    sseReconnectAuditPersisted: boolean;
    sseJitterMultipleDisconnectsSimulated: boolean;
    sseJitterRepeatedAfterCursorUsed: boolean;
    sseJitterCompletionSeen: boolean;
    sseJitterNoDuplicateReplay: boolean;
    sseJitterAuditPersisted: boolean;
    restartServeStarted: boolean;
    restartDeviceAuthPersisted: boolean;
    restartSessionPersisted: boolean;
    restartSessionContextSeen: boolean;
    restartJobPersisted: boolean;
    restartJobAuditPersisted: boolean;
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
    lanSmoke: {
      usedLoopbackFallback: boolean;
      healthOk: boolean;
      panelOk: boolean;
      authOk: boolean;
    };
    peerCredentialsSaved: boolean;
    peerSavedListed: boolean;
    peerDispatchBoundAllInterfaces: boolean;
    peerDispatchExternalUrlReachable: boolean;
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
    peerLongAgentDispatched: boolean;
    peerLongDispatchRunningObserved: boolean;
    peerLongDispatchCompleted: boolean;
    peerLongDispatchResultReturned: boolean;
    peerLongDispatchSecondAgentCall: boolean;
    peerLongRemoteFileWritten: boolean;
    peerLongRemoteFileIsolated: boolean;
    peerLongRemoteJobCompleted: boolean;
    peerLongRemoteAuditPersisted: boolean;
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
      assertions: overrides.assertions ?? 67,
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
            { length: overrides.assertions ?? 67 },
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
          sseDisconnectSimulated: true,
          sseReconnectUsedAfterId: true,
          sseReconnectCompletionSeen: true,
          sseReconnectNoDuplicateReplay: true,
          sseReconnectAuditPersisted: true,
          sseJitterMultipleDisconnectsSimulated: true,
          sseJitterRepeatedAfterCursorUsed: true,
          sseJitterCompletionSeen: true,
          sseJitterNoDuplicateReplay: true,
          sseJitterAuditPersisted: true,
          restartServeStarted: true,
          restartDeviceAuthPersisted: true,
          restartSessionPersisted: true,
          restartSessionContextSeen: true,
          restartJobPersisted: true,
          restartJobAuditPersisted: true,
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
          lanSmoke: {
            usedLoopbackFallback: false,
            healthOk: true,
            panelOk: true,
            authOk: true
          },
          peerCredentialsSaved: true,
          peerSavedListed: true,
          peerDispatchBoundAllInterfaces: true,
          peerDispatchExternalUrlReachable: true,
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
          peerLongAgentDispatched: true,
          peerLongDispatchRunningObserved: true,
          peerLongDispatchCompleted: true,
          peerLongDispatchResultReturned: true,
          peerLongDispatchSecondAgentCall: true,
          peerLongRemoteFileWritten: true,
          peerLongRemoteFileIsolated: true,
          peerLongRemoteJobCompleted: true,
          peerLongRemoteAuditPersisted: true,
          ...overrides
        }
      }
    ]
  };
}
