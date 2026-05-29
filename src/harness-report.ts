export type HarnessScenarioStatus = "passed" | "failed";
export type HarnessFailureKind =
  | "assertion"
  | "permission"
  | "provider"
  | "timeout"
  | "tool"
  | "unknown";

export interface HarnessScenarioResult {
  name: string;
  status: HarnessScenarioStatus;
  durationMs: number;
  score: number;
  failureKind: HarnessFailureKind | null;
  error?: string;
  details?: Record<string, unknown>;
}

export interface HarnessToolEfficiency {
  toolCallCount: number;
  uniqueToolCount: number;
  toolCallsPerScenario: number;
  topTools: Array<{ name: string; count: number }>;
}

export interface HarnessReport {
  version: 1;
  name: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: HarnessScenarioStatus;
  summary: {
    total: number;
    passed: number;
    failed: number;
    successRate: number;
    score: number;
    providerCalls: number;
    providerCallsPerScenario: number;
    assertions: number;
    filesVerified: number;
    toolEfficiency: HarnessToolEfficiency;
    failureKinds: Record<string, number>;
    regressions: Array<{ scenario: string; failureKind: HarnessFailureKind; error?: string }>;
  };
  scenarios: HarnessScenarioResult[];
}

export function classifyHarnessFailure(error: unknown): HarnessFailureKind {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out|timeout/i.test(message)) return "timeout";
  if (/permission|approval/i.test(message)) return "permission";
  if (/fallback|provider|transient|HTTP|fetch|network|ECONN|ENOTFOUND/i.test(message)) {
    return "provider";
  }
  if (
    /tool|ToolSearch|FileWrite|FilePatch|Grep|Glob|WorkspaceDiagnostics|Memory|LearningDraft|TodoWrite/i.test(
      message
    )
  ) {
    return "tool";
  }
  if (/assert|expected|missing|did not|was not|should/i.test(message)) return "assertion";
  return "unknown";
}

export function summarizeHarnessError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(/\r?\n/).slice(0, 8).join("\n");
}

export function buildHarnessReport(input: {
  name: string;
  startedAt: Date;
  completedAt?: Date;
  scenarios: HarnessScenarioResult[];
}): HarnessReport {
  const completedAt = input.completedAt ?? new Date();
  const passed = input.scenarios.filter((result) => result.status === "passed").length;
  const failed = input.scenarios.length - passed;
  const failureKinds: Record<string, number> = {};
  let providerCalls = 0;
  let score = 0;
  let assertions = 0;
  let filesVerified = 0;
  const toolCounts = new Map<string, number>();
  const regressions: Array<{ scenario: string; failureKind: HarnessFailureKind; error?: string }> =
    [];
  for (const result of input.scenarios) {
    score += result.score;
    if (result.failureKind) {
      failureKinds[result.failureKind] = (failureKinds[result.failureKind] ?? 0) + 1;
      regressions.push({
        scenario: result.name,
        failureKind: result.failureKind,
        error: result.error
      });
    }
    const calls = readProviderCallCount(result.details);
    if (calls !== undefined) {
      providerCalls += calls;
    }
    assertions += readStringList(result.details?.assertions).length;
    filesVerified += readStringList(result.details?.filesVerified).length;
    for (const [toolName, count] of Object.entries(readToolCounts(result.details))) {
      toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + count);
    }
  }
  const total = input.scenarios.length;
  const toolCallCount = [...toolCounts.values()].reduce((sum, value) => sum + value, 0);
  const topTools = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([name, count]) => ({ name, count }));
  return {
    version: 1,
    name: input.name,
    startedAt: input.startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: Math.max(0, completedAt.getTime() - input.startedAt.getTime()),
    status: failed === 0 ? "passed" : "failed",
    summary: {
      total,
      passed,
      failed,
      successRate: total === 0 ? 0 : passed / total,
      score: total === 0 ? 0 : score / total,
      providerCalls,
      providerCallsPerScenario: total === 0 ? 0 : providerCalls / total,
      assertions,
      filesVerified,
      toolEfficiency: {
        toolCallCount,
        uniqueToolCount: toolCounts.size,
        toolCallsPerScenario: total === 0 ? 0 : toolCallCount / total,
        topTools
      },
      failureKinds,
      regressions
    },
    scenarios: input.scenarios
  };
}

function readProviderCallCount(details: Record<string, unknown> | undefined): number | undefined {
  const provider = details?.provider;
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    return undefined;
  }
  const callCount = (provider as Record<string, unknown>).callCount;
  return typeof callCount === "number" && Number.isFinite(callCount) ? callCount : undefined;
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function readToolCounts(details: Record<string, unknown> | undefined): Record<string, number> {
  const fromDetails = readNumberRecord(details?.toolCounts);
  const fromProvider = readNumberRecord(readRecord(details?.provider).toolCounts);
  return mergeNumberRecords(fromProvider, fromDetails);
}

function readNumberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const output: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      output[key] = raw;
    }
  }
  return output;
}

function mergeNumberRecords(...records: Array<Record<string, number>>): Record<string, number> {
  const output: Record<string, number> = {};
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      output[key] = (output[key] ?? 0) + value;
    }
  }
  return output;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
