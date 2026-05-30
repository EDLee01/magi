import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CapabilityReport } from "../src/capability-report.js";
import {
  appendCapabilityTrendHistory,
  buildCapabilityTrendReport,
  formatCapabilityTrendReport,
  readCapabilityTrendOptions,
  readCapabilityTrendOptionsFromEnv,
  readCapabilityTrendHistory,
  writeCapabilityTrendReport
} from "../src/capability-trend.js";

describe("capability trend report", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("passes without history and samples current capability metrics", () => {
    const report = buildCapabilityTrendReport({
      current: capabilityReport(),
      generatedAt: new Date("2026-05-30T00:00:00.000Z")
    });

    expect(report).toMatchObject({
      status: "passed",
      historyCount: 0,
      current: {
        score: 1,
        total: 2,
        passed: 2,
        failed: 0,
        providerCalls: 10,
        toolCallCount: 14,
        regressions: 0
      },
      failures: []
    });
    expect(formatCapabilityTrendReport(report)).toContain("checks: 2/2");
  });

  it("fails when score or passed checks regress from the latest sample", () => {
    const report = buildCapabilityTrendReport({
      current: capabilityReport({
        status: "failed",
        score: 0.5,
        passed: 1,
        failed: 1,
        checkStatuses: ["passed", "failed"]
      }),
      history: [
        sample({
          score: 1,
          passed: 2,
          failed: 0
        })
      ]
    });

    expect(report.status).toBe("failed");
    expect(report.failures).toEqual(
      expect.arrayContaining([
        "scoreDelta=-0.5",
        "passedDelta=-1",
        "failedDelta=+1",
        "status=failed"
      ])
    );
  });

  it("fails on new regressions but keeps provider and tool deltas as observations", () => {
    const report = buildCapabilityTrendReport({
      current: capabilityReport({
        providerCalls: [16, 10],
        toolCallCount: [25, 15],
        regressions: [1, 0]
      }),
      history: [sample({ providerCalls: 10, toolCallCount: 14, regressions: 0 })]
    });

    expect(report.status).toBe("failed");
    expect(report.failures).toEqual(
      expect.arrayContaining(["regressionsDelta=+1", "regressions=1"])
    );
    expect(report.observations).toEqual(
      expect.arrayContaining(["providerCallsDelta=+16", "toolCallCountDelta=+26"])
    );
  });

  it("fails when capability efficiency regresses beyond the trend budget", () => {
    const report = buildCapabilityTrendReport({
      current: capabilityReport({
        providerCalls: [26, 7],
        toolCallCount: [90, 35]
      }),
      history: [
        sample({
          providerCalls: 10,
          toolCallCount: 14,
          checks: [
            sampleCheck({ id: "blackbox", providerCalls: 6, toolCallCount: 8 }),
            sampleCheck({ id: "memory", providerCalls: 4, toolCallCount: 6 })
          ]
        })
      ]
    });

    expect(report.status).toBe("failed");
    expect(report.failures).toEqual(
      expect.arrayContaining([
        "providerCallsBudget=+23>+20",
        "toolCallCountBudget=+111>+100",
        "blackbox.providerCallsBudget=+20>+10",
        "blackbox.toolCallCountBudget=+82>+60"
      ])
    );
    expect(report.efficiencyBudget).toMatchObject({
      providerCalls: { absolute: 20, relative: 0.35 },
      toolCallCount: { absolute: 100, relative: 0.35 },
      checkProviderCalls: { absolute: 10, relative: 0.5 },
      checkToolCallCount: { absolute: 60, relative: 0.5 }
    });
  });

  it("accepts custom efficiency budgets for intentionally larger benchmark profiles", () => {
    const report = buildCapabilityTrendReport({
      current: capabilityReport({
        providerCalls: [26, 7],
        toolCallCount: [90, 35]
      }),
      history: [
        sample({
          providerCalls: 10,
          toolCallCount: 14,
          checks: [
            sampleCheck({ id: "blackbox", providerCalls: 6, toolCallCount: 8 }),
            sampleCheck({ id: "memory", providerCalls: 4, toolCallCount: 6 })
          ]
        })
      ],
      efficiencyBudget: {
        providerCalls: { absolute: 30 },
        toolCallCount: { absolute: 120 },
        checkProviderCalls: { absolute: 25 },
        checkToolCallCount: { absolute: 90 }
      }
    });

    expect(report.status).toBe("passed");
    expect(report.failures).toEqual([]);
  });

  it("uses the nightly trend profile for longer benchmark runs", () => {
    const ciReport = buildCapabilityTrendReport({
      current: capabilityReport({
        providerCalls: [40, 20],
        toolCallCount: [150, 30]
      }),
      history: [
        sample({
          providerCalls: 10,
          toolCallCount: 14,
          checks: [
            sampleCheck({ id: "blackbox", providerCalls: 6, toolCallCount: 8 }),
            sampleCheck({ id: "memory", providerCalls: 4, toolCallCount: 6 })
          ]
        })
      ]
    });
    const nightlyReport = buildCapabilityTrendReport({
      current: capabilityReport({
        providerCalls: [40, 20],
        toolCallCount: [150, 30]
      }),
      history: [
        sample({
          providerCalls: 10,
          toolCallCount: 14,
          checks: [
            sampleCheck({ id: "blackbox", providerCalls: 6, toolCallCount: 8 }),
            sampleCheck({ id: "memory", providerCalls: 4, toolCallCount: 6 })
          ]
        })
      ],
      profile: "nightly"
    });

    expect(ciReport.status).toBe("failed");
    expect(ciReport.failures).toContain("providerCallsBudget=+50>+20");
    expect(nightlyReport).toMatchObject({
      status: "passed",
      profile: "nightly",
      failures: [],
      efficiencyBudget: {
        providerCalls: { absolute: 80, relative: 0.6 },
        toolCallCount: { absolute: 320, relative: 0.6 },
        checkProviderCalls: { absolute: 35, relative: 0.75 },
        checkToolCallCount: { absolute: 160, relative: 0.75 }
      }
    });
    expect(formatCapabilityTrendReport(nightlyReport)).toContain("profile: nightly");
  });

  it("compares trend deltas only against history from the same profile", () => {
    const report = buildCapabilityTrendReport({
      current: capabilityReport({
        providerCalls: [20, 10],
        toolCallCount: [40, 20]
      }),
      profile: "nightly",
      history: [
        sample({
          providerCalls: 10,
          toolCallCount: 14,
          checks: [
            sampleCheck({ id: "blackbox", providerCalls: 6, toolCallCount: 8 }),
            sampleCheck({ id: "memory", providerCalls: 4, toolCallCount: 6 })
          ]
        }),
        sample({
          profile: "nightly",
          providerCalls: 28,
          toolCallCount: 55,
          checks: [
            sampleCheck({ id: "blackbox", providerCalls: 18, toolCallCount: 30 }),
            sampleCheck({ id: "memory", providerCalls: 10, toolCallCount: 25 })
          ]
        })
      ]
    });

    expect(report.profile).toBe("nightly");
    expect(report.previous?.profile).toBe("nightly");
    expect(report.delta).toMatchObject({
      providerCalls: 2,
      toolCallCount: 5
    });
    expect(report.status).toBe("passed");
  });

  it("reads trend profile and budget overrides from environment variables", () => {
    expect(
      readCapabilityTrendOptionsFromEnv({
        MAGI_CAPABILITY_TREND_PROFILE: "nightly",
        MAGI_CAPABILITY_TREND_PROVIDER_ABSOLUTE: "44",
        MAGI_CAPABILITY_TREND_PROVIDER_RELATIVE: "0.25",
        MAGI_CAPABILITY_TREND_CHECK_TOOLS_ABSOLUTE: "88"
      })
    ).toEqual({
      profile: "nightly",
      efficiencyBudget: {
        providerCalls: { absolute: 44, relative: 0.25 },
        checkToolCallCount: { absolute: 88 }
      }
    });

    expect(() =>
      readCapabilityTrendOptionsFromEnv({ MAGI_CAPABILITY_TREND_PROFILE: "weekend" })
    ).toThrow("Invalid MAGI_CAPABILITY_TREND_PROFILE: weekend");
    expect(() =>
      readCapabilityTrendOptionsFromEnv({ MAGI_CAPABILITY_TREND_PROVIDER_ABSOLUTE: "-1" })
    ).toThrow("MAGI_CAPABILITY_TREND_PROVIDER_ABSOLUTE must be a non-negative number");
  });

  it("lets CLI profile arguments override the environment profile", () => {
    expect(
      readCapabilityTrendOptions({
        profile: "ci",
        env: {
          MAGI_CAPABILITY_TREND_PROFILE: "nightly",
          MAGI_CAPABILITY_TREND_TOOLS_ABSOLUTE: "125"
        }
      })
    ).toEqual({
      profile: "ci",
      efficiencyBudget: {
        toolCallCount: { absolute: 125 }
      }
    });

    expect(() => readCapabilityTrendOptions({ profile: "later" })).toThrow(
      "Invalid MAGI_CAPABILITY_TREND_PROFILE: later"
    );
  });

  it("reads, writes, and trims history samples", () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "magi-capability-trend-"));
    const historyFile = path.join(tempDir, "history.json");
    const reportFile = path.join(tempDir, "report.json");

    const first = buildCapabilityTrendReport({
      current: capabilityReport({ generatedAt: "2026-05-30T00:00:00.000Z" })
    });
    const second = buildCapabilityTrendReport({
      current: capabilityReport({ generatedAt: "2026-05-30T00:01:00.000Z" })
    });

    appendCapabilityTrendHistory({ file: historyFile, report: first, maxSamples: 1 });
    appendCapabilityTrendHistory({ file: historyFile, report: second, maxSamples: 1 });
    writeCapabilityTrendReport(reportFile, second);

    const history = readCapabilityTrendHistory(historyFile);
    expect(history).toHaveLength(1);
    expect(history[0]?.generatedAt).toBe("2026-05-30T00:01:00.000Z");
    expect(JSON.parse(readFileSync(reportFile, "utf8"))).toMatchObject({
      name: "capability-trend",
      status: "passed",
      profile: "ci"
    });
  });
});

function capabilityReport(
  overrides: Partial<{
    generatedAt: string;
    status: "passed" | "failed";
    score: number;
    passed: number;
    failed: number;
    providerCalls: number[];
    toolCallCount: number[];
    regressions: number[];
    checkStatuses: Array<"passed" | "failed">;
  }> = {}
): CapabilityReport {
  const providerCalls = overrides.providerCalls ?? [6, 4];
  const toolCallCount = overrides.toolCallCount ?? [8, 6];
  const regressions = overrides.regressions ?? [0, 0];
  const checkStatuses = overrides.checkStatuses ?? ["passed", "passed"];
  return {
    version: 1,
    name: "capability-alignment",
    generatedAt: overrides.generatedAt ?? "2026-05-30T00:00:00.000Z",
    status: overrides.status ?? "passed",
    summary: {
      total: 2,
      passed: overrides.passed ?? 2,
      failed: overrides.failed ?? 0,
      score: overrides.score ?? 1
    },
    checks: ["blackbox", "memory"].map((id, index) => ({
      id,
      title: id,
      status: checkStatuses[index] ?? "passed",
      score: checkStatuses[index] === "failed" ? 0 : 1,
      metrics: {
        providerCalls: providerCalls[index] ?? 0,
        toolCallCount: toolCallCount[index] ?? 0,
        regressions: regressions[index] ?? 0
      },
      failures: checkStatuses[index] === "failed" ? ["failed"] : []
    })),
    sources: {}
  };
}

function sample(
  overrides: Partial<{
    score: number;
    total: number;
    passed: number;
    failed: number;
    providerCalls: number;
    toolCallCount: number;
    regressions: number;
    profile: "ci" | "nightly";
    checks: Array<{
      id: string;
      status: string;
      score: number;
      providerCalls: number;
      toolCallCount: number;
      regressions: number;
    }>;
  }> = {}
) {
  return {
    generatedAt: "2026-05-29T00:00:00.000Z",
    profile: overrides.profile ?? "ci",
    status: "passed",
    score: overrides.score ?? 1,
    total: overrides.total ?? 2,
    passed: overrides.passed ?? 2,
    failed: overrides.failed ?? 0,
    providerCalls: overrides.providerCalls ?? 10,
    toolCallCount: overrides.toolCallCount ?? 14,
    regressions: overrides.regressions ?? 0,
    checks: overrides.checks ?? [
      sampleCheck({ id: "blackbox", providerCalls: 6, toolCallCount: 8 }),
      sampleCheck({ id: "memory", providerCalls: 4, toolCallCount: 6 })
    ]
  };
}

function sampleCheck(input: {
  id: string;
  status?: string;
  score?: number;
  providerCalls: number;
  toolCallCount: number;
  regressions?: number;
}) {
  return {
    id: input.id,
    status: input.status ?? "passed",
    score: input.score ?? 1,
    providerCalls: input.providerCalls,
    toolCallCount: input.toolCallCount,
    regressions: input.regressions ?? 0
  };
}
