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
    failureKinds: Record<string, number>;
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
  for (const result of input.scenarios) {
    score += result.score;
    if (result.failureKind) {
      failureKinds[result.failureKind] = (failureKinds[result.failureKind] ?? 0) + 1;
    }
    const calls = readProviderCallCount(result.details);
    if (calls !== undefined) {
      providerCalls += calls;
    }
  }
  const total = input.scenarios.length;
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
      failureKinds
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
