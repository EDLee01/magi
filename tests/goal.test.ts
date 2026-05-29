import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";

import {
  clearGoal,
  createGoal,
  formatGoal,
  formatGoalBadge,
  formatGoalContext,
  getGoal,
  goalStorePath,
  isGoalCreationArgs,
  listGoals,
  updateGoalStatus
} from "../src/goal.js";
import { getMagiPaths } from "../src/paths.js";
import { makeTempRoot } from "./helpers.js";

describe("goal state", () => {
  it("creates, reads, injects, and completes a session goal", () => {
    const temp = makeTempRoot();
    try {
      const paths = getMagiPaths(temp.env);
      const goal = createGoal(paths, { sessionId: "session-1", objective: "ship goal support" });

      expect(goal.status).toBe("active");
      expect(getGoal(paths, "session-1")?.objective).toBe("ship goal support");
      expect(formatGoalContext(goal)).toContain("Objective: ship goal support");

      expect(formatGoal(goal)).toContain("Status: active");
      expect(formatGoalBadge(goal)).toBe("goal active · ship goal support");

      const completed = updateGoalStatus(paths, {
        sessionId: "session-1",
        status: "completed",
        note: "verified"
      });

      expect(completed?.status).toBe("completed");
      expect(getGoal(paths, "session-1")).toBeUndefined();
      expect(listGoals(paths, "session-1")[0]).toMatchObject({
        status: "completed",
        note: "verified"
      });
    } finally {
      temp.cleanup();
    }
  });

  it("uses cancelled for clear and superseded goals", () => {
    const temp = makeTempRoot();
    try {
      const paths = getMagiPaths(temp.env);
      createGoal(paths, { sessionId: "session-1", objective: "first goal" });
      const replacement = createGoal(paths, { sessionId: "session-1", objective: "second goal" });

      expect(replacement.status).toBe("active");
      expect(listGoals(paths, "session-1")).toContainEqual(
        expect.objectContaining({
          objective: "first goal",
          status: "cancelled",
          note: "Replaced by a new active goal"
        })
      );

      const cleared = clearGoal(paths, "session-1");

      expect(cleared).toMatchObject({
        objective: "second goal",
        status: "cancelled",
        note: "Cancelled by user"
      });
      expect(getGoal(paths, "session-1")).toBeUndefined();
    } finally {
      temp.cleanup();
    }
  });

  it("classifies goal objective commands separately from management commands", () => {
    expect(isGoalCreationArgs(["finish", "the", "release"])).toBe(true);
    expect(isGoalCreationArgs(["status"])).toBe(false);
    expect(isGoalCreationArgs(["done"])).toBe(false);
    expect(isGoalCreationArgs(["stop"])).toBe(false);
    expect(isGoalCreationArgs([])).toBe(false);
  });

  it("normalizes legacy completed status when reading stored goals", () => {
    const temp = makeTempRoot();
    try {
      const paths = getMagiPaths(temp.env);
      mkdirSync(paths.stateRoot, { recursive: true });
      writeFileSync(
        goalStorePath(paths),
        `${JSON.stringify({
          version: 1,
          goals: [
            {
              id: "goal-1",
              sessionId: "session-1",
              objective: "finish legacy goal",
              status: "complete",
              createdAt: "2026-05-28T00:00:00.000Z",
              updatedAt: "2026-05-28T00:00:00.000Z"
            }
          ]
        })}\n`,
        "utf8"
      );

      const stored = listGoals(paths, "session-1")[0];
      expect(stored.status).toBe("completed");
      expect(formatGoal(stored)).toContain("Status: completed");
      expect(formatGoalContext(stored)).toBeUndefined();
    } finally {
      temp.cleanup();
    }
  });
});
