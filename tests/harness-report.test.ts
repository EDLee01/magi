import { describe, expect, it } from "vitest";

import {
  buildHarnessReport,
  classifyHarnessFailure,
  summarizeHarnessError
} from "../src/harness-report.js";

describe("harness report", () => {
  it("builds a structured report with success rate, score, provider calls, and failure classes", () => {
    const report = buildHarnessReport({
      name: "blackbox-e2e",
      startedAt: new Date("2026-05-29T00:00:00.000Z"),
      completedAt: new Date("2026-05-29T00:00:03.000Z"),
      scenarios: [
        {
          name: "complex workflow",
          status: "passed",
          durationMs: 1200,
          score: 1,
          failureKind: null,
          details: {
            provider: { callCount: 5, toolCounts: { FileRead: 1, FilePatch: 2 } },
            assertions: ["report written", "patch applied"],
            filesVerified: ["reports/e2e-result.md"]
          }
        },
        {
          name: "tool feedback ranking",
          status: "failed",
          durationMs: 800,
          score: 0,
          failureKind: "tool",
          error: "ToolSearch did not rank successful Glob ahead after feedback",
          details: {
            provider: { callCount: 2, toolCounts: { Grep: 4, Glob: 4 } },
            toolCounts: { ToolSearch: 1 },
            assertions: ["ranking checked"]
          }
        }
      ]
    });

    expect(report).toMatchObject({
      version: 1,
      name: "blackbox-e2e",
      durationMs: 3000,
      status: "failed",
      summary: {
        total: 2,
        passed: 1,
        failed: 1,
        successRate: 0.5,
        score: 0.5,
        providerCalls: 7,
        providerCallsPerScenario: 3.5,
        assertions: 3,
        filesVerified: 1,
        toolEfficiency: {
          toolCallCount: 12,
          uniqueToolCount: 5,
          toolCallsPerScenario: 6,
          topTools: [
            { name: "Glob", count: 4 },
            { name: "Grep", count: 4 },
            { name: "FilePatch", count: 2 },
            { name: "FileRead", count: 1 },
            { name: "ToolSearch", count: 1 }
          ]
        },
        failureKinds: { tool: 1 },
        regressions: [
          {
            scenario: "tool feedback ranking",
            failureKind: "tool",
            error: "ToolSearch did not rank successful Glob ahead after feedback"
          }
        ]
      }
    });
  });

  it("classifies common black-box failure modes", () => {
    expect(classifyHarnessFailure(new Error("tool feedback ranking timed out"))).toBe("timeout");
    expect(classifyHarnessFailure(new Error("Permission ask: FileWrite requires approval"))).toBe(
      "permission"
    );
    expect(classifyHarnessFailure(new Error("primary transient provider failure"))).toBe(
      "provider"
    );
    expect(classifyHarnessFailure(new Error("ToolSearch did not rank FilePatch first"))).toBe(
      "tool"
    );
    expect(classifyHarnessFailure(new Error("expected report file to exist"))).toBe("assertion");
  });

  it("keeps error summaries concise", () => {
    const error = new Error(Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"));
    expect(summarizeHarnessError(error).split("\n")).toHaveLength(8);
  });
});
