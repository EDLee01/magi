import { describe, expect, it } from "vitest";

import { checkPlanExecutionGuard, readBeforeWriteRules } from "../src/plan-execution-guard.js";
import { PlanReviewRecord } from "../src/plan-state.js";
import { SessionRecord } from "../src/session-store.js";

describe("plan execution guard", () => {
  it("extracts read-before-write rules from approved plan text", () => {
    expect(
      readBeforeWriteRules(
        [
          "1. Inspect feedback",
          "2. Read src/config.ts before editing",
          "3. Read `docs/release.md` before writing"
        ].join("\n")
      )
    ).toEqual([{ readPath: "src/config.ts" }, { readPath: "docs/release.md" }]);
    expect(
      readBeforeWriteRules(
        [
          "1. Inspect",
          "2. Read inherited-plan-source.txt before editing",
          "3. Write inherited-plan-output.txt only after reading"
        ].join("\n")
      )
    ).toContainEqual({
      readPath: "inherited-plan-source.txt",
      targetPath: "inherited-plan-output.txt"
    });
  });

  it("blocks writes before the required read and allows them after read evidence", () => {
    const plan = planRecord("1. Read target.txt before writing\n2. Write target.txt");
    const blocked = checkPlanExecutionGuard({
      plan,
      session: sessionRecord([]),
      toolUse: {
        type: "tool-use",
        id: "write-first",
        name: "FileWrite",
        input: { file_path: "target.txt", content: "new" }
      }
    });
    expect(blocked?.message).toContain("Required first: FileRead target.txt");

    const allowed = checkPlanExecutionGuard({
      plan,
      session: sessionRecord([
        {
          role: "tool",
          content: "Read target.txt (12 bytes)\nold",
          metadata: { toolName: "FileRead" }
        }
      ]),
      toolUse: {
        type: "tool-use",
        id: "write-after-read",
        name: "FileWrite",
        input: { file_path: "target.txt", content: "new" }
      }
    });
    expect(allowed).toBeUndefined();
  });
});

function planRecord(plan: string): PlanReviewRecord {
  return {
    id: "plan-1",
    sessionId: "session-1",
    plan,
    status: "approved",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function sessionRecord(
  messages: Array<{ role: string; content: string; metadata?: Record<string, unknown> }>
): SessionRecord {
  return {
    id: "session-1",
    title: "session",
    cwd: "/tmp/work",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    metadata: {},
    messages: messages.map((message, index) => ({
      id: index + 1,
      sessionId: "session-1",
      role: message.role,
      content: message.content,
      createdAt: "2026-01-01T00:00:00.000Z",
      metadata: message.metadata ?? {}
    }))
  };
}
