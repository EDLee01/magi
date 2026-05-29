#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import qrcodeTerminal from "qrcode-terminal";

import { MagiConfigError, MagiUsageError } from "./errors.js";
import { ProviderError } from "./providers/errors.js";
import { formatConfig, loadConfig } from "./config.js";
import { formatDoctorReport } from "./doctor.js";
import { loadMagiEnvFile } from "./env.js";
import { runHeadlessPrompt } from "./headless.js";
import { formatMemory, MemoryScope } from "./memory.js";
import { initMemory, listMemoryFiles, readMemoryFile } from "./memory-files.js";
import { retrieveRelevantMemory, formatMemoryContext } from "./memory-search.js";
import { formatMemoryLinkResult, linkMemoryNodes } from "./memory-link.js";
import {
  formatMemoryConflictGroups,
  formatMemoryConflicts,
  listMemoryConflictGroups,
  listMemoryConflicts
} from "./memory-conflicts.js";
import { formatMemoryMerges, listMemoryMerges } from "./memory-merges.js";
import { formatMemoryEvalReport, runMemoryEval, writeMemoryEvalReport } from "./memory-eval.js";
import { correctMemory, formatMemoryCorrectionResult } from "./memory-correction.js";
import {
  applyMemoryFeedback,
  formatMemoryFeedbackResult,
  formatMemoryFeedbackTrends,
  listMemoryFeedbackTrends
} from "./memory-feedback.js";
import {
  configureMemoryMaintenance,
  formatMemoryMaintenancePolicy,
  formatMemoryMaintenanceResult,
  maintainMemory,
  readMemoryMaintenancePolicy
} from "./memory-maintenance.js";
import {
  adoptPlanReview,
  formatPlanReview,
  formatPlanReviewChain,
  formatPlanReviewList,
  getLatestPlanReview,
  getPlanReview,
  getPlanReviewChain,
  listPlanReviews
} from "./plan-state.js";
import {
  proposeMemoryDraft,
  listDrafts,
  formatDraftReview,
  applyDraft,
  rejectDraft
} from "./memory-draft.js";
import { runDream, listDreams, showDream, applyDream, rejectDream } from "./memory-dream.js";
import {
  applyLearningDraft,
  formatLearningDraftList,
  formatLearningDraftReview,
  listLearningDrafts,
  rejectLearningDraft
} from "./learning-draft.js";
import { McpConnectionManager } from "./mcp/connection-manager.js";
import { ensureMagiHome, getMagiPaths, getRuntimeSettings } from "./paths.js";
import { formatAgentInstructions, loadAgentInstructions } from "./rules/agents-loader.js";
import { SessionStore } from "./session-store.js";
import { formatSessionList, formatSessionResume, runInteractiveTerminal } from "./tui.js";
import { startControlServer } from "./control/server.js";
import {
  getDaemonStatus,
  startDaemon,
  stopDaemon,
  writeDaemonPidFile,
  clearDaemonPidFile
} from "./control/daemon.js";
import { createJsonLogger, type Logger, type LogLevel } from "./logger.js";
import { setColorEnabled } from "./colors.js";
import { compactSessionWithHooks, formatCompactResult } from "./context/compaction.js";
import { computeSessionContextBudget, formatSessionContextBudget } from "./context/token-budget.js";
import {
  cancelAgentTask,
  completeAgentTask,
  spawnAgentTask,
  startAgentTask,
  waitAgentTask
} from "./agents/task-queue.js";
import { resolveRunnerCommand, RunnerClient } from "./runner/client.js";
import { AgentRole } from "./session-store.js";
import { formatPluginList, listLocalPlugins } from "./plugins/manifest.js";
import {
  discoverLocalMarketplaceSources,
  formatMarketplaces,
  loadMarketplace
} from "./plugins/marketplace.js";
import { findSkill, formatSkillList, listSkills } from "./skills/loader.js";
import { formatSessionSearch } from "./slash.js";
import {
  formatWorkspaceDiagnostics,
  runWorkspaceDiagnostics
} from "./tools/workspace-diagnostics.js";
import { VERSION } from "./version.js";
import { triggerHooks } from "./hooks/events.js";
import { buildProviderRegistry } from "./providers/registry.js";
import { resolveModelAlias } from "./routing/model-alias.js";
import {
  createGoal,
  clearGoal,
  formatGoal,
  formatGoalStatus,
  getGoal,
  isGoalCreationArgs,
  listGoals,
  updateGoalStatus
} from "./goal.js";
import { parsePermissionMode } from "./commands/permissions.js";
import { ToolPermissionMode } from "./tools/registry.js";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): Promise<CliResult> {
  try {
    return await runCliUnsafe(argv, env, cwd);
  } catch (error) {
    if (error instanceof MagiConfigError || error instanceof MagiUsageError) {
      return { exitCode: 2, stdout: "", stderr: `${error.message}\n` };
    }
    if (error instanceof ProviderError) {
      // Provider errors (HTTP 401/429/502/etc) already carry a user-friendly
      // message. Don't print the stack — it adds noise without information.
      return { exitCode: 1, stdout: "", stderr: `${error.message}\n` };
    }
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    return { exitCode: 1, stdout: "", stderr: `${detail}\n` };
  }
}

async function runCliUnsafe(
  argv: string[],
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<CliResult> {
  const parsed = parseArgs(argv);
  const command = parsed.command;

  // Honor --no-color flag (NO_COLOR env var is handled by colors.ts default).
  if (argv.includes("--no-color")) {
    setColorEnabled(false);
  } else if (env.NO_COLOR && env.NO_COLOR !== "") {
    // env passed in may differ from process.env (tests); honor it explicitly.
    setColorEnabled(false);
  }

  if (!command || command === "help" || command === "--help" || command === "-h") {
    if (!command) {
      const runtimeEnv = loadMagiEnvFile(env).env;
      const paths = getMagiPaths(runtimeEnv);
      ensureMagiHome(paths);
      const config = loadConfig(paths, runtimeEnv);
      const store = SessionStore.open(paths);
      try {
        const resumeSession = parsed.continueSession ? store.getMostRecentSession(cwd) : undefined;
        const exitCode = await runInteractiveTerminal({
          cwd,
          config,
          store,
          paths,
          env: runtimeEnv,
          modelAlias: parsed.modelAlias ?? "main",
          sessionId: resumeSession?.id
        });
        return { exitCode, stdout: "", stderr: "" };
      } finally {
        store.close();
      }
    }
    return { exitCode: 0, stdout: helpText(), stderr: "" };
  }

  if (command === "--version" || command === "-v") {
    return runCliUnsafeWithParsed(parsed, env, cwd);
  }

  const runtimeEnv = loadMagiEnvFile(env).env;

  if (!command?.startsWith("-") && !knownCommands().has(command)) {
    parsed.command = "-p";
    parsed.prompt = [command, ...parsed.rest].join(" ");
    parsed.rest = [];
    return runCliUnsafeWithParsed(parsed, runtimeEnv, cwd);
  }

  return runCliUnsafeWithParsed(parsed, runtimeEnv, cwd);
}

async function runCliUnsafeWithParsed(
  parsed: ParsedArgs,
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<CliResult> {
  const command = parsed.command;

  // First-run bootstrap: ensure ~/.magi-next exists and bundled skills are
  // installed. Called every CLI invocation but is idempotent (skips existing).
  try {
    const paths = getMagiPaths(env);
    ensureMagiHome(paths);
    const { installBundledSkills } = await import("./skills/bundled.js");
    installBundledSkills(paths);
  } catch {
    // Best-effort. Anything important fails again later with a clearer error.
  }

  if (command === "--version" || command === "-v") {
    return { exitCode: 0, stdout: `magi ${VERSION}\n`, stderr: "" };
  }

  if (command === "-p" || command === "--prompt") {
    const prompt = parsed.prompt;
    if (!prompt || !prompt.trim()) {
      throw new MagiUsageError("magi -p requires a non-empty prompt");
    }
    const paths = getMagiPaths(env);
    ensureMagiHome(paths);
    const config = loadConfig(paths, env);
    const setupSessionId = `setup-${Date.now()}`;
    const setupStore = SessionStore.open(paths);
    try {
      await triggerHooks({
        event: "setup",
        hooks: config.hooks,
        store: setupStore,
        sessionId: setupSessionId,
        cwd,
        env
      });
    } finally {
      setupStore.close();
    }

    const store = SessionStore.open(paths);
    try {
      const resumeSession = parsed.resumeSessionId
        ? store.getSession(parsed.resumeSessionId)
        : parsed.continueSession
          ? store.getMostRecentSession(cwd)
          : undefined;
      if (parsed.resumeSessionId && !resumeSession) {
        throw new MagiUsageError(`Session not found: ${parsed.resumeSessionId}`);
      }
      if (parsed.sessionId && !store.getSession(parsed.sessionId)) {
        store.createSession({
          id: parsed.sessionId,
          title: parsed.sessionName ?? prompt.slice(0, 80),
          cwd,
          metadata: { mode: "headless", explicitSessionId: true }
        });
      }
      const result = await runHeadlessPrompt({
        prompt,
        cwd,
        store,
        config,
        env,
        paths,
        stateRoot: paths.stateRoot,
        modelAlias: parsed.modelAlias ?? "main",
        sessionId: parsed.sessionId ?? resumeSession?.id,
        sessionName: parsed.sessionName,
        persistSession: parsed.persistSession,
        collectEvents: parsed.outputFormat === "stream-json",
        permissionMode: parsed.permissionMode
      });
      if (parsed.outputFormat === "stream-json") {
        return {
          exitCode: 0,
          stdout: formatStreamJson(result),
          stderr: ""
        };
      }
      if (parsed.outputFormat === "json") {
        return { exitCode: 0, stdout: `${JSON.stringify(result)}\n`, stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: [
          result.message,
          `sessionId: ${result.sessionId}`,
          `jobId: ${result.jobId}`,
          `stateDb: ${paths.sessionDbFile}`,
          ""
        ].join("\n"),
        stderr: ""
      };
    } finally {
      store.close();
    }
  }

  if (command === "doctor") {
    const paths = getMagiPaths(env);
    ensureMagiHome(paths);
    const runtime = getRuntimeSettings(env);
    const config = loadConfig(paths, env);
    return {
      exitCode: 0,
      stdout: formatDoctorReport({ paths, runtime, config, legacyAccessDetected: false }),
      stderr: ""
    };
  }

  if (command === "config") {
    const paths = getMagiPaths(env);
    ensureMagiHome(paths);
    const config = loadConfig(paths, env);
    return {
      exitCode: 0,
      stdout: [`configFile: ${paths.configFile}`, formatConfig(config)].join("\n"),
      stderr: ""
    };
  }

  if (command === "sessions") {
    const paths = getMagiPaths(env);
    ensureMagiHome(paths);
    loadConfig(paths, env);
    const store = SessionStore.open(paths);
    try {
      return { exitCode: 0, stdout: formatSessionList(store), stderr: "" };
    } finally {
      store.close();
    }
  }

  if (command === "resume") {
    const sessionId = parsed.rest[0];
    if (!sessionId) {
      throw new MagiUsageError("magi resume requires a session id");
    }
    const paths = getMagiPaths(env);
    ensureMagiHome(paths);
    loadConfig(paths, env);
    const store = SessionStore.open(paths);
    try {
      const output = formatSessionResume(store, sessionId);
      return {
        exitCode: output.startsWith("Session not found:") ? 2 : 0,
        stdout: output,
        stderr: ""
      };
    } finally {
      store.close();
    }
  }

  if (command === "-r" || command === "--resume") {
    const paths = getMagiPaths(env);
    ensureMagiHome(paths);
    loadConfig(paths, env);
    const store = SessionStore.open(paths);
    try {
      if (parsed.resumeSessionId) {
        const output = formatSessionResume(store, parsed.resumeSessionId);
        return {
          exitCode: output.startsWith("Session not found:") ? 2 : 0,
          stdout: output,
          stderr: ""
        };
      }
      return { exitCode: 0, stdout: `${formatSessionSearch(store, "")}\n`, stderr: "" };
    } finally {
      store.close();
    }
  }

  if (command === "context") {
    const paths = getMagiPaths(env);
    ensureMagiHome(paths);
    loadConfig(paths, env);
    const store = SessionStore.open(paths);
    try {
      const session = resolveSessionForCommand(store, parsed.rest[0], cwd);
      const summaries = store.listContextSummaries(session.id);
      return {
        exitCode: 0,
        stdout: formatSessionContextBudget(computeSessionContextBudget({ session, summaries })),
        stderr: ""
      };
    } finally {
      store.close();
    }
  }

  if (command === "compact") {
    const paths = getMagiPaths(env);
    ensureMagiHome(paths);
    const config = loadConfig(paths, env);
    const setupSessionId = `setup-${Date.now()}`;
    const setupStore = SessionStore.open(paths);
    try {
      await triggerHooks({
        event: "setup",
        hooks: config.hooks,
        store: setupStore,
        sessionId: setupSessionId,
        cwd,
        env
      });
    } finally {
      setupStore.close();
    }

    const store = SessionStore.open(paths);
    try {
      const session = resolveSessionForCommand(store, parsed.rest[0], cwd);
      const modelRunner = parsed.modelAlias
        ? resolveCompactionModelRunner(config, env, parsed.modelAlias)
        : undefined;
      const compacted = await compactSessionWithHooks({
        store,
        sessionId: session.id,
        hooks: config.hooks,
        cwd,
        env,
        modelRunner,
        trigger: "manual"
      });
      return {
        exitCode: 0,
        stdout: formatCompactResult(compacted),
        stderr: ""
      };
    } finally {
      store.close();
    }
  }

  if (command === "goal") {
    const paths = getMagiPaths(env);
    ensureMagiHome(paths);
    loadConfig(paths, env);
    const store = SessionStore.open(paths);
    try {
      const sub = parsed.rest[0]?.toLowerCase();
      const isStatusCommand = !sub || sub === "status" || sub === "show";
      const isListCommand = sub === "list";
      const session = resolveGoalSessionForCommand({
        store,
        sessionId: parsed.sessionId ?? parsed.resumeSessionId,
        cwd,
        create: isGoalCreationArgs(parsed.rest),
        title: parsed.rest.join(" ").slice(0, 80) || "goal",
        optional: isStatusCommand || isListCommand
      });
      if (!session) {
        if (isStatusCommand) {
          return { exitCode: 0, stdout: `${formatGoal(undefined)}\n`, stderr: "" };
        }
        if (isListCommand) {
          return { exitCode: 0, stdout: "No goals for this session.\n", stderr: "" };
        }
        throw new MagiUsageError("No sessions found");
      }
      if (isStatusCommand) {
        return { exitCode: 0, stdout: `${formatGoal(getGoal(paths, session.id))}\n`, stderr: "" };
      }
      if (isListCommand) {
        const goals = listGoals(paths, session.id);
        return {
          exitCode: 0,
          stdout:
            goals.length === 0
              ? "No goals for this session.\n"
              : `${["Goals for this session:", ...goals.map((goal) => `- ${formatGoalStatus(goal.status).padEnd(16)} ${goal.objective} (${goal.updatedAt})`)].join("\n")}\n`,
          stderr: ""
        };
      }
      if (sub === "done" || sub === "complete" || sub === "completed") {
        const goal = updateGoalStatus(paths, {
          sessionId: session.id,
          status: "completed",
          note: parsed.rest.slice(1).join(" ")
        });
        return {
          exitCode: goal ? 0 : 2,
          stdout: `${goal ? `Goal completed: ${goal.objective}` : "No active goal."}\n`,
          stderr: ""
        };
      }
      if (sub === "blocked" || sub === "block") {
        const goal = updateGoalStatus(paths, {
          sessionId: session.id,
          status: "blocked",
          note: parsed.rest.slice(1).join(" ")
        });
        return {
          exitCode: goal ? 0 : 2,
          stdout: `${goal ? `Goal blocked: ${goal.objective}` : "No active goal."}\n`,
          stderr: ""
        };
      }
      if (
        sub === "cancel" ||
        sub === "cancelled" ||
        sub === "clear" ||
        sub === "reset" ||
        sub === "stop"
      ) {
        const goal = clearGoal(paths, session.id);
        return {
          exitCode: goal ? 0 : 2,
          stdout: `${goal ? `Goal cancelled: ${goal.objective}` : "No active goal."}\n`,
          stderr: ""
        };
      }
      const goal = createGoal(paths, { sessionId: session.id, objective: parsed.rest.join(" ") });
      return { exitCode: 0, stdout: `Goal started: ${goal.objective}\n`, stderr: "" };
    } finally {
      store.close();
    }
  }

  if (command === "plan") {
    const paths = getMagiPaths(env);
    ensureMagiHome(paths);
    loadConfig(paths, env);
    const store = SessionStore.open(paths);
    try {
      const sub = parsed.rest[0]?.toLowerCase();
      const isList = sub === "list";
      const isAll = sub === "all" || sub === "global";
      if (sub === "show") {
        const planId = parsed.rest[1];
        return {
          exitCode: planId ? 0 : 2,
          stdout: `${planId ? formatPlanReview(getPlanReview(paths.stateRoot, planId)) : ""}\n`,
          stderr: planId ? "" : "Usage: magi plan show <plan-id>\n"
        };
      }
      if (sub === "chain") {
        const planId = parsed.rest[1];
        return {
          exitCode: planId ? 0 : 2,
          stdout: `${planId ? formatPlanReviewChain(getPlanReviewChain(paths.stateRoot, planId)) : ""}\n`,
          stderr: planId ? "" : "Usage: magi plan chain <plan-id>\n"
        };
      }
      if (sub === "adopt" || sub === "migrate") {
        const planId = parsed.rest[1];
        const session = resolvePlanSessionForCommand({
          store,
          sessionId: parsed.sessionId ?? parsed.resumeSessionId,
          cwd,
          optional: false
        });
        if (!session) {
          throw new MagiUsageError("No sessions found");
        }
        if (!planId) {
          return {
            exitCode: 2,
            stdout: "",
            stderr: "Usage: magi plan adopt <plan-id> --session-id <target-session>\n"
          };
        }
        const adopted = adoptPlanReview({
          stateRoot: paths.stateRoot,
          sourcePlanId: planId,
          targetSessionId: session.id
        });
        return {
          exitCode: 0,
          stdout: [
            `Plan adopted: ${adopted.id}`,
            `Session: ${adopted.sessionId}`,
            `Adopted from plan: ${adopted.adoptedFromPlanId}`,
            ""
          ].join("\n"),
          stderr: ""
        };
      }
      const session = resolvePlanSessionForCommand({
        store,
        sessionId: isAll ? undefined : (parsed.sessionId ?? parsed.resumeSessionId),
        cwd,
        optional: true
      });
      const records = listPlanReviews(paths.stateRoot, isAll ? undefined : session?.id);
      return {
        exitCode: 0,
        stdout: `${
          isList || isAll
            ? formatPlanReviewList(records)
            : formatPlanReview(getLatestPlanReview(paths.stateRoot, session?.id))
        }\n`,
        stderr: ""
      };
    } finally {
      store.close();
    }
  }

  if (command === "rules") {
    return { exitCode: 0, stdout: formatAgentInstructions(loadAgentInstructions(cwd)), stderr: "" };
  }

  if (command === "workspace") {
    const subcommand = parsed.rest[0] ?? "diagnose";
    if (subcommand !== "diagnose" && subcommand !== "diagnostics") {
      throw new MagiUsageError(`Unknown workspace command: ${subcommand}`);
    }
    const format = parsed.outputFormat === "json" ? "json" : "text";
    const diagnostics = runWorkspaceDiagnostics({
      cwd,
      request: {
        path: parsed.rest[1],
        format,
        maxFiles: 2_000
      }
    });
    return {
      exitCode: 0,
      stdout: formatWorkspaceDiagnostics(diagnostics, format),
      stderr: ""
    };
  }

  if (command === "memory") {
    const paths = getMagiPaths(env);
    ensureMagiHome(paths);
    loadConfig(paths, env);
    const config = loadConfig(paths, env);
    const subcommand = parsed.rest[0] ?? "view";
    const rootInput = { appRoot: paths.root, root: config.memory.root };
    if (subcommand === "init") {
      return { exitCode: 0, stdout: `Memory initialized: ${initMemory(rootInput)}\n`, stderr: "" };
    }
    if (subcommand === "list") {
      const files = listMemoryFiles(rootInput);
      return {
        exitCode: 0,
        stdout: `${files.map((file) => `${file.path}\t${file.size}`).join("\n") || "No Memory files"}\n`,
        stderr: ""
      };
    }
    if (subcommand === "show") {
      const target = parsed.rest[1];
      if (!target) throw new MagiUsageError("magi memory show requires a path");
      return {
        exitCode: 0,
        stdout: readMemoryFile({ ...rootInput, filePath: target }),
        stderr: ""
      };
    }
    if (subcommand === "search") {
      const query = parsed.rest.slice(1).join(" ");
      if (!query.trim()) {
        throw new MagiUsageError("magi memory search requires a query");
      }
      const sessionId = parsed.resumeSessionId ?? parsed.sessionId;
      const hits = retrieveRelevantMemory({
        ...rootInput,
        query,
        maxResults: config.memory.maxResults,
        sessionId,
        legacy: {
          paths,
          cwd,
          sessionId,
          scopes: config.memory.scopes
        }
      });
      return {
        exitCode: 0,
        stdout: `${formatMemoryContext(hits) || "No matching Memory"}\n`,
        stderr: ""
      };
    }
    if (subcommand === "link") {
      const options = parseMemoryLinkArgs(parsed.rest.slice(1));
      const result = linkMemoryNodes({
        ...rootInput,
        paths,
        from: options.from,
        to: options.to,
        relation: options.relation,
        weight: options.weight
      });
      return { exitCode: 0, stdout: `${formatMemoryLinkResult(result)}\n`, stderr: "" };
    }
    if (subcommand === "correct") {
      const options = parseMemoryCorrectArgs(parsed.rest.slice(1));
      const result = correctMemory({
        ...rootInput,
        paths,
        sessionId: parsed.resumeSessionId ?? parsed.sessionId,
        target: options.target,
        reason: options.reason,
        replacement: options.replacement,
        replacementTitle: options.replacementTitle,
        replacementSummary: options.replacementSummary,
        replacementType: options.replacementType
      });
      return { exitCode: 0, stdout: `${formatMemoryCorrectionResult(result)}\n`, stderr: "" };
    }
    if (subcommand === "feedback") {
      if (parsed.rest[1] === "trends") {
        const options = parseMemoryFeedbackTrendsArgs(parsed.rest.slice(2));
        const trends = listMemoryFeedbackTrends({
          ...rootInput,
          paths,
          limit: options.limit,
          minEvents: options.minEvents
        });
        return { exitCode: 0, stdout: `${formatMemoryFeedbackTrends(trends)}\n`, stderr: "" };
      }
      const options = parseMemoryFeedbackArgs(parsed.rest.slice(1));
      const result = applyMemoryFeedback({
        ...rootInput,
        paths,
        sessionId: parsed.resumeSessionId ?? parsed.sessionId,
        target: options.target,
        signal: options.signal,
        reason: options.reason,
        replacement: options.replacement,
        replacementTitle: options.replacementTitle,
        replacementSummary: options.replacementSummary,
        replacementType: options.replacementType
      });
      return { exitCode: 0, stdout: `${formatMemoryFeedbackResult(result)}\n`, stderr: "" };
    }
    if (subcommand === "conflicts") {
      const options = parseMemoryConflictsArgs(parsed.rest.slice(1));
      if (options.groups) {
        const groups = listMemoryConflictGroups({
          ...rootInput,
          paths,
          limit: options.limit
        });
        return { exitCode: 0, stdout: `${formatMemoryConflictGroups(groups)}\n`, stderr: "" };
      }
      const conflicts = listMemoryConflicts({
        ...rootInput,
        paths,
        limit: options.limit
      });
      return { exitCode: 0, stdout: `${formatMemoryConflicts(conflicts)}\n`, stderr: "" };
    }
    if (subcommand === "merges") {
      const options = parseMemoryMergesArgs(parsed.rest.slice(1));
      const merges = listMemoryMerges({
        ...rootInput,
        paths,
        limit: options.limit
      });
      return { exitCode: 0, stdout: `${formatMemoryMerges(merges)}\n`, stderr: "" };
    }
    if (subcommand === "eval") {
      const options = parseMemoryEvalArgs(parsed.rest.slice(1));
      const sessionId = parsed.resumeSessionId ?? parsed.sessionId;
      const report = runMemoryEval({
        ...rootInput,
        paths,
        cwd,
        caseFile: options.caseFile,
        maxResults: options.maxResults,
        minScore: options.minScore,
        sessionId,
        scopes: config.memory.scopes
      });
      if (options.reportFile) {
        writeMemoryEvalReport(options.reportFile, report);
      }
      return {
        exitCode: report.failed === 0 && report.thresholdPassed ? 0 : 1,
        stdout: `${formatMemoryEvalReport(report)}${options.reportFile ? `\nReport: ${options.reportFile}` : ""}\n`,
        stderr: ""
      };
    }
    if (subcommand === "maintain") {
      const rawMaintainArgs = parsed.rest.slice(1);
      if (rawMaintainArgs[0] === "config") {
        const configArgs = rawMaintainArgs.slice(1);
        if (configArgs.length === 0) {
          return {
            exitCode: 0,
            stdout: `${formatMemoryMaintenancePolicy(readMemoryMaintenancePolicy(rootInput))}\n`,
            stderr: ""
          };
        }
        const options = parseMemoryMaintainConfigArgs(configArgs);
        const result = configureMemoryMaintenance({
          ...rootInput,
          sessionId: parsed.resumeSessionId ?? parsed.sessionId,
          olderThanDays: options.olderThanDays,
          decay: options.decay,
          minWeight: options.minWeight,
          limit: options.limit
        });
        return { exitCode: 0, stdout: `${formatMemoryMaintenancePolicy(result)}\n`, stderr: "" };
      }
      const options = parseMemoryMaintainArgs(rawMaintainArgs);
      const result = maintainMemory({
        ...rootInput,
        paths,
        sessionId: parsed.resumeSessionId ?? parsed.sessionId,
        apply: options.apply,
        olderThanDays: options.olderThanDays,
        decay: options.decay,
        minWeight: options.minWeight,
        limit: options.limit
      });
      return { exitCode: 0, stdout: `${formatMemoryMaintenanceResult(result)}\n`, stderr: "" };
    }
    if (subcommand === "drafts") {
      const drafts = listDrafts(rootInput);
      return {
        exitCode: 0,
        stdout: `${drafts.map((draft) => `${draft.id}\t${draft.status}\t${draft.targetFile}`).join("\n") || "No Memory Drafts"}\n`,
        stderr: ""
      };
    }
    if (subcommand === "draft") {
      const action = parsed.rest[1];
      const id = parsed.rest[2];
      if (!action || !id) throw new MagiUsageError("magi memory draft <show|apply|reject> <id>");
      if (action === "show")
        return { exitCode: 0, stdout: `${formatDraftReview({ ...rootInput, id })}\n`, stderr: "" };
      if (action === "apply")
        return {
          exitCode: 0,
          stdout: `Applied Memory Draft: ${applyDraft({ ...rootInput, id }).id}\n`,
          stderr: ""
        };
      if (action === "reject")
        return {
          exitCode: 0,
          stdout: `Rejected Memory Draft: ${rejectDraft({ ...rootInput, id }).id}\n`,
          stderr: ""
        };
      throw new MagiUsageError(`Unknown memory draft action: ${action}`);
    }
    if (subcommand === "dream") {
      const action = parsed.rest[1];
      const id = parsed.rest[2];
      if (!action) {
        const dream = runDream({ ...rootInput, paths });
        return {
          exitCode: 0,
          stdout: `Experimental Dream created: ${dream.id}\n${dream.summary}\nDrafts: ${dream.draftIds.length}\n`,
          stderr: ""
        };
      }
      if (!id) throw new MagiUsageError("magi memory dream <show|apply|reject> <id>");
      if (action === "show")
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(showDream({ ...rootInput, id }), null, 2)}\n`,
          stderr: ""
        };
      if (action === "apply") {
        const dream = applyDream({
          ...rootInput,
          id,
          paths,
          applyDraft: (draftId) => applyDraft({ ...rootInput, id: draftId })
        });
        return {
          exitCode: 0,
          stdout: `Applied Dream: ${dream.id}\nArchived graph nodes: ${dream.graphReview?.nodeIds.length ?? 0}\nRedirected graph edges: ${dream.graphReview?.redirectedEdgeCount ?? 0}\nFused graph node weights: ${dream.graphReview?.fusedWeightCount ?? 0}\nResolved graph edge conflicts: ${dream.graphReview?.resolvedEdgeConflictCount ?? 0}\n`,
          stderr: ""
        };
      }
      if (action === "reject") {
        const dream = rejectDream({
          ...rootInput,
          id,
          paths,
          rejectDraft: (draftId) => rejectDraft({ ...rootInput, id: draftId })
        });
        return {
          exitCode: 0,
          stdout: `Rejected Dream: ${dream.id}\nKept graph nodes: ${dream.graphReview?.nodeIds.length ?? 0}\n`,
          stderr: ""
        };
      }
      throw new MagiUsageError(`Unknown memory dream action: ${action}`);
    }
    if (subcommand === "dreams") {
      const dreams = listDreams(rootInput);
      return {
        exitCode: 0,
        stdout: `${dreams.map((dream) => `${dream.id}\t${dream.status}\toperations=${dream.operationCount}\tdrafts=${dream.draftCount}`).join("\n") || "No experimental Dream runs"}\n`,
        stderr: ""
      };
    }
    if (subcommand === "view") {
      const scope = readMemoryScope(parsed.rest[1]);
      const sessionId = parsed.resumeSessionId ?? parsed.sessionId;
      if (scope === "session" && !sessionId) {
        throw new MagiUsageError("magi memory view session requires --session-id <id>");
      }
      return { exitCode: 0, stdout: formatMemory({ paths, cwd, scope, sessionId }), stderr: "" };
    }
    if (subcommand === "append") {
      const scope = readMemoryScope(parsed.rest[1]);
      const text = parsed.rest.slice(2).join(" ");
      if (!text.trim()) {
        throw new MagiUsageError("magi memory append <user|project|session> requires text");
      }
      const sessionId = parsed.resumeSessionId ?? parsed.sessionId;
      const draft = proposeMemoryDraft({
        ...rootInput,
        targetFile: memoryScopeTargetFile(scope),
        content: text,
        reason: `CLI memory append proposed ${scope} Memory`,
        sourceSession: sessionId
      });
      return {
        exitCode: 0,
        stdout: `Created Memory Draft: ${draft.id} -> ${draft.targetFile}\nApply it with: magi memory draft apply ${draft.id}\n`,
        stderr: ""
      };
    }
    throw new MagiUsageError(`Unknown memory command: ${subcommand}`);
  }

  if (command === "learning" || command === "learn") {
    const paths = getMagiPaths(env);
    ensureMagiHome(paths);
    const config = loadConfig(paths, env);
    const rootInput = {
      appRoot: paths.root,
      memoryRoot: config.memory.root,
      skillsRoot: paths.skillsRoot
    };
    const subcommand = parsed.rest[0] ?? "drafts";
    if (subcommand === "drafts" || subcommand === "list") {
      return {
        exitCode: 0,
        stdout: `${formatLearningDraftList(listLearningDrafts(rootInput))}\n`,
        stderr: ""
      };
    }
    if (subcommand === "draft") {
      const action = parsed.rest[1];
      const id = parsed.rest[2];
      if (!action || !id) throw new MagiUsageError("magi learning draft <show|apply|reject> <id>");
      if (action === "show")
        return {
          exitCode: 0,
          stdout: `${formatLearningDraftReview({ ...rootInput, id })}\n`,
          stderr: ""
        };
      if (action === "apply")
        return {
          exitCode: 0,
          stdout: `Applied LearningDraft: ${applyLearningDraft({ ...rootInput, id }).id}\n`,
          stderr: ""
        };
      if (action === "reject")
        return {
          exitCode: 0,
          stdout: `Rejected LearningDraft: ${rejectLearningDraft({ ...rootInput, id }).id}\n`,
          stderr: ""
        };
      throw new MagiUsageError(`Unknown learning draft action: ${action}`);
    }
    throw new MagiUsageError(`Unknown learning command: ${subcommand}`);
  }

  if (command === "mcp") {
    const paths = getMagiPaths(env);
    ensureMagiHome(paths);
    const config = loadConfig(paths, env);
    const subcommand = parsed.rest[0] ?? "list";
    if (subcommand !== "list" && subcommand !== "resources" && subcommand !== "read-resource") {
      throw new MagiUsageError(`Unknown mcp command: ${subcommand}`);
    }
    const serverName = parsed.rest[1];
    if (!serverName) {
      return {
        exitCode: 0,
        stdout: `${Object.keys(config.mcp.servers).join("\n") || "No MCP servers configured"}\n`,
        stderr: ""
      };
    }
    if (!config.mcp.servers[serverName]) {
      throw new MagiUsageError(`MCP server is not configured: ${serverName}`);
    }
    const manager = new McpConnectionManager({ servers: config.mcp.servers, env });
    try {
      const client = await manager.connect(serverName);
      if (subcommand === "resources") {
        const resources = await client.listResources();
        return {
          exitCode: 0,
          stdout: `${resources
            .map((resource) =>
              [resource.uri, resource.name, resource.mimeType, resource.description]
                .filter(Boolean)
                .join("  ")
            )
            .join("\n")}\n`,
          stderr: ""
        };
      }
      if (subcommand === "read-resource") {
        const uri = requireArg(parsed.rest[2], "resource uri");
        const result = await client.readResource(uri);
        return {
          exitCode: 0,
          stdout: `${result.contents
            .map((content) =>
              [
                content.uri ? `uri: ${content.uri}` : undefined,
                content.mimeType ? `mime: ${content.mimeType}` : undefined,
                content.text ?? content.blob ?? ""
              ]
                .filter(Boolean)
                .join("\n")
            )
            .join("\n\n")}\n`,
          stderr: ""
        };
      }
      const tools = await client.listTools();
      return {
        exitCode: 0,
        stdout: `${tools.map((tool) => tool.name).join("\n")}\n`,
        stderr: ""
      };
    } finally {
      manager.disconnectAll();
    }
  }

  if (command === "plugins") {
    const paths = getMagiPaths(env);
    ensureMagiHome(paths);
    loadConfig(paths, env);
    return { exitCode: 0, stdout: formatPluginList(listLocalPlugins(paths)), stderr: "" };
  }

  if (command === "marketplace") {
    const paths = getMagiPaths(env);
    ensureMagiHome(paths);
    loadConfig(paths, env);
    const records = discoverLocalMarketplaceSources(paths).map(loadMarketplace);
    return { exitCode: 0, stdout: formatMarketplaces(records), stderr: "" };
  }

  if (command === "skills") {
    const paths = getMagiPaths(env);
    ensureMagiHome(paths);
    loadConfig(paths, env);
    const subcommand = parsed.rest[0] ?? "list";
    if (subcommand === "list") {
      return { exitCode: 0, stdout: formatSkillList(listSkills(paths)), stderr: "" };
    }
    if (subcommand === "show") {
      const name = requireArg(parsed.rest[1], "skill name");
      const skill = findSkill(paths, name);
      if (!skill) {
        throw new MagiUsageError(`Skill not found: ${name}`);
      }
      return { exitCode: 0, stdout: `${skill.body ?? ""}\n`, stderr: "" };
    }
    throw new MagiUsageError(`Unknown skills command: ${subcommand}`);
  }

  if (command === "agents") {
    const paths = getMagiPaths(env);
    ensureMagiHome(paths);
    const config = loadConfig(paths, env);
    const setupSessionId = `setup-${Date.now()}`;
    const setupStore = SessionStore.open(paths);
    try {
      await triggerHooks({
        event: "setup",
        hooks: config.hooks,
        store: setupStore,
        sessionId: setupSessionId,
        cwd,
        env
      });
    } finally {
      setupStore.close();
    }

    const store = SessionStore.open(paths);
    try {
      const subcommand = parsed.rest[0] ?? "list";
      if (subcommand === "list") {
        const tasks = store.listAgentTasks(50);
        return {
          exitCode: 0,
          stdout:
            tasks.length === 0
              ? "No agent tasks\n"
              : `${tasks.map((task) => `${task.id}  ${task.role}  ${task.status}  ${task.prompt}`).join("\n")}\n`,
          stderr: ""
        };
      }
      if (subcommand === "spawn") {
        const role = readAgentRole(parsed.rest[1]);
        const prompt = parsed.rest.slice(2).join(" ");
        if (!prompt.trim()) {
          throw new MagiUsageError("magi agents spawn <explorer|worker> <prompt> requires prompt");
        }
        const sessionId = store.createSession({
          title: `agent task ${role}`,
          cwd,
          metadata: { command: "agents spawn", role }
        });
        const task = spawnAgentTask(store, {
          role,
          prompt,
          cwd,
          sessionId,
          writeFiles: parsed.writeFiles
        });
        await triggerHooks({
          event: "task_created",
          hooks: config.hooks,
          store,
          sessionId,
          cwd,
          env,
          context: {
            taskId: task.id,
            taskSubject: prompt,
            taskDescription: prompt,
            agentId: task.id,
            agentType: task.role
          }
        });
        return { exitCode: 0, stdout: `${JSON.stringify(task)}\n`, stderr: "" };
      }
      if (subcommand === "start") {
        const task = startAgentTask(store, requireArg(parsed.rest[1], "task id"));
        const sessionId =
          task.sessionId ?? store.createSession({ title: "cli agent start", cwd: task.cwd });
        await triggerHooks({
          event: "subagent_start",
          hooks: config.hooks,
          store,
          sessionId,
          cwd: task.cwd,
          env,
          context: {
            agentId: task.id,
            agentType: task.role,
            taskId: task.id,
            taskSubject: task.prompt
          }
        });
        return { exitCode: 0, stdout: `${JSON.stringify(task)}\n`, stderr: "" };
      }
      if (subcommand === "wait") {
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(waitAgentTask(store, requireArg(parsed.rest[1], "task id")))}\n`,
          stderr: ""
        };
      }
      if (subcommand === "cancel") {
        const task = cancelAgentTask(store, requireArg(parsed.rest[1], "task id"));
        const sessionId =
          task.sessionId ?? store.createSession({ title: "cli agent stop", cwd: task.cwd });
        await triggerHooks({
          event: "stop",
          hooks: config.hooks,
          store,
          sessionId,
          cwd: task.cwd,
          env,
          context: {
            message: `Agent task ${task.id} cancelled`,
            notificationType: "agent_task_cancelled",
            lastAssistantMessage: task.result ?? undefined
          }
        });
        await triggerHooks({
          event: "subagent_stop",
          hooks: config.hooks,
          store,
          sessionId,
          cwd: task.cwd,
          env,
          context: {
            agentId: task.id,
            agentType: task.role,
            taskId: task.id,
            taskSubject: task.prompt,
            message: `Agent task ${task.id} cancelled`,
            notificationType: "agent_task_cancelled"
          }
        });
        return { exitCode: 0, stdout: `${JSON.stringify(task)}\n`, stderr: "" };
      }
      if (subcommand === "complete") {
        const task = completeAgentTask(
          store,
          requireArg(parsed.rest[1], "task id"),
          parsed.rest.slice(2).join(" ")
        );
        const sessionId =
          task.sessionId ?? store.createSession({ title: "cli agent notification", cwd: task.cwd });
        await triggerHooks({
          event: "notification",
          hooks: config.hooks,
          store,
          sessionId,
          cwd: task.cwd,
          env,
          context: {
            message: `Agent task ${task.id} completed`,
            title: "Agent task completed",
            notificationType: "agent_task_completed",
            lastAssistantMessage: task.result ?? undefined
          }
        });
        await triggerHooks({
          event: "task_completed",
          hooks: config.hooks,
          store,
          sessionId,
          cwd: task.cwd,
          env,
          context: {
            taskId: task.id,
            taskSubject: task.prompt,
            taskDescription: task.prompt,
            agentId: task.id,
            agentType: task.role,
            lastAssistantMessage: task.result ?? undefined
          }
        });
        await triggerHooks({
          event: "subagent_stop",
          hooks: config.hooks,
          store,
          sessionId,
          cwd: task.cwd,
          env,
          context: {
            agentId: task.id,
            agentType: task.role,
            taskId: task.id,
            taskSubject: task.prompt,
            lastAssistantMessage: task.result ?? undefined
          }
        });
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(task)}\n`,
          stderr: ""
        };
      }
      throw new MagiUsageError(`Unknown agents command: ${subcommand}`);
    } finally {
      store.close();
    }
  }

  if (command === "runner") {
    const subcommand = parsed.rest[0] ?? "ping";
    const client = new RunnerClient({ command: resolveRunnerCommand(env), env });
    try {
      if (subcommand === "ping") {
        const initialized = await client.initialize();
        const ping = await client.ping();
        return {
          exitCode: 0,
          stdout: [
            `runner: ${initialized.runner}`,
            `version: ${initialized.version}`,
            `capabilities: ${initialized.capabilities.join(",")}`,
            `ok: ${ping.ok ? "true" : "false"}`,
            ""
          ].join("\n"),
          stderr: ""
        };
      }
      if (subcommand === "run") {
        const shellCommand = parsed.rest.slice(1).join(" ");
        if (!shellCommand.trim()) {
          throw new MagiUsageError("magi runner run requires a command");
        }
        const result = await client.runProcess({
          command: shellCommand,
          cwd,
          timeoutMs: parsed.runnerTimeoutMs
        });
        return {
          exitCode: result.timedOut ? 124 : (result.exitCode ?? 1),
          stdout: [
            `command: ${result.command}`,
            `cwd: ${result.cwd}`,
            `exitCode: ${result.exitCode ?? "null"}`,
            `timedOut: ${result.timedOut ? "true" : "false"}`,
            "stdout:",
            result.stdout,
            "stderr:",
            result.stderr
          ].join("\n"),
          stderr: ""
        };
      }
      if (subcommand === "pty-smoke") {
        const result = await client.ptySmoke();
        return {
          exitCode: result.ok ? 0 : 1,
          stdout: [
            `ok: ${result.ok ? "true" : "false"}`,
            "stdout:",
            result.stdout,
            "stderr:",
            result.stderr
          ].join("\n"),
          stderr: ""
        };
      }
      if (subcommand === "apply") {
        const filePath = parsed.rest[1];
        const content = parsed.rest.slice(2).join(" ");
        if (!filePath || !content) {
          throw new MagiUsageError("magi runner apply <file> <content> requires file and content");
        }
        if (!parsed.approve) {
          throw new MagiUsageError("magi runner apply requires --approve");
        }
        const paths = getMagiPaths(env);
        ensureMagiHome(paths);
        loadConfig(paths, env);
        const store = SessionStore.open(paths);
        try {
          const sessionId =
            parsed.sessionId ??
            store.createSession({
              title: `runner apply ${filePath}`,
              cwd,
              metadata: { command: "runner apply" }
            });
          const result = await client.applyPatch({
            cwd,
            filePath,
            content,
            approved: parsed.approve
          });
          store.recordAudit({
            sessionId,
            action: result.auditEvent.action,
            target: result.auditEvent.target ?? result.path,
            metadata: result.auditEvent.metadata
          });
          return {
            exitCode: 0,
            stdout: [
              `path: ${result.path}`,
              `approved: ${result.approved ? "true" : "false"}`,
              `sessionId: ${sessionId}`,
              "diff:",
              result.diff
            ].join("\n"),
            stderr: ""
          };
        } finally {
          store.close();
        }
      }
      throw new MagiUsageError(`Unknown runner command: ${subcommand}`);
    } finally {
      client.close();
    }
  }

  if (command === "peers") {
    const sub = parsed.rest[0];
    // peers add <name> <url> <device-id> <token>
    if (sub === "add") {
      const [, name, url, deviceId, token] = parsed.rest;
      if (!name || !url || !deviceId || !token) {
        throw new MagiUsageError("Usage: magi peers add <name> <url> <device-id> <token>");
      }
      const paths = getMagiPaths(env);
      ensureMagiHome(paths);
      const store = SessionStore.open(paths);
      try {
        store.upsertMcpOAuthToken({
          serverName: `peer:${name}`,
          accessToken: token,
          tokenType: "Bearer",
          authServerUrl: url,
          metadata: { deviceId, peerUrl: url }
        });
        return {
          exitCode: 0,
          stdout: `Saved peer credentials for "${name}" (${url}).\nUse it as a target: Agent({target: "${name}"})\n`,
          stderr: ""
        };
      } finally {
        store.close();
      }
    }
    if (sub === "remove" || sub === "rm") {
      const name = parsed.rest[1];
      if (!name) throw new MagiUsageError("Usage: magi peers remove <name>");
      const paths = getMagiPaths(env);
      ensureMagiHome(paths);
      const store = SessionStore.open(paths);
      try {
        store.deleteMcpOAuthToken(`peer:${name}`);
        return { exitCode: 0, stdout: `Removed peer credentials for "${name}".\n`, stderr: "" };
      } finally {
        store.close();
      }
    }
    if (sub === "saved") {
      const paths = getMagiPaths(env);
      ensureMagiHome(paths);
      const store = SessionStore.open(paths);
      try {
        const tokens = store.listMcpOAuthTokens().filter((t) => t.serverName.startsWith("peer:"));
        if (tokens.length === 0) {
          return {
            exitCode: 0,
            stdout:
              "No saved peers.\nUse 'magi peers add <name> <url> <device-id> <token>' to register one.\n",
            stderr: ""
          };
        }
        const lines = ["Saved peers:", ""];
        for (const t of tokens) {
          const name = t.serverName.replace(/^peer:/, "");
          const url = (t.metadata as Record<string, unknown>)?.peerUrl ?? t.authServerUrl ?? "?";
          lines.push(`  ${name.padEnd(24)} ${url}`);
        }
        return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
      } finally {
        store.close();
      }
    }
    // Default: discover via mDNS
    const { browseMdns } = await import("./control/mdns.js");
    const handle = browseMdns({});
    const waitMs = sub === "list" ? Number(parsed.rest[1]) || 2500 : Number(sub) || 2500;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const peers = handle.peers();
    handle.stop();
    if (peers.length === 0) {
      return {
        exitCode: 0,
        stdout:
          [
            "No Magi peers discovered on the LAN.",
            "",
            `Scanned for ${waitMs}ms via mDNS (_magi._tcp.local.).`,
            "Make sure other daemons are running with mDNS enabled.",
            "Set MAGI_DISABLE_MDNS=1 to disable advertisement on this host.",
            "",
            "To register a peer manually with credentials:",
            "  magi peers add <name> <url> <device-id> <token>"
          ].join("\n") + "\n",
        stderr: ""
      };
    }
    const lines = [`Discovered ${peers.length} Magi peer(s):`, ""];
    for (const peer of peers) {
      lines.push(`  ${peer.instanceName}`);
      lines.push(`    Host:    ${peer.hostname}`);
      lines.push(`    Address: ${peer.address}:${peer.port}`);
      if (Object.keys(peer.txt).length > 0) {
        lines.push(
          `    Info:    ${Object.entries(peer.txt)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")}`
        );
      }
      lines.push("");
    }
    lines.push(
      "Use 'magi peers add <name> <url> <device-id> <token>' to save credentials for cross-machine dispatch."
    );
    return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
  }

  if (command === "ps") {
    const paths = getMagiPaths(env);
    ensureMagiHome(paths);
    const limit = Number(parsed.rest[0]) || 30;
    const store = SessionStore.open(paths);
    try {
      const jobs = store.listJobs(limit);
      if (jobs.length === 0) {
        return { exitCode: 0, stdout: "No jobs found.\n", stderr: "" };
      }
      const lines = ["Recent jobs (newest first):", ""];
      lines.push(
        `  ${"ID".padEnd(38)} ${"Status".padEnd(11)} ${"Kind".padEnd(16)} ${"Created".padEnd(20)} Title`
      );
      for (const job of jobs) {
        const meta = (job.metadata ?? {}) as Record<string, unknown>;
        const desc =
          typeof meta.description === "string"
            ? meta.description
            : typeof meta.title === "string"
              ? meta.title
              : "";
        const created = job.createdAt.replace("T", " ").slice(0, 19);
        lines.push(
          `  ${job.id.padEnd(38)} ${job.status.padEnd(11)} ${job.kind.padEnd(16)} ${created.padEnd(20)} ${desc}`
        );
      }
      lines.push("");
      lines.push("Use 'magi logs <id>' for events, 'magi kill <id>' to cancel a running job.");
      return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
    } finally {
      store.close();
    }
  }

  if (command === "logs") {
    const jobId = parsed.rest[0];
    if (!jobId) {
      throw new MagiUsageError("Usage: magi logs <job-id> [tail-count]");
    }
    const tail = Number(parsed.rest[1]) || 100;
    const paths = getMagiPaths(env);
    ensureMagiHome(paths);
    const store = SessionStore.open(paths);
    try {
      const job = store.getJob(jobId);
      if (!job) {
        return { exitCode: 0, stdout: `Job not found: ${jobId}\n`, stderr: "" };
      }
      const events = store.listAuditEvents(2000).filter((e) => e.jobId === jobId);
      const lines = [
        `Job: ${job.id}`,
        `Status: ${job.status}    Kind: ${job.kind}    Session: ${job.sessionId}`,
        `Created: ${job.createdAt}`
      ];
      if (job.updatedAt) lines.push(`Updated: ${job.updatedAt}`);
      const meta = (job.metadata ?? {}) as Record<string, unknown>;
      if (typeof meta.error === "string") lines.push(`Error: ${meta.error}`);
      if (typeof meta.result === "string") {
        const r = meta.result.length > 400 ? meta.result.slice(0, 400) + "..." : meta.result;
        lines.push("", "Result:", r);
      }
      lines.push("", `Events (${events.length}):`);
      const slice = events.slice(0, tail).reverse();
      for (const event of slice) {
        const time = event.createdAt.slice(11, 19);
        const target = event.target ? ` ${event.target}` : "";
        lines.push(`  ${time}  ${event.action}${target}`);
      }
      return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
    } finally {
      store.close();
    }
  }

  if (command === "kill") {
    const jobId = parsed.rest[0];
    if (!jobId) {
      throw new MagiUsageError("Usage: magi kill <job-id>");
    }
    const paths = getMagiPaths(env);
    ensureMagiHome(paths);
    const status = getDaemonStatus(paths);
    if (!status.running) {
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          "Magi daemon is not running. Only running jobs can be cancelled.\nStart it with: magi daemon start\n"
      };
    }
    const reason = parsed.rest.slice(1).join(" ").trim() || "cancelled by user";
    const url = `http://${status.bind ?? "127.0.0.1"}:${status.port}/jobs/${encodeURIComponent(jobId)}/cancel`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason })
      });
      if (!response.ok) {
        const text = await response.text();
        return {
          exitCode: 1,
          stdout: "",
          stderr: `Daemon rejected cancel (${response.status}): ${text}\n`
        };
      }
      return { exitCode: 0, stdout: `Cancelled job ${jobId}\n`, stderr: "" };
    } catch (error) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Failed to reach daemon: ${error instanceof Error ? error.message : String(error)}\n`
      };
    }
  }

  if (command === "tutorial") {
    const { runTutorial } = await import("./commands/tutorial.js");
    await runTutorial();
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  if (command === "init") {
    const paths = getMagiPaths(env);
    ensureMagiHome(paths);
    const { runInit } = await import("./commands/init.js");
    const presetArg = parsed.rest[0];
    const preset =
      presetArg === "anthropic" || presetArg === "openai" || presetArg === "deepseek"
        ? presetArg
        : undefined;
    const nonInteractive = parsed.rest.includes("--non-interactive") || parsed.rest.includes("-y");
    const result = await runInit({ paths, env, preset, nonInteractive });
    if (!result.wrote && result.reason) {
      return { exitCode: 0, stdout: `${result.reason}\n`, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  if (command === "pair") {
    const paths = getMagiPaths(env);
    ensureMagiHome(paths);
    const status = getDaemonStatus(paths);
    if (!status.running) {
      throw new MagiUsageError("Magi daemon is not running. Start it first: magi daemon start");
    }
    const deviceName = parsed.rest[0] ?? `device-${Date.now().toString(36)}`;
    const url = `http://${status.bind ?? "127.0.0.1"}:${status.port ?? 8765}/pairing`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: deviceName })
    });
    if (!response.ok) {
      throw new MagiUsageError(
        `Pairing request failed (${response.status}): ${await response.text()}`
      );
    }
    const token = (await response.json()) as { deviceId: string; token: string; expiresAt: string };
    // Build the connection URL (works for phone) — replace bind with actual LAN IP if needed
    const { networkInterfaces } = await import("node:os");
    const ifaces = networkInterfaces();
    const lanIps: string[] = [];
    for (const list of Object.values(ifaces)) {
      for (const iface of list ?? []) {
        if (iface.family === "IPv4" && !iface.internal) {
          lanIps.push(iface.address);
        }
      }
    }
    const port = status.port ?? 8765;
    const localPairingUrl = buildPanelPairingUrl("127.0.0.1", port, token.deviceId, token.token);
    const isLanReachableBind = status.bind === "0.0.0.0" || status.bind === "::";
    const lanPairingUrls = isLanReachableBind
      ? lanIps.map((ip) => buildPanelPairingUrl(ip, port, token.deviceId, token.token))
      : [];
    const primaryPairingUrl = lanPairingUrls[0] ?? localPairingUrl;
    let qrCode = "";
    qrcodeTerminal.generate(primaryPairingUrl, { small: true }, (rendered) => {
      qrCode = rendered;
    });
    const lines = [
      `Pairing token created for "${deviceName}".`,
      "",
      `Device ID:  ${token.deviceId}`,
      `Token:      ${token.token}`,
      `Expires:    ${token.expiresAt}`,
      "",
      "Scan this QR code or open the pairing URL to connect the panel automatically:",
      qrCode.trimEnd(),
      "",
      `Pairing URL: ${primaryPairingUrl}`,
      "",
      "Use these on the client side. Set headers on every request:",
      "  X-Magi-Device-Id: <device-id>",
      "  Authorization: Bearer <token>",
      ""
    ];
    if (isLanReachableBind && lanPairingUrls.length > 0) {
      lines.push("Open the panel on your phone (paired automatically):");
      for (const url of lanPairingUrls) lines.push(`  ${url}`);
      lines.push("");
    }
    lines.push(`Local:     ${localPairingUrl}`);
    lines.push("");
    if (status.bind !== "0.0.0.0" && status.bind !== "::") {
      lines.push(
        "To allow LAN access (for phone), restart the daemon with MAGI_CONTROL_BIND=0.0.0.0:"
      );
      lines.push("  magi daemon stop && MAGI_CONTROL_BIND=0.0.0.0 magi daemon start");
    }
    return { exitCode: 0, stdout: lines.join("\n") + "\n", stderr: "" };
  }

  if (command === "daemon") {
    const sub = parsed.rest[0] ?? "status";
    const paths = getMagiPaths(env);
    ensureMagiHome(paths);
    if (sub === "start") {
      const status = getDaemonStatus(paths);
      if (status.running) {
        return {
          exitCode: 0,
          stdout: `Magi daemon is already running (pid ${status.pid}, ${status.bind}:${status.port}).\nLog: ${status.logFile}\n`,
          stderr: ""
        };
      }
      const binPath = process.argv[1];
      const result = startDaemon(paths, { binPath, env });
      return {
        exitCode: 0,
        stdout:
          [
            `Magi daemon started (pid ${result.pid}).`,
            `Log: ${result.logFile}`,
            `PID: ${result.pidFile}`,
            `Use 'magi daemon status' to verify, 'magi daemon stop' to stop.`
          ].join("\n") + "\n",
        stderr: ""
      };
    }
    if (sub === "stop") {
      const result = stopDaemon(paths);
      if (!result.stopped) {
        return { exitCode: 0, stdout: "Magi daemon is not running.\n", stderr: "" };
      }
      return { exitCode: 0, stdout: `Stopped Magi daemon (pid ${result.pid}).\n`, stderr: "" };
    }
    if (sub === "status") {
      const status = getDaemonStatus(paths);
      if (!status.running) {
        return {
          exitCode: 0,
          stdout:
            [
              "Magi daemon is not running.",
              `PID file: ${status.pidFile}`,
              `Log file: ${status.logFile}`,
              "Use 'magi daemon start' to start it."
            ].join("\n") + "\n",
          stderr: ""
        };
      }
      return {
        exitCode: 0,
        stdout:
          [
            `Magi daemon is running (pid ${status.pid}).`,
            `Address: ${status.bind ?? "?"}:${status.port ?? "?"}`,
            `Started: ${status.startedAt ?? "?"}`,
            `Log: ${status.logFile}`
          ].join("\n") + "\n",
        stderr: ""
      };
    }
    if (sub === "restart") {
      stopDaemon(paths);
      // Wait briefly for the process to terminate
      await new Promise((resolve) => setTimeout(resolve, 200));
      const binPath = process.argv[1];
      const result = startDaemon(paths, { binPath, env });
      return {
        exitCode: 0,
        stdout: `Restarted Magi daemon (pid ${result.pid}).\n`,
        stderr: ""
      };
    }
    if (sub === "logs") {
      const status = getDaemonStatus(paths);
      const { readFileSync, existsSync } = await import("node:fs");
      if (!existsSync(status.logFile)) {
        return { exitCode: 0, stdout: "No daemon logs yet.\n", stderr: "" };
      }
      const tail = parsed.rest[1] ? Number(parsed.rest[1]) : 50;
      const content = readFileSync(status.logFile, "utf8");
      const lines = content.split("\n");
      const lastN = lines.slice(-tail).join("\n");
      return { exitCode: 0, stdout: lastN.endsWith("\n") ? lastN : lastN + "\n", stderr: "" };
    }
    throw new MagiUsageError(
      `Unknown daemon subcommand: ${sub}. Use start/stop/restart/status/logs.`
    );
  }

  if (command === "serve") {
    const paths = getMagiPaths(env);
    ensureMagiHome(paths);
    const runtime = getRuntimeSettings(env);
    const config = loadConfig(paths, env);
    const setupSessionId = `setup-${Date.now()}`;
    const setupStore = SessionStore.open(paths);
    try {
      await triggerHooks({
        event: "setup",
        hooks: config.hooks,
        store: setupStore,
        sessionId: setupSessionId,
        cwd,
        env
      });
    } finally {
      setupStore.close();
    }

    const store = SessionStore.open(paths);
    const handle = await startControlServer({ paths, runtime, config, store, cwd, env });
    // If running as a daemon, write the real PID file with the bound port
    let daemonLogger: Logger | undefined;
    if (env?.MAGI_DAEMON === "1") {
      const portMatch = /:(\d+)$/.exec(handle.url);
      const boundPort = portMatch ? Number(portMatch[1]) : runtime.controlPort;
      writeDaemonPidFile(paths, {
        pid: process.pid,
        port: boundPort,
        bind: runtime.controlBind
      });
      // Structured JSON log for the daemon process
      const logLevel = (env.MAGI_LOG_LEVEL as LogLevel | undefined) ?? "info";
      daemonLogger = createJsonLogger({
        filePath: path.join(paths.logsRoot, "magi-daemon.log"),
        level: logLevel
      });
      daemonLogger.info("daemon started", {
        pid: process.pid,
        port: boundPort,
        bind: runtime.controlBind,
        url: handle.url,
        version: VERSION
      });
      // Cleanup PID file and logger on graceful shutdown
      const cleanup = () => {
        try {
          daemonLogger?.info("daemon stopping", { pid: process.pid });
        } catch {}
        clearDaemonPidFile(paths);
        try {
          daemonLogger?.close();
        } catch {}
      };
      process.on("SIGTERM", cleanup);
      process.on("SIGINT", cleanup);
      process.on("exit", cleanup);
    }
    if (isMain(import.meta.url, process.argv[1])) {
      process.stdout.write(`Magi Control API listening on ${handle.url}\n`);
      await waitForShutdown();
      await handle.close();
      store.close();
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    // Non-main invocation: close resources to prevent leaks
    await handle.close();
    store.close();
    return { exitCode: 0, stdout: `Magi Control API listening on ${handle.url}\n`, stderr: "" };
  }

  throw new MagiUsageError(`Unknown magi command: ${command}`);
}

function buildPanelPairingUrl(host: string, port: number, deviceId: string, token: string): string {
  const url = new URL(`http://${host}:${port}/panel`);
  url.searchParams.set("device", deviceId);
  url.searchParams.set("token", token);
  return url.toString();
}

function formatStreamJson(result: Awaited<ReturnType<typeof runHeadlessPrompt>>): string {
  const lines = [
    JSON.stringify({
      type: "session.started",
      sessionId: result.sessionId,
      jobId: result.jobId,
      provider: result.provider,
      model: result.model
    }),
    ...(result.events ?? []).map((event) => JSON.stringify({ type: `agent.${event.type}`, event })),
    JSON.stringify({
      type: "session.completed",
      sessionId: result.sessionId,
      jobId: result.jobId,
      message: result.message,
      provider: result.provider,
      model: result.model
    })
  ];
  return `${lines.join("\n")}\n`;
}

function helpText(): string {
  return [
    "Magi Next clean-room CLI",
    "",
    "Usage:",
    "  magi --version",
    "  magi doctor",
    "  magi config",
    "  magi --model <alias-or-model> -p <prompt>",
    "  magi --permission-mode <default|acceptEdits|bypassPermissions|plan> -p <prompt>",
    "  magi --output-format json -p <prompt>",
    "  magi -c -p <prompt>",
    "  magi -p <prompt>",
    "  magi sessions",
    "  magi resume <session-id>",
    "  magi goal [objective] [--session-id <id>]",
    "  magi plan [list|all|show <id>|chain <id>|adopt <id>] [--session-id <id>]",
    "  magi context [session-id]",
    "  magi compact [session-id]",
    "  magi rules",
    "  magi workspace diagnose [path]",
    "  magi memory view [user|project|session] [--session-id <id>]",
    "  magi memory search <query> [--session-id <id>]",
    "  magi memory link --from <node> --to <node> [--relation <rel>] [--weight <0..1>]",
    "  magi memory correct --target <node|query> --reason <text> [--replacement <text>]",
    "  magi memory feedback --target <node|query> --signal <useful|irrelevant|wrong|stale> [--reason <text>] [--replacement <text>]",
    "  magi memory feedback trends [--limit <n>] [--min-events <n>]",
    "  magi memory conflicts [--groups] [--limit <n>]",
    "  magi memory merges [--limit <n>]",
    "  magi memory eval --case-file <file> [--max-results <n>] [--min-score <0..1>] [--report <file>]",
    "  magi memory maintain [--apply] [--older-than-days <n>] [--decay <0..1>] [--min-weight <0..1>]",
    "  magi memory maintain config [--older-than-days <n>] [--decay <0..1>] [--min-weight <0..1>] [--limit <n>]",
    "  magi memory append <user|project|session> <text> [--session-id <id>]",
    "  magi learning list",
    "  magi learning draft <show|apply|reject> <id>",
    "  magi mcp list [server]",
    "  magi mcp resources <server>",
    "  magi mcp read-resource <server> <uri>",
    "  magi plugins",
    "  magi marketplace",
    "  magi skills list",
    "  magi skills show <name>",
    "  magi agents list",
    "  magi agents spawn <explorer|worker> <prompt>",
    "  magi runner ping",
    "  magi runner run <command>",
    "  magi runner pty-smoke",
    "  magi runner apply <file> <content> --approve",
    "  magi serve",
    ""
  ].join("\n");
}

function knownCommands(): Set<string> {
  return new Set([
    "help",
    "--help",
    "-h",
    "--version",
    "-v",
    "-p",
    "--prompt",
    "--print",
    "doctor",
    "config",
    "sessions",
    "resume",
    "context",
    "compact",
    "rules",
    "goal",
    "workspace",
    "memory",
    "learning",
    "learn",
    "mcp",
    "plugins",
    "marketplace",
    "skills",
    "agents",
    "runner",
    "serve",
    "daemon",
    "pair",
    "peers",
    "ps",
    "logs",
    "kill",
    "plan",
    "init",
    "tutorial",
    "-r",
    "--resume"
  ]);
}

function parseMemoryLinkArgs(args: string[]): {
  from: string;
  to: string;
  relation?: string;
  weight?: number;
} {
  let from = "";
  let to = "";
  let relation: string | undefined;
  let weight: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--from") {
      from = args[++index] ?? "";
      continue;
    }
    if (arg === "--to") {
      to = args[++index] ?? "";
      continue;
    }
    if (arg === "--relation") {
      relation = args[++index] ?? "";
      continue;
    }
    if (arg === "--weight") {
      const value = Number(args[++index]);
      if (!Number.isFinite(value)) {
        throw new MagiUsageError("magi memory link --weight must be a number between 0 and 1");
      }
      weight = value;
      continue;
    }
    throw new MagiUsageError(`Unknown magi memory link option: ${arg}`);
  }
  if (!from || !to) {
    throw new MagiUsageError("magi memory link requires --from <node> and --to <node>");
  }
  return { from, to, relation, weight };
}

function parseMemoryCorrectArgs(args: string[]): {
  target: string;
  reason: string;
  replacement?: string;
  replacementTitle?: string;
  replacementSummary?: string;
  replacementType?: import("./memory-node-store.js").MemoryNodeType;
} {
  let target = "";
  let reason = "";
  let replacement: string | undefined;
  let replacementTitle: string | undefined;
  let replacementSummary: string | undefined;
  let replacementType: import("./memory-node-store.js").MemoryNodeType | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--target") {
      target = args[++index] ?? "";
      continue;
    }
    if (arg === "--reason") {
      reason = args[++index] ?? "";
      continue;
    }
    if (arg === "--replacement") {
      replacement = args[++index] ?? "";
      continue;
    }
    if (arg === "--replacement-title") {
      replacementTitle = args[++index] ?? "";
      continue;
    }
    if (arg === "--replacement-summary") {
      replacementSummary = args[++index] ?? "";
      continue;
    }
    if (arg === "--type") {
      const value = args[++index] ?? "";
      if (!isMemoryNodeType(value)) {
        throw new MagiUsageError(`Invalid memory correction --type: ${value}`);
      }
      replacementType = value;
      continue;
    }
    throw new MagiUsageError(`Unknown magi memory correct option: ${arg}`);
  }
  if (!target || !reason) {
    throw new MagiUsageError(
      "magi memory correct requires --target <node|query> and --reason <text>"
    );
  }
  return { target, reason, replacement, replacementTitle, replacementSummary, replacementType };
}

function parseMemoryFeedbackArgs(args: string[]): {
  target: string;
  signal: import("./memory-node-store.js").MemoryFeedbackSignal;
  reason?: string;
  replacement?: string;
  replacementTitle?: string;
  replacementSummary?: string;
  replacementType?: import("./memory-node-store.js").MemoryNodeType;
} {
  let target = "";
  let signal: import("./memory-node-store.js").MemoryFeedbackSignal | undefined;
  let reason: string | undefined;
  let replacement: string | undefined;
  let replacementTitle: string | undefined;
  let replacementSummary: string | undefined;
  let replacementType: import("./memory-node-store.js").MemoryNodeType | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--target") {
      target = args[++index] ?? "";
      continue;
    }
    if (arg === "--signal") {
      signal = readMemoryFeedbackSignal(args[++index]);
      continue;
    }
    if (arg === "--reason") {
      reason = args[++index] ?? "";
      continue;
    }
    if (arg === "--replacement") {
      replacement = args[++index] ?? "";
      continue;
    }
    if (arg === "--replacement-title") {
      replacementTitle = args[++index] ?? "";
      continue;
    }
    if (arg === "--replacement-summary") {
      replacementSummary = args[++index] ?? "";
      continue;
    }
    if (arg === "--type") {
      const value = args[++index] ?? "";
      if (!isMemoryNodeType(value)) {
        throw new MagiUsageError(`Invalid memory feedback --type: ${value}`);
      }
      replacementType = value;
      continue;
    }
    throw new MagiUsageError(`Unknown magi memory feedback option: ${arg}`);
  }
  if (!target || !signal) {
    throw new MagiUsageError(
      "magi memory feedback requires --target <node|query> and --signal <useful|irrelevant|wrong|stale>"
    );
  }
  return {
    target,
    signal,
    reason,
    replacement,
    replacementTitle,
    replacementSummary,
    replacementType
  };
}

function parseMemoryFeedbackTrendsArgs(args: string[]): { limit?: number; minEvents?: number } {
  let limit: number | undefined;
  let minEvents: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--limit") {
      limit = readPositiveNumberArg(args[++index], "magi memory feedback trends --limit");
      continue;
    }
    if (arg === "--min-events") {
      minEvents = readPositiveNumberArg(args[++index], "magi memory feedback trends --min-events");
      continue;
    }
    throw new MagiUsageError(`Unknown magi memory feedback trends option: ${arg}`);
  }
  return { limit, minEvents };
}

function parseMemoryConflictsArgs(args: string[]): { groups?: boolean; limit?: number } {
  let groups = false;
  let limit: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--groups" || arg === "--grouped") {
      groups = true;
      continue;
    }
    if (arg === "--limit") {
      limit = readPositiveNumberArg(args[++index], "magi memory conflicts --limit");
      continue;
    }
    throw new MagiUsageError(`Unknown magi memory conflicts option: ${arg}`);
  }
  return { groups, limit };
}

function parseMemoryMergesArgs(args: string[]): { limit?: number } {
  let limit: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--limit") {
      limit = readPositiveNumberArg(args[++index], "magi memory merges --limit");
      continue;
    }
    throw new MagiUsageError(`Unknown magi memory merges option: ${arg}`);
  }
  return { limit };
}

function parseMemoryEvalArgs(args: string[]): {
  caseFile: string;
  maxResults?: number;
  minScore?: number;
  reportFile?: string;
} {
  let caseFile = "";
  let maxResults: number | undefined;
  let minScore: number | undefined;
  let reportFile: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--case-file") {
      caseFile = args[++index] ?? "";
      continue;
    }
    if (arg === "--max-results") {
      maxResults = readPositiveNumberArg(args[++index], "magi memory eval --max-results");
      continue;
    }
    if (arg === "--min-score") {
      minScore = readUnitNumberArg(args[++index], "magi memory eval --min-score");
      continue;
    }
    if (arg === "--report") {
      reportFile = args[++index] ?? "";
      continue;
    }
    throw new MagiUsageError(`Unknown magi memory eval option: ${arg}`);
  }
  if (!caseFile) {
    throw new MagiUsageError("magi memory eval requires --case-file <file>");
  }
  return { caseFile, maxResults, minScore, reportFile };
}

function parseMemoryMaintainArgs(args: string[]): {
  apply?: boolean;
  olderThanDays?: number;
  decay?: number;
  minWeight?: number;
  limit?: number;
} {
  let apply = false;
  let olderThanDays: number | undefined;
  let decay: number | undefined;
  let minWeight: number | undefined;
  let limit: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--older-than-days") {
      olderThanDays = readPositiveNumberArg(
        args[++index],
        "magi memory maintain --older-than-days"
      );
      continue;
    }
    if (arg === "--decay") {
      decay = readUnitNumberArg(args[++index], "magi memory maintain --decay");
      continue;
    }
    if (arg === "--min-weight") {
      minWeight = readUnitNumberArg(args[++index], "magi memory maintain --min-weight");
      continue;
    }
    if (arg === "--limit") {
      limit = readPositiveNumberArg(args[++index], "magi memory maintain --limit");
      continue;
    }
    throw new MagiUsageError(`Unknown magi memory maintain option: ${arg}`);
  }
  return { apply, olderThanDays, decay, minWeight, limit };
}

function parseMemoryMaintainConfigArgs(args: string[]): {
  olderThanDays?: number;
  decay?: number;
  minWeight?: number;
  limit?: number;
} {
  const options = parseMemoryMaintainArgs(args);
  if (options.apply) {
    throw new MagiUsageError("magi memory maintain config does not accept --apply");
  }
  return {
    olderThanDays: options.olderThanDays,
    decay: options.decay,
    minWeight: options.minWeight,
    limit: options.limit
  };
}

function readPositiveNumberArg(value: string | undefined, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new MagiUsageError(`${label} must be a non-negative number`);
  }
  return number;
}

function readUnitNumberArg(value: string | undefined, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new MagiUsageError(`${label} must be a number between 0 and 1`);
  }
  return number;
}

function isMemoryNodeType(value: string): value is import("./memory-node-store.js").MemoryNodeType {
  return (
    value === "user_profile" ||
    value === "preference" ||
    value === "work_habit" ||
    value === "workflow" ||
    value === "project" ||
    value === "decision" ||
    value === "problem" ||
    value === "reference" ||
    value === "skill_ref" ||
    value === "session"
  );
}

function readMemoryFeedbackSignal(
  value: string | undefined
): import("./memory-node-store.js").MemoryFeedbackSignal {
  if (value === "useful" || value === "irrelevant" || value === "wrong" || value === "stale") {
    return value;
  }
  throw new MagiUsageError(`Invalid memory feedback --signal: ${value ?? ""}`);
}

interface ParsedArgs {
  command: string | undefined;
  rest: string[];
  prompt?: string;
  modelAlias?: string;
  outputFormat?: "text" | "json" | "stream-json";
  continueSession: boolean;
  resumeSessionId?: string;
  sessionId?: string;
  sessionName?: string;
  persistSession: boolean;
  writeFiles: string[];
  runnerTimeoutMs?: number;
  approve: boolean;
  permissionMode?: ToolPermissionMode;
}

function parseArgs(argv: string[]): ParsedArgs {
  const rest: string[] = [];
  let command: string | undefined;
  let prompt: string | undefined;
  let modelAlias: string | undefined;
  let outputFormat: "text" | "json" | "stream-json" = "text";
  let continueSession = false;
  let resumeSessionId: string | undefined;
  let sessionId: string | undefined;
  let sessionName: string | undefined;
  let persistSession = true;
  const writeFiles: string[] = [];
  let runnerTimeoutMs: number | undefined;
  let approve = false;
  let permissionMode: ToolPermissionMode | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-p" || arg === "--print" || arg === "--prompt") {
      command = "-p";
      prompt = argv[++index];
      continue;
    }
    if (arg === "--model") {
      modelAlias = argv[++index];
      continue;
    }
    if (arg === "--output-format") {
      const value = argv[++index];
      if (value !== "text" && value !== "json" && value !== "stream-json") {
        throw new MagiUsageError("--output-format must be text, json, or stream-json");
      }
      outputFormat = value;
      continue;
    }
    if (arg === "-c" || arg === "--continue") {
      continueSession = true;
      continue;
    }
    if (arg === "-r" || arg === "--resume") {
      command = arg;
      const next = argv[index + 1];
      if (next && !next.startsWith("-")) {
        resumeSessionId = argv[++index];
      }
      continue;
    }
    if (arg === "--session-id") {
      sessionId = argv[++index];
      continue;
    }
    if (arg === "-n" || arg === "--name") {
      sessionName = argv[++index];
      continue;
    }
    if (arg === "--no-session-persistence") {
      persistSession = false;
      continue;
    }
    if (arg === "--write-file") {
      writeFiles.push(argv[++index]);
      continue;
    }
    if (arg === "--timeout-ms") {
      runnerTimeoutMs = readPositiveInteger(argv[++index], "--timeout-ms");
      continue;
    }
    if (arg === "--no-color") {
      // Handled at the start of runCliUnsafe; ignore here (don't push to rest).
      continue;
    }
    if (arg === "--approve") {
      approve = true;
      continue;
    }
    if (arg === "--permission-mode") {
      const value = argv[++index];
      const parsedMode = parsePermissionMode(value);
      if (!parsedMode) {
        throw new MagiUsageError(
          "--permission-mode must be default, acceptEdits, bypassPermissions, or plan"
        );
      }
      permissionMode = parsedMode;
      continue;
    }
    if (!command) {
      command = arg;
    } else {
      rest.push(arg);
    }
  }

  return {
    command,
    rest,
    prompt,
    modelAlias,
    outputFormat,
    continueSession,
    resumeSessionId,
    sessionId,
    sessionName,
    persistSession,
    writeFiles,
    runnerTimeoutMs,
    approve,
    permissionMode
  };
}

function readPositiveInteger(value: string | undefined, label: string): number {
  if (!value || !/^\d+$/.test(value)) {
    throw new MagiUsageError(`${label} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new MagiUsageError(`${label} must be a positive integer`);
  }
  return parsed;
}

function readAgentRole(value: string | undefined): AgentRole {
  if (value === "explorer" || value === "worker") {
    return value;
  }
  throw new MagiUsageError("agent role must be explorer or worker");
}

function requireArg(value: string | undefined, label: string): string {
  if (!value) {
    throw new MagiUsageError(`Missing ${label}`);
  }
  return value;
}

function resolveSessionForCommand(store: SessionStore, sessionId: string | undefined, cwd: string) {
  if (sessionId) {
    const session = store.getSession(sessionId);
    if (!session) {
      throw new MagiUsageError(`Session not found: ${sessionId}`);
    }
    return session;
  }
  const session = store.getMostRecentSession(cwd) ?? store.getMostRecentSession();
  if (!session) {
    throw new MagiUsageError("No sessions found");
  }
  return session;
}

function resolveGoalSessionForCommand(input: {
  store: SessionStore;
  sessionId: string | undefined;
  cwd: string;
  create: boolean;
  title: string;
  optional?: boolean;
}) {
  if (input.sessionId) {
    const session = input.store.getSession(input.sessionId);
    if (!session) {
      throw new MagiUsageError(`Session not found: ${input.sessionId}`);
    }
    return session;
  }
  const session = input.store.getMostRecentSession(input.cwd) ?? input.store.getMostRecentSession();
  if (session) return session;
  if (input.create) {
    const id = input.store.createSession({
      title: input.title,
      cwd: input.cwd,
      metadata: { mode: "goal", command: "goal" }
    });
    const created = input.store.getSession(id);
    if (created) return created;
  }
  if (input.optional) {
    return undefined;
  }
  throw new MagiUsageError("No sessions found");
}

function resolvePlanSessionForCommand(input: {
  store: SessionStore;
  sessionId: string | undefined;
  cwd: string;
  optional?: boolean;
}) {
  if (input.sessionId) {
    const session = input.store.getSession(input.sessionId);
    if (!session) {
      throw new MagiUsageError(`Session not found: ${input.sessionId}`);
    }
    return session;
  }
  const session = input.store.getMostRecentSession(input.cwd) ?? input.store.getMostRecentSession();
  if (session || input.optional) return session;
  throw new MagiUsageError("No sessions found");
}

function resolveCompactionModelRunner(
  config: ReturnType<typeof loadConfig>,
  env: NodeJS.ProcessEnv,
  alias: string
) {
  const registry = buildProviderRegistry({ config, env });
  const resolved = resolveModelAlias(config, alias);
  const adapter = registry.get(resolved.providerName);
  if (!adapter) {
    throw new MagiUsageError(
      `Provider ${resolved.providerName} is not configured for compaction model ${JSON.stringify(alias)}`
    );
  }
  return {
    adapter,
    model: resolved.model,
    providerName: resolved.providerName
  };
}

function readMemoryScope(value: string | undefined): MemoryScope {
  if (value === "user" || value === "project" || value === "session") {
    return value;
  }
  if (value === undefined) {
    return "project";
  }
  throw new MagiUsageError("memory scope must be user, project, or session");
}

function memoryScopeTargetFile(scope: MemoryScope): string {
  if (scope === "user") return "user.md";
  if (scope === "session") return "sessions/README.md";
  return "projects/default.md";
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => resolve();
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

if (isMain(import.meta.url, process.argv[1])) {
  const result = await runCli(process.argv.slice(2));
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.exitCode = result.exitCode;
}

function isMain(moduleUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) {
    return false;
  }
  return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
}
