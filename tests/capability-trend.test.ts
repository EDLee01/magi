import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CapabilityReport } from "../src/capability-report.js";
import {
  appendCapabilityTrendHistory,
  buildCapabilityTrendReport,
  formatCapabilityTrendReport,
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
        providerCalls: [18, 10],
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
      expect.arrayContaining(["providerCallsDelta=+18", "toolCallCountDelta=+26"])
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
      status: "passed"
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
  }> = {}
) {
  return {
    generatedAt: "2026-05-29T00:00:00.000Z",
    status: "passed",
    score: overrides.score ?? 1,
    total: overrides.total ?? 2,
    passed: overrides.passed ?? 2,
    failed: overrides.failed ?? 0,
    providerCalls: overrides.providerCalls ?? 10,
    toolCallCount: overrides.toolCallCount ?? 14,
    regressions: overrides.regressions ?? 0,
    checks: []
  };
}
