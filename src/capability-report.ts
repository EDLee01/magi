import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface CapabilityReportInput {
  blackbox: Record<string, unknown>;
  modelTasks: Record<string, unknown>;
  memory: Record<string, unknown>;
  patch: Record<string, unknown>;
  goalPlan: Record<string, unknown>;
  toolDiscovery: Record<string, unknown>;
  controlApi: Record<string, unknown>;
  generatedAt?: Date;
  sources?: Record<string, string>;
}

export interface CapabilityCheck {
  id: string;
  title: string;
  status: "passed" | "failed";
  score: number;
  metrics: Record<string, unknown>;
  failures: string[];
}

export interface CapabilityReport {
  version: 1;
  name: "capability-alignment";
  generatedAt: string;
  status: "passed" | "failed";
  summary: {
    total: number;
    passed: number;
    failed: number;
    score: number;
  };
  checks: CapabilityCheck[];
  sources: Record<string, string>;
}

export function buildCapabilityReport(input: CapabilityReportInput): CapabilityReport {
  const checks = [
    checkBlackboxReport(input.blackbox),
    checkModelTaskReport(input.modelTasks),
    checkMemoryReport(input.memory),
    checkPatchReport(input.patch),
    checkGoalPlanReport(input.goalPlan),
    checkToolDiscoveryReport(input.toolDiscovery),
    checkControlApiReport(input.controlApi)
  ];
  const failed = checks.filter((check) => check.status !== "passed");
  return {
    version: 1,
    name: "capability-alignment",
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    status: failed.length === 0 ? "passed" : "failed",
    summary: {
      total: checks.length,
      passed: checks.length - failed.length,
      failed: failed.length,
      score: checks.length === 0 ? 0 : average(checks.map((check) => check.score))
    },
    checks,
    sources: input.sources ?? {}
  };
}

export function buildCapabilityReportFromFiles(input: {
  repoRoot: string;
  reportsRoot?: string;
  generatedAt?: Date;
}): CapabilityReport {
  const reportsRoot = input.reportsRoot ?? path.join(input.repoRoot, ".magi-reports");
  const reportPath = (name: string) => path.join(reportsRoot, name);
  return buildCapabilityReport({
    blackbox: readJsonReport(reportPath("blackbox-e2e.json")),
    modelTasks: readJsonReport(reportPath("model-task-benchmark.json")),
    memory: readJsonReport(reportPath("memory-recall-eval.json")),
    patch: readJsonReport(reportPath("patch-engine-eval.json")),
    goalPlan: readJsonReport(reportPath("goal-plan-eval.json")),
    toolDiscovery: readJsonReport(reportPath("tool-discovery-eval.json")),
    controlApi: readJsonReport(reportPath("control-api-eval.json")),
    generatedAt: input.generatedAt,
    sources: {
      blackbox: path.relative(input.repoRoot, reportPath("blackbox-e2e.json")),
      modelTasks: path.relative(input.repoRoot, reportPath("model-task-benchmark.json")),
      memory: path.relative(input.repoRoot, reportPath("memory-recall-eval.json")),
      patch: path.relative(input.repoRoot, reportPath("patch-engine-eval.json")),
      goalPlan: path.relative(input.repoRoot, reportPath("goal-plan-eval.json")),
      toolDiscovery: path.relative(input.repoRoot, reportPath("tool-discovery-eval.json")),
      controlApi: path.relative(input.repoRoot, reportPath("control-api-eval.json"))
    }
  });
}

export function writeCapabilityReport(file: string, report: CapabilityReport): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

export function formatCapabilityReport(report: CapabilityReport): string {
  return [
    `Capability alignment: ${report.status}`,
    `checks: ${report.summary.passed}/${report.summary.total}`,
    `score: ${report.summary.score.toFixed(2)}`,
    ...report.checks.map((check) => {
      const suffix =
        check.failures.length > 0
          ? ` - ${check.failures.join("; ")}`
          : ` score=${check.score.toFixed(2)}`;
      return `- ${check.id}: ${check.status}${suffix}`;
    })
  ].join("\n");
}

function checkBlackboxReport(report: Record<string, unknown>): CapabilityCheck {
  const base = checkHarnessReport({
    id: "blackbox",
    title: "Black-box CLI harness",
    report,
    minScore: 1,
    minSuccessRate: 1
  });
  const summary = readRecord(report.summary);
  const toolEfficiency = readRecord(summary.toolEfficiency);
  const failures = [...base.failures];
  const assertions = readNumber(summary.assertions);
  const filesVerified = readNumber(summary.filesVerified);
  const toolCallCount = readNumber(toolEfficiency.toolCallCount);
  const uniqueToolCount = readNumber(toolEfficiency.uniqueToolCount);
  const providerCallsPerScenario = readNumber(summary.providerCallsPerScenario);
  if (assertions < 25) failures.push(`assertions=${assertions}`);
  if (filesVerified < 2) failures.push(`filesVerified=${filesVerified}`);
  if (toolCallCount < 20) failures.push(`toolCallCount=${toolCallCount}`);
  if (uniqueToolCount < 8) failures.push(`uniqueToolCount=${uniqueToolCount}`);
  if (providerCallsPerScenario <= 0) failures.push("providerCallsPerScenario=0");
  if (Array.isArray(summary.regressions) && summary.regressions.length > 0) {
    failures.push(`regressions=${summary.regressions.length}`);
  }
  return {
    ...base,
    status: failures.length === 0 ? "passed" : "failed",
    score: failures.length === 0 ? 1 : 0,
    metrics: {
      ...base.metrics,
      providerCallsPerScenario,
      assertions,
      filesVerified,
      toolCallCount,
      uniqueToolCount,
      topTools: Array.isArray(toolEfficiency.topTools) ? toolEfficiency.topTools : [],
      regressions: Array.isArray(summary.regressions) ? summary.regressions.length : 0
    },
    failures
  };
}

function checkModelTaskReport(report: Record<string, unknown>): CapabilityCheck {
  const base = checkHarnessReport({
    id: "model-tasks",
    title: "Model task benchmark",
    report,
    minScore: 1,
    minSuccessRate: 1
  });
  const summary = readRecord(report.summary);
  const toolEfficiency = readRecord(summary.toolEfficiency);
  const failures = [...base.failures];
  const scenarios = Array.isArray(report.scenarios) ? report.scenarios.map(readRecord) : [];
  const taskClasses = new Set(
    scenarios
      .map((scenario) => readRecord(scenario.details).taskClass)
      .filter((taskClass): taskClass is string => typeof taskClass === "string")
  );
  const assertions = readNumber(summary.assertions);
  const filesVerified = readNumber(summary.filesVerified);
  const toolCallCount = readNumber(toolEfficiency.toolCallCount);
  const uniqueToolCount = readNumber(toolEfficiency.uniqueToolCount);
  const providerCallsPerScenario = readNumber(summary.providerCallsPerScenario);
  if (readNumber(summary.total) < 4) failures.push(`scenarios=${readNumber(summary.total)}`);
  if (taskClasses.size < 4) failures.push(`taskClasses=${taskClasses.size}`);
  if (assertions < 14) failures.push(`assertions=${assertions}`);
  if (filesVerified < 6) failures.push(`filesVerified=${filesVerified}`);
  if (toolCallCount < 11) failures.push(`toolCallCount=${toolCallCount}`);
  if (uniqueToolCount < 5) failures.push(`uniqueToolCount=${uniqueToolCount}`);
  if (providerCallsPerScenario <= 0) failures.push("providerCallsPerScenario=0");
  if (Array.isArray(summary.regressions) && summary.regressions.length > 0) {
    failures.push(`regressions=${summary.regressions.length}`);
  }
  return {
    ...base,
    status: failures.length === 0 ? "passed" : "failed",
    score: failures.length === 0 ? 1 : 0,
    metrics: {
      ...base.metrics,
      taskClasses: Array.from(taskClasses).sort(),
      providerCallsPerScenario,
      assertions,
      filesVerified,
      toolCallCount,
      uniqueToolCount,
      topTools: Array.isArray(toolEfficiency.topTools) ? toolEfficiency.topTools : [],
      regressions: Array.isArray(summary.regressions) ? summary.regressions.length : 0
    },
    failures
  };
}

function checkHarnessReport(input: {
  id: string;
  title: string;
  report: Record<string, unknown>;
  minScore: number;
  minSuccessRate: number;
}): CapabilityCheck {
  const summary = readRecord(input.report.summary);
  const successRate = readNumber(summary.successRate);
  const score = readNumber(summary.score);
  const failures = [];
  if (input.report.status !== "passed") failures.push(`status=${String(input.report.status)}`);
  if (successRate < input.minSuccessRate) failures.push(`successRate=${successRate}`);
  if (score < input.minScore) failures.push(`score=${score}`);
  return {
    id: input.id,
    title: input.title,
    status: failures.length === 0 ? "passed" : "failed",
    score: failures.length === 0 ? 1 : Math.max(0, Math.min(score, successRate)),
    metrics: {
      scenarios: readNumber(summary.total),
      successRate,
      score,
      providerCalls: readNumber(summary.providerCalls),
      providerCallsPerScenario: readNumber(summary.providerCallsPerScenario),
      assertions: readNumber(summary.assertions),
      filesVerified: readNumber(summary.filesVerified),
      toolCallCount: readNumber(readRecord(summary.toolEfficiency).toolCallCount),
      uniqueToolCount: readNumber(readRecord(summary.toolEfficiency).uniqueToolCount),
      regressions: Array.isArray(summary.regressions) ? summary.regressions.length : 0
    },
    failures
  };
}

function checkMemoryReport(report: Record<string, unknown>): CapabilityCheck {
  const failures = [];
  const score = readNumber(report.score);
  const results = Array.isArray(report.results) ? report.results.map(readRecord) : [];
  const resultNames = results
    .map((result) => (typeof result.name === "string" ? result.name : ""))
    .filter(Boolean);
  const maintenanceRecallSeen = resultNames.includes("protected workflow survives maintenance");
  if (report.failed !== 0) failures.push(`failed=${String(report.failed)}`);
  if (report.thresholdPassed !== true) failures.push("thresholdPassed=false");
  if (score < readNumber(report.minScore, 1)) failures.push(`score=${score}`);
  if (!maintenanceRecallSeen) failures.push("maintenanceRecallSeen=false");
  return {
    id: "memory",
    title: "Memory graph recall and lifecycle eval",
    status: failures.length === 0 ? "passed" : "failed",
    score: failures.length === 0 ? 1 : score,
    metrics: {
      cases: readNumber(report.total),
      passed: readNumber(report.passed),
      failed: readNumber(report.failed),
      score,
      minScore: readNumber(report.minScore),
      maintenanceRecallSeen
    },
    failures
  };
}

function checkPatchReport(report: Record<string, unknown>): CapabilityCheck {
  const base = checkHarnessReport({
    id: "patch",
    title: "Patch engine eval",
    report,
    minScore: 1,
    minSuccessRate: 1
  });
  const scenarios = Array.isArray(report.scenarios) ? report.scenarios : [];
  const scenario = readRecord(scenarios[0]);
  const details = readRecord(scenario.details);
  const toolCounts = readRecord(details.toolCounts);
  const patchUsageRate = readNumber(details.patchUsageRate);
  const failures = [...base.failures];
  if (readNumber(toolCounts.FilePatch) < 2) failures.push("FilePatch calls < 2");
  if (readNumber(toolCounts.FileEdit) !== 1) failures.push("FileEdit calls != 1");
  if (readNumber(toolCounts.FileWrite) !== 0) failures.push("FileWrite used");
  if (details.recoverySeen !== true) failures.push("recoverySeen=false");
  if (details.toolSearchRankedFilePatch !== true) failures.push("toolSearchRankedFilePatch=false");
  if (details.approvalDiffPreviewSeen !== true) failures.push("approvalDiffPreviewSeen=false");
  if (patchUsageRate < 0.5) failures.push(`patchUsageRate=${patchUsageRate}`);
  return {
    ...base,
    status: failures.length === 0 ? "passed" : "failed",
    score: failures.length === 0 ? 1 : Math.min(base.score, patchUsageRate),
    metrics: {
      ...base.metrics,
      patchUsageRate,
      filePatchCalls: readNumber(toolCounts.FilePatch),
      fileEditCalls: readNumber(toolCounts.FileEdit),
      fileWriteCalls: readNumber(toolCounts.FileWrite),
      recoverySeen: details.recoverySeen === true,
      toolSearchRankedFilePatch: details.toolSearchRankedFilePatch === true,
      approvalDiffPreviewSeen: details.approvalDiffPreviewSeen === true
    },
    failures
  };
}

function checkGoalPlanReport(report: Record<string, unknown>): CapabilityCheck {
  const base = checkHarnessReport({
    id: "goal-plan",
    title: "Goal and Plan lifecycle eval",
    report,
    minScore: 1,
    minSuccessRate: 1
  });
  const scenarios = Array.isArray(report.scenarios) ? report.scenarios : [];
  const scenario = readRecord(scenarios[0]);
  const details = readRecord(scenario.details);
  const failures = [...base.failures];
  if (details.activeGoalContextSeen !== true) failures.push("activeGoalContextSeen=false");
  if (details.completedGoalSuppressed !== true) failures.push("completedGoalSuppressed=false");
  if (details.blockedGoalSuppressed !== true) failures.push("blockedGoalSuppressed=false");
  if (details.writeDeniedInPlanMode !== true) failures.push("writeDeniedInPlanMode=false");
  if (details.planSubmittedToModel !== true) failures.push("planSubmittedToModel=false");
  if (details.planReviewPersisted !== true) failures.push("planReviewPersisted=false");
  if (details.crossSessionPlanReviewListed !== true) {
    failures.push("crossSessionPlanReviewListed=false");
  }
  if (details.planRevisionFeedbackSeen !== true) failures.push("planRevisionFeedbackSeen=false");
  if (details.planRevisionPersisted !== true) failures.push("planRevisionPersisted=false");
  if (details.planApprovalSeen !== true) failures.push("planApprovalSeen=false");
  if (details.planApprovalPersisted !== true) failures.push("planApprovalPersisted=false");
  if (details.planRevisionChainLinked !== true) failures.push("planRevisionChainLinked=false");
  if (details.planRevisionChainViewListed !== true) {
    failures.push("planRevisionChainViewListed=false");
  }
  if (details.inheritedPlanContextSeen !== true) failures.push("inheritedPlanContextSeen=false");
  if (details.blockedGoalPersisted !== true) failures.push("blockedGoalPersisted=false");
  if (details.goalCompleted !== true) failures.push("goalCompleted=false");
  return {
    ...base,
    status: failures.length === 0 ? "passed" : "failed",
    score: failures.length === 0 ? 1 : 0,
    metrics: {
      ...base.metrics,
      activeGoalContextSeen: details.activeGoalContextSeen === true,
      completedGoalSuppressed: details.completedGoalSuppressed === true,
      blockedGoalSuppressed: details.blockedGoalSuppressed === true,
      writeDeniedInPlanMode: details.writeDeniedInPlanMode === true,
      planSubmittedToModel: details.planSubmittedToModel === true,
      planReviewPersisted: details.planReviewPersisted === true,
      crossSessionPlanReviewListed: details.crossSessionPlanReviewListed === true,
      planRevisionFeedbackSeen: details.planRevisionFeedbackSeen === true,
      planRevisionPersisted: details.planRevisionPersisted === true,
      planApprovalSeen: details.planApprovalSeen === true,
      planApprovalPersisted: details.planApprovalPersisted === true,
      planRevisionChainLinked: details.planRevisionChainLinked === true,
      planRevisionChainViewListed: details.planRevisionChainViewListed === true,
      inheritedPlanContextSeen: details.inheritedPlanContextSeen === true,
      blockedGoalPersisted: details.blockedGoalPersisted === true,
      goalCompleted: details.goalCompleted === true
    },
    failures
  };
}

function checkToolDiscoveryReport(report: Record<string, unknown>): CapabilityCheck {
  const base = checkHarnessReport({
    id: "tool-discovery",
    title: "Tool Discovery eval",
    report,
    minScore: 1,
    minSuccessRate: 1
  });
  const scenarios = Array.isArray(report.scenarios) ? report.scenarios : [];
  const scenario = readRecord(scenarios[0]);
  const details = readRecord(scenario.details);
  const failures = [...base.failures];
  if (details.coreToolsExposed !== true) failures.push("coreToolsExposed=false");
  if (details.deferredToolsHidden !== true) failures.push("deferredToolsHidden=false");
  if (details.fileEditIntentRankedFilePatch !== true) {
    failures.push("fileEditIntentRankedFilePatch=false");
  }
  if (details.browserAutomationRankedBrowser !== true) {
    failures.push("browserAutomationRankedBrowser=false");
  }
  if (details.learningDraftRevealed !== true) failures.push("learningDraftRevealed=false");
  if (details.feedbackResultsReturned !== true) failures.push("feedbackResultsReturned=false");
  if (details.feedbackRankingUsedUsage !== true) failures.push("feedbackRankingUsedUsage=false");
  if (details.intentScopedUsageRecorded !== true) {
    failures.push("intentScopedUsageRecorded=false");
  }
  if (details.failureKindRecorded !== true) failures.push("failureKindRecorded=false");
  if (details.failureKindShownInRanking !== true) {
    failures.push("failureKindShownInRanking=false");
  }
  if (details.failureRecoverySuggested !== true) {
    failures.push("failureRecoverySuggested=false");
  }
  if (details.crossTaskRecoveryRankingSeen !== true) {
    failures.push("crossTaskRecoveryRankingSeen=false");
  }
  if (details.crossTaskRecoveryGuidanceSeen !== true) {
    failures.push("crossTaskRecoveryGuidanceSeen=false");
  }
  if (details.crossTaskIntentScopedRankingSeen !== true) {
    failures.push("crossTaskIntentScopedRankingSeen=false");
  }
  if (details.crossTaskUnrelatedIntentIsolated !== true) {
    failures.push("crossTaskUnrelatedIntentIsolated=false");
  }
  if (readNumber(details.crossTaskProviderCalls) <= 0) failures.push("crossTaskProviderCalls=0");
  if (readNumber(details.longCycleProviderCalls) <= 0) failures.push("longCycleProviderCalls=0");
  if (readNumber(details.grepFailures) < 4) failures.push("grepFailures < 4");
  if (readNumber(details.globSuccesses) < 4) failures.push("globSuccesses < 4");
  if (readNumber(details.grepIntentFailures) < 4) failures.push("grepIntentFailures < 4");
  if (readNumber(details.globIntentSuccesses) < 4) failures.push("globIntentSuccesses < 4");
  if (readNumber(details.grepPathFailures) < 4) failures.push("grepPathFailures < 4");
  if (readNumber(details.grepIntentPathFailures) < 4) {
    failures.push("grepIntentPathFailures < 4");
  }
  if (readNumber(details.revealedToolCount) <= readNumber(details.initialToolCount)) {
    failures.push("revealedToolCount did not increase");
  }
  return {
    ...base,
    status: failures.length === 0 ? "passed" : "failed",
    score: failures.length === 0 ? 1 : 0,
    metrics: {
      ...base.metrics,
      coreToolsExposed: details.coreToolsExposed === true,
      deferredToolsHidden: details.deferredToolsHidden === true,
      fileEditIntentRankedFilePatch: details.fileEditIntentRankedFilePatch === true,
      browserAutomationRankedBrowser: details.browserAutomationRankedBrowser === true,
      learningDraftRevealed: details.learningDraftRevealed === true,
      feedbackResultsReturned: details.feedbackResultsReturned === true,
      feedbackRankingUsedUsage: details.feedbackRankingUsedUsage === true,
      intentScopedUsageRecorded: details.intentScopedUsageRecorded === true,
      failureKindRecorded: details.failureKindRecorded === true,
      failureKindShownInRanking: details.failureKindShownInRanking === true,
      failureRecoverySuggested: details.failureRecoverySuggested === true,
      crossTaskRecoveryRankingSeen: details.crossTaskRecoveryRankingSeen === true,
      crossTaskRecoveryGuidanceSeen: details.crossTaskRecoveryGuidanceSeen === true,
      crossTaskIntentScopedRankingSeen: details.crossTaskIntentScopedRankingSeen === true,
      crossTaskUnrelatedIntentIsolated: details.crossTaskUnrelatedIntentIsolated === true,
      crossTaskProviderCalls: readNumber(details.crossTaskProviderCalls),
      longCycleProviderCalls: readNumber(details.longCycleProviderCalls),
      initialToolCount: readNumber(details.initialToolCount),
      revealedToolCount: readNumber(details.revealedToolCount),
      grepFailures: readNumber(details.grepFailures),
      globSuccesses: readNumber(details.globSuccesses),
      grepIntentFailures: readNumber(details.grepIntentFailures),
      globIntentSuccesses: readNumber(details.globIntentSuccesses),
      grepPathFailures: readNumber(details.grepPathFailures),
      grepIntentPathFailures: readNumber(details.grepIntentPathFailures)
    },
    failures
  };
}

function checkControlApiReport(report: Record<string, unknown>): CapabilityCheck {
  const base = checkHarnessReport({
    id: "control-api",
    title: "Control API mobile workflow eval",
    report,
    minScore: 1,
    minSuccessRate: 1
  });
  const scenarios = Array.isArray(report.scenarios) ? report.scenarios : [];
  const scenario = readRecord(scenarios[0]);
  const details = readRecord(scenario.details);
  const failures = [...base.failures];
  const required = [
    "controlServeStarted",
    "pairingSucceeded",
    "pairingUrlGenerated",
    "pairingUrlTokenHandoffSeen",
    "mdnsPeerDiscovered",
    "approvalSseSeen",
    "approvalResolved",
    "approvalFileWritten",
    "backgroundJobCompleted",
    "approvalAuditPersisted",
    "streamDeltaSeen",
    "jobCancelRequested",
    "jobCancelled",
    "queryCancelledAuditPersisted",
    "approvalCancelResolved",
    "cancelledApprovalDidNotWrite",
    "approvalCancelledAuditPersisted",
    "sessionCreatedForResume",
    "panelPayloadAccepted",
    "resumedSessionContextSeen",
    "resumedSessionMessagesPersisted",
    "panelHtmlServed",
    "panelClientContractValid",
    "panelUiApprovalControlsSeen",
    "panelUiCancelControlSeen",
    "panelClientCreateSessionUnwrapped",
    "panelClientStartJobAccepted",
    "panelSseJobStreamSeen",
    "mobileBrowserViewportSeen",
    "mobileBrowserTokenStored",
    "mobileBrowserTokenUrlCleaned",
    "mobileBrowserMessageSent",
    "mobileBrowserStreamRendered",
    "mobileBrowserCancelRequested",
    "mobileBrowserCancelRendered",
    "peerCredentialsSaved",
    "peerSavedListed",
    "peerAgentToolSearched",
    "peerAgentSchemaRevealed",
    "peerAgentDispatched",
    "peerDispatchSingleAgentCall",
    "peerDispatchCompleted",
    "peerDispatchResultReturned",
    "peerRemoteSessionCreated",
    "peerRemoteJobCompleted",
    "peerDispatchAuditPersisted"
  ];
  for (const key of required) {
    if (details[key] !== true) {
      failures.push(`${key}=false`);
    }
  }
  return {
    ...base,
    status: failures.length === 0 ? "passed" : "failed",
    score: failures.length === 0 ? 1 : 0,
    metrics: {
      ...base.metrics,
      controlServeStarted: details.controlServeStarted === true,
      pairingSucceeded: details.pairingSucceeded === true,
      pairingUrlGenerated: details.pairingUrlGenerated === true,
      pairingUrlTokenHandoffSeen: details.pairingUrlTokenHandoffSeen === true,
      mdnsPeerDiscovered: details.mdnsPeerDiscovered === true,
      approvalSseSeen: details.approvalSseSeen === true,
      approvalResolved: details.approvalResolved === true,
      approvalFileWritten: details.approvalFileWritten === true,
      backgroundJobCompleted: details.backgroundJobCompleted === true,
      approvalAuditPersisted: details.approvalAuditPersisted === true,
      streamDeltaSeen: details.streamDeltaSeen === true,
      jobCancelRequested: details.jobCancelRequested === true,
      jobCancelled: details.jobCancelled === true,
      queryCancelledAuditPersisted: details.queryCancelledAuditPersisted === true,
      approvalCancelResolved: details.approvalCancelResolved === true,
      cancelledApprovalDidNotWrite: details.cancelledApprovalDidNotWrite === true,
      approvalCancelledAuditPersisted: details.approvalCancelledAuditPersisted === true,
      sessionCreatedForResume: details.sessionCreatedForResume === true,
      panelPayloadAccepted: details.panelPayloadAccepted === true,
      resumedSessionContextSeen: details.resumedSessionContextSeen === true,
      resumedSessionMessagesPersisted: details.resumedSessionMessagesPersisted === true,
      panelHtmlServed: details.panelHtmlServed === true,
      panelClientContractValid: details.panelClientContractValid === true,
      panelUiApprovalControlsSeen: details.panelUiApprovalControlsSeen === true,
      panelUiCancelControlSeen: details.panelUiCancelControlSeen === true,
      panelClientCreateSessionUnwrapped: details.panelClientCreateSessionUnwrapped === true,
      panelClientStartJobAccepted: details.panelClientStartJobAccepted === true,
      panelSseJobStreamSeen: details.panelSseJobStreamSeen === true,
      mobileBrowserViewportSeen: details.mobileBrowserViewportSeen === true,
      mobileBrowserTokenStored: details.mobileBrowserTokenStored === true,
      mobileBrowserTokenUrlCleaned: details.mobileBrowserTokenUrlCleaned === true,
      mobileBrowserMessageSent: details.mobileBrowserMessageSent === true,
      mobileBrowserStreamRendered: details.mobileBrowserStreamRendered === true,
      mobileBrowserCancelRequested: details.mobileBrowserCancelRequested === true,
      mobileBrowserCancelRendered: details.mobileBrowserCancelRendered === true,
      peerCredentialsSaved: details.peerCredentialsSaved === true,
      peerSavedListed: details.peerSavedListed === true,
      peerAgentToolSearched: details.peerAgentToolSearched === true,
      peerAgentSchemaRevealed: details.peerAgentSchemaRevealed === true,
      peerAgentDispatched: details.peerAgentDispatched === true,
      peerDispatchSingleAgentCall: details.peerDispatchSingleAgentCall === true,
      peerDispatchCompleted: details.peerDispatchCompleted === true,
      peerDispatchResultReturned: details.peerDispatchResultReturned === true,
      peerRemoteSessionCreated: details.peerRemoteSessionCreated === true,
      peerRemoteJobCompleted: details.peerRemoteJobCompleted === true,
      peerDispatchAuditPersisted: details.peerDispatchAuditPersisted === true
    },
    failures
  };
}

function readJsonReport(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function readNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
