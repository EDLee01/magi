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
  complexHarness: Record<string, unknown>;
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
    checkControlApiReport(input.controlApi),
    checkComplexHarnessReport(input.complexHarness)
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
    complexHarness: readJsonReport(reportPath("complex-harness.json")),
    generatedAt: input.generatedAt,
    sources: {
      blackbox: path.relative(input.repoRoot, reportPath("blackbox-e2e.json")),
      modelTasks: path.relative(input.repoRoot, reportPath("model-task-benchmark.json")),
      memory: path.relative(input.repoRoot, reportPath("memory-recall-eval.json")),
      patch: path.relative(input.repoRoot, reportPath("patch-engine-eval.json")),
      goalPlan: path.relative(input.repoRoot, reportPath("goal-plan-eval.json")),
      toolDiscovery: path.relative(input.repoRoot, reportPath("tool-discovery-eval.json")),
      controlApi: path.relative(input.repoRoot, reportPath("control-api-eval.json")),
      complexHarness: path.relative(input.repoRoot, reportPath("complex-harness.json"))
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
  const scenarios = Array.isArray(report.scenarios) ? report.scenarios.map(readRecord) : [];
  const assertionList = scenarios.flatMap((scenario) =>
    readStringList(readRecord(scenario.details).assertions)
  );
  const learningDraftApplySeen =
    assertionList.includes("learning draft listed") &&
    assertionList.includes("learning draft review showed evidence") &&
    assertionList.includes("learning draft applied to memory") &&
    assertionList.includes("applied learning indexed into memory graph");
  const skillLearningApplySeen =
    assertionList.includes("skill learning draft reviewed") &&
    assertionList.includes("skill learning draft applied") &&
    assertionList.includes("learned skill recalled in model context");
  const skillPatchLearningSeen =
    assertionList.includes("skill patch learning draft reviewed") &&
    assertionList.includes("skill patch learning draft applied") &&
    assertionList.includes("patched skill recalled in model context");
  const skillCorrectionSeen =
    assertionList.includes("stale skill correction draft reviewed") &&
    assertionList.includes("stale skill correction applied replacement") &&
    assertionList.includes("corrected skill recalled without stale guidance");
  const longCycleSkillIterationSeen =
    assertionList.includes("iterative skill patch reviewed after correction") &&
    assertionList.includes("iterative skill patch applied latest guidance") &&
    assertionList.includes("mature skill recalled after multiple learning cycles");
  const harnessCiTuiGuardSeen =
    assertionList.includes("CI skips interactive TUI unless forced") &&
    assertionList.includes("forced CI can opt into interactive TUI") &&
    assertionList.includes("local opt-in can run interactive TUI") &&
    assertionList.includes("hanging child commands time out and terminate");
  const helpShapeSeen =
    assertionList.includes("help output grouped Usage Options Commands") &&
    assertionList.includes("help output documented compatibility-shaped options") &&
    assertionList.includes("help output documented command families") &&
    assertionList.includes("help output documented unsupported legacy paths");
  const textOutputProtocolSeen =
    assertionList.includes("text output default emitted final message only") &&
    assertionList.includes("text output default hid session metadata") &&
    assertionList.includes("text output verbose included session metadata");
  const streamJsonProtocolSeen =
    assertionList.includes("stream-json emitted only JSON lines") &&
    assertionList.includes("stream-json emitted user and assistant message events") &&
    assertionList.includes("stream-json emitted tool started and completed events") &&
    assertionList.includes("stream-json preserved raw agent events") &&
    assertionList.includes("stream-json completed with status and final message");
  const jsonOutputProtocolSeen =
    assertionList.includes("json output emitted single object") &&
    assertionList.includes("json output included session job status message") &&
    assertionList.includes("json output included provider model usage") &&
    assertionList.includes("json error output stayed JSON") &&
    assertionList.includes("json error output included failure status and kind");
  const barePromptHeadlessSeen =
    assertionList.includes("bare prompt argument entered headless provider path") &&
    assertionList.includes("bare prompt stream-json emitted valid lifecycle events") &&
    assertionList.includes("bare prompt headless session completed");
  const resumePickerTtySeen =
    assertionList.includes("TTY -r rendered searchable session picker") &&
    assertionList.includes("TTY -r filtered sessions by typed query") &&
    assertionList.includes("TTY -r resumed selected session") &&
    assertionList.includes("non-TTY -r session list remains available");
  const slashResumeSearchTtySeen =
    assertionList.includes("slash /resume opened searchable session picker") &&
    assertionList.includes("slash /resume initial query filtered sessions") &&
    assertionList.includes("slash /resume Enter resumed selected session") &&
    assertionList.includes("slash /resume no-results state rendered") &&
    assertionList.includes("slash /resume Escape returned without resuming");
  const toolPolicySeen =
    assertionList.includes("--tools allow-list filtered exposed schemas") &&
    assertionList.includes("--tools allow-list denied hidden write execution") &&
    assertionList.includes("--disallowed-tools filtered exposed schemas") &&
    assertionList.includes("--disallowed-tools denied requested tool execution") &&
    assertionList.includes("--allowed-tools scoped selector allowed matching Bash command") &&
    assertionList.includes("--allowed-tools scoped selector denied non-matching Bash command") &&
    assertionList.includes("dontAsk mode denied non-read-only tool without writing") &&
    assertionList.includes("acceptEdits mode allowed ordinary write without approval") &&
    assertionList.includes("dangerous Bash denied outside bypassPermissions") &&
    assertionList.includes("bypassPermissions dangerous Bash required explicit env approval") &&
    assertionList.includes("bypassPermissions dangerous Bash ran with explicit env approval");
  const slashSuggestionPromptSeen =
    assertionList.includes("slash suggestion menu rendered for slash input") &&
    assertionList.includes("slash suggestion filtered command descriptions") &&
    assertionList.includes("slash suggestion arrow selection submitted command") &&
    assertionList.includes("slash suggestion enter submitted filtered command") &&
    assertionList.includes("slash command coverage included context rules run extensions agents") &&
    assertionList.includes("slash suggestion submitted extension command") &&
    assertionList.includes("slash suggestion submitted command alias");
  const assertions = readNumber(summary.assertions);
  const filesVerified = readNumber(summary.filesVerified);
  const toolCallCount = readNumber(toolEfficiency.toolCallCount);
  const uniqueToolCount = readNumber(toolEfficiency.uniqueToolCount);
  const providerCallsPerScenario = readNumber(summary.providerCallsPerScenario);
  if (assertions < 88) failures.push(`assertions=${assertions}`);
  if (filesVerified < 4) failures.push(`filesVerified=${filesVerified}`);
  if (!learningDraftApplySeen) failures.push("learningDraftApplySeen=false");
  if (!skillLearningApplySeen) failures.push("skillLearningApplySeen=false");
  if (!skillPatchLearningSeen) failures.push("skillPatchLearningSeen=false");
  if (!skillCorrectionSeen) failures.push("skillCorrectionSeen=false");
  if (!longCycleSkillIterationSeen) failures.push("longCycleSkillIterationSeen=false");
  if (!harnessCiTuiGuardSeen) failures.push("harnessCiTuiGuardSeen=false");
  if (!helpShapeSeen) failures.push("helpShapeSeen=false");
  if (!textOutputProtocolSeen) failures.push("textOutputProtocolSeen=false");
  if (!streamJsonProtocolSeen) failures.push("streamJsonProtocolSeen=false");
  if (!jsonOutputProtocolSeen) failures.push("jsonOutputProtocolSeen=false");
  if (!barePromptHeadlessSeen) failures.push("barePromptHeadlessSeen=false");
  if (!resumePickerTtySeen) failures.push("resumePickerTtySeen=false");
  if (!slashResumeSearchTtySeen) failures.push("slashResumeSearchTtySeen=false");
  if (!toolPolicySeen) failures.push("toolPolicySeen=false");
  if (!slashSuggestionPromptSeen) failures.push("slashSuggestionPromptSeen=false");
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
      learningDraftApplySeen,
      skillLearningApplySeen,
      skillPatchLearningSeen,
      skillCorrectionSeen,
      longCycleSkillIterationSeen,
      harnessCiTuiGuardSeen,
      helpShapeSeen,
      textOutputProtocolSeen,
      streamJsonProtocolSeen,
      jsonOutputProtocolSeen,
      barePromptHeadlessSeen,
      resumePickerTtySeen,
      slashResumeSearchTtySeen,
      toolPolicySeen,
      slashSuggestionPromptSeen,
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
  const patchStrategy = scenarios.find(
    (scenario) => readRecord(scenario.details).taskClass === "patch_strategy"
  );
  const patchStrategyDetails = readRecord(patchStrategy ? readRecord(patchStrategy).details : {});
  const patchStrategyToolCounts = readRecord(patchStrategyDetails.toolCounts);
  const patchStrategyRate = readNumber(patchStrategyDetails.patchUsageRate);
  const patchStrategyFilePatchCalls = readNumber(patchStrategyToolCounts.FilePatch);
  const patchStrategyFileEditCalls = readNumber(patchStrategyToolCounts.FileEdit);
  const patchStrategyFileWriteCalls = readNumber(patchStrategyToolCounts.FileWrite);
  const testDrivenRecoveryTaskSeen = taskClasses.has("test_driven_recovery");
  const dependencyRefactorTaskSeen = taskClasses.has("dependency_refactor");
  const continuousPatchRecovery = scenarios.find(
    (scenario) => readRecord(scenario.details).taskClass === "continuous_patch_recovery"
  );
  const continuousPatchRecoveryDetails = readRecord(
    continuousPatchRecovery ? readRecord(continuousPatchRecovery).details : {}
  );
  const continuousPatchRecoveryToolCounts = readRecord(continuousPatchRecoveryDetails.toolCounts);
  const continuousPatchRecoveryTaskSeen = taskClasses.has("continuous_patch_recovery");
  const continuousPatchFailedAttempts = readNumber(
    continuousPatchRecoveryDetails.failedPatchAttempts
  );
  const continuousPatchFilePatchCalls = readNumber(continuousPatchRecoveryToolCounts.FilePatch);
  const continuousPatchFileReadCalls = readNumber(continuousPatchRecoveryToolCounts.FileRead);
  const continuousPatchBashCalls = readNumber(continuousPatchRecoveryToolCounts.Bash);
  const continuousPatchFileWriteCalls = readNumber(continuousPatchRecoveryToolCounts.FileWrite);
  const continuousPatchFileEditCalls = readNumber(continuousPatchRecoveryToolCounts.FileEdit);
  const apiMigration = scenarios.find(
    (scenario) => readRecord(scenario.details).taskClass === "api_migration"
  );
  const apiMigrationDetails = readRecord(apiMigration ? readRecord(apiMigration).details : {});
  const apiMigrationToolCounts = readRecord(apiMigrationDetails.toolCounts);
  const apiMigrationTaskSeen = taskClasses.has("api_migration");
  const apiMigrationBashCalls = readNumber(apiMigrationToolCounts.Bash);
  const apiMigrationToolSearchCalls = readNumber(apiMigrationToolCounts.ToolSearch);
  const apiMigrationFileMoveCalls = readNumber(apiMigrationToolCounts.FileMove);
  const apiMigrationFilePatchCalls = readNumber(apiMigrationToolCounts.FilePatch);
  const apiMigrationFileWriteCalls = readNumber(apiMigrationToolCounts.FileWrite);
  const monorepoGeneratedBoundary = scenarios.find(
    (scenario) => readRecord(scenario.details).taskClass === "monorepo_generated_boundary"
  );
  const monorepoGeneratedBoundaryDetails = readRecord(
    monorepoGeneratedBoundary ? readRecord(monorepoGeneratedBoundary).details : {}
  );
  const monorepoGeneratedBoundaryToolCounts = readRecord(
    monorepoGeneratedBoundaryDetails.toolCounts
  );
  const monorepoGeneratedBoundaryTaskSeen = taskClasses.has("monorepo_generated_boundary");
  const monorepoGeneratedBoundaryBashCalls = readNumber(monorepoGeneratedBoundaryToolCounts.Bash);
  const monorepoGeneratedBoundaryToolSearchCalls = readNumber(
    monorepoGeneratedBoundaryToolCounts.ToolSearch
  );
  const monorepoGeneratedBoundaryFileMoveCalls = readNumber(
    monorepoGeneratedBoundaryToolCounts.FileMove
  );
  const monorepoGeneratedBoundaryFilePatchCalls = readNumber(
    monorepoGeneratedBoundaryToolCounts.FilePatch
  );
  const monorepoGeneratedBoundaryFileWriteCalls = readNumber(
    monorepoGeneratedBoundaryToolCounts.FileWrite
  );
  const monorepoGeneratedBoundaryFileEditCalls = readNumber(
    monorepoGeneratedBoundaryToolCounts.FileEdit
  );
  const workspacePolicyMigration = scenarios.find(
    (scenario) => readRecord(scenario.details).taskClass === "workspace_policy_migration"
  );
  const workspacePolicyMigrationDetails = readRecord(
    workspacePolicyMigration ? readRecord(workspacePolicyMigration).details : {}
  );
  const workspacePolicyMigrationToolCounts = readRecord(workspacePolicyMigrationDetails.toolCounts);
  const workspacePolicyMigrationTaskSeen = taskClasses.has("workspace_policy_migration");
  const workspacePolicyMigrationBashCalls = readNumber(workspacePolicyMigrationToolCounts.Bash);
  const workspacePolicyMigrationFileReadCalls = readNumber(
    workspacePolicyMigrationToolCounts.FileRead
  );
  const workspacePolicyMigrationFilePatchCalls = readNumber(
    workspacePolicyMigrationToolCounts.FilePatch
  );
  const workspacePolicyMigrationFileWriteCalls = readNumber(
    workspacePolicyMigrationToolCounts.FileWrite
  );
  const workspacePolicyMigrationFileEditCalls = readNumber(
    workspacePolicyMigrationToolCounts.FileEdit
  );
  const mixedLanguageContractMigration = scenarios.find(
    (scenario) => readRecord(scenario.details).taskClass === "mixed_language_contract_migration"
  );
  const mixedLanguageContractMigrationDetails = readRecord(
    mixedLanguageContractMigration ? readRecord(mixedLanguageContractMigration).details : {}
  );
  const mixedLanguageContractMigrationToolCounts = readRecord(
    mixedLanguageContractMigrationDetails.toolCounts
  );
  const mixedLanguageContractMigrationTaskSeen = taskClasses.has(
    "mixed_language_contract_migration"
  );
  const mixedLanguageContractMigrationBashCalls = readNumber(
    mixedLanguageContractMigrationToolCounts.Bash
  );
  const mixedLanguageContractMigrationFileReadCalls = readNumber(
    mixedLanguageContractMigrationToolCounts.FileRead
  );
  const mixedLanguageContractMigrationFilePatchCalls = readNumber(
    mixedLanguageContractMigrationToolCounts.FilePatch
  );
  const mixedLanguageContractMigrationFileWriteCalls = readNumber(
    mixedLanguageContractMigrationToolCounts.FileWrite
  );
  const mixedLanguageContractMigrationFileEditCalls = readNumber(
    mixedLanguageContractMigrationToolCounts.FileEdit
  );
  const largeRepoLongChainMigration = scenarios.find(
    (scenario) => readRecord(scenario.details).taskClass === "large_repo_long_chain_migration"
  );
  const largeRepoLongChainMigrationDetails = readRecord(
    largeRepoLongChainMigration ? readRecord(largeRepoLongChainMigration).details : {}
  );
  const largeRepoLongChainMigrationToolCounts = readRecord(
    largeRepoLongChainMigrationDetails.toolCounts
  );
  const largeRepoLongChainMigrationTaskSeen = taskClasses.has("large_repo_long_chain_migration");
  const largeRepoLongChainMigrationBashCalls = readNumber(
    largeRepoLongChainMigrationToolCounts.Bash
  );
  const largeRepoLongChainMigrationGlobCalls = readNumber(
    largeRepoLongChainMigrationToolCounts.Glob
  );
  const largeRepoLongChainMigrationGrepCalls = readNumber(
    largeRepoLongChainMigrationToolCounts.Grep
  );
  const largeRepoLongChainMigrationFileReadCalls = readNumber(
    largeRepoLongChainMigrationToolCounts.FileRead
  );
  const largeRepoLongChainMigrationFilePatchCalls = readNumber(
    largeRepoLongChainMigrationToolCounts.FilePatch
  );
  const largeRepoLongChainMigrationFileWriteCalls = readNumber(
    largeRepoLongChainMigrationToolCounts.FileWrite
  );
  const largeRepoLongChainMigrationFileEditCalls = readNumber(
    largeRepoLongChainMigrationToolCounts.FileEdit
  );
  const pluginApiCompatibilityMigration = scenarios.find(
    (scenario) => readRecord(scenario.details).taskClass === "plugin_api_compatibility_migration"
  );
  const pluginApiCompatibilityMigrationDetails = readRecord(
    pluginApiCompatibilityMigration ? readRecord(pluginApiCompatibilityMigration).details : {}
  );
  const pluginApiCompatibilityMigrationToolCounts = readRecord(
    pluginApiCompatibilityMigrationDetails.toolCounts
  );
  const pluginApiCompatibilityMigrationTaskSeen = taskClasses.has(
    "plugin_api_compatibility_migration"
  );
  const pluginApiCompatibilityMigrationBashCalls = readNumber(
    pluginApiCompatibilityMigrationToolCounts.Bash
  );
  const pluginApiCompatibilityMigrationGlobCalls = readNumber(
    pluginApiCompatibilityMigrationToolCounts.Glob
  );
  const pluginApiCompatibilityMigrationGrepCalls = readNumber(
    pluginApiCompatibilityMigrationToolCounts.Grep
  );
  const pluginApiCompatibilityMigrationFileReadCalls = readNumber(
    pluginApiCompatibilityMigrationToolCounts.FileRead
  );
  const pluginApiCompatibilityMigrationFilePatchCalls = readNumber(
    pluginApiCompatibilityMigrationToolCounts.FilePatch
  );
  const pluginApiCompatibilityMigrationFileWriteCalls = readNumber(
    pluginApiCompatibilityMigrationToolCounts.FileWrite
  );
  const pluginApiCompatibilityMigrationFileEditCalls = readNumber(
    pluginApiCompatibilityMigrationToolCounts.FileEdit
  );
  const ossStyleOpenSourceMigration = scenarios.find(
    (scenario) => readRecord(scenario.details).taskClass === "oss_style_open_source_migration"
  );
  const ossStyleOpenSourceMigrationDetails = readRecord(
    ossStyleOpenSourceMigration ? readRecord(ossStyleOpenSourceMigration).details : {}
  );
  const ossStyleOpenSourceMigrationToolCounts = readRecord(
    ossStyleOpenSourceMigrationDetails.toolCounts
  );
  const ossStyleOpenSourceMigrationTaskSeen = taskClasses.has("oss_style_open_source_migration");
  const ossStyleOpenSourceMigrationBashCalls = readNumber(
    ossStyleOpenSourceMigrationToolCounts.Bash
  );
  const ossStyleOpenSourceMigrationGlobCalls = readNumber(
    ossStyleOpenSourceMigrationToolCounts.Glob
  );
  const ossStyleOpenSourceMigrationGrepCalls = readNumber(
    ossStyleOpenSourceMigrationToolCounts.Grep
  );
  const ossStyleOpenSourceMigrationFileReadCalls = readNumber(
    ossStyleOpenSourceMigrationToolCounts.FileRead
  );
  const ossStyleOpenSourceMigrationFilePatchCalls = readNumber(
    ossStyleOpenSourceMigrationToolCounts.FilePatch
  );
  const ossStyleOpenSourceMigrationFileWriteCalls = readNumber(
    ossStyleOpenSourceMigrationToolCounts.FileWrite
  );
  const ossStyleOpenSourceMigrationFileEditCalls = readNumber(
    ossStyleOpenSourceMigrationToolCounts.FileEdit
  );
  const securityMiddlewarePolicyMigration = scenarios.find(
    (scenario) => readRecord(scenario.details).taskClass === "security_middleware_policy_migration"
  );
  const securityMiddlewarePolicyMigrationDetails = readRecord(
    securityMiddlewarePolicyMigration ? readRecord(securityMiddlewarePolicyMigration).details : {}
  );
  const securityMiddlewarePolicyMigrationToolCounts = readRecord(
    securityMiddlewarePolicyMigrationDetails.toolCounts
  );
  const securityMiddlewarePolicyMigrationTaskSeen = taskClasses.has(
    "security_middleware_policy_migration"
  );
  const securityMiddlewarePolicyMigrationBashCalls = readNumber(
    securityMiddlewarePolicyMigrationToolCounts.Bash
  );
  const securityMiddlewarePolicyMigrationGlobCalls = readNumber(
    securityMiddlewarePolicyMigrationToolCounts.Glob
  );
  const securityMiddlewarePolicyMigrationGrepCalls = readNumber(
    securityMiddlewarePolicyMigrationToolCounts.Grep
  );
  const securityMiddlewarePolicyMigrationFileReadCalls = readNumber(
    securityMiddlewarePolicyMigrationToolCounts.FileRead
  );
  const securityMiddlewarePolicyMigrationFilePatchCalls = readNumber(
    securityMiddlewarePolicyMigrationToolCounts.FilePatch
  );
  const securityMiddlewarePolicyMigrationFileWriteCalls = readNumber(
    securityMiddlewarePolicyMigrationToolCounts.FileWrite
  );
  const securityMiddlewarePolicyMigrationFileEditCalls = readNumber(
    securityMiddlewarePolicyMigrationToolCounts.FileEdit
  );
  const ossIssueRegressionFix = scenarios.find(
    (scenario) => readRecord(scenario.details).taskClass === "oss_issue_regression_fix"
  );
  const ossIssueRegressionFixDetails = readRecord(
    ossIssueRegressionFix ? readRecord(ossIssueRegressionFix).details : {}
  );
  const ossIssueRegressionFixToolCounts = readRecord(ossIssueRegressionFixDetails.toolCounts);
  const ossIssueRegressionFixTaskSeen = taskClasses.has("oss_issue_regression_fix");
  const ossIssueRegressionFixBashCalls = readNumber(ossIssueRegressionFixToolCounts.Bash);
  const ossIssueRegressionFixGlobCalls = readNumber(ossIssueRegressionFixToolCounts.Glob);
  const ossIssueRegressionFixGrepCalls = readNumber(ossIssueRegressionFixToolCounts.Grep);
  const ossIssueRegressionFixFileReadCalls = readNumber(ossIssueRegressionFixToolCounts.FileRead);
  const ossIssueRegressionFixFilePatchCalls = readNumber(ossIssueRegressionFixToolCounts.FilePatch);
  const ossIssueRegressionFixFileWriteCalls = readNumber(ossIssueRegressionFixToolCounts.FileWrite);
  const ossIssueRegressionFixFileEditCalls = readNumber(ossIssueRegressionFixToolCounts.FileEdit);
  const ossSecurityAdvisoryFix = scenarios.find(
    (scenario) => readRecord(scenario.details).taskClass === "oss_security_advisory_fix"
  );
  const ossSecurityAdvisoryFixDetails = readRecord(
    ossSecurityAdvisoryFix ? readRecord(ossSecurityAdvisoryFix).details : {}
  );
  const ossSecurityAdvisoryFixToolCounts = readRecord(ossSecurityAdvisoryFixDetails.toolCounts);
  const ossSecurityAdvisoryFixTaskSeen = taskClasses.has("oss_security_advisory_fix");
  const ossSecurityAdvisoryFixBashCalls = readNumber(ossSecurityAdvisoryFixToolCounts.Bash);
  const ossSecurityAdvisoryFixGlobCalls = readNumber(ossSecurityAdvisoryFixToolCounts.Glob);
  const ossSecurityAdvisoryFixGrepCalls = readNumber(ossSecurityAdvisoryFixToolCounts.Grep);
  const ossSecurityAdvisoryFixFileReadCalls = readNumber(ossSecurityAdvisoryFixToolCounts.FileRead);
  const ossSecurityAdvisoryFixFilePatchCalls = readNumber(
    ossSecurityAdvisoryFixToolCounts.FilePatch
  );
  const ossSecurityAdvisoryFixFileWriteCalls = readNumber(
    ossSecurityAdvisoryFixToolCounts.FileWrite
  );
  const ossSecurityAdvisoryFixFileEditCalls = readNumber(ossSecurityAdvisoryFixToolCounts.FileEdit);
  const ciFailureDiagnosisFix = scenarios.find(
    (scenario) => readRecord(scenario.details).taskClass === "ci_failure_diagnosis_fix"
  );
  const ciFailureDiagnosisFixDetails = readRecord(
    ciFailureDiagnosisFix ? readRecord(ciFailureDiagnosisFix).details : {}
  );
  const ciFailureDiagnosisFixToolCounts = readRecord(ciFailureDiagnosisFixDetails.toolCounts);
  const ciFailureDiagnosisFixTaskSeen = taskClasses.has("ci_failure_diagnosis_fix");
  const ciFailureDiagnosisFixBashCalls = readNumber(ciFailureDiagnosisFixToolCounts.Bash);
  const ciFailureDiagnosisFixGlobCalls = readNumber(ciFailureDiagnosisFixToolCounts.Glob);
  const ciFailureDiagnosisFixGrepCalls = readNumber(ciFailureDiagnosisFixToolCounts.Grep);
  const ciFailureDiagnosisFixFileReadCalls = readNumber(ciFailureDiagnosisFixToolCounts.FileRead);
  const ciFailureDiagnosisFixFilePatchCalls = readNumber(ciFailureDiagnosisFixToolCounts.FilePatch);
  const ciFailureDiagnosisFixFileWriteCalls = readNumber(ciFailureDiagnosisFixToolCounts.FileWrite);
  const ciFailureDiagnosisFixFileEditCalls = readNumber(ciFailureDiagnosisFixToolCounts.FileEdit);
  const assertions = readNumber(summary.assertions);
  const filesVerified = readNumber(summary.filesVerified);
  const toolCallCount = readNumber(toolEfficiency.toolCallCount);
  const uniqueToolCount = readNumber(toolEfficiency.uniqueToolCount);
  const providerCallsPerScenario = readNumber(summary.providerCallsPerScenario);
  if (readNumber(summary.total) < 19) failures.push(`scenarios=${readNumber(summary.total)}`);
  if (taskClasses.size < 19) failures.push(`taskClasses=${taskClasses.size}`);
  if (!taskClasses.has("patch_strategy")) failures.push("patchStrategyTask=false");
  if (!testDrivenRecoveryTaskSeen) failures.push("testDrivenRecoveryTask=false");
  if (!dependencyRefactorTaskSeen) failures.push("dependencyRefactorTask=false");
  if (!continuousPatchRecoveryTaskSeen) failures.push("continuousPatchRecoveryTask=false");
  if (!apiMigrationTaskSeen) failures.push("apiMigrationTask=false");
  if (!monorepoGeneratedBoundaryTaskSeen) failures.push("monorepoGeneratedBoundaryTask=false");
  if (!workspacePolicyMigrationTaskSeen) failures.push("workspacePolicyMigrationTask=false");
  if (!mixedLanguageContractMigrationTaskSeen) {
    failures.push("mixedLanguageContractMigrationTask=false");
  }
  if (!largeRepoLongChainMigrationTaskSeen) {
    failures.push("largeRepoLongChainMigrationTask=false");
  }
  if (!pluginApiCompatibilityMigrationTaskSeen) {
    failures.push("pluginApiCompatibilityMigrationTask=false");
  }
  if (!ossStyleOpenSourceMigrationTaskSeen) {
    failures.push("ossStyleOpenSourceMigrationTask=false");
  }
  if (!securityMiddlewarePolicyMigrationTaskSeen) {
    failures.push("securityMiddlewarePolicyMigrationTask=false");
  }
  if (!ossIssueRegressionFixTaskSeen) {
    failures.push("ossIssueRegressionFixTask=false");
  }
  if (!ossSecurityAdvisoryFixTaskSeen) {
    failures.push("ossSecurityAdvisoryFixTask=false");
  }
  if (!ciFailureDiagnosisFixTaskSeen) {
    failures.push("ciFailureDiagnosisFixTask=false");
  }
  if (assertions < 237) failures.push(`assertions=${assertions}`);
  if (filesVerified < 107) failures.push(`filesVerified=${filesVerified}`);
  if (toolCallCount < 223) failures.push(`toolCallCount=${toolCallCount}`);
  if (uniqueToolCount < 9) failures.push(`uniqueToolCount=${uniqueToolCount}`);
  if (patchStrategyFilePatchCalls < 1) failures.push("patchStrategyFilePatchCalls < 1");
  if (patchStrategyFileEditCalls !== 1) failures.push("patchStrategyFileEditCalls != 1");
  if (patchStrategyFileWriteCalls !== 0) failures.push("patchStrategyFileWrite used");
  if (patchStrategyRate < 0.5) failures.push(`patchStrategyRate=${patchStrategyRate}`);
  if (continuousPatchFailedAttempts < 2) failures.push("continuousPatchFailedAttempts < 2");
  if (continuousPatchFilePatchCalls < 3) failures.push("continuousPatchFilePatchCalls < 3");
  if (continuousPatchFileReadCalls < 2) failures.push("continuousPatchFileReadCalls < 2");
  if (continuousPatchBashCalls !== 2) failures.push("continuousPatchBashCalls != 2");
  if (continuousPatchFileWriteCalls !== 0) failures.push("continuousPatchFileWrite used");
  if (continuousPatchFileEditCalls !== 0) failures.push("continuousPatchFileEdit used");
  if (continuousPatchRecoveryDetails.reReadAfterRepeatedPatchFailures !== true) {
    failures.push("reReadAfterRepeatedPatchFailures=false");
  }
  if (continuousPatchRecoveryDetails.finalDiffQualityVerified !== true) {
    failures.push("finalDiffQualityVerified=false");
  }
  if (continuousPatchRecoveryDetails.unrelatedFileUnchanged !== true) {
    failures.push("unrelatedFileUnchanged=false");
  }
  if (apiMigrationBashCalls !== 2) failures.push("apiMigrationBashCalls != 2");
  if (apiMigrationToolSearchCalls !== 1) failures.push("apiMigrationToolSearchCalls != 1");
  if (apiMigrationFileMoveCalls !== 1) failures.push("apiMigrationFileMoveCalls != 1");
  if (apiMigrationFilePatchCalls < 3) failures.push("apiMigrationFilePatchCalls < 3");
  if (apiMigrationFileWriteCalls !== 0) failures.push("apiMigrationFileWrite used");
  if (apiMigrationDetails.fileMoveRevealed !== true) failures.push("fileMoveRevealed=false");
  if (apiMigrationDetails.movedFileVerified !== true) failures.push("movedFileVerified=false");
  if (apiMigrationDetails.oldPathRemoved !== true) failures.push("oldPathRemoved=false");
  if (apiMigrationDetails.batchApiMigrationVerified !== true) {
    failures.push("batchApiMigrationVerified=false");
  }
  if (monorepoGeneratedBoundaryBashCalls !== 2) {
    failures.push("monorepoGeneratedBoundaryBashCalls != 2");
  }
  if (monorepoGeneratedBoundaryToolSearchCalls !== 1) {
    failures.push("monorepoGeneratedBoundaryToolSearchCalls != 1");
  }
  if (monorepoGeneratedBoundaryFileMoveCalls !== 1) {
    failures.push("monorepoGeneratedBoundaryFileMoveCalls != 1");
  }
  if (monorepoGeneratedBoundaryFilePatchCalls < 3) {
    failures.push("monorepoGeneratedBoundaryFilePatchCalls < 3");
  }
  if (monorepoGeneratedBoundaryFileWriteCalls !== 0) {
    failures.push("monorepoGeneratedBoundaryFileWrite used");
  }
  if (monorepoGeneratedBoundaryFileEditCalls !== 0) {
    failures.push("monorepoGeneratedBoundaryFileEdit used");
  }
  if (monorepoGeneratedBoundaryDetails.fileMoveRevealed !== true) {
    failures.push("monorepoGeneratedBoundaryFileMoveRevealed=false");
  }
  if (monorepoGeneratedBoundaryDetails.sourcePackageMoved !== true) {
    failures.push("sourcePackageMoved=false");
  }
  if (monorepoGeneratedBoundaryDetails.oldSourcePackagePathRemoved !== true) {
    failures.push("oldSourcePackagePathRemoved=false");
  }
  if (monorepoGeneratedBoundaryDetails.generatedFileUntouched !== true) {
    failures.push("generatedFileUntouched=false");
  }
  if (monorepoGeneratedBoundaryDetails.monorepoPackageMigrationVerified !== true) {
    failures.push("monorepoPackageMigrationVerified=false");
  }
  if (workspacePolicyMigrationBashCalls !== 2) {
    failures.push("workspacePolicyMigrationBashCalls != 2");
  }
  if (workspacePolicyMigrationFileReadCalls !== 8) {
    failures.push("workspacePolicyMigrationFileReadCalls != 8");
  }
  if (workspacePolicyMigrationFilePatchCalls < 6) {
    failures.push("workspacePolicyMigrationFilePatchCalls < 6");
  }
  if (workspacePolicyMigrationFileWriteCalls !== 0) {
    failures.push("workspacePolicyMigrationFileWrite used");
  }
  if (workspacePolicyMigrationFileEditCalls !== 0) {
    failures.push("workspacePolicyMigrationFileEdit used");
  }
  if (workspacePolicyMigrationDetails.configMigrated !== true) {
    failures.push("workspacePolicyConfigMigrated=false");
  }
  if (workspacePolicyMigrationDetails.packageScriptsMigrated !== true) {
    failures.push("workspacePolicyPackageScriptsMigrated=false");
  }
  if (workspacePolicyMigrationDetails.sourceMigrated !== true) {
    failures.push("workspacePolicySourceMigrated=false");
  }
  if (workspacePolicyMigrationDetails.docsMigrated !== true) {
    failures.push("workspacePolicyDocsMigrated=false");
  }
  if (workspacePolicyMigrationDetails.generatedFileUntouched !== true) {
    failures.push("workspacePolicyGeneratedFileUntouched=false");
  }
  if (workspacePolicyMigrationDetails.vendorFileUntouched !== true) {
    failures.push("workspacePolicyVendorFileUntouched=false");
  }
  if (workspacePolicyMigrationDetails.workspacePolicyMigrationVerified !== true) {
    failures.push("workspacePolicyMigrationVerified=false");
  }
  if (mixedLanguageContractMigrationBashCalls !== 2) {
    failures.push("mixedLanguageContractMigrationBashCalls != 2");
  }
  if (mixedLanguageContractMigrationFileReadCalls !== 4) {
    failures.push("mixedLanguageContractMigrationFileReadCalls != 4");
  }
  if (mixedLanguageContractMigrationFilePatchCalls < 3) {
    failures.push("mixedLanguageContractMigrationFilePatchCalls < 3");
  }
  if (mixedLanguageContractMigrationFileWriteCalls !== 0) {
    failures.push("mixedLanguageContractMigrationFileWrite used");
  }
  if (mixedLanguageContractMigrationFileEditCalls !== 0) {
    failures.push("mixedLanguageContractMigrationFileEdit used");
  }
  if (mixedLanguageContractMigrationDetails.tsContractMigrated !== true) {
    failures.push("mixedLanguageTsContractMigrated=false");
  }
  if (mixedLanguageContractMigrationDetails.pythonContractMigrated !== true) {
    failures.push("mixedLanguagePythonContractMigrated=false");
  }
  if (mixedLanguageContractMigrationDetails.docsContractMigrated !== true) {
    failures.push("mixedLanguageDocsContractMigrated=false");
  }
  if (mixedLanguageContractMigrationDetails.generatedClientUntouched !== true) {
    failures.push("mixedLanguageGeneratedClientUntouched=false");
  }
  if (mixedLanguageContractMigrationDetails.mixedLanguageContractVerified !== true) {
    failures.push("mixedLanguageContractVerified=false");
  }
  if (largeRepoLongChainMigrationBashCalls !== 2) {
    failures.push("largeRepoLongChainMigrationBashCalls != 2");
  }
  if (largeRepoLongChainMigrationGlobCalls !== 1) {
    failures.push("largeRepoLongChainMigrationGlobCalls != 1");
  }
  if (largeRepoLongChainMigrationGrepCalls !== 1) {
    failures.push("largeRepoLongChainMigrationGrepCalls != 1");
  }
  if (largeRepoLongChainMigrationFileReadCalls !== 12) {
    failures.push("largeRepoLongChainMigrationFileReadCalls != 12");
  }
  if (largeRepoLongChainMigrationFilePatchCalls < 9) {
    failures.push("largeRepoLongChainMigrationFilePatchCalls < 9");
  }
  if (largeRepoLongChainMigrationFileWriteCalls !== 0) {
    failures.push("largeRepoLongChainMigrationFileWrite used");
  }
  if (largeRepoLongChainMigrationFileEditCalls !== 0) {
    failures.push("largeRepoLongChainMigrationFileEdit used");
  }
  if (largeRepoLongChainMigrationDetails.repoDiscoveryVerified !== true) {
    failures.push("largeRepoDiscoveryVerified=false");
  }
  if (largeRepoLongChainMigrationDetails.sourceContractsMigrated !== true) {
    failures.push("largeRepoSourceContractsMigrated=false");
  }
  if (largeRepoLongChainMigrationDetails.docsMigrated !== true) {
    failures.push("largeRepoDocsMigrated=false");
  }
  if (largeRepoLongChainMigrationDetails.oldOwnedReferencesRemoved !== true) {
    failures.push("largeRepoOldOwnedReferencesRemoved=false");
  }
  if (largeRepoLongChainMigrationDetails.generatedClientUntouched !== true) {
    failures.push("largeRepoGeneratedClientUntouched=false");
  }
  if (largeRepoLongChainMigrationDetails.vendorShimUntouched !== true) {
    failures.push("largeRepoVendorShimUntouched=false");
  }
  if (largeRepoLongChainMigrationDetails.largeRepoLongChainVerified !== true) {
    failures.push("largeRepoLongChainVerified=false");
  }
  if (pluginApiCompatibilityMigrationBashCalls !== 2) {
    failures.push("pluginApiCompatibilityMigrationBashCalls != 2");
  }
  if (pluginApiCompatibilityMigrationGlobCalls !== 1) {
    failures.push("pluginApiCompatibilityMigrationGlobCalls != 1");
  }
  if (pluginApiCompatibilityMigrationGrepCalls !== 1) {
    failures.push("pluginApiCompatibilityMigrationGrepCalls != 1");
  }
  if (pluginApiCompatibilityMigrationFileReadCalls !== 10) {
    failures.push("pluginApiCompatibilityMigrationFileReadCalls != 10");
  }
  if (pluginApiCompatibilityMigrationFilePatchCalls < 7) {
    failures.push("pluginApiCompatibilityMigrationFilePatchCalls < 7");
  }
  if (pluginApiCompatibilityMigrationFileWriteCalls !== 0) {
    failures.push("pluginApiCompatibilityMigrationFileWrite used");
  }
  if (pluginApiCompatibilityMigrationFileEditCalls !== 0) {
    failures.push("pluginApiCompatibilityMigrationFileEdit used");
  }
  if (pluginApiCompatibilityMigrationDetails.pluginApiRepoDiscoveryVerified !== true) {
    failures.push("pluginApiRepoDiscoveryVerified=false");
  }
  if (pluginApiCompatibilityMigrationDetails.pluginRuntimeMigrated !== true) {
    failures.push("pluginRuntimeMigrated=false");
  }
  if (pluginApiCompatibilityMigrationDetails.firstPartyPluginsMigrated !== true) {
    failures.push("firstPartyPluginsMigrated=false");
  }
  if (pluginApiCompatibilityMigrationDetails.legacyAdapterCompatibilityPreserved !== true) {
    failures.push("legacyAdapterCompatibilityPreserved=false");
  }
  if (pluginApiCompatibilityMigrationDetails.examplesDocsChangelogMigrated !== true) {
    failures.push("pluginApiExamplesDocsChangelogMigrated=false");
  }
  if (pluginApiCompatibilityMigrationDetails.oldOwnedHookReferencesRemoved !== true) {
    failures.push("oldOwnedHookReferencesRemoved=false");
  }
  if (pluginApiCompatibilityMigrationDetails.generatedPluginTypesUntouched !== true) {
    failures.push("generatedPluginTypesUntouched=false");
  }
  if (pluginApiCompatibilityMigrationDetails.vendorPluginShimUntouched !== true) {
    failures.push("vendorPluginShimUntouched=false");
  }
  if (pluginApiCompatibilityMigrationDetails.pluginApiCompatibilityVerified !== true) {
    failures.push("pluginApiCompatibilityVerified=false");
  }
  if (ossStyleOpenSourceMigrationBashCalls !== 2) {
    failures.push("ossStyleOpenSourceMigrationBashCalls != 2");
  }
  if (ossStyleOpenSourceMigrationGlobCalls !== 1) {
    failures.push("ossStyleOpenSourceMigrationGlobCalls != 1");
  }
  if (ossStyleOpenSourceMigrationGrepCalls !== 1) {
    failures.push("ossStyleOpenSourceMigrationGrepCalls != 1");
  }
  if (ossStyleOpenSourceMigrationFileReadCalls !== 10) {
    failures.push("ossStyleOpenSourceMigrationFileReadCalls != 10");
  }
  if (ossStyleOpenSourceMigrationFilePatchCalls < 7) {
    failures.push("ossStyleOpenSourceMigrationFilePatchCalls < 7");
  }
  if (ossStyleOpenSourceMigrationFileWriteCalls !== 0) {
    failures.push("ossStyleOpenSourceMigrationFileWrite used");
  }
  if (ossStyleOpenSourceMigrationFileEditCalls !== 0) {
    failures.push("ossStyleOpenSourceMigrationFileEdit used");
  }
  if (ossStyleOpenSourceMigrationDetails.ossRepoDiscoveryVerified !== true) {
    failures.push("ossRepoDiscoveryVerified=false");
  }
  if (ossStyleOpenSourceMigrationDetails.coreContractsMigrated !== true) {
    failures.push("ossCoreContractsMigrated=false");
  }
  if (ossStyleOpenSourceMigrationDetails.pluginContractsMigrated !== true) {
    failures.push("ossPluginContractsMigrated=false");
  }
  if (ossStyleOpenSourceMigrationDetails.examplesDocsChangelogMigrated !== true) {
    failures.push("ossExamplesDocsChangelogMigrated=false");
  }
  if (ossStyleOpenSourceMigrationDetails.oldOwnedOptionReferencesRemoved !== true) {
    failures.push("ossOldOwnedOptionReferencesRemoved=false");
  }
  if (ossStyleOpenSourceMigrationDetails.generatedOptionsUntouched !== true) {
    failures.push("ossGeneratedOptionsUntouched=false");
  }
  if (ossStyleOpenSourceMigrationDetails.vendorOptionsUntouched !== true) {
    failures.push("ossVendorOptionsUntouched=false");
  }
  if (ossStyleOpenSourceMigrationDetails.ossStyleMigrationVerified !== true) {
    failures.push("ossStyleMigrationVerified=false");
  }
  if (securityMiddlewarePolicyMigrationBashCalls !== 2) {
    failures.push("securityMiddlewarePolicyMigrationBashCalls != 2");
  }
  if (securityMiddlewarePolicyMigrationGlobCalls !== 1) {
    failures.push("securityMiddlewarePolicyMigrationGlobCalls != 1");
  }
  if (securityMiddlewarePolicyMigrationGrepCalls !== 1) {
    failures.push("securityMiddlewarePolicyMigrationGrepCalls != 1");
  }
  if (securityMiddlewarePolicyMigrationFileReadCalls !== 10) {
    failures.push("securityMiddlewarePolicyMigrationFileReadCalls != 10");
  }
  if (securityMiddlewarePolicyMigrationFilePatchCalls < 7) {
    failures.push("securityMiddlewarePolicyMigrationFilePatchCalls < 7");
  }
  if (securityMiddlewarePolicyMigrationFileWriteCalls !== 0) {
    failures.push("securityMiddlewarePolicyMigrationFileWrite used");
  }
  if (securityMiddlewarePolicyMigrationFileEditCalls !== 0) {
    failures.push("securityMiddlewarePolicyMigrationFileEdit used");
  }
  if (securityMiddlewarePolicyMigrationDetails.securityPolicyRepoDiscoveryVerified !== true) {
    failures.push("securityPolicyRepoDiscoveryVerified=false");
  }
  if (securityMiddlewarePolicyMigrationDetails.securityPolicyConfigMigrated !== true) {
    failures.push("securityPolicyConfigMigrated=false");
  }
  if (securityMiddlewarePolicyMigrationDetails.securityMiddlewareMigrated !== true) {
    failures.push("securityMiddlewareMigrated=false");
  }
  if (securityMiddlewarePolicyMigrationDetails.securityClientMigrated !== true) {
    failures.push("securityClientMigrated=false");
  }
  if (securityMiddlewarePolicyMigrationDetails.securityExamplesDocsChangelogMigrated !== true) {
    failures.push("securityExamplesDocsChangelogMigrated=false");
  }
  if (securityMiddlewarePolicyMigrationDetails.oldOwnedSecurityReferencesRemoved !== true) {
    failures.push("oldOwnedSecurityReferencesRemoved=false");
  }
  if (securityMiddlewarePolicyMigrationDetails.generatedSecuritySchemaUntouched !== true) {
    failures.push("generatedSecuritySchemaUntouched=false");
  }
  if (securityMiddlewarePolicyMigrationDetails.vendorSecurityShimUntouched !== true) {
    failures.push("vendorSecurityShimUntouched=false");
  }
  if (securityMiddlewarePolicyMigrationDetails.securityMiddlewarePolicyVerified !== true) {
    failures.push("securityMiddlewarePolicyVerified=false");
  }
  if (ossIssueRegressionFixBashCalls !== 2) {
    failures.push("ossIssueRegressionFixBashCalls != 2");
  }
  if (ossIssueRegressionFixGlobCalls !== 1) {
    failures.push("ossIssueRegressionFixGlobCalls != 1");
  }
  if (ossIssueRegressionFixGrepCalls !== 1) {
    failures.push("ossIssueRegressionFixGrepCalls != 1");
  }
  if (ossIssueRegressionFixFileReadCalls !== 9) {
    failures.push("ossIssueRegressionFixFileReadCalls != 9");
  }
  if (ossIssueRegressionFixFilePatchCalls < 5) {
    failures.push("ossIssueRegressionFixFilePatchCalls < 5");
  }
  if (ossIssueRegressionFixFileWriteCalls !== 0) {
    failures.push("ossIssueRegressionFixFileWrite used");
  }
  if (ossIssueRegressionFixFileEditCalls !== 0) {
    failures.push("ossIssueRegressionFixFileEdit used");
  }
  if (ossIssueRegressionFixDetails.issueReportReadBeforePatch !== true) {
    failures.push("ossIssueReportReadBeforePatch=false");
  }
  if (ossIssueRegressionFixDetails.issueRegressionReproduced !== true) {
    failures.push("ossIssueRegressionReproduced=false");
  }
  if (ossIssueRegressionFixDetails.coreUrlEncodingFixed !== true) {
    failures.push("ossIssueCoreUrlEncodingFixed=false");
  }
  if (ossIssueRegressionFixDetails.clientUrlEncodingFixed !== true) {
    failures.push("ossIssueClientUrlEncodingFixed=false");
  }
  if (ossIssueRegressionFixDetails.pluginUrlEncodingFixed !== true) {
    failures.push("ossIssuePluginUrlEncodingFixed=false");
  }
  if (ossIssueRegressionFixDetails.issueDocsChangelogUpdated !== true) {
    failures.push("ossIssueDocsChangelogUpdated=false");
  }
  if (ossIssueRegressionFixDetails.generatedOpenapiUntouched !== true) {
    failures.push("ossIssueGeneratedOpenapiUntouched=false");
  }
  if (ossIssueRegressionFixDetails.vendorRouteUntouched !== true) {
    failures.push("ossIssueVendorRouteUntouched=false");
  }
  if (ossIssueRegressionFixDetails.issueRegressionVerified !== true) {
    failures.push("ossIssueRegressionVerified=false");
  }
  if (ossSecurityAdvisoryFixBashCalls !== 2) {
    failures.push("ossSecurityAdvisoryFixBashCalls != 2");
  }
  if (ossSecurityAdvisoryFixGlobCalls !== 1) {
    failures.push("ossSecurityAdvisoryFixGlobCalls != 1");
  }
  if (ossSecurityAdvisoryFixGrepCalls !== 1) {
    failures.push("ossSecurityAdvisoryFixGrepCalls != 1");
  }
  if (ossSecurityAdvisoryFixFileReadCalls !== 9) {
    failures.push("ossSecurityAdvisoryFixFileReadCalls != 9");
  }
  if (ossSecurityAdvisoryFixFilePatchCalls < 5) {
    failures.push("ossSecurityAdvisoryFixFilePatchCalls < 5");
  }
  if (ossSecurityAdvisoryFixFileWriteCalls !== 0) {
    failures.push("ossSecurityAdvisoryFixFileWrite used");
  }
  if (ossSecurityAdvisoryFixFileEditCalls !== 0) {
    failures.push("ossSecurityAdvisoryFixFileEdit used");
  }
  if (ossSecurityAdvisoryFixDetails.securityAdvisoryReadBeforePatch !== true) {
    failures.push("ossSecurityAdvisoryReadBeforePatch=false");
  }
  if (ossSecurityAdvisoryFixDetails.securityAdvisoryReproduced !== true) {
    failures.push("ossSecurityAdvisoryReproduced=false");
  }
  if (ossSecurityAdvisoryFixDetails.sessionCookieDefaultsHardened !== true) {
    failures.push("ossSecuritySessionCookieDefaultsHardened=false");
  }
  if (ossSecurityAdvisoryFixDetails.clientCookieSummaryUpdated !== true) {
    failures.push("ossSecurityClientCookieSummaryUpdated=false");
  }
  if (ossSecurityAdvisoryFixDetails.sessionExampleUpdated !== true) {
    failures.push("ossSecuritySessionExampleUpdated=false");
  }
  if (ossSecurityAdvisoryFixDetails.sessionSecurityDocsChangelogUpdated !== true) {
    failures.push("ossSecurityDocsChangelogUpdated=false");
  }
  if (ossSecurityAdvisoryFixDetails.generatedCookieSchemaUntouched !== true) {
    failures.push("ossSecurityGeneratedCookieSchemaUntouched=false");
  }
  if (ossSecurityAdvisoryFixDetails.vendorCookieShimUntouched !== true) {
    failures.push("ossSecurityVendorCookieShimUntouched=false");
  }
  if (ossSecurityAdvisoryFixDetails.securityAdvisoryVerified !== true) {
    failures.push("ossSecurityAdvisoryVerified=false");
  }
  if (ciFailureDiagnosisFixBashCalls !== 2) {
    failures.push("ciFailureDiagnosisFixBashCalls != 2");
  }
  if (ciFailureDiagnosisFixGlobCalls !== 1) {
    failures.push("ciFailureDiagnosisFixGlobCalls != 1");
  }
  if (ciFailureDiagnosisFixGrepCalls !== 1) {
    failures.push("ciFailureDiagnosisFixGrepCalls != 1");
  }
  if (ciFailureDiagnosisFixFileReadCalls !== 8) {
    failures.push("ciFailureDiagnosisFixFileReadCalls != 8");
  }
  if (ciFailureDiagnosisFixFilePatchCalls < 3) {
    failures.push("ciFailureDiagnosisFixFilePatchCalls < 3");
  }
  if (ciFailureDiagnosisFixFileWriteCalls !== 0) {
    failures.push("ciFailureDiagnosisFixFileWrite used");
  }
  if (ciFailureDiagnosisFixFileEditCalls !== 0) {
    failures.push("ciFailureDiagnosisFixFileEdit used");
  }
  if (ciFailureDiagnosisFixDetails.ciWorkflowReadBeforePatch !== true) {
    failures.push("ciWorkflowReadBeforePatch=false");
  }
  if (ciFailureDiagnosisFixDetails.ciFailureLogReadBeforePatch !== true) {
    failures.push("ciFailureLogReadBeforePatch=false");
  }
  if (ciFailureDiagnosisFixDetails.ciFailureReproduced !== true) {
    failures.push("ciFailureReproduced=false");
  }
  if (ciFailureDiagnosisFixDetails.releaseSlugFixed !== true) {
    failures.push("ciReleaseSlugFixed=false");
  }
  if (ciFailureDiagnosisFixDetails.projectPathEncodingFixed !== true) {
    failures.push("ciProjectPathEncodingFixed=false");
  }
  if (ciFailureDiagnosisFixDetails.ciDocsChangelogUpdated !== true) {
    failures.push("ciDocsChangelogUpdated=false");
  }
  if (ciFailureDiagnosisFixDetails.generatedRouteSchemaUntouched !== true) {
    failures.push("ciGeneratedRouteSchemaUntouched=false");
  }
  if (ciFailureDiagnosisFixDetails.vendorSlugShimUntouched !== true) {
    failures.push("ciVendorSlugShimUntouched=false");
  }
  if (ciFailureDiagnosisFixDetails.ciFailureVerified !== true) {
    failures.push("ciFailureVerified=false");
  }
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
      patchStrategyRate,
      patchStrategyFilePatchCalls,
      patchStrategyFileEditCalls,
      patchStrategyFileWriteCalls,
      testDrivenRecoveryTaskSeen,
      dependencyRefactorTaskSeen,
      continuousPatchRecoveryTaskSeen,
      continuousPatchFailedAttempts,
      continuousPatchFilePatchCalls,
      continuousPatchFileReadCalls,
      continuousPatchBashCalls,
      continuousPatchFileWriteCalls,
      continuousPatchFileEditCalls,
      reReadAfterRepeatedPatchFailures:
        continuousPatchRecoveryDetails.reReadAfterRepeatedPatchFailures === true,
      finalDiffQualityVerified: continuousPatchRecoveryDetails.finalDiffQualityVerified === true,
      unrelatedFileUnchanged: continuousPatchRecoveryDetails.unrelatedFileUnchanged === true,
      apiMigrationTaskSeen,
      apiMigrationBashCalls,
      apiMigrationToolSearchCalls,
      apiMigrationFileMoveCalls,
      apiMigrationFilePatchCalls,
      apiMigrationFileWriteCalls,
      fileMoveRevealed: apiMigrationDetails.fileMoveRevealed === true,
      movedFileVerified: apiMigrationDetails.movedFileVerified === true,
      oldPathRemoved: apiMigrationDetails.oldPathRemoved === true,
      batchApiMigrationVerified: apiMigrationDetails.batchApiMigrationVerified === true,
      monorepoGeneratedBoundaryTaskSeen,
      monorepoGeneratedBoundaryBashCalls,
      monorepoGeneratedBoundaryToolSearchCalls,
      monorepoGeneratedBoundaryFileMoveCalls,
      monorepoGeneratedBoundaryFilePatchCalls,
      monorepoGeneratedBoundaryFileWriteCalls,
      monorepoGeneratedBoundaryFileEditCalls,
      monorepoGeneratedBoundaryFileMoveRevealed:
        monorepoGeneratedBoundaryDetails.fileMoveRevealed === true,
      sourcePackageMoved: monorepoGeneratedBoundaryDetails.sourcePackageMoved === true,
      oldSourcePackagePathRemoved:
        monorepoGeneratedBoundaryDetails.oldSourcePackagePathRemoved === true,
      generatedFileUntouched: monorepoGeneratedBoundaryDetails.generatedFileUntouched === true,
      monorepoPackageMigrationVerified:
        monorepoGeneratedBoundaryDetails.monorepoPackageMigrationVerified === true,
      workspacePolicyMigrationTaskSeen,
      workspacePolicyMigrationBashCalls,
      workspacePolicyMigrationFileReadCalls,
      workspacePolicyMigrationFilePatchCalls,
      workspacePolicyMigrationFileWriteCalls,
      workspacePolicyMigrationFileEditCalls,
      workspacePolicyConfigMigrated: workspacePolicyMigrationDetails.configMigrated === true,
      workspacePolicyPackageScriptsMigrated:
        workspacePolicyMigrationDetails.packageScriptsMigrated === true,
      workspacePolicySourceMigrated: workspacePolicyMigrationDetails.sourceMigrated === true,
      workspacePolicyDocsMigrated: workspacePolicyMigrationDetails.docsMigrated === true,
      workspacePolicyGeneratedFileUntouched:
        workspacePolicyMigrationDetails.generatedFileUntouched === true,
      workspacePolicyVendorFileUntouched:
        workspacePolicyMigrationDetails.vendorFileUntouched === true,
      workspacePolicyMigrationVerified:
        workspacePolicyMigrationDetails.workspacePolicyMigrationVerified === true,
      mixedLanguageContractMigrationTaskSeen,
      mixedLanguageContractMigrationBashCalls,
      mixedLanguageContractMigrationFileReadCalls,
      mixedLanguageContractMigrationFilePatchCalls,
      mixedLanguageContractMigrationFileWriteCalls,
      mixedLanguageContractMigrationFileEditCalls,
      mixedLanguageTsContractMigrated:
        mixedLanguageContractMigrationDetails.tsContractMigrated === true,
      mixedLanguagePythonContractMigrated:
        mixedLanguageContractMigrationDetails.pythonContractMigrated === true,
      mixedLanguageDocsContractMigrated:
        mixedLanguageContractMigrationDetails.docsContractMigrated === true,
      mixedLanguageGeneratedClientUntouched:
        mixedLanguageContractMigrationDetails.generatedClientUntouched === true,
      mixedLanguageContractVerified:
        mixedLanguageContractMigrationDetails.mixedLanguageContractVerified === true,
      largeRepoLongChainMigrationTaskSeen,
      largeRepoLongChainMigrationBashCalls,
      largeRepoLongChainMigrationGlobCalls,
      largeRepoLongChainMigrationGrepCalls,
      largeRepoLongChainMigrationFileReadCalls,
      largeRepoLongChainMigrationFilePatchCalls,
      largeRepoLongChainMigrationFileWriteCalls,
      largeRepoLongChainMigrationFileEditCalls,
      largeRepoDiscoveryVerified: largeRepoLongChainMigrationDetails.repoDiscoveryVerified === true,
      largeRepoSourceContractsMigrated:
        largeRepoLongChainMigrationDetails.sourceContractsMigrated === true,
      largeRepoDocsMigrated: largeRepoLongChainMigrationDetails.docsMigrated === true,
      largeRepoOldOwnedReferencesRemoved:
        largeRepoLongChainMigrationDetails.oldOwnedReferencesRemoved === true,
      largeRepoGeneratedClientUntouched:
        largeRepoLongChainMigrationDetails.generatedClientUntouched === true,
      largeRepoVendorShimUntouched: largeRepoLongChainMigrationDetails.vendorShimUntouched === true,
      largeRepoLongChainVerified:
        largeRepoLongChainMigrationDetails.largeRepoLongChainVerified === true,
      pluginApiCompatibilityMigrationTaskSeen,
      pluginApiCompatibilityMigrationBashCalls,
      pluginApiCompatibilityMigrationGlobCalls,
      pluginApiCompatibilityMigrationGrepCalls,
      pluginApiCompatibilityMigrationFileReadCalls,
      pluginApiCompatibilityMigrationFilePatchCalls,
      pluginApiCompatibilityMigrationFileWriteCalls,
      pluginApiCompatibilityMigrationFileEditCalls,
      pluginApiRepoDiscoveryVerified:
        pluginApiCompatibilityMigrationDetails.pluginApiRepoDiscoveryVerified === true,
      pluginRuntimeMigrated: pluginApiCompatibilityMigrationDetails.pluginRuntimeMigrated === true,
      firstPartyPluginsMigrated:
        pluginApiCompatibilityMigrationDetails.firstPartyPluginsMigrated === true,
      legacyAdapterCompatibilityPreserved:
        pluginApiCompatibilityMigrationDetails.legacyAdapterCompatibilityPreserved === true,
      pluginApiExamplesDocsChangelogMigrated:
        pluginApiCompatibilityMigrationDetails.examplesDocsChangelogMigrated === true,
      oldOwnedHookReferencesRemoved:
        pluginApiCompatibilityMigrationDetails.oldOwnedHookReferencesRemoved === true,
      generatedPluginTypesUntouched:
        pluginApiCompatibilityMigrationDetails.generatedPluginTypesUntouched === true,
      vendorPluginShimUntouched:
        pluginApiCompatibilityMigrationDetails.vendorPluginShimUntouched === true,
      pluginApiCompatibilityVerified:
        pluginApiCompatibilityMigrationDetails.pluginApiCompatibilityVerified === true,
      ossStyleOpenSourceMigrationTaskSeen,
      ossStyleOpenSourceMigrationBashCalls,
      ossStyleOpenSourceMigrationGlobCalls,
      ossStyleOpenSourceMigrationGrepCalls,
      ossStyleOpenSourceMigrationFileReadCalls,
      ossStyleOpenSourceMigrationFilePatchCalls,
      ossStyleOpenSourceMigrationFileWriteCalls,
      ossStyleOpenSourceMigrationFileEditCalls,
      ossRepoDiscoveryVerified:
        ossStyleOpenSourceMigrationDetails.ossRepoDiscoveryVerified === true,
      ossCoreContractsMigrated: ossStyleOpenSourceMigrationDetails.coreContractsMigrated === true,
      ossPluginContractsMigrated:
        ossStyleOpenSourceMigrationDetails.pluginContractsMigrated === true,
      ossExamplesDocsChangelogMigrated:
        ossStyleOpenSourceMigrationDetails.examplesDocsChangelogMigrated === true,
      ossOldOwnedOptionReferencesRemoved:
        ossStyleOpenSourceMigrationDetails.oldOwnedOptionReferencesRemoved === true,
      ossGeneratedOptionsUntouched:
        ossStyleOpenSourceMigrationDetails.generatedOptionsUntouched === true,
      ossVendorOptionsUntouched: ossStyleOpenSourceMigrationDetails.vendorOptionsUntouched === true,
      ossStyleMigrationVerified:
        ossStyleOpenSourceMigrationDetails.ossStyleMigrationVerified === true,
      securityMiddlewarePolicyMigrationTaskSeen,
      securityMiddlewarePolicyMigrationBashCalls,
      securityMiddlewarePolicyMigrationGlobCalls,
      securityMiddlewarePolicyMigrationGrepCalls,
      securityMiddlewarePolicyMigrationFileReadCalls,
      securityMiddlewarePolicyMigrationFilePatchCalls,
      securityMiddlewarePolicyMigrationFileWriteCalls,
      securityMiddlewarePolicyMigrationFileEditCalls,
      securityPolicyRepoDiscoveryVerified:
        securityMiddlewarePolicyMigrationDetails.securityPolicyRepoDiscoveryVerified === true,
      securityPolicyConfigMigrated:
        securityMiddlewarePolicyMigrationDetails.securityPolicyConfigMigrated === true,
      securityMiddlewareMigrated:
        securityMiddlewarePolicyMigrationDetails.securityMiddlewareMigrated === true,
      securityClientMigrated:
        securityMiddlewarePolicyMigrationDetails.securityClientMigrated === true,
      securityExamplesDocsChangelogMigrated:
        securityMiddlewarePolicyMigrationDetails.securityExamplesDocsChangelogMigrated === true,
      oldOwnedSecurityReferencesRemoved:
        securityMiddlewarePolicyMigrationDetails.oldOwnedSecurityReferencesRemoved === true,
      generatedSecuritySchemaUntouched:
        securityMiddlewarePolicyMigrationDetails.generatedSecuritySchemaUntouched === true,
      vendorSecurityShimUntouched:
        securityMiddlewarePolicyMigrationDetails.vendorSecurityShimUntouched === true,
      securityMiddlewarePolicyVerified:
        securityMiddlewarePolicyMigrationDetails.securityMiddlewarePolicyVerified === true,
      ossIssueRegressionFixTaskSeen,
      ossIssueRegressionFixBashCalls,
      ossIssueRegressionFixGlobCalls,
      ossIssueRegressionFixGrepCalls,
      ossIssueRegressionFixFileReadCalls,
      ossIssueRegressionFixFilePatchCalls,
      ossIssueRegressionFixFileWriteCalls,
      ossIssueRegressionFixFileEditCalls,
      ossIssueReportReadBeforePatch:
        ossIssueRegressionFixDetails.issueReportReadBeforePatch === true,
      ossIssueRegressionReproduced: ossIssueRegressionFixDetails.issueRegressionReproduced === true,
      ossIssueCoreUrlEncodingFixed: ossIssueRegressionFixDetails.coreUrlEncodingFixed === true,
      ossIssueClientUrlEncodingFixed: ossIssueRegressionFixDetails.clientUrlEncodingFixed === true,
      ossIssuePluginUrlEncodingFixed: ossIssueRegressionFixDetails.pluginUrlEncodingFixed === true,
      ossIssueDocsChangelogUpdated: ossIssueRegressionFixDetails.issueDocsChangelogUpdated === true,
      ossIssueGeneratedOpenapiUntouched:
        ossIssueRegressionFixDetails.generatedOpenapiUntouched === true,
      ossIssueVendorRouteUntouched: ossIssueRegressionFixDetails.vendorRouteUntouched === true,
      ossIssueRegressionVerified: ossIssueRegressionFixDetails.issueRegressionVerified === true,
      ossSecurityAdvisoryFixTaskSeen,
      ossSecurityAdvisoryFixBashCalls,
      ossSecurityAdvisoryFixGlobCalls,
      ossSecurityAdvisoryFixGrepCalls,
      ossSecurityAdvisoryFixFileReadCalls,
      ossSecurityAdvisoryFixFilePatchCalls,
      ossSecurityAdvisoryFixFileWriteCalls,
      ossSecurityAdvisoryFixFileEditCalls,
      ossSecurityAdvisoryReadBeforePatch:
        ossSecurityAdvisoryFixDetails.securityAdvisoryReadBeforePatch === true,
      ossSecurityAdvisoryReproduced:
        ossSecurityAdvisoryFixDetails.securityAdvisoryReproduced === true,
      ossSecuritySessionCookieDefaultsHardened:
        ossSecurityAdvisoryFixDetails.sessionCookieDefaultsHardened === true,
      ossSecurityClientCookieSummaryUpdated:
        ossSecurityAdvisoryFixDetails.clientCookieSummaryUpdated === true,
      ossSecuritySessionExampleUpdated:
        ossSecurityAdvisoryFixDetails.sessionExampleUpdated === true,
      ossSecurityDocsChangelogUpdated:
        ossSecurityAdvisoryFixDetails.sessionSecurityDocsChangelogUpdated === true,
      ossSecurityGeneratedCookieSchemaUntouched:
        ossSecurityAdvisoryFixDetails.generatedCookieSchemaUntouched === true,
      ossSecurityVendorCookieShimUntouched:
        ossSecurityAdvisoryFixDetails.vendorCookieShimUntouched === true,
      ossSecurityAdvisoryVerified: ossSecurityAdvisoryFixDetails.securityAdvisoryVerified === true,
      ciFailureDiagnosisFixTaskSeen,
      ciFailureDiagnosisFixBashCalls,
      ciFailureDiagnosisFixGlobCalls,
      ciFailureDiagnosisFixGrepCalls,
      ciFailureDiagnosisFixFileReadCalls,
      ciFailureDiagnosisFixFilePatchCalls,
      ciFailureDiagnosisFixFileWriteCalls,
      ciFailureDiagnosisFixFileEditCalls,
      ciWorkflowReadBeforePatch: ciFailureDiagnosisFixDetails.ciWorkflowReadBeforePatch === true,
      ciFailureLogReadBeforePatch:
        ciFailureDiagnosisFixDetails.ciFailureLogReadBeforePatch === true,
      ciFailureReproduced: ciFailureDiagnosisFixDetails.ciFailureReproduced === true,
      ciReleaseSlugFixed: ciFailureDiagnosisFixDetails.releaseSlugFixed === true,
      ciProjectPathEncodingFixed: ciFailureDiagnosisFixDetails.projectPathEncodingFixed === true,
      ciDocsChangelogUpdated: ciFailureDiagnosisFixDetails.ciDocsChangelogUpdated === true,
      ciGeneratedRouteSchemaUntouched:
        ciFailureDiagnosisFixDetails.generatedRouteSchemaUntouched === true,
      ciVendorSlugShimUntouched: ciFailureDiagnosisFixDetails.vendorSlugShimUntouched === true,
      ciFailureVerified: ciFailureDiagnosisFixDetails.ciFailureVerified === true,
      regressions: Array.isArray(summary.regressions) ? summary.regressions.length : 0
    },
    failures
  };
}

function checkComplexHarnessReport(report: Record<string, unknown>): CapabilityCheck {
  const base = checkHarnessReport({
    id: "complex-harness",
    title: "Complex task harness",
    report,
    minScore: 1,
    minSuccessRate: 1
  });
  const summary = readRecord(report.summary);
  const toolEfficiency = readRecord(summary.toolEfficiency);
  const scenarios = Array.isArray(report.scenarios) ? report.scenarios.map(readRecord) : [];
  const detailsList = scenarios.map((scenario) => readRecord(scenario.details));
  const taskClasses = new Set(
    detailsList
      .map((details) => details.taskClass)
      .filter((taskClass): taskClass is string => typeof taskClass === "string")
  );
  const h1 = detailsList.find((details) => details.taskId === "H1");
  const h1ToolCounts = readRecord(h1?.toolCounts);
  const h1ChangedFiles = readStringList(h1?.changedFiles);
  const h1Assertions = readStringList(h1?.assertions);
  const h1ForbiddenChanges = readStringList(h1?.forbiddenChanges);
  const h1Session = readRecord(h1?.session);
  const h1Limits = readRecord(h1?.limitResults);
  const h1Seen = Boolean(h1);
  const assertions = readNumber(summary.assertions);
  const filesVerified = readNumber(summary.filesVerified);
  const toolCallCount = readNumber(toolEfficiency.toolCallCount);
  const uniqueToolCount = readNumber(toolEfficiency.uniqueToolCount);
  const failures = [...base.failures];

  if (readNumber(summary.total) < 1) failures.push(`scenarios=${readNumber(summary.total)}`);
  if (!taskClasses.has("single_file_bug_fix")) failures.push("singleFileBugFixTask=false");
  if (!h1Seen) failures.push("H1=false");
  if (assertions < 10) failures.push(`assertions=${assertions}`);
  if (filesVerified < 4) failures.push(`filesVerified=${filesVerified}`);
  if (toolCallCount < 6) failures.push(`toolCallCount=${toolCallCount}`);
  if (uniqueToolCount < 3) failures.push(`uniqueToolCount=${uniqueToolCount}`);
  if (readNumber(h1ToolCounts.FileRead) < 2) failures.push("H1FileReadCalls < 2");
  if (readNumber(h1ToolCounts.FilePatch) < 2) failures.push("H1FilePatchCalls < 2");
  if (readNumber(h1ToolCounts.Bash) !== 2) failures.push("H1BashCalls != 2");
  if (readNumber(h1ToolCounts.FileWrite) !== 0) failures.push("H1FileWrite used");
  if (readNumber(h1ToolCounts.FileEdit) !== 0) failures.push("H1FileEdit used");
  if (h1?.checksPassed !== true) failures.push("H1ChecksPassed=false");
  if (h1?.streamJsonLifecycleVerified !== true) failures.push("H1StreamJsonLifecycle=false");
  if (JSON.stringify(h1ChangedFiles) !== JSON.stringify(["src/discount.ts"])) {
    failures.push(`H1ChangedFiles=${JSON.stringify(h1ChangedFiles)}`);
  }
  if (h1ForbiddenChanges.length > 0)
    failures.push(`H1ForbiddenChanges=${h1ForbiddenChanges.length}`);
  if (h1Assertions.length < 10) failures.push(`H1Assertions=${h1Assertions.length}`);
  if (readNumber(h1Session.messageCount) < 2) failures.push("H1SessionMessages < 2");
  if (readNumber(h1Session.auditEventCount) < 1) failures.push("H1AuditEvents < 1");
  if (h1Limits.withinTime !== true) failures.push("H1WithinTime=false");
  if (h1Limits.withinCommands !== true) failures.push("H1WithinCommands=false");
  if (h1Limits.withinFileChanges !== true) failures.push("H1WithinFileChanges=false");
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
      assertions,
      filesVerified,
      toolCallCount,
      uniqueToolCount,
      H1Seen: h1Seen,
      H1FileReadCalls: readNumber(h1ToolCounts.FileRead),
      H1FilePatchCalls: readNumber(h1ToolCounts.FilePatch),
      H1BashCalls: readNumber(h1ToolCounts.Bash),
      H1FileWriteCalls: readNumber(h1ToolCounts.FileWrite),
      H1FileEditCalls: readNumber(h1ToolCounts.FileEdit),
      H1ChecksPassed: h1?.checksPassed === true,
      H1StreamJsonLifecycle: h1?.streamJsonLifecycleVerified === true,
      H1ChangedFiles: h1ChangedFiles,
      H1ForbiddenChanges: h1ForbiddenChanges.length,
      H1Assertions: h1Assertions.length,
      H1SessionMessages: readNumber(h1Session.messageCount),
      H1AuditEvents: readNumber(h1Session.auditEventCount),
      H1WithinTime: h1Limits.withinTime === true,
      H1WithinCommands: h1Limits.withinCommands === true,
      H1WithinFileChanges: h1Limits.withinFileChanges === true,
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
  const details = readRecord(report.details);
  const resultNames = results
    .map((result) => (typeof result.name === "string" ? result.name : ""))
    .filter(Boolean);
  const maintenanceRecallSeen = resultNames.includes("protected workflow survives maintenance");
  const workflowGraphRecallSeen = resultNames.includes("workflow graph recalls second-hop habit");
  const conflictGroupViewSeen = details.conflictGroupViewSeen === true;
  const assertionList = readStringList(details.assertions);
  const conversationIdentityRecallSeen =
    details.conversationIdentityRecallSeen === true &&
    assertionList.includes("conversation prompt injected durable identity hot memory") &&
    assertionList.includes("conversation prompt preserved identity question with memory context") &&
    assertionList.includes("conversation prompt answered identity from durable memory");
  const dreamConflictGroupLifecycleSeen = details.dreamConflictGroupLifecycleSeen === true;
  const naturalLanguageCorrectionSeen =
    assertionList.includes("natural-language correction disputed stale memory") &&
    assertionList.includes("natural-language correction recalled replacement only") &&
    assertionList.includes("natural-language correction persisted agent audit");
  const correctedMemoryConversationRecallSeen =
    details.correctedMemoryConversationRecallSeen === true &&
    assertionList.includes("corrected memory conversation recalled replacement hot memory") &&
    assertionList.includes("corrected memory conversation excluded disputed stale memory");
  const graphEdgeReinforcementSeen = assertionList.includes(
    "memory graph recall reinforced traversed edges"
  );
  const userFeedbackTrendSeen =
    assertionList.includes("user feedback increased useful memory weight") &&
    assertionList.includes("user feedback persisted memory trend metadata") &&
    assertionList.includes("user feedback trend view rendered useful memory");
  const longCycleFeedbackTrendSeen =
    details.longCycleFeedbackTrendSeen === true &&
    assertionList.includes("long-cycle feedback trend persisted across CLI process") &&
    assertionList.includes("long-cycle feedback trend recalled hot workflow");
  const longProjectFeedbackConvergenceSeen =
    details.longProjectFeedbackConvergenceSeen === true &&
    assertionList.includes(
      "long-project repeated useful feedback accumulated on focused workflow"
    ) &&
    assertionList.includes("long-project irrelevant feedback cooled default workflow") &&
    assertionList.includes("long-project feedback trend ranked focused workflow") &&
    assertionList.includes("long-project search ranked focused workflow before default workflow");
  const longProjectLearningDraftRecallSeen =
    details.longProjectLearningDraftRecallSeen === true &&
    assertionList.includes("long-project learning draft reviewed with evidence") &&
    assertionList.includes("long-project learning draft applied to memory graph") &&
    assertionList.includes("rejected learning draft did not enter memory recall") &&
    assertionList.includes("learned long-project workflow recalled across CLI process") &&
    assertionList.includes("learned long-project workflow feedback raised weight");
  const autonomousLearningCycleSeen =
    details.autonomousLearningCycleSeen === true &&
    assertionList.includes("autonomous post-task learning draft created from long project cycle") &&
    assertionList.includes("autonomous learning draft review preserved project evidence") &&
    assertionList.includes("autonomous learning draft applied into wiki memory") &&
    assertionList.includes("autonomous learned workflow indexed into sqlite graph") &&
    assertionList.includes("autonomous learned workflow linked to existing habit") &&
    assertionList.includes("autonomous learned workflow recalled with graph neighbor") &&
    assertionList.includes("autonomous learned workflow feedback raised weight and trend");
  const staleKnowledgeDemotionSeen =
    details.staleKnowledgeDemotionSeen === true &&
    assertionList.includes("stale knowledge maintenance lowered old workflow weight") &&
    assertionList.includes("repeated useful feedback made current workflow hot") &&
    assertionList.includes("current workflow ranked before stale keyword-heavy workflow");
  const crossNodeRecommendationSeen =
    details.crossNodeRecommendationSeen === true &&
    resultNames.includes("feedback trend recalls workflow neighborhood") &&
    assertionList.includes("cross-node workflow recommendation surfaced related habit");
  const projectCaseRecallSeen =
    details.projectCaseRecallSeen === true &&
    assertionList.includes("project-level release owner recall passed") &&
    assertionList.includes("project-level incident handoff recall passed");
  const multiProjectConflictRecallSeen =
    details.multiProjectConflictRecallSeen === true &&
    resultNames.includes("multi-project Magi release rule wins in Magi context") &&
    resultNames.includes("multi-project Kira support rule wins in Kira context") &&
    assertionList.includes("multi-project wiki sources indexed into sqlite") &&
    assertionList.includes("multi-project conflict edges linked project rules") &&
    assertionList.includes("multi-project Magi rule recalled without Kira rule") &&
    assertionList.includes("multi-project Kira rule recalled without Magi rule") &&
    assertionList.includes("shared user preference recalled across project rules");
  const multilingualProjectRecallSeen =
    details.multilingualProjectRecallSeen === true &&
    resultNames.includes("Spanish preference recalls concise verification") &&
    resultNames.includes("French project rule recalls recette validation") &&
    resultNames.includes("Japanese project rule recalls approval") &&
    assertionList.includes("multilingual Spanish preference recalled") &&
    assertionList.includes("multilingual French project rule recalled with shared preference") &&
    assertionList.includes("multilingual Japanese project rule recalled with shared preference") &&
    assertionList.includes("multilingual project recall isolated unrelated project rule") &&
    assertionList.includes("multilingual wiki sources indexed into sqlite") &&
    assertionList.includes("multilingual project graph edges linked shared preference");
  const multiNodeSupersededCleanupSeen =
    details.multiNodeSupersededCleanupSeen === true &&
    assertionList.includes("multi-node superseded cleanup candidates listed disputed nodes") &&
    assertionList.includes("Dream multi-node cleanup archived superseded project nodes") &&
    assertionList.includes("post-cleanup project recall excluded archived superseded nodes");
  const maintenanceConfigBoundarySeen =
    details.maintenanceConfigBoundarySeen === true &&
    assertionList.includes("maintenance config boundary values were clamped") &&
    assertionList.includes("maintenance config invalid values were rejected");
  const assertions = assertionList.length;
  const filesVerified = readStringList(details.filesVerified).length;
  if (report.failed !== 0) failures.push(`failed=${String(report.failed)}`);
  if (report.thresholdPassed !== true) failures.push("thresholdPassed=false");
  if (score < readNumber(report.minScore, 1)) failures.push(`score=${score}`);
  if (results.length < 11) failures.push(`cases=${results.length}`);
  if (assertions < 70) failures.push(`assertions=${assertions}`);
  if (filesVerified < 10) failures.push(`filesVerified=${filesVerified}`);
  if (!maintenanceRecallSeen) failures.push("maintenanceRecallSeen=false");
  if (!workflowGraphRecallSeen) failures.push("workflowGraphRecallSeen=false");
  if (!conflictGroupViewSeen) failures.push("conflictGroupViewSeen=false");
  if (!conversationIdentityRecallSeen) failures.push("conversationIdentityRecallSeen=false");
  if (!dreamConflictGroupLifecycleSeen) failures.push("dreamConflictGroupLifecycleSeen=false");
  if (!naturalLanguageCorrectionSeen) failures.push("naturalLanguageCorrectionSeen=false");
  if (!correctedMemoryConversationRecallSeen) {
    failures.push("correctedMemoryConversationRecallSeen=false");
  }
  if (!graphEdgeReinforcementSeen) failures.push("graphEdgeReinforcementSeen=false");
  if (!userFeedbackTrendSeen) failures.push("userFeedbackTrendSeen=false");
  if (!longCycleFeedbackTrendSeen) failures.push("longCycleFeedbackTrendSeen=false");
  if (!longProjectFeedbackConvergenceSeen) {
    failures.push("longProjectFeedbackConvergenceSeen=false");
  }
  if (!longProjectLearningDraftRecallSeen) {
    failures.push("longProjectLearningDraftRecallSeen=false");
  }
  if (!autonomousLearningCycleSeen) failures.push("autonomousLearningCycleSeen=false");
  if (!staleKnowledgeDemotionSeen) failures.push("staleKnowledgeDemotionSeen=false");
  if (!crossNodeRecommendationSeen) failures.push("crossNodeRecommendationSeen=false");
  if (!projectCaseRecallSeen) failures.push("projectCaseRecallSeen=false");
  if (!multiProjectConflictRecallSeen) failures.push("multiProjectConflictRecallSeen=false");
  if (!multilingualProjectRecallSeen) failures.push("multilingualProjectRecallSeen=false");
  if (!multiNodeSupersededCleanupSeen) failures.push("multiNodeSupersededCleanupSeen=false");
  if (!maintenanceConfigBoundarySeen) failures.push("maintenanceConfigBoundarySeen=false");
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
      assertions,
      filesVerified,
      maintenanceRecallSeen,
      workflowGraphRecallSeen,
      conflictGroupViewSeen,
      conversationIdentityRecallSeen,
      dreamConflictGroupLifecycleSeen,
      naturalLanguageCorrectionSeen,
      correctedMemoryConversationRecallSeen,
      graphEdgeReinforcementSeen,
      userFeedbackTrendSeen,
      longCycleFeedbackTrendSeen,
      longProjectFeedbackConvergenceSeen,
      longProjectLearningDraftRecallSeen,
      autonomousLearningCycleSeen,
      staleKnowledgeDemotionSeen,
      crossNodeRecommendationSeen,
      projectCaseRecallSeen,
      multiProjectConflictRecallSeen,
      multilingualProjectRecallSeen,
      multiNodeSupersededCleanupSeen,
      maintenanceConfigBoundarySeen
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
  const summary = readRecord(report.summary);
  const scenarios = Array.isArray(report.scenarios) ? report.scenarios.map(readRecord) : [];
  const details = readRecord(report.details);
  const scenarioCount = readNumber(summary.total);
  const patchUsageRate = readNumber(details.patchUsageRate);
  const filePatchCalls = readNumber(details.filePatchCalls);
  const fileEditCalls = readNumber(details.fileEditCalls);
  const fileWriteCalls = readNumber(details.fileWriteCalls);
  const recoveryScenarioCount = readNumber(details.recoveryScenarioCount);
  const multiFileRecoverySeen = details.multiFileRecoverySeen === true;
  const conflictExplanationSeen = details.conflictExplanationSeen === true;
  const rollbackVerified = details.rollbackVerified === true;
  const finalDiffQualityVerified = details.finalDiffQualityVerified === true;
  const unrelatedFilePreserved = details.unrelatedFilePreserved === true;
  const toolSearchRankedFilePatch =
    details.toolSearchRankedFilePatch === true ||
    scenarios.some((scenario) => readRecord(scenario.details).toolSearchRankedFilePatch === true);
  const approvalDiffPreviewSeen =
    details.approvalDiffPreviewSeen === true ||
    scenarios.some((scenario) => readRecord(scenario.details).approvalDiffPreviewSeen === true);
  const failures = [...base.failures];
  if (scenarioCount < 4) {
    failures.push(`scenarios=${scenarioCount}`);
  }
  if (filePatchCalls < 10) failures.push("FilePatch calls < 10");
  if (fileEditCalls !== 1) failures.push("FileEdit calls != 1");
  if (fileWriteCalls !== 0) failures.push("FileWrite used");
  if (recoveryScenarioCount < 4) failures.push(`recoveryScenarioCount=${recoveryScenarioCount}`);
  if (!multiFileRecoverySeen) failures.push("multiFileRecoverySeen=false");
  if (!conflictExplanationSeen) failures.push("conflictExplanationSeen=false");
  if (!rollbackVerified) failures.push("rollbackVerified=false");
  if (!finalDiffQualityVerified) failures.push("finalDiffQualityVerified=false");
  if (!unrelatedFilePreserved) failures.push("unrelatedFilePreserved=false");
  if (!toolSearchRankedFilePatch) failures.push("toolSearchRankedFilePatch=false");
  if (!approvalDiffPreviewSeen) failures.push("approvalDiffPreviewSeen=false");
  if (patchUsageRate < 0.8) failures.push(`patchUsageRate=${patchUsageRate}`);
  return {
    ...base,
    status: failures.length === 0 ? "passed" : "failed",
    score: failures.length === 0 ? 1 : Math.min(base.score, patchUsageRate),
    metrics: {
      ...base.metrics,
      patchUsageRate,
      filePatchCalls,
      fileEditCalls,
      fileWriteCalls,
      recoveryScenarioCount,
      multiFileRecoverySeen,
      conflictExplanationSeen,
      rollbackVerified,
      finalDiffQualityVerified,
      unrelatedFilePreserved,
      toolSearchRankedFilePatch,
      approvalDiffPreviewSeen
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
  const summary = readRecord(report.summary);
  const toolEfficiency = readRecord(summary.toolEfficiency);
  const failures = [...base.failures];
  const assertions = readNumber(summary.assertions);
  const filesVerified = readNumber(summary.filesVerified);
  const toolCallCount = readNumber(toolEfficiency.toolCallCount);
  const uniqueToolCount = readNumber(toolEfficiency.uniqueToolCount);
  if (assertions < 51) failures.push(`assertions=${assertions}`);
  if (filesVerified < 13) failures.push(`filesVerified=${filesVerified}`);
  if (toolCallCount < 37) failures.push(`toolCallCount=${toolCallCount}`);
  if (uniqueToolCount < 3) failures.push(`uniqueToolCount=${uniqueToolCount}`);
  if (details.activeGoalContextSeen !== true) failures.push("activeGoalContextSeen=false");
  if (details.completedGoalSuppressed !== true) failures.push("completedGoalSuppressed=false");
  if (details.blockedGoalSuppressed !== true) failures.push("blockedGoalSuppressed=false");
  if (details.writeDeniedInPlanMode !== true) failures.push("writeDeniedInPlanMode=false");
  if (details.planReviewPreviewShown !== true) failures.push("planReviewPreviewShown=false");
  if (details.planSubmittedToModel !== true) failures.push("planSubmittedToModel=false");
  if (details.planReviewPersisted !== true) failures.push("planReviewPersisted=false");
  if (details.crossSessionPlanReviewListed !== true) {
    failures.push("crossSessionPlanReviewListed=false");
  }
  if (details.planRevisionFeedbackSeen !== true) failures.push("planRevisionFeedbackSeen=false");
  if (details.planRevisionPersisted !== true) failures.push("planRevisionPersisted=false");
  if (details.multiRoundPlanFeedbackSeen !== true) {
    failures.push("multiRoundPlanFeedbackSeen=false");
  }
  if (details.secondPlanRevisionPersisted !== true) {
    failures.push("secondPlanRevisionPersisted=false");
  }
  if (details.planApprovalSeen !== true) failures.push("planApprovalSeen=false");
  if (details.planApprovalPersisted !== true) failures.push("planApprovalPersisted=false");
  if (details.planRevisionChainLinked !== true) failures.push("planRevisionChainLinked=false");
  if (details.planRevisionChainViewListed !== true) {
    failures.push("planRevisionChainViewListed=false");
  }
  if (details.inheritedPlanContextSeen !== true) failures.push("inheritedPlanContextSeen=false");
  if (details.inheritedPlanExecutionFollowed !== true) {
    failures.push("inheritedPlanExecutionFollowed=false");
  }
  if (details.inheritedPlanDeviationCorrected !== true) {
    failures.push("inheritedPlanDeviationCorrected=false");
  }
  if (details.repeatedPlanDeviationBlocked !== true) {
    failures.push("repeatedPlanDeviationBlocked=false");
  }
  if (details.multiStepPlanDeviationRecovered !== true) {
    failures.push("multiStepPlanDeviationRecovered=false");
  }
  if (details.migrationPlanExecutionVerified !== true) {
    failures.push("migrationPlanExecutionVerified=false");
  }
  if (details.crossSessionPlanAdopted !== true) failures.push("crossSessionPlanAdopted=false");
  if (details.crossSessionAdoptedPlanContextSeen !== true) {
    failures.push("crossSessionAdoptedPlanContextSeen=false");
  }
  if (details.parallelPlanIsolationSeen !== true) failures.push("parallelPlanIsolationSeen=false");
  if (details.parallelPlanConflictRejected !== true) {
    failures.push("parallelPlanConflictRejected=false");
  }
  if (details.parallelPlanAdoptedExplicitly !== true) {
    failures.push("parallelPlanAdoptedExplicitly=false");
  }
  if (details.mergedPlanCreated !== true) failures.push("mergedPlanCreated=false");
  if (details.mergedPlanContextSeen !== true) failures.push("mergedPlanContextSeen=false");
  if (details.multiBranchConvergenceCreated !== true) {
    failures.push("multiBranchConvergenceCreated=false");
  }
  if (details.multiBranchConvergenceContextSeen !== true) {
    failures.push("multiBranchConvergenceContextSeen=false");
  }
  if (details.multiBranchConvergenceExecuted !== true) {
    failures.push("multiBranchConvergenceExecuted=false");
  }
  if (details.conflictedMergeNeedsRevision !== true) {
    failures.push("conflictedMergeNeedsRevision=false");
  }
  if (details.conflictedMergeContextSeen !== true) {
    failures.push("conflictedMergeContextSeen=false");
  }
  if (details.conflictedMergeResolved !== true) failures.push("conflictedMergeResolved=false");
  if (details.resolvedMergeContextSeen !== true) {
    failures.push("resolvedMergeContextSeen=false");
  }
  if (details.multiObjectiveConflictDetected !== true) {
    failures.push("multiObjectiveConflictDetected=false");
  }
  if (details.multiObjectiveUserChoiceResolved !== true) {
    failures.push("multiObjectiveUserChoiceResolved=false");
  }
  if (details.multiObjectiveChoiceContextSeen !== true) {
    failures.push("multiObjectiveChoiceContextSeen=false");
  }
  if (details.multiObjectiveRejectedBranchExcluded !== true) {
    failures.push("multiObjectiveRejectedBranchExcluded=false");
  }
  if (details.multiObjectiveCompatibleBranchPreserved !== true) {
    failures.push("multiObjectiveCompatibleBranchPreserved=false");
  }
  if (details.multiObjectiveReadBeforeWriteGuardSeen !== true) {
    failures.push("multiObjectiveReadBeforeWriteGuardSeen=false");
  }
  if (details.multiObjectiveReleaseFilesUpdated !== true) {
    failures.push("multiObjectiveReleaseFilesUpdated=false");
  }
  if (details.multiObjectiveExecutionVerified !== true) {
    failures.push("multiObjectiveExecutionVerified=false");
  }
  if (details.longProjectRetrospectiveContextSeen !== true) {
    failures.push("longProjectRetrospectiveContextSeen=false");
  }
  if (details.longProjectRetrospectiveGenerated !== true) {
    failures.push("longProjectRetrospectiveGenerated=false");
  }
  if (details.longProjectRetrospectiveVerified !== true) {
    failures.push("longProjectRetrospectiveVerified=false");
  }
  if (details.blockedGoalPersisted !== true) failures.push("blockedGoalPersisted=false");
  if (details.goalCompleted !== true) failures.push("goalCompleted=false");
  return {
    ...base,
    status: failures.length === 0 ? "passed" : "failed",
    score: failures.length === 0 ? 1 : 0,
    metrics: {
      ...base.metrics,
      assertions,
      filesVerified,
      toolCallCount,
      uniqueToolCount,
      activeGoalContextSeen: details.activeGoalContextSeen === true,
      completedGoalSuppressed: details.completedGoalSuppressed === true,
      blockedGoalSuppressed: details.blockedGoalSuppressed === true,
      writeDeniedInPlanMode: details.writeDeniedInPlanMode === true,
      planReviewPreviewShown: details.planReviewPreviewShown === true,
      planSubmittedToModel: details.planSubmittedToModel === true,
      planReviewPersisted: details.planReviewPersisted === true,
      crossSessionPlanReviewListed: details.crossSessionPlanReviewListed === true,
      planRevisionFeedbackSeen: details.planRevisionFeedbackSeen === true,
      planRevisionPersisted: details.planRevisionPersisted === true,
      multiRoundPlanFeedbackSeen: details.multiRoundPlanFeedbackSeen === true,
      secondPlanRevisionPersisted: details.secondPlanRevisionPersisted === true,
      planApprovalSeen: details.planApprovalSeen === true,
      planApprovalPersisted: details.planApprovalPersisted === true,
      planRevisionChainLinked: details.planRevisionChainLinked === true,
      planRevisionChainViewListed: details.planRevisionChainViewListed === true,
      inheritedPlanContextSeen: details.inheritedPlanContextSeen === true,
      inheritedPlanExecutionFollowed: details.inheritedPlanExecutionFollowed === true,
      inheritedPlanDeviationCorrected: details.inheritedPlanDeviationCorrected === true,
      repeatedPlanDeviationBlocked: details.repeatedPlanDeviationBlocked === true,
      multiStepPlanDeviationRecovered: details.multiStepPlanDeviationRecovered === true,
      migrationPlanExecutionVerified: details.migrationPlanExecutionVerified === true,
      crossSessionPlanAdopted: details.crossSessionPlanAdopted === true,
      crossSessionAdoptedPlanContextSeen: details.crossSessionAdoptedPlanContextSeen === true,
      parallelPlanIsolationSeen: details.parallelPlanIsolationSeen === true,
      parallelPlanConflictRejected: details.parallelPlanConflictRejected === true,
      parallelPlanAdoptedExplicitly: details.parallelPlanAdoptedExplicitly === true,
      mergedPlanCreated: details.mergedPlanCreated === true,
      mergedPlanContextSeen: details.mergedPlanContextSeen === true,
      multiBranchConvergenceCreated: details.multiBranchConvergenceCreated === true,
      multiBranchConvergenceContextSeen: details.multiBranchConvergenceContextSeen === true,
      multiBranchConvergenceExecuted: details.multiBranchConvergenceExecuted === true,
      conflictedMergeNeedsRevision: details.conflictedMergeNeedsRevision === true,
      conflictedMergeContextSeen: details.conflictedMergeContextSeen === true,
      conflictedMergeResolved: details.conflictedMergeResolved === true,
      resolvedMergeContextSeen: details.resolvedMergeContextSeen === true,
      multiObjectiveConflictDetected: details.multiObjectiveConflictDetected === true,
      multiObjectiveUserChoiceResolved: details.multiObjectiveUserChoiceResolved === true,
      multiObjectiveChoiceContextSeen: details.multiObjectiveChoiceContextSeen === true,
      multiObjectiveRejectedBranchExcluded: details.multiObjectiveRejectedBranchExcluded === true,
      multiObjectiveCompatibleBranchPreserved:
        details.multiObjectiveCompatibleBranchPreserved === true,
      multiObjectiveReadBeforeWriteGuardSeen:
        details.multiObjectiveReadBeforeWriteGuardSeen === true,
      multiObjectiveReleaseFilesUpdated: details.multiObjectiveReleaseFilesUpdated === true,
      multiObjectiveExecutionVerified: details.multiObjectiveExecutionVerified === true,
      longProjectRetrospectiveContextSeen: details.longProjectRetrospectiveContextSeen === true,
      longProjectRetrospectiveGenerated: details.longProjectRetrospectiveGenerated === true,
      longProjectRetrospectiveVerified: details.longProjectRetrospectiveVerified === true,
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
  const summary = readRecord(report.summary);
  const toolEfficiency = readRecord(summary.toolEfficiency);
  const failures = [...base.failures];
  const assertions = readNumber(summary.assertions);
  const filesVerified = readNumber(summary.filesVerified);
  const toolCallCount = readNumber(toolEfficiency.toolCallCount);
  const uniqueToolCount = readNumber(toolEfficiency.uniqueToolCount);
  if (assertions < 48) failures.push(`assertions=${assertions}`);
  if (filesVerified < 2) failures.push(`filesVerified=${filesVerified}`);
  if (toolCallCount < 60) failures.push(`toolCallCount=${toolCallCount}`);
  if (uniqueToolCount < 3) failures.push(`uniqueToolCount=${uniqueToolCount}`);
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
  if (details.longCycleWorkspaceNoiseInjected !== true) {
    failures.push("longCycleWorkspaceNoiseInjected=false");
  }
  if (details.longCycleRepeatedWorkspaceStable !== true) {
    failures.push("longCycleRepeatedWorkspaceStable=false");
  }
  if (details.longCycleRepeatedBrowserStable !== true) {
    failures.push("longCycleRepeatedBrowserStable=false");
  }
  if (details.longCycleRepeatedFileEditStable !== true) {
    failures.push("longCycleRepeatedFileEditStable=false");
  }
  if (details.longCycleRepeatedMemoryCorrectStable !== true) {
    failures.push("longCycleRepeatedMemoryCorrectStable=false");
  }
  if (details.longCycleRepeatedMemoryRecallStable !== true) {
    failures.push("longCycleRepeatedMemoryRecallStable=false");
  }
  if (details.longCycleRepeatedSkillStable !== true) {
    failures.push("longCycleRepeatedSkillStable=false");
  }
  if (details.longCycleRepeatedAgentStable !== true) {
    failures.push("longCycleRepeatedAgentStable=false");
  }
  if (details.longCycleStrategyDriftStable !== true) {
    failures.push("longCycleStrategyDriftStable=false");
  }
  if (details.mixedIntentFileEditRanked !== true) {
    failures.push("mixedIntentFileEditRanked=false");
  }
  if (details.mixedIntentBrowserRanked !== true) {
    failures.push("mixedIntentBrowserRanked=false");
  }
  if (details.mixedIntentMemoryRecallRanked !== true) {
    failures.push("mixedIntentMemoryRecallRanked=false");
  }
  if (details.mixedIntentAgentRanked !== true) {
    failures.push("mixedIntentAgentRanked=false");
  }
  if (details.mixedIntentSchemasRevealed !== true) {
    failures.push("mixedIntentSchemasRevealed=false");
  }
  if (details.mixedIntentDynamicExpansionSeen !== true) {
    failures.push("mixedIntentDynamicExpansionSeen=false");
  }
  if (details.crossTurnMixedIntentInitialDeferredSeen !== true) {
    failures.push("crossTurnMixedIntentInitialDeferredSeen=false");
  }
  if (details.crossTurnMixedIntentFileEditStable !== true) {
    failures.push("crossTurnMixedIntentFileEditStable=false");
  }
  if (details.crossTurnMixedIntentBrowserStable !== true) {
    failures.push("crossTurnMixedIntentBrowserStable=false");
  }
  if (details.crossTurnMixedIntentMemoryRecallStable !== true) {
    failures.push("crossTurnMixedIntentMemoryRecallStable=false");
  }
  if (details.crossTurnMixedIntentAgentStable !== true) {
    failures.push("crossTurnMixedIntentAgentStable=false");
  }
  if (details.crossTurnMixedIntentSchemaIsolationSeen !== true) {
    failures.push("crossTurnMixedIntentSchemaIsolationSeen=false");
  }
  if (details.largeRepoInitialDeferredSeen !== true) {
    failures.push("largeRepoInitialDeferredSeen=false");
  }
  if (details.largeRepoMemoryCorrectCoreAvailable !== true) {
    failures.push("largeRepoMemoryCorrectCoreAvailable=false");
  }
  if (details.largeRepoWorkspaceRanked !== true) {
    failures.push("largeRepoWorkspaceRanked=false");
  }
  if (details.largeRepoFileEditRanked !== true) {
    failures.push("largeRepoFileEditRanked=false");
  }
  if (details.largeRepoBrowserRanked !== true) {
    failures.push("largeRepoBrowserRanked=false");
  }
  if (details.largeRepoArchiveRanked !== true) {
    failures.push("largeRepoArchiveRanked=false");
  }
  if (details.largeRepoMemoryCorrectRanked !== true) {
    failures.push("largeRepoMemoryCorrectRanked=false");
  }
  if (details.largeRepoMemoryRecallRanked !== true) {
    failures.push("largeRepoMemoryRecallRanked=false");
  }
  if (details.largeRepoLearningDraftRanked !== true) {
    failures.push("largeRepoLearningDraftRanked=false");
  }
  if (details.largeRepoAgentRanked !== true) {
    failures.push("largeRepoAgentRanked=false");
  }
  if (details.largeRepoSchemasRevealed !== true) {
    failures.push("largeRepoSchemasRevealed=false");
  }
  if (details.largeRepoSchemaIsolationSeen !== true) {
    failures.push("largeRepoSchemaIsolationSeen=false");
  }
  if (details.toolSearchContextPersisted !== true) {
    failures.push("toolSearchContextPersisted=false");
  }
  if (readNumber(details.toolSearchContextIntentCoverage) < 8) {
    failures.push("toolSearchContextIntentCoverage < 8");
  }
  if (readNumber(details.crossTaskProviderCalls) <= 0) failures.push("crossTaskProviderCalls=0");
  if (readNumber(details.longCycleProviderCalls) <= 0) failures.push("longCycleProviderCalls=0");
  if (readNumber(details.mixedIntentProviderCalls) <= 0) {
    failures.push("mixedIntentProviderCalls=0");
  }
  if (readNumber(details.crossTurnMixedIntentProviderCalls) <= 0) {
    failures.push("crossTurnMixedIntentProviderCalls=0");
  }
  if (readNumber(details.largeRepoProviderCalls) <= 0) failures.push("largeRepoProviderCalls=0");
  if (readNumber(details.largeRepoSelectedToolCount) < 5) {
    failures.push("largeRepoSelectedToolCount < 5");
  }
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
      assertions,
      filesVerified,
      toolCallCount,
      uniqueToolCount,
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
      longCycleWorkspaceNoiseInjected: details.longCycleWorkspaceNoiseInjected === true,
      longCycleRepeatedWorkspaceStable: details.longCycleRepeatedWorkspaceStable === true,
      longCycleRepeatedBrowserStable: details.longCycleRepeatedBrowserStable === true,
      longCycleRepeatedFileEditStable: details.longCycleRepeatedFileEditStable === true,
      longCycleRepeatedMemoryCorrectStable: details.longCycleRepeatedMemoryCorrectStable === true,
      longCycleRepeatedMemoryRecallStable: details.longCycleRepeatedMemoryRecallStable === true,
      longCycleRepeatedSkillStable: details.longCycleRepeatedSkillStable === true,
      longCycleRepeatedAgentStable: details.longCycleRepeatedAgentStable === true,
      longCycleStrategyDriftStable: details.longCycleStrategyDriftStable === true,
      mixedIntentFileEditRanked: details.mixedIntentFileEditRanked === true,
      mixedIntentBrowserRanked: details.mixedIntentBrowserRanked === true,
      mixedIntentMemoryRecallRanked: details.mixedIntentMemoryRecallRanked === true,
      mixedIntentAgentRanked: details.mixedIntentAgentRanked === true,
      mixedIntentSchemasRevealed: details.mixedIntentSchemasRevealed === true,
      mixedIntentDynamicExpansionSeen: details.mixedIntentDynamicExpansionSeen === true,
      crossTurnMixedIntentInitialDeferredSeen:
        details.crossTurnMixedIntentInitialDeferredSeen === true,
      crossTurnMixedIntentFileEditStable: details.crossTurnMixedIntentFileEditStable === true,
      crossTurnMixedIntentBrowserStable: details.crossTurnMixedIntentBrowserStable === true,
      crossTurnMixedIntentMemoryRecallStable:
        details.crossTurnMixedIntentMemoryRecallStable === true,
      crossTurnMixedIntentAgentStable: details.crossTurnMixedIntentAgentStable === true,
      crossTurnMixedIntentSchemaIsolationSeen:
        details.crossTurnMixedIntentSchemaIsolationSeen === true,
      largeRepoInitialDeferredSeen: details.largeRepoInitialDeferredSeen === true,
      largeRepoMemoryCorrectCoreAvailable: details.largeRepoMemoryCorrectCoreAvailable === true,
      largeRepoWorkspaceRanked: details.largeRepoWorkspaceRanked === true,
      largeRepoFileEditRanked: details.largeRepoFileEditRanked === true,
      largeRepoBrowserRanked: details.largeRepoBrowserRanked === true,
      largeRepoArchiveRanked: details.largeRepoArchiveRanked === true,
      largeRepoMemoryCorrectRanked: details.largeRepoMemoryCorrectRanked === true,
      largeRepoMemoryRecallRanked: details.largeRepoMemoryRecallRanked === true,
      largeRepoLearningDraftRanked: details.largeRepoLearningDraftRanked === true,
      largeRepoAgentRanked: details.largeRepoAgentRanked === true,
      largeRepoSchemasRevealed: details.largeRepoSchemasRevealed === true,
      largeRepoSchemaIsolationSeen: details.largeRepoSchemaIsolationSeen === true,
      toolSearchContextPersisted: details.toolSearchContextPersisted === true,
      toolSearchContextIntentCoverage: readNumber(details.toolSearchContextIntentCoverage),
      crossTaskProviderCalls: readNumber(details.crossTaskProviderCalls),
      longCycleProviderCalls: readNumber(details.longCycleProviderCalls),
      mixedIntentProviderCalls: readNumber(details.mixedIntentProviderCalls),
      crossTurnMixedIntentProviderCalls: readNumber(details.crossTurnMixedIntentProviderCalls),
      largeRepoProviderCalls: readNumber(details.largeRepoProviderCalls),
      largeRepoSelectedToolCount: readNumber(details.largeRepoSelectedToolCount),
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
  const summary = readRecord(report.summary);
  const toolEfficiency = readRecord(summary.toolEfficiency);
  const failures = [...base.failures];
  const assertions = readNumber(summary.assertions);
  const filesVerified = readNumber(summary.filesVerified);
  const toolCallCount = readNumber(toolEfficiency.toolCallCount);
  const uniqueToolCount = readNumber(toolEfficiency.uniqueToolCount);
  if (assertions < 64) failures.push(`assertions=${assertions}`);
  if (filesVerified < 6) failures.push(`filesVerified=${filesVerified}`);
  if (toolCallCount < 4) failures.push(`toolCallCount=${toolCallCount}`);
  if (uniqueToolCount < 3) failures.push(`uniqueToolCount=${uniqueToolCount}`);
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
    "sseDisconnectSimulated",
    "sseReconnectUsedAfterId",
    "sseReconnectCompletionSeen",
    "sseReconnectNoDuplicateReplay",
    "sseReconnectAuditPersisted",
    "sseJitterMultipleDisconnectsSimulated",
    "sseJitterRepeatedAfterCursorUsed",
    "sseJitterCompletionSeen",
    "sseJitterNoDuplicateReplay",
    "sseJitterAuditPersisted",
    "restartServeStarted",
    "restartDeviceAuthPersisted",
    "restartSessionPersisted",
    "restartSessionContextSeen",
    "restartJobPersisted",
    "restartJobAuditPersisted",
    "mobileBrowserViewportSeen",
    "mobileBrowserTokenStored",
    "mobileBrowserTokenUrlCleaned",
    "mobileBrowserMessageSent",
    "mobileBrowserStreamRendered",
    "mobileBrowserCancelRequested",
    "mobileBrowserCancelRendered",
    "lanSmokeBoundAllInterfaces",
    "lanSmokeHealthSeen",
    "lanSmokePanelLoaded",
    "lanSmokeAuthenticatedApiSeen",
    "peerCredentialsSaved",
    "peerSavedListed",
    "peerDispatchBoundAllInterfaces",
    "peerDispatchExternalUrlReachable",
    "peerAgentToolSearched",
    "peerAgentSchemaRevealed",
    "peerAgentDispatched",
    "peerDispatchSingleAgentCall",
    "peerDispatchCompleted",
    "peerDispatchResultReturned",
    "peerRemoteSessionCreated",
    "peerRemoteJobCompleted",
    "peerRemotePermissionModeInherited",
    "peerRemoteFileWritten",
    "peerLocalFileNotWritten",
    "peerDispatchAuditPersisted",
    "peerLongAgentDispatched",
    "peerLongDispatchRunningObserved",
    "peerLongDispatchCompleted",
    "peerLongDispatchResultReturned",
    "peerLongDispatchSecondAgentCall",
    "peerLongRemoteFileWritten",
    "peerLongRemoteFileIsolated",
    "peerLongRemoteJobCompleted",
    "peerLongRemoteAuditPersisted"
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
      assertions,
      filesVerified,
      toolCallCount,
      uniqueToolCount,
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
      sseDisconnectSimulated: details.sseDisconnectSimulated === true,
      sseReconnectUsedAfterId: details.sseReconnectUsedAfterId === true,
      sseReconnectCompletionSeen: details.sseReconnectCompletionSeen === true,
      sseReconnectNoDuplicateReplay: details.sseReconnectNoDuplicateReplay === true,
      sseReconnectAuditPersisted: details.sseReconnectAuditPersisted === true,
      sseJitterMultipleDisconnectsSimulated: details.sseJitterMultipleDisconnectsSimulated === true,
      sseJitterRepeatedAfterCursorUsed: details.sseJitterRepeatedAfterCursorUsed === true,
      sseJitterCompletionSeen: details.sseJitterCompletionSeen === true,
      sseJitterNoDuplicateReplay: details.sseJitterNoDuplicateReplay === true,
      sseJitterAuditPersisted: details.sseJitterAuditPersisted === true,
      restartServeStarted: details.restartServeStarted === true,
      restartDeviceAuthPersisted: details.restartDeviceAuthPersisted === true,
      restartSessionPersisted: details.restartSessionPersisted === true,
      restartSessionContextSeen: details.restartSessionContextSeen === true,
      restartJobPersisted: details.restartJobPersisted === true,
      restartJobAuditPersisted: details.restartJobAuditPersisted === true,
      mobileBrowserViewportSeen: details.mobileBrowserViewportSeen === true,
      mobileBrowserTokenStored: details.mobileBrowserTokenStored === true,
      mobileBrowserTokenUrlCleaned: details.mobileBrowserTokenUrlCleaned === true,
      mobileBrowserMessageSent: details.mobileBrowserMessageSent === true,
      mobileBrowserStreamRendered: details.mobileBrowserStreamRendered === true,
      mobileBrowserCancelRequested: details.mobileBrowserCancelRequested === true,
      mobileBrowserCancelRendered: details.mobileBrowserCancelRendered === true,
      lanSmokeBoundAllInterfaces: details.lanSmokeBoundAllInterfaces === true,
      lanSmokeHealthSeen: details.lanSmokeHealthSeen === true,
      lanSmokePanelLoaded: details.lanSmokePanelLoaded === true,
      lanSmokeAuthenticatedApiSeen: details.lanSmokeAuthenticatedApiSeen === true,
      peerCredentialsSaved: details.peerCredentialsSaved === true,
      peerSavedListed: details.peerSavedListed === true,
      peerDispatchBoundAllInterfaces: details.peerDispatchBoundAllInterfaces === true,
      peerDispatchExternalUrlReachable: details.peerDispatchExternalUrlReachable === true,
      peerAgentToolSearched: details.peerAgentToolSearched === true,
      peerAgentSchemaRevealed: details.peerAgentSchemaRevealed === true,
      peerAgentDispatched: details.peerAgentDispatched === true,
      peerDispatchSingleAgentCall: details.peerDispatchSingleAgentCall === true,
      peerDispatchCompleted: details.peerDispatchCompleted === true,
      peerDispatchResultReturned: details.peerDispatchResultReturned === true,
      peerRemoteSessionCreated: details.peerRemoteSessionCreated === true,
      peerRemoteJobCompleted: details.peerRemoteJobCompleted === true,
      peerRemotePermissionModeInherited: details.peerRemotePermissionModeInherited === true,
      peerRemoteFileWritten: details.peerRemoteFileWritten === true,
      peerLocalFileNotWritten: details.peerLocalFileNotWritten === true,
      peerDispatchAuditPersisted: details.peerDispatchAuditPersisted === true,
      peerLongAgentDispatched: details.peerLongAgentDispatched === true,
      peerLongDispatchRunningObserved: details.peerLongDispatchRunningObserved === true,
      peerLongDispatchCompleted: details.peerLongDispatchCompleted === true,
      peerLongDispatchResultReturned: details.peerLongDispatchResultReturned === true,
      peerLongDispatchSecondAgentCall: details.peerLongDispatchSecondAgentCall === true,
      peerLongRemoteFileWritten: details.peerLongRemoteFileWritten === true,
      peerLongRemoteFileIsolated: details.peerLongRemoteFileIsolated === true,
      peerLongRemoteJobCompleted: details.peerLongRemoteJobCompleted === true,
      peerLongRemoteAuditPersisted: details.peerLongRemoteAuditPersisted === true
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

function readStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
