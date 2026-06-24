import { MagiConfig } from "./config.js";
import { MagiPaths } from "./paths.js";
import { SessionStore } from "./session-store.js";
import { ThreadGoal, updateGoalStatus } from "./goal.js";
import { runHeadlessPrompt } from "./headless.js";
import { buildProviderRegistry } from "./providers/registry.js";
import { resolveModelAlias } from "./routing/model-alias.js";
import { textMessage } from "./providers/ir.js";
import { runShellCommand } from "./tools/shell.js";

/**
 * Self-driving goal execution loop.
 *
 * Implements an aider-style do -> check -> fix reflection loop:
 *   1. The agent works on the objective (runHeadlessPrompt).
 *   2. A deterministic external check command runs (exit code is the verdict).
 *   3. Exit 0 -> goal is auto-marked completed.
 *      Non-zero -> the failure output is fed back as the next prompt and the
 *      agent tries again, until maxChecks is reached (then auto-blocked).
 *
 * Completion is verified by the check command, never declared by the model.
 * A stuck detector stops early when two consecutive checks produce identical
 * output (the agent is spinning without making progress).
 */

export const DEFAULT_MAX_CHECKS = 3;
const CHECK_OUTPUT_LIMIT = 8000;

/**
 * Default timeout for the goal's setup and check commands. Complex goals run
 * full dependency installs, builds, and test suites that the previous 10-minute
 * cap could kill mid-run. Default to 30 minutes, overridable globally via
 * MAGI_GOAL_TURN_TIMEOUT_MS. A bounded cap is still enforced so a hung command
 * cannot spin forever.
 */
export function resolveGoalTurnTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MAGI_GOAL_TURN_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30 * 60_000;
}

export interface CheckResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GoalLoopStatus = "completed" | "blocked";

export interface GoalLoopResult {
  status: GoalLoopStatus;
  attempts: number;
  checkCommand: string;
  reason?: "max_checks" | "stuck" | "setup_failed";
  lastCheck?: CheckResult;
  setupCommand?: string;
}

export interface GoalLoopEvent {
  type:
    | "setup-proposed"
    | "setup-start"
    | "setup-result"
    | "check-proposed"
    | "attempt-start"
    | "check-result"
    | "stuck"
    | "done";
  attempt?: number;
  maxChecks?: number;
  checkCommand?: string;
  setupCommand?: string;
  exitCode?: number;
  status?: GoalLoopStatus;
}

export interface GoalLoopDeps {
  /** Run one agent turn against the objective/reflection prompt. */
  runPrompt: (prompt: string, attempt: number) => Promise<{ message: string }>;
  /** Run the deterministic check command; exit code is the verdict. */
  runCheck: (command: string) => Promise<CheckResult>;
  /** Propose a check command when the goal has none. Returns undefined on failure. */
  proposeCheck?: (objective: string) => Promise<string | undefined>;
  /** Run the one-time setup command (e.g. create venv, install deps). */
  runSetup?: (command: string) => Promise<CheckResult>;
}

/** Run a shell command via the reviewed shell boundary; exit code is the verdict. */
export async function runShellCheck(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = resolveGoalTurnTimeoutMs(env)
): Promise<CheckResult> {
  try {
    const result = await runShellCommand({
      cwd,
      command,
      timeoutMs,
      approveDangerous: true,
      skipAutoBackground: true
    });
    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout,
      stderr: result.stderr
    };
  } catch (error) {
    return { exitCode: 124, stdout: "", stderr: (error as Error).message };
  }
}

function truncate(text: string, limit = CHECK_OUTPUT_LIMIT): string {
  const trimmed = text.trimEnd();
  if (trimmed.length <= limit) return trimmed;
  return `...[truncated]...\n${trimmed.slice(trimmed.length - limit)}`;
}

function combinedOutput(check: CheckResult): string {
  return `${check.stdout}\n${check.stderr}`.trim();
}

function initialPrompt(goal: ThreadGoal, checkCommand: string): string {
  return [
    `You are working toward this goal: ${goal.objective}`,
    "",
    "Do the work needed to achieve it. When you believe it is done, stop.",
    `Completion is verified by running this check command: ${checkCommand}`,
    "Make sure that command will succeed (exit code 0) before you finish.",
    "Decompose the work with TodoWrite if it has several steps; skip the breakdown for simple goals."
  ].join("\n");
}

function reflectionPrompt(
  goal: ThreadGoal,
  checkCommand: string,
  check: CheckResult,
  attempt: number,
  maxChecks: number
): string {
  return [
    `The check command for goal "${goal.objective}" failed (attempt ${attempt}/${maxChecks}).`,
    `Command: ${checkCommand}`,
    `Exit code: ${check.exitCode}`,
    "",
    "Output:",
    truncate(combinedOutput(check)),
    "",
    "Fix the underlying problem so the check command passes, then stop.",
    "Address the actual failure above — do not guess."
  ].join("\n");
}

/**
 * Drive a goal to completion via the do -> check -> fix loop.
 * The goal must already exist and be active.
 */
export async function runGoalLoop(input: {
  goal: ThreadGoal;
  paths: MagiPaths;
  deps: GoalLoopDeps;
  maxChecks?: number;
  onEvent?: (event: GoalLoopEvent) => void;
}): Promise<GoalLoopResult> {
  const { goal, paths, deps, onEvent } = input;
  const maxChecks = input.maxChecks ?? goal.maxChecks ?? DEFAULT_MAX_CHECKS;

  if (goal.setupCommand) {
    onEvent?.({ type: "setup-start", setupCommand: goal.setupCommand });
    const setup = deps.runSetup
      ? await deps.runSetup(goal.setupCommand)
      : await deps.runCheck(goal.setupCommand);
    onEvent?.({ type: "setup-result", setupCommand: goal.setupCommand, exitCode: setup.exitCode });
    if (setup.exitCode !== 0) {
      updateGoalStatus(paths, {
        sessionId: goal.sessionId,
        status: "blocked",
        note: `Setup command failed (exit ${setup.exitCode}). Command: ${goal.setupCommand}`
      });
      onEvent?.({ type: "done", status: "blocked" });
      return {
        status: "blocked",
        attempts: 0,
        checkCommand: goal.checkCommand ?? "",
        reason: "setup_failed",
        lastCheck: setup,
        setupCommand: goal.setupCommand
      };
    }
  }

  let checkCommand = goal.checkCommand;
  if (!checkCommand) {
    checkCommand = deps.proposeCheck ? await deps.proposeCheck(goal.objective) : undefined;
    if (!checkCommand) {
      throw new Error(
        "goal run requires a check command. Pass --check <cmd> or configure a provider so one can be proposed."
      );
    }
    onEvent?.({ type: "check-proposed", checkCommand });
  }

  let prompt = initialPrompt(goal, checkCommand);
  let previousOutput: string | undefined;
  let lastCheck: CheckResult | undefined;

  for (let attempt = 1; attempt <= maxChecks; attempt += 1) {
    onEvent?.({ type: "attempt-start", attempt, maxChecks, checkCommand });
    await deps.runPrompt(prompt, attempt);

    const check = await deps.runCheck(checkCommand);
    lastCheck = check;
    onEvent?.({ type: "check-result", attempt, exitCode: check.exitCode });

    if (check.exitCode === 0) {
      updateGoalStatus(paths, {
        sessionId: goal.sessionId,
        status: "completed",
        note: `Verified by check command (exit 0) on attempt ${attempt}: ${checkCommand}`
      });
      onEvent?.({ type: "done", status: "completed", attempt });
      return { status: "completed", attempts: attempt, checkCommand, lastCheck: check };
    }

    const output = combinedOutput(check);
    if (previousOutput !== undefined && previousOutput === output) {
      onEvent?.({ type: "stuck", attempt });
      updateGoalStatus(paths, {
        sessionId: goal.sessionId,
        status: "blocked",
        note: `Stuck: identical check failure twice (exit ${check.exitCode}). Command: ${checkCommand}`
      });
      onEvent?.({ type: "done", status: "blocked", attempt });
      return {
        status: "blocked",
        attempts: attempt,
        checkCommand,
        reason: "stuck",
        lastCheck: check
      };
    }
    previousOutput = output;

    prompt = reflectionPrompt(goal, checkCommand, check, attempt, maxChecks);
  }

  updateGoalStatus(paths, {
    sessionId: goal.sessionId,
    status: "blocked",
    note: `Check command still failing after ${maxChecks} attempts. Command: ${checkCommand}`
  });
  onEvent?.({ type: "done", status: "blocked", attempt: maxChecks });
  return { status: "blocked", attempts: maxChecks, checkCommand, reason: "max_checks", lastCheck };
}

/**
 * Build the real (non-test) loop dependencies: runPrompt drives the headless
 * agent against the goal's session, runCheck spawns a shell, proposeCheck does
 * a single lightweight model call to suggest a verification command.
 */
export function buildGoalLoopDeps(input: {
  goal: ThreadGoal;
  cwd: string;
  store: SessionStore;
  config: MagiConfig;
  paths: MagiPaths;
  env: NodeJS.ProcessEnv;
  modelAlias?: string;
  permissionMode?: Parameters<typeof runHeadlessPrompt>[0]["permissionMode"];
}): GoalLoopDeps {
  const modelAlias = input.modelAlias ?? "main";

  return {
    runPrompt: async (prompt) => {
      const result = await runHeadlessPrompt({
        prompt,
        cwd: input.cwd,
        store: input.store,
        config: input.config,
        env: input.env,
        paths: input.paths,
        stateRoot: input.paths.stateRoot,
        modelAlias,
        sessionId: input.goal.sessionId,
        persistSession: true,
        permissionMode: input.permissionMode
      });
      return { message: result.message };
    },
    runCheck: (command) => runShellCheck(command, input.cwd, input.env),
    runSetup: (command) => runShellCheck(command, input.cwd, input.env),
    proposeCheck: async (objective) => {
      try {
        const registry = buildProviderRegistry({ config: input.config, env: input.env });
        const resolved = resolveModelAlias(input.config, modelAlias);
        const adapter = registry.get(resolved.providerName);
        if (!adapter) return undefined;
        const response = await adapter.complete({
          model: resolved.model,
          messages: [
            textMessage(
              "user",
              [
                "Propose a single shell command that deterministically verifies whether this goal is complete.",
                "The command must exit 0 only when the goal is genuinely achieved.",
                "Reply with the command only — no explanation, no markdown, no backticks.",
                "",
                `Goal: ${objective}`,
                `Working directory: ${input.cwd}`
              ].join("\n")
            )
          ],
          maxOutputTokens: 200
        });
        const command = response.text
          .trim()
          .replace(/^```[a-z]*\n?/i, "")
          .replace(/\n?```$/i, "")
          .trim();
        return command || undefined;
      } catch {
        return undefined;
      }
    }
  };
}
