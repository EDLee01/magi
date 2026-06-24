import { describe, expect, it } from "vitest";

import { createGoal, getGoal, listGoals } from "../src/goal.js";
import {
  CheckResult,
  GoalLoopDeps,
  resolveGoalTurnTimeoutMs,
  runGoalLoop,
  runShellCheck
} from "../src/goal-loop.js";
import { getMagiPaths } from "../src/paths.js";
import { makeTempRoot } from "./helpers.js";

function check(exitCode: number, stdout = "", stderr = ""): CheckResult {
  return { exitCode, stdout, stderr };
}

describe("goal execution loop", () => {
  it("feeds check failure back to the agent, then auto-completes on a passing check", async () => {
    const temp = makeTempRoot();
    try {
      const paths = getMagiPaths(temp.env);
      const goal = createGoal(paths, {
        sessionId: "s1",
        objective: "make fib pass",
        checkCommand: "pytest"
      });

      const prompts: string[] = [];
      // First check fails with a real error, second passes.
      const checks = [check(1, "", "AssertionError: fib(10) != 55"), check(0, "3 passed")];
      const deps: GoalLoopDeps = {
        runPrompt: async (prompt) => {
          prompts.push(prompt);
          return { message: "worked" };
        },
        runCheck: async () => checks.shift() ?? check(0)
      };

      const result = await runGoalLoop({ goal, paths, deps });

      expect(result.status).toBe("completed");
      expect(result.attempts).toBe(2);
      // Second prompt is a reflection carrying the real failure output back.
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("AssertionError: fib(10) != 55");
      expect(prompts[1]).toContain("attempt 1/3");

      // Goal is auto-marked completed (no manual done needed).
      expect(getGoal(paths, "s1")).toBeUndefined();
      expect(listGoals(paths, "s1")[0]).toMatchObject({ status: "completed" });
    } finally {
      temp.cleanup();
    }
  });

  it("blocks the goal after maxChecks consecutive distinct failures", async () => {
    const temp = makeTempRoot();
    try {
      const paths = getMagiPaths(temp.env);
      const goal = createGoal(paths, {
        sessionId: "s1",
        objective: "never passes",
        checkCommand: "false",
        maxChecks: 3
      });

      let n = 0;
      const deps: GoalLoopDeps = {
        runPrompt: async () => ({ message: "tried" }),
        // Distinct output each time so the stuck detector does not trigger.
        runCheck: async () => check(1, "", `failure variant ${(n += 1)}`)
      };

      const result = await runGoalLoop({ goal, paths, deps });

      expect(result.status).toBe("blocked");
      expect(result.reason).toBe("max_checks");
      expect(result.attempts).toBe(3);
      const stored = listGoals(paths, "s1")[0];
      expect(stored.status).toBe("blocked");
      expect(stored.note).toContain("after 3 attempts");
    } finally {
      temp.cleanup();
    }
  });

  it("stops early when two consecutive checks produce identical output", async () => {
    const temp = makeTempRoot();
    try {
      const paths = getMagiPaths(temp.env);
      const goal = createGoal(paths, {
        sessionId: "s1",
        objective: "spinning",
        checkCommand: "flaky",
        maxChecks: 5
      });

      const deps: GoalLoopDeps = {
        runPrompt: async () => ({ message: "tried" }),
        // Same output every time -> stuck after the second check.
        runCheck: async () => check(1, "", "identical error")
      };

      const result = await runGoalLoop({ goal, paths, deps });

      expect(result.status).toBe("blocked");
      expect(result.reason).toBe("stuck");
      expect(result.attempts).toBe(2);
      expect(listGoals(paths, "s1")[0].note).toContain("Stuck");
    } finally {
      temp.cleanup();
    }
  });

  it("proposes a check command when the goal has none", async () => {
    const temp = makeTempRoot();
    try {
      const paths = getMagiPaths(temp.env);
      const goal = createGoal(paths, { sessionId: "s1", objective: "build it" });

      let proposed = false;
      const deps: GoalLoopDeps = {
        runPrompt: async () => ({ message: "ok" }),
        runCheck: async () => check(0, "ok"),
        proposeCheck: async () => {
          proposed = true;
          return "test -f build/output";
        }
      };

      const events: string[] = [];
      const result = await runGoalLoop({
        goal,
        paths,
        deps,
        onEvent: (event) => {
          if (event.type === "check-proposed") events.push(event.checkCommand ?? "");
        }
      });

      expect(proposed).toBe(true);
      expect(result.checkCommand).toBe("test -f build/output");
      expect(events).toEqual(["test -f build/output"]);
      expect(result.status).toBe("completed");
    } finally {
      temp.cleanup();
    }
  });

  it("throws when no check command exists and none can be proposed", async () => {
    const temp = makeTempRoot();
    try {
      const paths = getMagiPaths(temp.env);
      const goal = createGoal(paths, { sessionId: "s1", objective: "no check" });
      const deps: GoalLoopDeps = {
        runPrompt: async () => ({ message: "ok" }),
        runCheck: async () => check(0),
        proposeCheck: async () => undefined
      };

      await expect(runGoalLoop({ goal, paths, deps })).rejects.toThrow(/check command/);
    } finally {
      temp.cleanup();
    }
  });

  it("resolves the goal turn timeout from env with a 30-minute default", () => {
    expect(resolveGoalTurnTimeoutMs({})).toBe(30 * 60_000);
    expect(resolveGoalTurnTimeoutMs({ MAGI_GOAL_TURN_TIMEOUT_MS: "21600000" })).toBe(21_600_000);
    // Invalid / non-positive values fall back to the default.
    expect(resolveGoalTurnTimeoutMs({ MAGI_GOAL_TURN_TIMEOUT_MS: "abc" })).toBe(30 * 60_000);
    expect(resolveGoalTurnTimeoutMs({ MAGI_GOAL_TURN_TIMEOUT_MS: "0" })).toBe(30 * 60_000);
    expect(resolveGoalTurnTimeoutMs({ MAGI_GOAL_TURN_TIMEOUT_MS: "-5" })).toBe(30 * 60_000);
  });

  it("runShellCheck captures exit code and output from a real command", async () => {
    const temp = makeTempRoot();
    try {
      const pass = await runShellCheck("echo hello && exit 0", temp.path, process.env);
      expect(pass.exitCode).toBe(0);
      expect(pass.stdout).toContain("hello");

      const fail = await runShellCheck("echo boom >&2 && exit 7", temp.path, process.env);
      expect(fail.exitCode).toBe(7);
      expect(fail.stderr).toContain("boom");
    } finally {
      temp.cleanup();
    }
  });

  it("runs setup before the loop and blocks when setup fails", async () => {
    const temp = makeTempRoot();
    try {
      const paths = getMagiPaths(temp.env);
      const goal = createGoal(paths, {
        sessionId: "s1",
        objective: "needs deps",
        setupCommand: "python3 -m venv .venv && .venv/bin/pip install pytest",
        checkCommand: "pytest"
      });

      let ranPrompt = false;
      const deps: GoalLoopDeps = {
        runPrompt: async () => {
          ranPrompt = true;
          return { message: "should not run" };
        },
        runCheck: async () => check(0),
        runSetup: async () => check(1, "", "ERROR: could not create venv")
      };

      const events: string[] = [];
      const result = await runGoalLoop({
        goal,
        paths,
        deps,
        onEvent: (event) => {
          if (event.type === "setup-start" || event.type === "setup-result") {
            events.push(event.type);
          }
        }
      });

      expect(result.status).toBe("blocked");
      expect(result.reason).toBe("setup_failed");
      expect(result.attempts).toBe(0);
      expect(ranPrompt).toBe(false);
      expect(events).toEqual(["setup-start", "setup-result"]);
      const stored = listGoals(paths, "s1")[0];
      expect(stored.status).toBe("blocked");
      expect(stored.note).toContain("Setup command failed");
    } finally {
      temp.cleanup();
    }
  });

  it("runs setup successfully then enters the do-check-fix loop", async () => {
    const temp = makeTempRoot();
    try {
      const paths = getMagiPaths(temp.env);
      const goal = createGoal(paths, {
        sessionId: "s1",
        objective: "build with deps",
        setupCommand: "python3 -m venv .venv",
        checkCommand: "pytest"
      });

      const order: string[] = [];
      const deps: GoalLoopDeps = {
        runPrompt: async () => {
          order.push("prompt");
          return { message: "worked" };
        },
        runCheck: async () => {
          order.push("check");
          return check(0, "1 passed");
        },
        runSetup: async () => {
          order.push("setup");
          return check(0, "venv created");
        }
      };

      const result = await runGoalLoop({ goal, paths, deps });

      expect(result.status).toBe("completed");
      expect(order[0]).toBe("setup");
      expect(order).toContain("prompt");
      expect(order).toContain("check");
      expect(listGoals(paths, "s1")[0]).toMatchObject({ status: "completed" });
    } finally {
      temp.cleanup();
    }
  });
});
