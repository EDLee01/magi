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
  const assertions = readNumber(summary.assertions);
  const filesVerified = readNumber(summary.filesVerified);
  const toolCallCount = readNumber(toolEfficiency.toolCallCount);
  const uniqueToolCount = readNumber(toolEfficiency.uniqueToolCount);
  const providerCallsPerScenario = readNumber(summary.providerCallsPerScenario);
  if (assertions < 37) failures.push(`assertions=${assertions}`);
  if (filesVerified < 4) failures.push(`filesVerified=${filesVerified}`);
  if (!learningDraftApplySeen) failures.push("learningDraftApplySeen=false");
  if (!skillLearningApplySeen) failures.push("skillLearningApplySeen=false");
  if (!skillPatchLearningSeen) failures.push("skillPatchLearningSeen=false");
  if (!skillCorrectionSeen) failures.push("skillCorrectionSeen=false");
  if (!longCycleSkillIterationSeen) failures.push("longCycleSkillIterationSeen=false");
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
  const assertions = readNumber(summary.assertions);
  const filesVerified = readNumber(summary.filesVerified);
  const toolCallCount = readNumber(toolEfficiency.toolCallCount);
  const uniqueToolCount = readNumber(toolEfficiency.uniqueToolCount);
  const providerCallsPerScenario = readNumber(summary.providerCallsPerScenario);
  if (readNumber(summary.total) < 13) failures.push(`scenarios=${readNumber(summary.total)}`);
  if (taskClasses.size < 13) failures.push(`taskClasses=${taskClasses.size}`);
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
  if (assertions < 110) failures.push(`assertions=${assertions}`);
  if (filesVerified < 51) failures.push(`filesVerified=${filesVerified}`);
  if (toolCallCount < 110) failures.push(`toolCallCount=${toolCallCount}`);
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
  const dreamConflictGroupLifecycleSeen = details.dreamConflictGroupLifecycleSeen === true;
  const assertionList = readStringList(details.assertions);
  const naturalLanguageCorrectionSeen =
    assertionList.includes("natural-language correction disputed stale memory") &&
    assertionList.includes("natural-language correction recalled replacement only") &&
    assertionList.includes("natural-language correction persisted agent audit");
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
  if (results.length < 8) failures.push(`cases=${results.length}`);
  if (assertions < 43) failures.push(`assertions=${assertions}`);
  if (filesVerified < 7) failures.push(`filesVerified=${filesVerified}`);
  if (!maintenanceRecallSeen) failures.push("maintenanceRecallSeen=false");
  if (!workflowGraphRecallSeen) failures.push("workflowGraphRecallSeen=false");
  if (!conflictGroupViewSeen) failures.push("conflictGroupViewSeen=false");
  if (!dreamConflictGroupLifecycleSeen) failures.push("dreamConflictGroupLifecycleSeen=false");
  if (!naturalLanguageCorrectionSeen) failures.push("naturalLanguageCorrectionSeen=false");
  if (!graphEdgeReinforcementSeen) failures.push("graphEdgeReinforcementSeen=false");
  if (!userFeedbackTrendSeen) failures.push("userFeedbackTrendSeen=false");
  if (!longCycleFeedbackTrendSeen) failures.push("longCycleFeedbackTrendSeen=false");
  if (!staleKnowledgeDemotionSeen) failures.push("staleKnowledgeDemotionSeen=false");
  if (!crossNodeRecommendationSeen) failures.push("crossNodeRecommendationSeen=false");
  if (!projectCaseRecallSeen) failures.push("projectCaseRecallSeen=false");
  if (!multiProjectConflictRecallSeen) failures.push("multiProjectConflictRecallSeen=false");
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
      dreamConflictGroupLifecycleSeen,
      naturalLanguageCorrectionSeen,
      graphEdgeReinforcementSeen,
      userFeedbackTrendSeen,
      longCycleFeedbackTrendSeen,
      staleKnowledgeDemotionSeen,
      crossNodeRecommendationSeen,
      projectCaseRecallSeen,
      multiProjectConflictRecallSeen,
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
  if (assertions < 46) failures.push(`assertions=${assertions}`);
  if (filesVerified < 12) failures.push(`filesVerified=${filesVerified}`);
  if (toolCallCount < 31) failures.push(`toolCallCount=${toolCallCount}`);
  if (uniqueToolCount < 3) failures.push(`uniqueToolCount=${uniqueToolCount}`);
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
  if (assertions < 22) failures.push(`assertions=${assertions}`);
  if (filesVerified < 1) failures.push(`filesVerified=${filesVerified}`);
  if (toolCallCount < 16) failures.push(`toolCallCount=${toolCallCount}`);
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
  if (readNumber(details.crossTaskProviderCalls) <= 0) failures.push("crossTaskProviderCalls=0");
  if (readNumber(details.longCycleProviderCalls) <= 0) failures.push("longCycleProviderCalls=0");
  if (readNumber(details.mixedIntentProviderCalls) <= 0) {
    failures.push("mixedIntentProviderCalls=0");
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
      crossTaskProviderCalls: readNumber(details.crossTaskProviderCalls),
      longCycleProviderCalls: readNumber(details.longCycleProviderCalls),
      mixedIntentProviderCalls: readNumber(details.mixedIntentProviderCalls),
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
  if (assertions < 58) failures.push(`assertions=${assertions}`);
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
