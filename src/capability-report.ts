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
  const complexWorkflow = scenarios.find((scenario) => scenario.name === "complex workflow");
  const complexWorkflowDetails = readRecord(complexWorkflow?.details);
  const complexWorkflowAssertions = readStringList(complexWorkflowDetails.assertions);
  const complexWorkflowFilesVerified = readStringList(complexWorkflowDetails.filesVerified);
  const complexWorkflowProvider = readRecord(complexWorkflowDetails.provider);
  const complexWorkflowToolCounts = readRecord(complexWorkflowProvider.toolCounts);
  const complexWorkflowExposedTools = readStringList(complexWorkflowProvider.exposedTools);
  const providerToolSurfaces = scenarios
    .map((scenario) => readRecord(readRecord(scenario.details).provider))
    .filter(providerHasToolSurfaceEvidence);
  const providerToolSurfaceCount = providerToolSurfaces.filter((provider) =>
    hasProviderToolSurface(provider)
  ).length;
  const providerToolSurfaceBadCount = providerToolSurfaces.length - providerToolSurfaceCount;
  const providerToolSurfaceTarget = Math.min(readNumber(summary.total), 23);
  const complexWorkflowLearningDraftExposed =
    hasProviderToolSurface(complexWorkflowProvider, BASE_PROVIDER_TOOLS.length + 1) &&
    complexWorkflowExposedTools.includes("LearningDraft");
  const retryFallback = scenarios.find((scenario) => scenario.name === "retry fallback");
  const retryFallbackDetails = readRecord(retryFallback?.details);
  const retryFallbackProvider = readRecord(retryFallbackDetails.provider);
  const retryFallbackModels = readStringList(retryFallbackProvider.models);
  const retryFallbackRetry = readRecord(retryFallbackDetails.retry);
  const tuiStatefulPickers = scenarios.find((scenario) => scenario.name === "TUI stateful pickers");
  const tuiStatefulPickersProvider = readRecord(readRecord(tuiStatefulPickers?.details).provider);
  const tuiStatefulPickerModels = readStringList(tuiStatefulPickersProvider.models);
  const tuiPickerKeyboardNavigation = scenarios.find(
    (scenario) => scenario.name === "TUI picker keyboard navigation"
  );
  const tuiPickerKeyboardNavigationProvider = readRecord(
    readRecord(tuiPickerKeyboardNavigation?.details).provider
  );
  const tuiPickerKeyboardNavigationModels = readStringList(
    tuiPickerKeyboardNavigationProvider.models
  );
  const toolFeedbackRanking = scenarios.find(
    (scenario) => scenario.name === "tool feedback ranking"
  );
  const toolFeedbackRankingDetails = readRecord(toolFeedbackRanking?.details);
  const toolFeedbackRankingProvider = readRecord(toolFeedbackRankingDetails.provider);
  const toolFeedback = readRecord(toolFeedbackRankingDetails.toolFeedback);
  const controlApprovalFlow = scenarios.find(
    (scenario) => scenario.name === "control approval flow"
  );
  const controlApprovalFlowDetails = readRecord(controlApprovalFlow?.details);
  const controlApproval = readRecord(controlApprovalFlowDetails.control);
  const controlApprovalEventCount = readNumber(controlApproval.eventCount);
  const providerModels = Array.from(
    new Set(
      scenarios.flatMap((scenario) =>
        readStringList(readRecord(readRecord(scenario.details).provider).models)
      )
    )
  ).sort();
  const providerModelCoverageSeen = ["mock-backup", "mock-fast", "mock-main"].every((model) =>
    providerModels.includes(model)
  );
  const retryFallbackModelsSeen =
    retryFallbackModels.includes("mock-backup") && retryFallbackModels.includes("mock-main");
  const tuiModelPickerModelsSeen =
    tuiStatefulPickerModels.includes("mock-fast") &&
    tuiPickerKeyboardNavigationModels.includes("mock-fast");
  const assertionList = scenarios.flatMap((scenario) =>
    readStringList(readRecord(scenario.details).assertions)
  );
  const complexWorkflowSeen =
    complexWorkflow?.status === "passed" &&
    readNumber(complexWorkflowProvider.callCount) >= 5 &&
    [
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
    ].every((assertion) => complexWorkflowAssertions.includes(assertion)) &&
    [
      "reports/e2e-result.md",
      "state/todos.json",
      "memory/workflows/focused-cli-e2e.md",
      "skills/blackbox-verify/SKILL.md"
    ].every((file) => complexWorkflowFilesVerified.includes(file)) &&
    readNumber(complexWorkflowToolCounts.ToolSearch) >= 1 &&
    readNumber(complexWorkflowToolCounts.FileWrite) >= 1 &&
    readNumber(complexWorkflowToolCounts.TodoWrite) >= 1 &&
    readNumber(complexWorkflowToolCounts.Memorize) >= 1 &&
    readNumber(complexWorkflowToolCounts.FilePatch) >= 1 &&
    readNumber(complexWorkflowToolCounts.LearningDraft) >= 1 &&
    readNumber(complexWorkflowToolCounts.WorkspaceDiagnostics) >= 1 &&
    readNumber(complexWorkflowToolCounts.SendUserMessage) >= 1;
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
  const streamJsonExtendedProtocolSeen =
    assertionList.includes("stream-json emitted structured request started event") &&
    assertionList.includes("stream-json emitted structured usage event") &&
    assertionList.includes("stream-json emitted structured message delta event") &&
    assertionList.includes("stream-json emitted structured user message event") &&
    assertionList.includes("stream-json emitted structured approval request event") &&
    assertionList.includes("stream-json emitted structured hook completed event") &&
    assertionList.includes("stream-json emitted structured query done event") &&
    assertionList.includes("stream-json preserved raw extended agent events") &&
    assertionList.includes(
      "stream-json extended protocol kept denied write from mutating workspace"
    );
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
  const headlessDefaultPermissionDeniedSeen =
    assertionList.includes("approval request emitted") &&
    assertionList.includes("permission denial returned to model") &&
    assertionList.includes("denied write did not mutate workspace") &&
    assertionList.includes("default permission denial completed two-turn provider loop");
  const headlessPlanModeSeen =
    assertionList.includes("write denied in plan mode") &&
    assertionList.includes("ExitPlanMode surfaced plan") &&
    assertionList.includes("plan review persisted");
  const controlApprovalFlowSeen =
    assertionList.includes("magi serve started from dist CLI") &&
    assertionList.includes("phone pairing returned auth headers") &&
    assertionList.includes("background job exposed pending approval") &&
    assertionList.includes("SSE streamed pending and resolved approval events") &&
    assertionList.includes("phone approval unblocked FileWrite") &&
    assertionList.includes("control job completed and persisted audit events") &&
    assertionList.includes("control approval flow completed two provider turns");
  const providerRetryFallbackSeen =
    assertionList.includes("retry attempts exhausted on primary") &&
    assertionList.includes("fallback event emitted") &&
    assertionList.includes("backup model recovered") &&
    assertionList.includes("retry fallback used one backup provider call") &&
    retryFallback?.status === "passed" &&
    readNumber(retryFallbackProvider.callCount) >= 4 &&
    readNumber(retryFallbackRetry.primaryCalls) === 3 &&
    readNumber(retryFallbackRetry.backupCalls) === 1;
  const toolFeedbackRankingSeen =
    assertionList.includes("tool failures persisted") &&
    assertionList.includes("tool successes persisted") &&
    assertionList.includes("ToolSearch ranking used feedback") &&
    assertionList.includes("ToolSearch recovery guidance visible") &&
    assertionList.includes("ToolSearch feedback returned to model") &&
    assertionList.includes("tool feedback ranking completed three-turn provider loop") &&
    toolFeedbackRanking?.status === "passed" &&
    readNumber(toolFeedbackRankingProvider.callCount) >= 3 &&
    readNumber(toolFeedback.grepFailures) >= 4 &&
    readNumber(toolFeedback.globSuccesses) >= 4 &&
    toolFeedback.recoveryGuidanceSeen === true;
  const memoryGraphLinkSeen =
    assertionList.includes("memory draft applied") &&
    assertionList.includes("graph edge created") &&
    assertionList.includes("linked neighbor retrieved through graph search") &&
    assertionList.includes("memory graph sqlite persisted");
  const memoryCorrectionMaintenanceSeen =
    assertionList.includes("stale memory retrieved before correction") &&
    assertionList.includes("memory correct disputed old node") &&
    assertionList.includes("replacement memory recalled through graph search") &&
    assertionList.includes("disputed stale memory excluded from search results") &&
    assertionList.includes("memory conflict audit view recommends active replacement") &&
    assertionList.includes("memory dream suggests corrected stale graph cleanup") &&
    assertionList.includes("memory dream apply archives corrected disputed graph node") &&
    assertionList.includes("memory maintenance policy persisted and reused") &&
    assertionList.includes("memory maintenance decayed stale node weights") &&
    assertionList.includes("memory correction and maintenance audit persisted") &&
    assertionList.includes("memory correction maintenance completed CLI lifecycle");
  const tuiRequiresTtySeen =
    assertionList.includes("non-TTY TUI exits clearly") &&
    assertionList.includes("TTY requirement message emitted") &&
    assertionList.includes("non-TTY TUI returned usage exit code");
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
  const resumePickerSearchFieldsSeen =
    assertionList.includes("slash /resume filtered sessions by cwd detail") &&
    assertionList.includes("slash /resume cwd search showed multiple matching sessions") &&
    assertionList.includes("slash /resume cwd search excluded nonmatching session") &&
    assertionList.includes("slash /resume partial session id resumed target");
  const resumePickerVisualContractSeen =
    assertionList.includes("resume picker visual contract bounded narrow frame") &&
    assertionList.includes(
      "resume picker visual contract rendered selection and scroll position"
    ) &&
    assertionList.includes("resume picker visual contract rendered filter prompt and footer") &&
    assertionList.includes("resume picker visual contract clipped long session detail");
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
  const dangerousPermissionMatrixSeen =
    assertionList.includes("dangerous Bash denied in default mode without approval") &&
    assertionList.includes("dangerous Bash denied in acceptEdits mode") &&
    assertionList.includes("dangerous Bash denied in dontAsk mode") &&
    assertionList.includes("dangerous Bash denied in plan mode") &&
    assertionList.includes("dangerous Bash bypassPermissions required explicit env approval") &&
    assertionList.includes(
      "dangerous Bash bypassPermissions executed only with explicit env approval"
    ) &&
    assertionList.includes("dangerous permission matrix preserved denied sentinels") &&
    assertionList.includes("dangerous permission matrix emitted stream-json tool evidence");
  const slashSuggestionPromptSeen =
    assertionList.includes("slash suggestion menu rendered for slash input") &&
    assertionList.includes("slash suggestion filtered command descriptions") &&
    assertionList.includes("slash suggestion arrow selection submitted command") &&
    assertionList.includes("slash suggestion enter submitted filtered command") &&
    assertionList.includes("slash command coverage included context rules run extensions agents") &&
    assertionList.includes("slash suggestion submitted extension command") &&
    assertionList.includes("slash suggestion submitted command alias");
  const tuiVisualContractSeen =
    assertionList.includes("TUI startup text hat rendered") &&
    assertionList.includes("TUI startup banner width bounded") &&
    assertionList.includes("slash suggestion visual contract stable") &&
    assertionList.includes("TUI status pending approval rendered") &&
    assertionList.includes("TUI status transcript width bounded");
  const tuiKeyboardInputSeen =
    assertionList.includes("TUI keyboard editing submitted corrected multiline prompt") &&
    assertionList.includes("TUI keyboard editing removed stale typed characters") &&
    assertionList.includes("TUI keyboard editing reached provider exactly once") &&
    assertionList.includes("TUI keyboard editing returned provider response and exited");
  const tuiPromptHistorySeen =
    assertionList.includes("TUI prompt history recalled previous prompt") &&
    assertionList.includes("TUI prompt history edit submitted revised prompt") &&
    assertionList.includes("TUI prompt history reached provider twice") &&
    assertionList.includes("TUI prompt history rendered both provider responses");
  const tuiBracketedPasteSeen =
    assertionList.includes("TUI bracketed paste rendered paste placeholder") &&
    assertionList.includes("TUI bracketed paste restored full multiline prompt") &&
    assertionList.includes("TUI bracketed paste hid raw pasted body from edit surface") &&
    assertionList.includes("TUI bracketed paste reached provider once and exited");
  const tuiStatefulPickersSeen =
    assertionList.includes("TUI model picker switched subsequent provider route") &&
    assertionList.includes("TUI permission picker switched to plan mode") &&
    assertionList.includes("TUI picker-selected plan mode denied write") &&
    assertionList.includes("TUI picker flow left workspace unchanged") &&
    assertionList.includes("TUI picker flow returned provider response and exited");
  const tuiPickerKeyboardNavigationSeen =
    assertionList.includes("TUI picker keyboard Tab completed model filter") &&
    assertionList.includes("TUI picker keyboard arrows selected permission mode") &&
    assertionList.includes("TUI picker keyboard selected model routed provider") &&
    assertionList.includes("TUI picker keyboard selected plan mode denied write") &&
    assertionList.includes("TUI picker keyboard flow left workspace unchanged");
  const tuiApprovalPickerSeen =
    assertionList.includes("TUI approval picker rendered pending FileWrite approval") &&
    assertionList.includes("TUI approval picker hotkey denial resolved interaction") &&
    assertionList.includes("TUI approval denial returned to model") &&
    assertionList.includes("TUI approval denial left workspace unchanged") &&
    assertionList.includes("TUI approval picker flow returned provider response and exited");
  const tuiApprovalAllowPickerSeen =
    assertionList.includes("TUI approval allow picker rendered pending FileWrite approval") &&
    assertionList.includes("TUI approval allow hotkey resolved interaction") &&
    assertionList.includes("TUI approval allow returned write result to model") &&
    assertionList.includes("TUI approval allow wrote approved file") &&
    assertionList.includes("TUI approval allow flow returned provider response and exited");
  const tuiApprovalAlwaysPickerSeen =
    assertionList.includes("TUI approval always picker rendered persistent approval action") &&
    assertionList.includes("TUI approval always hotkey persisted FileWrite rule") &&
    assertionList.includes("TUI approval always wrote initial approved file") &&
    assertionList.includes("TUI approval always reused rule without second prompt") &&
    assertionList.includes("TUI approval always returned second write result to model") &&
    assertionList.includes("TUI approval always flow returned provider response and exited");
  const assertions = readNumber(summary.assertions);
  const filesVerified = readNumber(summary.filesVerified);
  const toolCallCount = readNumber(toolEfficiency.toolCallCount);
  const uniqueToolCount = readNumber(toolEfficiency.uniqueToolCount);
  const providerCallsPerScenario = readNumber(summary.providerCallsPerScenario);
  if (assertions < 188) failures.push(`assertions=${assertions}`);
  if (filesVerified < 4) failures.push(`filesVerified=${filesVerified}`);
  if (providerToolSurfaceCount < providerToolSurfaceTarget) {
    failures.push(`providerToolSurfaceCount=${providerToolSurfaceCount}`);
  }
  if (providerToolSurfaceBadCount > 0) {
    failures.push(`providerToolSurfaceBadCount=${providerToolSurfaceBadCount}`);
  }
  if (!complexWorkflowLearningDraftExposed) {
    failures.push("complexWorkflowLearningDraftExposed=false");
  }
  if (!providerModelCoverageSeen) failures.push("providerModelCoverageSeen=false");
  if (!retryFallbackModelsSeen) failures.push("retryFallbackModelsSeen=false");
  if (!tuiModelPickerModelsSeen) failures.push("tuiModelPickerModelsSeen=false");
  if (controlApprovalEventCount < 18) {
    failures.push(`controlApprovalEventCount=${controlApprovalEventCount}`);
  }
  if (!complexWorkflowSeen) failures.push("complexWorkflowSeen=false");
  if (!learningDraftApplySeen) failures.push("learningDraftApplySeen=false");
  if (!skillLearningApplySeen) failures.push("skillLearningApplySeen=false");
  if (!skillPatchLearningSeen) failures.push("skillPatchLearningSeen=false");
  if (!skillCorrectionSeen) failures.push("skillCorrectionSeen=false");
  if (!longCycleSkillIterationSeen) failures.push("longCycleSkillIterationSeen=false");
  if (!harnessCiTuiGuardSeen) failures.push("harnessCiTuiGuardSeen=false");
  if (!helpShapeSeen) failures.push("helpShapeSeen=false");
  if (!textOutputProtocolSeen) failures.push("textOutputProtocolSeen=false");
  if (!streamJsonProtocolSeen) failures.push("streamJsonProtocolSeen=false");
  if (!streamJsonExtendedProtocolSeen) failures.push("streamJsonExtendedProtocolSeen=false");
  if (!jsonOutputProtocolSeen) failures.push("jsonOutputProtocolSeen=false");
  if (!barePromptHeadlessSeen) failures.push("barePromptHeadlessSeen=false");
  if (!headlessDefaultPermissionDeniedSeen) {
    failures.push("headlessDefaultPermissionDeniedSeen=false");
  }
  if (!headlessPlanModeSeen) failures.push("headlessPlanModeSeen=false");
  if (!controlApprovalFlowSeen) failures.push("controlApprovalFlowSeen=false");
  if (!providerRetryFallbackSeen) failures.push("providerRetryFallbackSeen=false");
  if (!toolFeedbackRankingSeen) failures.push("toolFeedbackRankingSeen=false");
  if (!memoryGraphLinkSeen) failures.push("memoryGraphLinkSeen=false");
  if (!memoryCorrectionMaintenanceSeen) {
    failures.push("memoryCorrectionMaintenanceSeen=false");
  }
  if (!tuiRequiresTtySeen) failures.push("tuiRequiresTtySeen=false");
  if (!resumePickerTtySeen) failures.push("resumePickerTtySeen=false");
  if (!slashResumeSearchTtySeen) failures.push("slashResumeSearchTtySeen=false");
  if (!resumePickerSearchFieldsSeen) failures.push("resumePickerSearchFieldsSeen=false");
  if (!resumePickerVisualContractSeen) failures.push("resumePickerVisualContractSeen=false");
  if (!toolPolicySeen) failures.push("toolPolicySeen=false");
  if (!dangerousPermissionMatrixSeen) failures.push("dangerousPermissionMatrixSeen=false");
  if (!slashSuggestionPromptSeen) failures.push("slashSuggestionPromptSeen=false");
  if (!tuiVisualContractSeen) failures.push("tuiVisualContractSeen=false");
  if (!tuiKeyboardInputSeen) failures.push("tuiKeyboardInputSeen=false");
  if (!tuiPromptHistorySeen) failures.push("tuiPromptHistorySeen=false");
  if (!tuiBracketedPasteSeen) failures.push("tuiBracketedPasteSeen=false");
  if (!tuiStatefulPickersSeen) failures.push("tuiStatefulPickersSeen=false");
  if (!tuiPickerKeyboardNavigationSeen) {
    failures.push("tuiPickerKeyboardNavigationSeen=false");
  }
  if (!tuiApprovalPickerSeen) failures.push("tuiApprovalPickerSeen=false");
  if (!tuiApprovalAllowPickerSeen) failures.push("tuiApprovalAllowPickerSeen=false");
  if (!tuiApprovalAlwaysPickerSeen) failures.push("tuiApprovalAlwaysPickerSeen=false");
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
      providerToolSurfaceCount,
      providerToolSurfaceTarget,
      providerToolSurfaceBadCount,
      complexWorkflowLearningDraftExposed,
      providerModels,
      providerModelCoverageSeen,
      retryFallbackModels,
      retryFallbackModelsSeen,
      tuiStatefulPickerModels,
      tuiPickerKeyboardNavigationModels,
      tuiModelPickerModelsSeen,
      controlApprovalEventCount,
      complexWorkflowSeen,
      complexWorkflowProviderCalls: readNumber(complexWorkflowProvider.callCount),
      complexWorkflowFilesVerified: complexWorkflowFilesVerified.length,
      complexWorkflowWorkspaceDiagnosticsCalls: readNumber(
        complexWorkflowToolCounts.WorkspaceDiagnostics
      ),
      complexWorkflowSendUserMessageCalls: readNumber(complexWorkflowToolCounts.SendUserMessage),
      learningDraftApplySeen,
      skillLearningApplySeen,
      skillPatchLearningSeen,
      skillCorrectionSeen,
      longCycleSkillIterationSeen,
      harnessCiTuiGuardSeen,
      helpShapeSeen,
      textOutputProtocolSeen,
      streamJsonProtocolSeen,
      streamJsonExtendedProtocolSeen,
      jsonOutputProtocolSeen,
      barePromptHeadlessSeen,
      headlessDefaultPermissionDeniedSeen,
      headlessPlanModeSeen,
      controlApprovalFlowSeen,
      providerRetryFallbackSeen,
      retryFallbackPrimaryCalls: readNumber(retryFallbackRetry.primaryCalls),
      retryFallbackBackupCalls: readNumber(retryFallbackRetry.backupCalls),
      toolFeedbackRankingSeen,
      toolFeedbackGrepFailures: readNumber(toolFeedback.grepFailures),
      toolFeedbackGlobSuccesses: readNumber(toolFeedback.globSuccesses),
      toolFeedbackRecoveryGuidanceSeen: toolFeedback.recoveryGuidanceSeen === true,
      memoryGraphLinkSeen,
      memoryCorrectionMaintenanceSeen,
      tuiRequiresTtySeen,
      resumePickerTtySeen,
      slashResumeSearchTtySeen,
      resumePickerSearchFieldsSeen,
      resumePickerVisualContractSeen,
      toolPolicySeen,
      dangerousPermissionMatrixSeen,
      slashSuggestionPromptSeen,
      tuiVisualContractSeen,
      tuiKeyboardInputSeen,
      tuiPromptHistorySeen,
      tuiBracketedPasteSeen,
      tuiStatefulPickersSeen,
      tuiPickerKeyboardNavigationSeen,
      tuiApprovalPickerSeen,
      tuiApprovalAllowPickerSeen,
      tuiApprovalAlwaysPickerSeen,
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
  const detailsByTaskClass = new Map<string, Record<string, unknown>>();
  for (const scenario of scenarios) {
    const details = readRecord(scenario.details);
    if (typeof details.taskClass === "string") {
      detailsByTaskClass.set(details.taskClass, details);
    }
  }
  const fileEditAvoidanceTaskClasses = [
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
  const fileWriteAvoidanceTaskClasses = [
    "patch_strategy",
    "dependency_refactor",
    "api_migration",
    ...fileEditAvoidanceTaskClasses
  ];
  const fileEditAvoidedTaskCount = fileEditAvoidanceTaskClasses.filter((taskClass) => {
    const details = detailsByTaskClass.get(taskClass);
    const toolCounts = readRecord(details?.toolCounts);
    return details?.fileEditAvoided === true && readNumber(toolCounts.FileEdit) === 0;
  }).length;
  const fileWriteAvoidedTaskCount = fileWriteAvoidanceTaskClasses.filter((taskClass) => {
    const details = detailsByTaskClass.get(taskClass);
    const toolCounts = readRecord(details?.toolCounts);
    return details?.fileWriteAvoided === true && readNumber(toolCounts.FileWrite) === 0;
  }).length;
  const patchStrategy = scenarios.find(
    (scenario) => readRecord(scenario.details).taskClass === "patch_strategy"
  );
  const patchStrategyDetails = readRecord(patchStrategy ? readRecord(patchStrategy).details : {});
  const patchStrategyToolCounts = readRecord(patchStrategyDetails.toolCounts);
  const patchStrategyRate = readNumber(patchStrategyDetails.patchUsageRate);
  const patchStrategyFilePatchCalls = readNumber(patchStrategyToolCounts.FilePatch);
  const patchStrategyFileEditCalls = readNumber(patchStrategyToolCounts.FileEdit);
  const patchStrategyFileWriteCalls = readNumber(patchStrategyToolCounts.FileWrite);
  const dependencyRefactor = scenarios.find(
    (scenario) => readRecord(scenario.details).taskClass === "dependency_refactor"
  );
  const dependencyRefactorDetails = readRecord(
    dependencyRefactor ? readRecord(dependencyRefactor).details : {}
  );
  const dependencyRefactorToolCounts = readRecord(dependencyRefactorDetails.toolCounts);
  const dependencyRefactorTaskSeen = taskClasses.has("dependency_refactor");
  const dependencyRefactorBashCalls = readNumber(dependencyRefactorToolCounts.Bash);
  const dependencyRefactorFileReadCalls = readNumber(dependencyRefactorToolCounts.FileRead);
  const dependencyRefactorFilePatchCalls = readNumber(dependencyRefactorToolCounts.FilePatch);
  const dependencyRefactorFileWriteCalls = readNumber(dependencyRefactorToolCounts.FileWrite);
  const dependencyRefactorFileEditCalls = readNumber(dependencyRefactorToolCounts.FileEdit);
  const testDrivenRecovery = scenarios.find(
    (scenario) => readRecord(scenario.details).taskClass === "test_driven_recovery"
  );
  const testDrivenRecoveryDetails = readRecord(
    testDrivenRecovery ? readRecord(testDrivenRecovery).details : {}
  );
  const testDrivenRecoveryToolCounts = readRecord(testDrivenRecoveryDetails.toolCounts);
  const testDrivenRecoveryTaskSeen = taskClasses.has("test_driven_recovery");
  const testDrivenRecoveryBashCalls = readNumber(testDrivenRecoveryToolCounts.Bash);
  const testDrivenRecoveryFileReadCalls = readNumber(testDrivenRecoveryToolCounts.FileRead);
  const testDrivenRecoveryFilePatchCalls = readNumber(testDrivenRecoveryToolCounts.FilePatch);
  const testDrivenRecoveryFileWriteCalls = readNumber(testDrivenRecoveryToolCounts.FileWrite);
  const testDrivenRecoveryFileEditCalls = readNumber(testDrivenRecoveryToolCounts.FileEdit);
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
  if (fileEditAvoidedTaskCount !== fileEditAvoidanceTaskClasses.length) {
    failures.push(`fileEditAvoidedTaskCount=${fileEditAvoidedTaskCount}`);
  }
  if (fileWriteAvoidedTaskCount !== fileWriteAvoidanceTaskClasses.length) {
    failures.push(`fileWriteAvoidedTaskCount=${fileWriteAvoidedTaskCount}`);
  }
  if (patchStrategyFilePatchCalls < 1) failures.push("patchStrategyFilePatchCalls < 1");
  if (patchStrategyFileEditCalls !== 1) failures.push("patchStrategyFileEditCalls != 1");
  if (patchStrategyFileWriteCalls !== 0) failures.push("patchStrategyFileWrite used");
  if (patchStrategyRate < 0.5) failures.push(`patchStrategyRate=${patchStrategyRate}`);
  if (patchStrategyDetails.fileWriteAvoided !== true) {
    failures.push("patchStrategyFileWriteAvoided=false");
  }
  if (dependencyRefactorBashCalls !== 2) failures.push("dependencyRefactorBashCalls != 2");
  if (dependencyRefactorFileReadCalls < 2) failures.push("dependencyRefactorFileReadCalls < 2");
  if (dependencyRefactorFilePatchCalls < 2) {
    failures.push("dependencyRefactorFilePatchCalls < 2");
  }
  if (dependencyRefactorFileWriteCalls !== 0) failures.push("dependencyRefactorFileWrite used");
  if (dependencyRefactorFileEditCalls !== 0) failures.push("dependencyRefactorFileEdit used");
  if (dependencyRefactorDetails.fileWriteAvoided !== true) {
    failures.push("dependencyRefactorFileWriteAvoided=false");
  }
  if (testDrivenRecoveryBashCalls !== 2) failures.push("testDrivenRecoveryBashCalls != 2");
  if (testDrivenRecoveryFileReadCalls < 1) failures.push("testDrivenRecoveryFileReadCalls < 1");
  if (testDrivenRecoveryFilePatchCalls < 2) {
    failures.push("testDrivenRecoveryFilePatchCalls < 2");
  }
  if (testDrivenRecoveryFileWriteCalls !== 1) {
    failures.push("testDrivenRecoveryFileWriteCalls != 1");
  }
  if (testDrivenRecoveryFileEditCalls !== 0) failures.push("testDrivenRecoveryFileEdit used");
  if (testDrivenRecoveryDetails.recoverySeen !== true) {
    failures.push("testDrivenRecoverySeen=false");
  }
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
  if (ossIssueRegressionFixDetails.ossIssueRegressionTaskSeen !== true) {
    failures.push("ossIssueRegressionTaskSeen=false");
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
      fileEditAvoidedTaskCount,
      fileEditAvoidanceTaskTarget: fileEditAvoidanceTaskClasses.length,
      fileWriteAvoidedTaskCount,
      fileWriteAvoidanceTaskTarget: fileWriteAvoidanceTaskClasses.length,
      patchStrategyRate,
      patchStrategyFilePatchCalls,
      patchStrategyFileEditCalls,
      patchStrategyFileWriteCalls,
      patchStrategyFileWriteAvoided: patchStrategyDetails.fileWriteAvoided === true,
      testDrivenRecoveryTaskSeen,
      testDrivenRecoveryBashCalls,
      testDrivenRecoveryFileReadCalls,
      testDrivenRecoveryFilePatchCalls,
      testDrivenRecoveryFileWriteCalls,
      testDrivenRecoveryFileEditCalls,
      testDrivenRecoverySeen: testDrivenRecoveryDetails.recoverySeen === true,
      dependencyRefactorTaskSeen,
      dependencyRefactorBashCalls,
      dependencyRefactorFileReadCalls,
      dependencyRefactorFilePatchCalls,
      dependencyRefactorFileWriteCalls,
      dependencyRefactorFileEditCalls,
      dependencyRefactorFileWriteAvoided: dependencyRefactorDetails.fileWriteAvoided === true,
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
      ossIssueRegressionTaskSeen: ossIssueRegressionFixDetails.ossIssueRegressionTaskSeen === true,
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
  const providerToolSurfaces = detailsList.map((details) => readRecord(details.provider));
  const providerToolSurfaceTarget = detailsList.length;
  const providerToolSurfaceCount = providerToolSurfaces.filter((provider) =>
    hasProviderToolSurface(provider)
  ).length;
  const providerToolSurfaceBadCount = providerToolSurfaces.filter(
    (provider) => providerHasToolSurfaceEvidence(provider) && !hasProviderToolSurface(provider)
  ).length;
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
  const h2 = detailsList.find((details) => details.taskId === "H2");
  const h2ToolCounts = readRecord(h2?.toolCounts);
  const h2ChangedFiles = readStringList(h2?.changedFiles);
  const h2Assertions = readStringList(h2?.assertions);
  const h2ForbiddenChanges = readStringList(h2?.forbiddenChanges);
  const h2Session = readRecord(h2?.session);
  const h2Limits = readRecord(h2?.limitResults);
  const h2Seen = Boolean(h2);
  const h3 = detailsList.find((details) => details.taskId === "H3");
  const h3ToolCounts = readRecord(h3?.toolCounts);
  const h3ChangedFiles = readStringList(h3?.changedFiles);
  const h3Assertions = readStringList(h3?.assertions);
  const h3ForbiddenChanges = readStringList(h3?.forbiddenChanges);
  const h3Session = readRecord(h3?.session);
  const h3Limits = readRecord(h3?.limitResults);
  const h3Seen = Boolean(h3);
  const h4 = detailsList.find((details) => details.taskId === "H4");
  const h4ToolCounts = readRecord(h4?.toolCounts);
  const h4ChangedFiles = readStringList(h4?.changedFiles);
  const h4Assertions = readStringList(h4?.assertions);
  const h4ForbiddenChanges = readStringList(h4?.forbiddenChanges);
  const h4Session = readRecord(h4?.session);
  const h4Limits = readRecord(h4?.limitResults);
  const h4Seen = Boolean(h4);
  const h5 = detailsList.find((details) => details.taskId === "H5");
  const h5ToolCounts = readRecord(h5?.toolCounts);
  const h5ChangedFiles = readStringList(h5?.changedFiles);
  const h5Assertions = readStringList(h5?.assertions);
  const h5ForbiddenChanges = readStringList(h5?.forbiddenChanges);
  const h5Session = readRecord(h5?.session);
  const h5FailedToolReasons = readRecordList(h5Session.failedToolReasons);
  const h5OutsideWriteToolCallIdSeen = h5FailedToolReasons.some(
    (failure) => failure.target === "FileWrite" && failure.toolCallId === "h5-attempt-outside-write"
  );
  const h5Limits = readRecord(h5?.limitResults);
  const h5Seen = Boolean(h5);
  const h6 = detailsList.find((details) => details.taskId === "H6");
  const h6ToolCounts = readRecord(h6?.toolCounts);
  const h6ChangedFiles = readStringList(h6?.changedFiles);
  const h6Assertions = readStringList(h6?.assertions);
  const h6ForbiddenChanges = readStringList(h6?.forbiddenChanges);
  const h6Session = readRecord(h6?.session);
  const h6Resume = readRecord(h6?.resume);
  const h6Limits = readRecord(h6?.limitResults);
  const h6Seen = Boolean(h6);
  const h7 = detailsList.find((details) => details.taskId === "H7");
  const h7ToolCounts = readRecord(h7?.toolCounts);
  const h7ChangedFiles = readStringList(h7?.changedFiles);
  const h7Assertions = readStringList(h7?.assertions);
  const h7ForbiddenChanges = readStringList(h7?.forbiddenChanges);
  const h7Session = readRecord(h7?.session);
  const h7Stream = readRecord(h7?.stream);
  const h7Limits = readRecord(h7?.limitResults);
  const h7Seen = Boolean(h7);
  const h8 = detailsList.find((details) => details.taskId === "H8");
  const h8ToolCounts = readRecord(h8?.toolCounts);
  const h8ChangedFiles = readStringList(h8?.changedFiles);
  const h8Assertions = readStringList(h8?.assertions);
  const h8ForbiddenChanges = readStringList(h8?.forbiddenChanges);
  const h8Session = readRecord(h8?.session);
  const h8AgentQueue = readRecord(h8?.agentQueue);
  const h8WriteClaimFiles = readStringList(h8AgentQueue.writeClaimFiles);
  const h8TaskPrompts = readStringList(h8AgentQueue.taskPrompts);
  const h8Tasks = readRecordList(h8AgentQueue.tasks);
  const h8Claims = readRecordList(h8AgentQueue.claims);
  const h8ExpectedWorkerTasks = [
    { prompt: "update left module", filePath: "src/left.txt" },
    { prompt: "update right module", filePath: "src/right.txt" }
  ];
  const h8WorkerTaskEvidenceSeen = hasWorkerTaskEvidence(h8Tasks, h8ExpectedWorkerTasks);
  const h8ClaimOwnerEvidenceSeen = hasWorkerClaimEvidence(
    h8Claims,
    h8Tasks,
    h8ExpectedWorkerTasks.map((task) => task.filePath)
  );
  const h8Limits = readRecord(h8?.limitResults);
  const h8Seen = Boolean(h8);
  const h9 = detailsList.find((details) => details.taskId === "H9");
  const h9ToolCounts = readRecord(h9?.toolCounts);
  const h9ChangedFiles = readStringList(h9?.changedFiles);
  const h9Assertions = readStringList(h9?.assertions);
  const h9ForbiddenChanges = readStringList(h9?.forbiddenChanges);
  const h9Session = readRecord(h9?.session);
  const h9Approval = readRecord(h9?.approval);
  const h9CompletedToolIds = readStringList(h9Approval.completedToolIds);
  const h9Limits = readRecord(h9?.limitResults);
  const h9Seen = Boolean(h9);
  const h10 = detailsList.find((details) => details.taskId === "H10");
  const h10ToolCounts = readRecord(h10?.toolCounts);
  const h10ChangedFiles = readStringList(h10?.changedFiles);
  const h10Assertions = readStringList(h10?.assertions);
  const h10ForbiddenChanges = readStringList(h10?.forbiddenChanges);
  const h10Session = readRecord(h10?.session);
  const h10Stream = readRecord(h10?.stream);
  const h10ProviderRouting = readRecord(h10?.providerRouting);
  const h10RetryProviders = readStringList(h10ProviderRouting.retryProviders);
  const h10RetryErrorKinds = readStringList(h10ProviderRouting.retryErrorKinds);
  const h10RetryAttempts = Array.isArray(h10ProviderRouting.retryAttempts)
    ? h10ProviderRouting.retryAttempts.filter(
        (attempt): attempt is number => typeof attempt === "number" && Number.isFinite(attempt)
      )
    : [];
  const h10Limits = readRecord(h10?.limitResults);
  const h10Seen = Boolean(h10);
  const normalStreamDiagnosticsTasks = [h1, h2, h3, h4, h5, h7, h8, h9];
  const normalStreamDiagnosticsCount = normalStreamDiagnosticsTasks.filter((details) => {
    const stream = readRecord(details?.stream);
    return (
      stream.providerRetrySeen === false &&
      readNumber(stream.providerRetryCount) === 0 &&
      stream.providerFallbackSeen === false &&
      stream.sessionErrorSeen === false &&
      stream.completedStatus === "completed"
    );
  }).length;
  const streamEventCountTasks = [h1, h2, h3, h4, h5, h7, h8, h9, h10];
  const streamEventCountEvidenceCount = streamEventCountTasks.filter((details) => {
    const stream = readRecord(details?.stream);
    return readNumber(stream.eventCount) >= 17;
  }).length;
  const assertions = readNumber(summary.assertions);
  const filesVerified = readNumber(summary.filesVerified);
  const toolCallCount = readNumber(toolEfficiency.toolCallCount);
  const uniqueToolCount = readNumber(toolEfficiency.uniqueToolCount);
  const failures = [...base.failures];

  if (readNumber(summary.total) < 10) failures.push(`scenarios=${readNumber(summary.total)}`);
  if (!taskClasses.has("single_file_bug_fix")) failures.push("singleFileBugFixTask=false");
  if (!taskClasses.has("multi_file_feature")) failures.push("multiFileFeatureTask=false");
  if (!taskClasses.has("behavior_preserving_refactor"))
    failures.push("behaviorPreservingRefactorTask=false");
  if (!taskClasses.has("repository_investigation_fix"))
    failures.push("repositoryInvestigationFixTask=false");
  if (!taskClasses.has("permission_boundary")) failures.push("permissionBoundaryTask=false");
  if (!taskClasses.has("resume_after_interruption"))
    failures.push("resumeAfterInterruptionTask=false");
  if (!taskClasses.has("stream_json_automation")) failures.push("streamJsonAutomationTask=false");
  if (!taskClasses.has("multi_agent_conflict")) failures.push("multiAgentConflictTask=false");
  if (!taskClasses.has("bash_approval_control")) failures.push("bashApprovalControlTask=false");
  if (!taskClasses.has("provider_retry_fallback")) failures.push("providerRetryFallbackTask=false");
  if (!h1Seen) failures.push("H1=false");
  if (!h2Seen) failures.push("H2=false");
  if (!h3Seen) failures.push("H3=false");
  if (!h4Seen) failures.push("H4=false");
  if (!h5Seen) failures.push("H5=false");
  if (!h6Seen) failures.push("H6=false");
  if (!h7Seen) failures.push("H7=false");
  if (!h8Seen) failures.push("H8=false");
  if (!h9Seen) failures.push("H9=false");
  if (!h10Seen) failures.push("H10=false");
  if (assertions < 145) failures.push(`assertions=${assertions}`);
  if (filesVerified < 53) failures.push(`filesVerified=${filesVerified}`);
  if (toolCallCount < 56) failures.push(`toolCallCount=${toolCallCount}`);
  if (uniqueToolCount < 6) failures.push(`uniqueToolCount=${uniqueToolCount}`);
  if (providerToolSurfaceCount !== providerToolSurfaceTarget) {
    failures.push(`providerToolSurfaceCount=${providerToolSurfaceCount}`);
  }
  if (providerToolSurfaceBadCount > 0) {
    failures.push(`providerToolSurfaceBadCount=${providerToolSurfaceBadCount}`);
  }
  if (normalStreamDiagnosticsCount !== normalStreamDiagnosticsTasks.length) {
    failures.push(`normalStreamDiagnosticsCount=${normalStreamDiagnosticsCount}`);
  }
  if (streamEventCountEvidenceCount !== streamEventCountTasks.length) {
    failures.push(`streamEventCountEvidenceCount=${streamEventCountEvidenceCount}`);
  }
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
  if (readNumber(h2ToolCounts.FileRead) < 4) failures.push("H2FileReadCalls < 4");
  if (readNumber(h2ToolCounts.FilePatch) < 4) failures.push("H2FilePatchCalls < 4");
  if (readNumber(h2ToolCounts.Bash) !== 2) failures.push("H2BashCalls != 2");
  if (readNumber(h2ToolCounts.FileWrite) !== 0) failures.push("H2FileWrite used");
  if (readNumber(h2ToolCounts.FileEdit) !== 0) failures.push("H2FileEdit used");
  if (h2?.checksPassed !== true) failures.push("H2ChecksPassed=false");
  if (h2?.streamJsonLifecycleVerified !== true) failures.push("H2StreamJsonLifecycle=false");
  if (
    JSON.stringify(h2ChangedFiles) !==
    JSON.stringify(["README.md", "src/cli.js", "src/store.js", "tests/cli.test.mjs"])
  ) {
    failures.push(`H2ChangedFiles=${JSON.stringify(h2ChangedFiles)}`);
  }
  if (h2ForbiddenChanges.length > 0)
    failures.push(`H2ForbiddenChanges=${h2ForbiddenChanges.length}`);
  if (h2Assertions.length < 12) failures.push(`H2Assertions=${h2Assertions.length}`);
  if (readNumber(h2Session.messageCount) < 2) failures.push("H2SessionMessages < 2");
  if (readNumber(h2Session.auditEventCount) < 1) failures.push("H2AuditEvents < 1");
  if (h2Limits.withinTime !== true) failures.push("H2WithinTime=false");
  if (h2Limits.withinCommands !== true) failures.push("H2WithinCommands=false");
  if (h2Limits.withinFileChanges !== true) failures.push("H2WithinFileChanges=false");
  if (readNumber(h3ToolCounts.FileRead) < 3) failures.push("H3FileReadCalls < 3");
  if (readNumber(h3ToolCounts.FilePatch) < 2) failures.push("H3FilePatchCalls < 2");
  if (readNumber(h3ToolCounts.Bash) !== 2) failures.push("H3BashCalls != 2");
  if (readNumber(h3ToolCounts.FileWrite) !== 1) failures.push("H3FileWriteCalls != 1");
  if (readNumber(h3ToolCounts.FileEdit) !== 0) failures.push("H3FileEdit used");
  if (h3?.checksPassed !== true) failures.push("H3ChecksPassed=false");
  if (h3?.streamJsonLifecycleVerified !== true) failures.push("H3StreamJsonLifecycle=false");
  if (
    JSON.stringify(h3ChangedFiles) !==
    JSON.stringify(["src/inventory.js", "src/parse.js", "src/sales.js"])
  ) {
    failures.push(`H3ChangedFiles=${JSON.stringify(h3ChangedFiles)}`);
  }
  if (h3ForbiddenChanges.length > 0)
    failures.push(`H3ForbiddenChanges=${h3ForbiddenChanges.length}`);
  if (h3Assertions.length < 13) failures.push(`H3Assertions=${h3Assertions.length}`);
  if (readNumber(h3Session.messageCount) < 2) failures.push("H3SessionMessages < 2");
  if (readNumber(h3Session.auditEventCount) < 1) failures.push("H3AuditEvents < 1");
  if (h3Limits.withinTime !== true) failures.push("H3WithinTime=false");
  if (h3Limits.withinCommands !== true) failures.push("H3WithinCommands=false");
  if (h3Limits.withinFileChanges !== true) failures.push("H3WithinFileChanges=false");
  if (readNumber(h4ToolCounts.Glob) < 1) failures.push("H4GlobCalls < 1");
  if (readNumber(h4ToolCounts.Grep) < 1) failures.push("H4GrepCalls < 1");
  if (readNumber(h4ToolCounts.FileRead) < 4) failures.push("H4FileReadCalls < 4");
  if (readNumber(h4ToolCounts.FilePatch) !== 1) failures.push("H4FilePatchCalls != 1");
  if (readNumber(h4ToolCounts.Bash) !== 2) failures.push("H4BashCalls != 2");
  if (readNumber(h4ToolCounts.FileWrite) !== 0) failures.push("H4FileWrite used");
  if (readNumber(h4ToolCounts.FileEdit) !== 0) failures.push("H4FileEdit used");
  if (h4?.checksPassed !== true) failures.push("H4ChecksPassed=false");
  if (h4?.streamJsonLifecycleVerified !== true) failures.push("H4StreamJsonLifecycle=false");
  if (JSON.stringify(h4ChangedFiles) !== JSON.stringify(["src/config/validate.js"])) {
    failures.push(`H4ChangedFiles=${JSON.stringify(h4ChangedFiles)}`);
  }
  if (h4ForbiddenChanges.length > 0)
    failures.push(`H4ForbiddenChanges=${h4ForbiddenChanges.length}`);
  if (h4Assertions.length < 14) failures.push(`H4Assertions=${h4Assertions.length}`);
  if (readNumber(h4Session.messageCount) < 2) failures.push("H4SessionMessages < 2");
  if (readNumber(h4Session.auditEventCount) < 1) failures.push("H4AuditEvents < 1");
  if (h4Limits.withinTime !== true) failures.push("H4WithinTime=false");
  if (h4Limits.withinCommands !== true) failures.push("H4WithinCommands=false");
  if (h4Limits.withinFileChanges !== true) failures.push("H4WithinFileChanges=false");
  if (readNumber(h5ToolCounts.FileRead) < 2) failures.push("H5FileReadCalls < 2");
  if (readNumber(h5ToolCounts.FileWrite) !== 1) failures.push("H5FileWriteCalls != 1");
  if (readNumber(h5ToolCounts.FilePatch) !== 1) failures.push("H5FilePatchCalls != 1");
  if (readNumber(h5ToolCounts.Bash) !== 2) failures.push("H5BashCalls != 2");
  if (readNumber(h5ToolCounts.FileEdit) !== 0) failures.push("H5FileEdit used");
  if (h5?.checksPassed !== true) failures.push("H5ChecksPassed=false");
  if (h5?.streamJsonLifecycleVerified !== true) failures.push("H5StreamJsonLifecycle=false");
  if (JSON.stringify(h5ChangedFiles) !== JSON.stringify(["src/project-config.js"])) {
    failures.push(`H5ChangedFiles=${JSON.stringify(h5ChangedFiles)}`);
  }
  if (h5ForbiddenChanges.length > 0)
    failures.push(`H5ForbiddenChanges=${h5ForbiddenChanges.length}`);
  if (h5Assertions.length < 14) failures.push(`H5Assertions=${h5Assertions.length}`);
  if (readNumber(h5Session.messageCount) < 2) failures.push("H5SessionMessages < 2");
  if (readNumber(h5Session.auditEventCount) < 1) failures.push("H5AuditEvents < 1");
  if (!hasFailedToolReason(h5FailedToolReasons, "FileWrite", "outside allowed directories")) {
    failures.push("H5OutsideWriteAuditMissing");
  }
  if (!h5OutsideWriteToolCallIdSeen) failures.push("H5OutsideWriteToolCallIdMissing");
  if (h5Limits.withinTime !== true) failures.push("H5WithinTime=false");
  if (h5Limits.withinCommands !== true) failures.push("H5WithinCommands=false");
  if (h5Limits.withinFileChanges !== true) failures.push("H5WithinFileChanges=false");
  if (readNumber(h6ToolCounts.FileRead) < 4) failures.push("H6FileReadCalls < 4");
  if (readNumber(h6ToolCounts.FileWrite) !== 1) failures.push("H6FileWriteCalls != 1");
  if (readNumber(h6ToolCounts.FilePatch) !== 1) failures.push("H6FilePatchCalls != 1");
  if (readNumber(h6ToolCounts.Bash) !== 2) failures.push("H6BashCalls != 2");
  if (readNumber(h6ToolCounts.FileEdit) !== 0) failures.push("H6FileEdit used");
  if (h6?.checksPassed !== true) failures.push("H6ChecksPassed=false");
  if (h6?.streamJsonLifecycleVerified !== true) failures.push("H6StreamJsonLifecycle=false");
  if (
    JSON.stringify(h6ChangedFiles) !==
    JSON.stringify(["reports/invoice-investigation.md", "src/invoice.js"])
  ) {
    failures.push(`H6ChangedFiles=${JSON.stringify(h6ChangedFiles)}`);
  }
  if (h6ForbiddenChanges.length > 0)
    failures.push(`H6ForbiddenChanges=${h6ForbiddenChanges.length}`);
  if (h6Assertions.length < 15) failures.push(`H6Assertions=${h6Assertions.length}`);
  if (readNumber(h6Session.messageCount) < 4) failures.push("H6SessionMessages < 4");
  if (readNumber(h6Session.auditEventCount) < 1) failures.push("H6AuditEvents < 1");
  if (h6Resume.sameSession !== true) failures.push("H6SameSession=false");
  if (
    typeof h6Resume.firstSessionId !== "string" ||
    typeof h6Resume.resumedSessionId !== "string" ||
    h6Resume.firstSessionId !== h6Resume.resumedSessionId
  ) {
    failures.push("H6ResumeSessionIdMismatch");
  }
  if (h6Limits.withinTime !== true) failures.push("H6WithinTime=false");
  if (h6Limits.withinCommands !== true) failures.push("H6WithinCommands=false");
  if (h6Limits.withinFileChanges !== true) failures.push("H6WithinFileChanges=false");
  if (readNumber(h7ToolCounts.FileWrite) !== 1) failures.push("H7FileWriteCalls != 1");
  if (readNumber(h7ToolCounts.FileRead) !== 0) failures.push("H7FileRead used");
  if (readNumber(h7ToolCounts.FilePatch) !== 0) failures.push("H7FilePatch used");
  if (readNumber(h7ToolCounts.Bash) !== 0) failures.push("H7Bash used");
  if (readNumber(h7ToolCounts.FileEdit) !== 0) failures.push("H7FileEdit used");
  if (h7?.checksPassed !== true) failures.push("H7ChecksPassed=false");
  if (h7?.streamJsonLifecycleVerified !== true) failures.push("H7StreamJsonLifecycle=false");
  if (JSON.stringify(h7ChangedFiles) !== JSON.stringify(["output/automation-result.txt"])) {
    failures.push(`H7ChangedFiles=${JSON.stringify(h7ChangedFiles)}`);
  }
  if (h7ForbiddenChanges.length > 0)
    failures.push(`H7ForbiddenChanges=${h7ForbiddenChanges.length}`);
  if (h7Assertions.length < 16) failures.push(`H7Assertions=${h7Assertions.length}`);
  if (readNumber(h7Session.messageCount) < 2) failures.push("H7SessionMessages < 2");
  if (readNumber(h7Session.auditEventCount) < 1) failures.push("H7AuditEvents < 1");
  if (h7Stream.validNdjson !== true) failures.push("H7ValidNdjson=false");
  if (h7Stream.stderrEmpty !== true) failures.push("H7StderrEmpty=false");
  if (h7Stream.startedFirst !== true) failures.push("H7StartedFirst=false");
  if (h7Stream.completedLast !== true) failures.push("H7CompletedLast=false");
  if (h7Stream.userMessageSeen !== true) failures.push("H7UserMessage=false");
  if (h7Stream.assistantMessageSeen !== true) failures.push("H7AssistantMessage=false");
  if (h7Stream.toolStartedSeen !== true) failures.push("H7ToolStarted=false");
  if (h7Stream.toolCompletedSeen !== true) failures.push("H7ToolCompleted=false");
  if (h7Stream.rawToolUseSeen !== true) failures.push("H7RawToolUse=false");
  if (h7Stream.rawToolResultSeen !== true) failures.push("H7RawToolResult=false");
  if (h7Seen && h7Stream.providerRetrySeen !== false) failures.push("H7ProviderRetrySeen=true");
  if (h7Seen && readNumber(h7Stream.providerRetryCount) !== 0) {
    failures.push("H7ProviderRetryStreamCount != 0");
  }
  if (h7Seen && h7Stream.providerFallbackSeen !== false) {
    failures.push("H7ProviderFallbackSeen=true");
  }
  if (h7Stream.finalMessageMatched !== true) failures.push("H7FinalMessage=false");
  if (h7Limits.withinTime !== true) failures.push("H7WithinTime=false");
  if (h7Limits.withinCommands !== true) failures.push("H7WithinCommands=false");
  if (h7Limits.withinFileChanges !== true) failures.push("H7WithinFileChanges=false");
  if (readNumber(h8ToolCounts.FileRead) !== 1) failures.push("H8FileReadCalls != 1");
  if (readNumber(h8ToolCounts.Bash) !== 1) failures.push("H8BashCalls != 1");
  if (readNumber(h8ToolCounts.FileWrite) !== 1) failures.push("H8FileWriteCalls != 1");
  if (readNumber(h8ToolCounts.FilePatch) !== 0) failures.push("H8FilePatch used");
  if (readNumber(h8ToolCounts.FileEdit) !== 0) failures.push("H8FileEdit used");
  if (h8?.checksPassed !== true) failures.push("H8ChecksPassed=false");
  if (h8?.streamJsonLifecycleVerified !== true) failures.push("H8StreamJsonLifecycle=false");
  if (JSON.stringify(h8ChangedFiles) !== JSON.stringify(["reports/agent-conflict-report.md"])) {
    failures.push(`H8ChangedFiles=${JSON.stringify(h8ChangedFiles)}`);
  }
  if (h8ForbiddenChanges.length > 0)
    failures.push(`H8ForbiddenChanges=${h8ForbiddenChanges.length}`);
  if (h8Assertions.length < 16) failures.push(`H8Assertions=${h8Assertions.length}`);
  if (readNumber(h8Session.messageCount) < 2) failures.push("H8SessionMessages < 2");
  if (readNumber(h8Session.auditEventCount) < 1) failures.push("H8AuditEvents < 1");
  if (readNumber(h8AgentQueue.taskCount) !== 2) failures.push("H8TaskCount != 2");
  if (readNumber(h8AgentQueue.completedTaskCount) !== 2) failures.push("H8CompletedTaskCount != 2");
  if (readNumber(h8AgentQueue.workerTaskCount) !== 2) failures.push("H8WorkerTaskCount != 2");
  if (readNumber(h8AgentQueue.writeClaimCount) !== 2) failures.push("H8WriteClaimCount != 2");
  if (JSON.stringify(h8WriteClaimFiles) !== JSON.stringify(["src/left.txt", "src/right.txt"])) {
    failures.push(`H8WriteClaimFiles=${JSON.stringify(h8WriteClaimFiles)}`);
  }
  if (
    JSON.stringify(h8TaskPrompts) !== JSON.stringify(["update left module", "update right module"])
  ) {
    failures.push(`H8TaskPrompts=${JSON.stringify(h8TaskPrompts)}`);
  }
  if (!h8WorkerTaskEvidenceSeen) failures.push("H8WorkerTaskEvidenceMissing");
  if (!h8ClaimOwnerEvidenceSeen) failures.push("H8ClaimOwnerEvidenceMissing");
  if (h8AgentQueue.conflictRejected !== true) failures.push("H8ConflictRejected=false");
  if (h8Limits.withinTime !== true) failures.push("H8WithinTime=false");
  if (h8Limits.withinCommands !== true) failures.push("H8WithinCommands=false");
  if (h8Limits.withinFileChanges !== true) failures.push("H8WithinFileChanges=false");
  if (readNumber(h9ToolCounts.FileRead) !== 1) failures.push("H9FileReadCalls != 1");
  if (readNumber(h9ToolCounts.Bash) !== 1) failures.push("H9BashCalls != 1");
  if (readNumber(h9ToolCounts.FileWrite) !== 1) failures.push("H9FileWriteCalls != 1");
  if (readNumber(h9ToolCounts.FilePatch) !== 0) failures.push("H9FilePatch used");
  if (readNumber(h9ToolCounts.FileEdit) !== 0) failures.push("H9FileEdit used");
  if (h9?.checksPassed !== true) failures.push("H9ChecksPassed=false");
  if (h9?.streamJsonLifecycleVerified !== true) failures.push("H9StreamJsonLifecycle=false");
  if (JSON.stringify(h9ChangedFiles) !== JSON.stringify(["reports/bash-approval-report.md"])) {
    failures.push(`H9ChangedFiles=${JSON.stringify(h9ChangedFiles)}`);
  }
  if (h9ForbiddenChanges.length > 0)
    failures.push(`H9ForbiddenChanges=${h9ForbiddenChanges.length}`);
  if (h9Assertions.length < 17) failures.push(`H9Assertions=${h9Assertions.length}`);
  if (readNumber(h9Session.messageCount) < 2) failures.push("H9SessionMessages < 2");
  if (readNumber(h9Session.auditEventCount) < 1) failures.push("H9AuditEvents < 1");
  if (readNumber(h9Approval.pendingCount) !== 1) failures.push("H9PendingApprovalCount != 1");
  if (readNumber(h9Approval.resolvedCount) < 1) failures.push("H9ResolvedApprovalCount < 1");
  if (readNumber(h9Approval.controlResolvedCount) !== 1)
    failures.push("H9ControlResolvedApprovalCount != 1");
  if (readNumber(h9Approval.completedBashToolCount) < 3)
    failures.push("H9CompletedBashToolCount < 3");
  if (h9Approval.pendingToolUseId !== "h9-run-approved-bash")
    failures.push("H9PendingToolUseIdMismatch");
  if (
    JSON.stringify(h9CompletedToolIds) !==
    JSON.stringify(["h9-readonly-pwd", "h9-run-approved-bash", "h9-run-control-approval-flow"])
  ) {
    failures.push(`H9CompletedToolIds=${JSON.stringify(h9CompletedToolIds)}`);
  }
  if (h9Approval.pendingCommand !== "npm test") failures.push("H9PendingCommandMismatch");
  if (readNumber(h9Approval.pendingTimeoutMs) !== 7000) failures.push("H9PendingTimeoutMismatch");
  if (typeof h9Approval.pendingCwd !== "string" || h9Approval.pendingCwd.length === 0)
    failures.push("H9PendingCwdMissing");
  if (h9Approval.approved !== true) failures.push("H9Approved=false");
  if (h9Approval.readOnlyBashCompleted !== true) failures.push("H9ReadOnlyBashCompleted=false");
  if (h9Approval.approvedBashCompleted !== true) failures.push("H9ApprovedBashCompleted=false");
  if (h9Limits.withinTime !== true) failures.push("H9WithinTime=false");
  if (h9Limits.withinCommands !== true) failures.push("H9WithinCommands=false");
  if (h9Limits.withinFileChanges !== true) failures.push("H9WithinFileChanges=false");
  if (readNumber(h10ToolCounts.FileRead) !== 1) failures.push("H10FileReadCalls != 1");
  if (readNumber(h10ToolCounts.FileWrite) !== 1) failures.push("H10FileWriteCalls != 1");
  if (readNumber(h10ToolCounts.Bash) !== 0) failures.push("H10Bash used");
  if (readNumber(h10ToolCounts.FilePatch) !== 0) failures.push("H10FilePatch used");
  if (readNumber(h10ToolCounts.FileEdit) !== 0) failures.push("H10FileEdit used");
  if (h10?.checksPassed !== true) failures.push("H10ChecksPassed=false");
  if (h10?.streamJsonLifecycleVerified !== true) failures.push("H10StreamJsonLifecycle=false");
  if (JSON.stringify(h10ChangedFiles) !== JSON.stringify(["reports/provider-retry-report.md"])) {
    failures.push(`H10ChangedFiles=${JSON.stringify(h10ChangedFiles)}`);
  }
  if (h10ForbiddenChanges.length > 0)
    failures.push(`H10ForbiddenChanges=${h10ForbiddenChanges.length}`);
  if (h10Assertions.length < 18) failures.push(`H10Assertions=${h10Assertions.length}`);
  if (readNumber(h10Session.messageCount) < 2) failures.push("H10SessionMessages < 2");
  if (readNumber(h10Session.auditEventCount) < 1) failures.push("H10AuditEvents < 1");
  if (h10Stream.assistantMessageSeen !== true) failures.push("H10AssistantMessage=false");
  if (readNumber(h10Stream.providerRetryCount) !== 2)
    failures.push("H10ProviderRetryStreamCount != 2");
  if (h10Stream.providerFallbackSeen !== true) failures.push("H10ProviderFallbackStream=false");
  if (h10Stream.sessionErrorSeen !== false) failures.push("H10SessionErrorSeen=true");
  if (readNumber(h10ProviderRouting.retryCount) !== 2)
    failures.push("H10ProviderRetryAuditCount != 2");
  if (JSON.stringify(h10RetryAttempts) !== JSON.stringify([1, 2])) {
    failures.push("H10RetryAttemptsMismatch");
  }
  if (readNumber(h10ProviderRouting.fallbackCount) !== 1)
    failures.push("H10ProviderFallbackAuditCount != 1");
  if (!h10RetryProviders.includes("openai")) failures.push("H10RetryProviderMissing");
  if (!h10RetryErrorKinds.includes("server-error")) failures.push("H10RetryErrorKindMissing");
  if (h10ProviderRouting.fallbackToProvider !== "backup")
    failures.push("H10FallbackProviderMismatch");
  if (h10ProviderRouting.fallbackFromProvider !== "openai") {
    failures.push("H10FallbackFromProviderMismatch");
  }
  if (h10ProviderRouting.fallbackErrorKind !== "server-error") {
    failures.push("H10FallbackErrorKindMismatch");
  }
  if (h10Limits.withinTime !== true) failures.push("H10WithinTime=false");
  if (h10Limits.withinCommands !== true) failures.push("H10WithinCommands=false");
  if (h10Limits.withinFileChanges !== true) failures.push("H10WithinFileChanges=false");
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
      providerToolSurfaceCount,
      providerToolSurfaceTarget,
      providerToolSurfaceBadCount,
      normalStreamDiagnosticsCount,
      normalStreamDiagnosticsTarget: normalStreamDiagnosticsTasks.length,
      streamEventCountEvidenceCount,
      streamEventCountTarget: streamEventCountTasks.length,
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
      H2Seen: h2Seen,
      H2FileReadCalls: readNumber(h2ToolCounts.FileRead),
      H2FilePatchCalls: readNumber(h2ToolCounts.FilePatch),
      H2BashCalls: readNumber(h2ToolCounts.Bash),
      H2FileWriteCalls: readNumber(h2ToolCounts.FileWrite),
      H2FileEditCalls: readNumber(h2ToolCounts.FileEdit),
      H2ChecksPassed: h2?.checksPassed === true,
      H2StreamJsonLifecycle: h2?.streamJsonLifecycleVerified === true,
      H2ChangedFiles: h2ChangedFiles,
      H2ForbiddenChanges: h2ForbiddenChanges.length,
      H2Assertions: h2Assertions.length,
      H2SessionMessages: readNumber(h2Session.messageCount),
      H2AuditEvents: readNumber(h2Session.auditEventCount),
      H2WithinTime: h2Limits.withinTime === true,
      H2WithinCommands: h2Limits.withinCommands === true,
      H2WithinFileChanges: h2Limits.withinFileChanges === true,
      H3Seen: h3Seen,
      H3FileReadCalls: readNumber(h3ToolCounts.FileRead),
      H3FilePatchCalls: readNumber(h3ToolCounts.FilePatch),
      H3BashCalls: readNumber(h3ToolCounts.Bash),
      H3FileWriteCalls: readNumber(h3ToolCounts.FileWrite),
      H3FileEditCalls: readNumber(h3ToolCounts.FileEdit),
      H3ChecksPassed: h3?.checksPassed === true,
      H3StreamJsonLifecycle: h3?.streamJsonLifecycleVerified === true,
      H3ChangedFiles: h3ChangedFiles,
      H3ForbiddenChanges: h3ForbiddenChanges.length,
      H3Assertions: h3Assertions.length,
      H3SessionMessages: readNumber(h3Session.messageCount),
      H3AuditEvents: readNumber(h3Session.auditEventCount),
      H3WithinTime: h3Limits.withinTime === true,
      H3WithinCommands: h3Limits.withinCommands === true,
      H3WithinFileChanges: h3Limits.withinFileChanges === true,
      H4Seen: h4Seen,
      H4GlobCalls: readNumber(h4ToolCounts.Glob),
      H4GrepCalls: readNumber(h4ToolCounts.Grep),
      H4FileReadCalls: readNumber(h4ToolCounts.FileRead),
      H4FilePatchCalls: readNumber(h4ToolCounts.FilePatch),
      H4BashCalls: readNumber(h4ToolCounts.Bash),
      H4FileWriteCalls: readNumber(h4ToolCounts.FileWrite),
      H4FileEditCalls: readNumber(h4ToolCounts.FileEdit),
      H4ChecksPassed: h4?.checksPassed === true,
      H4StreamJsonLifecycle: h4?.streamJsonLifecycleVerified === true,
      H4ChangedFiles: h4ChangedFiles,
      H4ForbiddenChanges: h4ForbiddenChanges.length,
      H4Assertions: h4Assertions.length,
      H4SessionMessages: readNumber(h4Session.messageCount),
      H4AuditEvents: readNumber(h4Session.auditEventCount),
      H4WithinTime: h4Limits.withinTime === true,
      H4WithinCommands: h4Limits.withinCommands === true,
      H4WithinFileChanges: h4Limits.withinFileChanges === true,
      H5Seen: h5Seen,
      H5FileReadCalls: readNumber(h5ToolCounts.FileRead),
      H5FileWriteCalls: readNumber(h5ToolCounts.FileWrite),
      H5FilePatchCalls: readNumber(h5ToolCounts.FilePatch),
      H5BashCalls: readNumber(h5ToolCounts.Bash),
      H5FileEditCalls: readNumber(h5ToolCounts.FileEdit),
      H5ChecksPassed: h5?.checksPassed === true,
      H5StreamJsonLifecycle: h5?.streamJsonLifecycleVerified === true,
      H5ChangedFiles: h5ChangedFiles,
      H5ForbiddenChanges: h5ForbiddenChanges.length,
      H5Assertions: h5Assertions.length,
      H5SessionMessages: readNumber(h5Session.messageCount),
      H5AuditEvents: readNumber(h5Session.auditEventCount),
      H5OutsideWriteAudit: hasFailedToolReason(
        h5FailedToolReasons,
        "FileWrite",
        "outside allowed directories"
      ),
      H5OutsideWriteToolCallIdSeen: h5OutsideWriteToolCallIdSeen,
      H5WithinTime: h5Limits.withinTime === true,
      H5WithinCommands: h5Limits.withinCommands === true,
      H5WithinFileChanges: h5Limits.withinFileChanges === true,
      H6Seen: h6Seen,
      H6FileReadCalls: readNumber(h6ToolCounts.FileRead),
      H6FileWriteCalls: readNumber(h6ToolCounts.FileWrite),
      H6FilePatchCalls: readNumber(h6ToolCounts.FilePatch),
      H6BashCalls: readNumber(h6ToolCounts.Bash),
      H6FileEditCalls: readNumber(h6ToolCounts.FileEdit),
      H6ChecksPassed: h6?.checksPassed === true,
      H6StreamJsonLifecycle: h6?.streamJsonLifecycleVerified === true,
      H6ChangedFiles: h6ChangedFiles,
      H6ForbiddenChanges: h6ForbiddenChanges.length,
      H6Assertions: h6Assertions.length,
      H6SessionMessages: readNumber(h6Session.messageCount),
      H6AuditEvents: readNumber(h6Session.auditEventCount),
      H6SameSession: h6Resume.sameSession === true,
      H6FirstSessionId: typeof h6Resume.firstSessionId === "string",
      H6ResumedSessionId: typeof h6Resume.resumedSessionId === "string",
      H6WithinTime: h6Limits.withinTime === true,
      H6WithinCommands: h6Limits.withinCommands === true,
      H6WithinFileChanges: h6Limits.withinFileChanges === true,
      H7Seen: h7Seen,
      H7FileWriteCalls: readNumber(h7ToolCounts.FileWrite),
      H7FileReadCalls: readNumber(h7ToolCounts.FileRead),
      H7FilePatchCalls: readNumber(h7ToolCounts.FilePatch),
      H7BashCalls: readNumber(h7ToolCounts.Bash),
      H7FileEditCalls: readNumber(h7ToolCounts.FileEdit),
      H7ChecksPassed: h7?.checksPassed === true,
      H7StreamJsonLifecycle: h7?.streamJsonLifecycleVerified === true,
      H7ChangedFiles: h7ChangedFiles,
      H7ForbiddenChanges: h7ForbiddenChanges.length,
      H7Assertions: h7Assertions.length,
      H7SessionMessages: readNumber(h7Session.messageCount),
      H7AuditEvents: readNumber(h7Session.auditEventCount),
      H7ValidNdjson: h7Stream.validNdjson === true,
      H7StderrEmpty: h7Stream.stderrEmpty === true,
      H7StartedFirst: h7Stream.startedFirst === true,
      H7CompletedLast: h7Stream.completedLast === true,
      H7UserMessageSeen: h7Stream.userMessageSeen === true,
      H7AssistantMessageSeen: h7Stream.assistantMessageSeen === true,
      H7ToolStartedSeen: h7Stream.toolStartedSeen === true,
      H7ToolCompletedSeen: h7Stream.toolCompletedSeen === true,
      H7RawToolUseSeen: h7Stream.rawToolUseSeen === true,
      H7RawToolResultSeen: h7Stream.rawToolResultSeen === true,
      H7ProviderRetrySeen: h7Stream.providerRetrySeen === true,
      H7ProviderRetryStreamCount: readNumber(h7Stream.providerRetryCount),
      H7ProviderFallbackSeen: h7Stream.providerFallbackSeen === true,
      H7FinalMessageMatched: h7Stream.finalMessageMatched === true,
      H7WithinTime: h7Limits.withinTime === true,
      H7WithinCommands: h7Limits.withinCommands === true,
      H7WithinFileChanges: h7Limits.withinFileChanges === true,
      H8Seen: h8Seen,
      H8FileReadCalls: readNumber(h8ToolCounts.FileRead),
      H8BashCalls: readNumber(h8ToolCounts.Bash),
      H8FileWriteCalls: readNumber(h8ToolCounts.FileWrite),
      H8FilePatchCalls: readNumber(h8ToolCounts.FilePatch),
      H8FileEditCalls: readNumber(h8ToolCounts.FileEdit),
      H8ChecksPassed: h8?.checksPassed === true,
      H8StreamJsonLifecycle: h8?.streamJsonLifecycleVerified === true,
      H8ChangedFiles: h8ChangedFiles,
      H8ForbiddenChanges: h8ForbiddenChanges.length,
      H8Assertions: h8Assertions.length,
      H8SessionMessages: readNumber(h8Session.messageCount),
      H8AuditEvents: readNumber(h8Session.auditEventCount),
      H8TaskCount: readNumber(h8AgentQueue.taskCount),
      H8CompletedTaskCount: readNumber(h8AgentQueue.completedTaskCount),
      H8WorkerTaskCount: readNumber(h8AgentQueue.workerTaskCount),
      H8WriteClaimCount: readNumber(h8AgentQueue.writeClaimCount),
      H8WriteClaimFiles: h8WriteClaimFiles,
      H8TaskPrompts: h8TaskPrompts,
      H8WorkerTaskEvidenceSeen: h8WorkerTaskEvidenceSeen,
      H8ClaimOwnerEvidenceSeen: h8ClaimOwnerEvidenceSeen,
      H8ConflictRejected: h8AgentQueue.conflictRejected === true,
      H8WithinTime: h8Limits.withinTime === true,
      H8WithinCommands: h8Limits.withinCommands === true,
      H8WithinFileChanges: h8Limits.withinFileChanges === true,
      H9Seen: h9Seen,
      H9FileReadCalls: readNumber(h9ToolCounts.FileRead),
      H9BashCalls: readNumber(h9ToolCounts.Bash),
      H9FileWriteCalls: readNumber(h9ToolCounts.FileWrite),
      H9FilePatchCalls: readNumber(h9ToolCounts.FilePatch),
      H9FileEditCalls: readNumber(h9ToolCounts.FileEdit),
      H9ChecksPassed: h9?.checksPassed === true,
      H9StreamJsonLifecycle: h9?.streamJsonLifecycleVerified === true,
      H9ChangedFiles: h9ChangedFiles,
      H9ForbiddenChanges: h9ForbiddenChanges.length,
      H9Assertions: h9Assertions.length,
      H9SessionMessages: readNumber(h9Session.messageCount),
      H9AuditEvents: readNumber(h9Session.auditEventCount),
      H9PendingApprovalCount: readNumber(h9Approval.pendingCount),
      H9ResolvedApprovalCount: readNumber(h9Approval.resolvedCount),
      H9ControlResolvedApprovalCount: readNumber(h9Approval.controlResolvedCount),
      H9CompletedBashToolCount: readNumber(h9Approval.completedBashToolCount),
      H9PendingToolUseId: h9Approval.pendingToolUseId,
      H9CompletedToolIds: h9CompletedToolIds,
      H9PendingCommand: h9Approval.pendingCommand,
      H9PendingTimeoutMs: readNumber(h9Approval.pendingTimeoutMs),
      H9PendingCwdSeen:
        typeof h9Approval.pendingCwd === "string" && h9Approval.pendingCwd.length > 0,
      H9Approved: h9Approval.approved === true,
      H9ReadOnlyBashCompleted: h9Approval.readOnlyBashCompleted === true,
      H9ApprovedBashCompleted: h9Approval.approvedBashCompleted === true,
      H9WithinTime: h9Limits.withinTime === true,
      H9WithinCommands: h9Limits.withinCommands === true,
      H9WithinFileChanges: h9Limits.withinFileChanges === true,
      H10Seen: h10Seen,
      H10FileReadCalls: readNumber(h10ToolCounts.FileRead),
      H10FileWriteCalls: readNumber(h10ToolCounts.FileWrite),
      H10BashCalls: readNumber(h10ToolCounts.Bash),
      H10FilePatchCalls: readNumber(h10ToolCounts.FilePatch),
      H10FileEditCalls: readNumber(h10ToolCounts.FileEdit),
      H10ChecksPassed: h10?.checksPassed === true,
      H10StreamJsonLifecycle: h10?.streamJsonLifecycleVerified === true,
      H10ChangedFiles: h10ChangedFiles,
      H10ForbiddenChanges: h10ForbiddenChanges.length,
      H10Assertions: h10Assertions.length,
      H10SessionMessages: readNumber(h10Session.messageCount),
      H10AuditEvents: readNumber(h10Session.auditEventCount),
      H10AssistantMessageSeen: h10Stream.assistantMessageSeen === true,
      H10ProviderRetryStreamCount: readNumber(h10Stream.providerRetryCount),
      H10ProviderFallbackStream: h10Stream.providerFallbackSeen === true,
      H10SessionErrorSeen: h10Stream.sessionErrorSeen === true,
      H10ProviderRetryAuditCount: readNumber(h10ProviderRouting.retryCount),
      H10RetryAttempts: h10RetryAttempts,
      H10ProviderFallbackAuditCount: readNumber(h10ProviderRouting.fallbackCount),
      H10RetryProviders: h10RetryProviders,
      H10RetryErrorKinds: h10RetryErrorKinds,
      H10FallbackToProvider: h10ProviderRouting.fallbackToProvider,
      H10FallbackFromProvider: h10ProviderRouting.fallbackFromProvider,
      H10FallbackErrorKind: h10ProviderRouting.fallbackErrorKind,
      H10WithinTime: h10Limits.withinTime === true,
      H10WithinCommands: h10Limits.withinCommands === true,
      H10WithinFileChanges: h10Limits.withinFileChanges === true,
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
  const memoryResultEvidenceCount = results.filter((result) => {
    const minResults = readNumber(result.minResults);
    const resultCount = readNumber(result.resultCount);
    const expectedMatched = readStringList(result.expectedMatched);
    const expectedMissing = readStringList(result.expectedMissing);
    const forbiddenClear = readStringList(result.forbiddenClear);
    const forbiddenFound = readStringList(result.forbiddenFound);
    const topResults = readRecordList(result.topResults);
    return (
      result.passed === true &&
      readNumber(result.score) >= 1 &&
      minResults > 0 &&
      resultCount >= minResults &&
      expectedMatched.length > 0 &&
      expectedMissing.length === 0 &&
      (forbiddenClear.length === 0 || forbiddenFound.length === 0) &&
      forbiddenFound.length === 0 &&
      topResults.length >= Math.min(resultCount, minResults) &&
      topResults.every(
        (topResult) =>
          typeof topResult.title === "string" &&
          typeof topResult.file === "string" &&
          typeof topResult.nodeId === "string" &&
          readNumber(topResult.score) > 0
      )
    );
  }).length;
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
  if (memoryResultEvidenceCount !== results.length) {
    failures.push(`memoryResultEvidenceCount=${memoryResultEvidenceCount}`);
  }
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
      memoryResultEvidenceCount,
      memoryResultEvidenceTarget: results.length,
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
  const rollbackQualitySeen =
    details.rollbackQualitySeen === true ||
    scenarios.some((scenario) => readRecord(scenario.details).rollbackQualitySeen === true);
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
  if (!rollbackQualitySeen) failures.push("rollbackQualitySeen=false");
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
      rollbackQualitySeen,
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
  const lanSmoke = readRecord(details.lanSmoke);
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
  if (lanSmoke.healthOk !== true) failures.push("lanSmokeHealthOk=false");
  if (lanSmoke.panelOk !== true) failures.push("lanSmokePanelOk=false");
  if (lanSmoke.authOk !== true) failures.push("lanSmokeAuthOk=false");
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
      lanSmokeUsedLoopbackFallback: lanSmoke.usedLoopbackFallback === true,
      lanSmokeHealthOk: lanSmoke.healthOk === true,
      lanSmokePanelOk: lanSmoke.panelOk === true,
      lanSmokeAuthOk: lanSmoke.authOk === true,
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

function readRecordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(readRecord).filter((entry) => Object.keys(entry).length)
    : [];
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function providerHasToolSurfaceEvidence(provider: Record<string, unknown>): boolean {
  return (
    readNumber(provider.exposedToolCount) > 0 || readStringList(provider.exposedTools).length > 0
  );
}

function hasProviderToolSurface(
  provider: Record<string, unknown>,
  minToolCount = BASE_PROVIDER_TOOLS.length
): boolean {
  const exposedTools = readStringList(provider.exposedTools);
  const exposedToolCount = readNumber(provider.exposedToolCount);
  return (
    exposedToolCount >= minToolCount &&
    exposedTools.length === exposedToolCount &&
    BASE_PROVIDER_TOOLS.every((tool) => exposedTools.includes(tool))
  );
}

function hasWorkerTaskEvidence(
  tasks: Record<string, unknown>[],
  expectedTasks: { prompt: string; filePath: string }[]
): boolean {
  return (
    tasks.length === expectedTasks.length &&
    expectedTasks.every((expected) =>
      tasks.some(
        (task) =>
          typeof task.id === "string" &&
          task.id.length > 0 &&
          task.role === "worker" &&
          task.status === "completed" &&
          task.prompt === expected.prompt &&
          JSON.stringify(readStringList(task.writeFiles)) === JSON.stringify([expected.filePath])
      )
    )
  );
}

function hasWorkerClaimEvidence(
  claims: Record<string, unknown>[],
  tasks: Record<string, unknown>[],
  expectedFiles: string[]
): boolean {
  const taskWriteFilesById = new Map<string, string[]>();
  for (const task of tasks) {
    if (typeof task.id === "string" && task.id.length > 0) {
      taskWriteFilesById.set(task.id, readStringList(task.writeFiles));
    }
  }

  return (
    claims.length === expectedFiles.length &&
    expectedFiles.every((filePath) =>
      claims.some((claim) => {
        if (typeof claim.taskId !== "string") return false;
        return (
          claim.filePath === filePath &&
          claim.ownerRole === "worker" &&
          taskWriteFilesById.get(claim.taskId)?.includes(filePath) === true
        );
      })
    )
  );
}

function hasFailedToolReason(
  failures: Record<string, unknown>[],
  target: string,
  reasonNeedle: string
): boolean {
  return failures.some(
    (failure) =>
      failure.target === target &&
      typeof failure.reason === "string" &&
      failure.reason.includes(reasonNeedle)
  );
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
