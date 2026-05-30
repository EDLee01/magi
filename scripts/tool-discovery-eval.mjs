#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");
const reportPath =
  process.env.MAGI_TOOL_DISCOVERY_EVAL_REPORT ??
  path.join(repoRoot, ".magi-reports", "tool-discovery-eval.json");
const startedAt = new Date();

const root = process.env.MAGI_KEEP_TOOL_DISCOVERY_EVAL_TMP
  ? mkdtempSync(path.join(os.tmpdir(), "magi-tool-discovery-eval-keep-"))
  : mkdtempSync(path.join(os.tmpdir(), "magi-tool-discovery-eval-"));
const configDir = path.join(root, "config");
const workDir = path.join(root, "work");

let harnessReport;

try {
  assert(existsSync(cliPath), "dist/cli.js does not exist. Run npm run build first.");
  harnessReport = await import("../dist/harness-report.js");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  const state = {
    coreToolsExposed: false,
    deferredToolsHidden: false,
    fileEditIntentRankedFilePatch: false,
    browserAutomationRankedBrowser: false,
    learningDraftRevealed: false,
    feedbackResultsReturned: false,
    feedbackRankingUsedUsage: false,
    intentScopedUsageRecorded: false,
    failureKindRecorded: false,
    failureKindShownInRanking: false,
    failureRecoverySuggested: false,
    crossTaskRecoveryRankingSeen: false,
    crossTaskRecoveryGuidanceSeen: false,
    crossTaskIntentScopedRankingSeen: false,
    crossTaskUnrelatedIntentIsolated: false,
    longCycleWorkspaceNoiseInjected: false,
    longCycleRepeatedWorkspaceStable: false,
    longCycleRepeatedBrowserStable: false,
    longCycleRepeatedFileEditStable: false,
    longCycleRepeatedMemoryCorrectStable: false,
    longCycleRepeatedMemoryRecallStable: false,
    longCycleRepeatedSkillStable: false,
    longCycleRepeatedAgentStable: false,
    longCycleStrategyDriftStable: false,
    mixedIntentFileEditRanked: false,
    mixedIntentBrowserRanked: false,
    mixedIntentMemoryRecallRanked: false,
    mixedIntentAgentRanked: false,
    mixedIntentSchemasRevealed: false,
    mixedIntentDynamicExpansionSeen: false,
    mixedIntentProviderCalls: 0,
    crossTurnMixedIntentInitialDeferredSeen: false,
    crossTurnMixedIntentFileEditStable: false,
    crossTurnMixedIntentBrowserStable: false,
    crossTurnMixedIntentMemoryRecallStable: false,
    crossTurnMixedIntentAgentStable: false,
    crossTurnMixedIntentSchemaIsolationSeen: false,
    crossTurnMixedIntentProviderCalls: 0,
    largeRepoInitialDeferredSeen: false,
    largeRepoMemoryCorrectCoreAvailable: false,
    largeRepoWorkspaceRanked: false,
    largeRepoFileEditRanked: false,
    largeRepoBrowserRanked: false,
    largeRepoArchiveRanked: false,
    largeRepoMemoryCorrectRanked: false,
    largeRepoMemoryRecallRanked: false,
    largeRepoLearningDraftRanked: false,
    largeRepoAgentRanked: false,
    largeRepoSchemasRevealed: false,
    largeRepoSchemaIsolationSeen: false,
    largeRepoProviderCalls: 0,
    largeRepoSelectedToolCount: 0,
    initialToolCount: 0,
    revealedToolCount: 0
  };

  const provider = await startProvider({ routeRequest: createRouter(state) });
  try {
    writeFileSync(
      path.join(configDir, "config.yaml"),
      renderConfig({ port: provider.port }),
      "utf8"
    );
    const output = await runCli([
      "--permission-mode",
      "acceptEdits",
      "--model",
      "main",
      "--output-format",
      "stream-json",
      "-p",
      [
        "Run the Tool Discovery eval.",
        "Use ToolSearch for edit and browser automation ranking.",
        "Select LearningDraft to reveal its schema.",
        "Then exercise tool feedback ranking for workspace search."
      ].join(" ")
    ]);
    assert(output.includes("Tool Discovery eval completed"), "tool discovery final answer missing");

    const statsPath = path.join(configDir, "state", "tool-usage-stats.json");
    assert(existsSync(statsPath), "tool usage stats were not persisted");
    const stats = JSON.parse(readFileSync(statsPath, "utf8"));
    const grepFailures = readNumber(stats.tools?.Grep?.failures);
    const globSuccesses = readNumber(stats.tools?.Glob?.successes);
    const grepIntentFailures = readNumber(
      stats.tools?.Grep?.intents?.["workspace-search"]?.failures
    );
    const globIntentSuccesses = readNumber(
      stats.tools?.Glob?.intents?.["workspace-search"]?.successes
    );
    const grepPathFailures = readNumber(stats.tools?.Grep?.failureKinds?.path);
    const grepIntentPathFailures = readNumber(
      stats.tools?.Grep?.intents?.["workspace-search"]?.failureKinds?.path
    );
    assert(grepFailures >= 4, "Grep failures were not recorded");
    assert(globSuccesses >= 4, "Glob successes were not recorded");
    assert(grepIntentFailures >= 4, "Grep workspace-search intent failures were not recorded");
    assert(globIntentSuccesses >= 4, "Glob workspace-search intent successes were not recorded");
    assert(grepPathFailures >= 4, "Grep path failure kind was not recorded");
    assert(grepIntentPathFailures >= 4, "Grep workspace-search path failure kind was not recorded");

    assert(state.coreToolsExposed, "core tool exposure was not verified");
    assert(state.deferredToolsHidden, "deferred tool hiding was not verified");
    assert(state.fileEditIntentRankedFilePatch, "FilePatch intent ranking was not verified");
    assert(state.browserAutomationRankedBrowser, "Browser intent ranking was not verified");
    assert(state.learningDraftRevealed, "LearningDraft reveal was not verified");
    assert(state.feedbackResultsReturned, "tool feedback results were not returned to the model");
    assert(state.feedbackRankingUsedUsage, "ToolSearch usage feedback ranking was not verified");
    state.intentScopedUsageRecorded = grepIntentFailures >= 4 && globIntentSuccesses >= 4;
    state.failureKindRecorded = grepPathFailures >= 4 && grepIntentPathFailures >= 4;
    assert(state.failureKindShownInRanking, "ToolSearch did not expose failure kind feedback");
    assert(state.failureRecoverySuggested, "ToolSearch did not expose recovery guidance");

    const crossTask = await runCrossTaskRecoveryEval(provider, state);
    const longCycle = await runLongCycleStrategyEval(provider, state);
    const mixedIntent = await runMixedIntentDynamicEval(provider, state);
    const crossTurnMixedIntent = await runCrossTurnMixedIntentDriftEval(provider, state);
    const largeRepo = await runLargeRepoRoutingEval(provider, state);
    const contextPath = path.join(configDir, "state", "tool-usage-context.json");
    assert(existsSync(contextPath), "tool usage context was not persisted");
    const contextStore = JSON.parse(readFileSync(contextPath, "utf8"));
    const contextIntents = new Set(
      (contextStore.contexts ?? [])
        .flatMap((context) => context.intents ?? [])
        .filter((intent) => typeof intent === "string")
    );
    const requiredContextIntents = [
      "file-edit",
      "workspace-search",
      "browser-automation",
      "memory-correction",
      "memory-recall",
      "skill-learning",
      "archive-management",
      "parallel-agent"
    ];
    const contextIntentCoverage = requiredContextIntents.filter((intent) =>
      contextIntents.has(intent)
    ).length;
    assert(
      contextIntentCoverage === requiredContextIntents.length,
      `tool usage context intent coverage was incomplete: ${contextIntentCoverage}/${requiredContextIntents.length}`
    );
    const assertions = [
      "ToolSearch exposed as core tool",
      "core file/search tools exposed initially",
      "deferred tools hidden initially",
      "FilePatch ranked first for file-edit intent",
      "Browser ranked first for browser automation intent",
      "LearningDraft schema revealed through select",
      "workspace ToolSearch result returned before feedback",
      "Grep path failures returned to model",
      "Glob successes returned to model",
      "usage feedback persisted globally",
      "usage feedback persisted by intent",
      "failure kind persisted globally and by intent",
      "ToolSearch ranking used usage feedback",
      "ToolSearch ranking exposed failure recovery guidance",
      "cross-task ToolSearch reused recovery feedback",
      "long-cycle strategy isolated unrelated browser intent",
      "long-cycle workspace ranking stayed stable after noisy feedback",
      "long-cycle browser ranking stayed stable after noisy feedback",
      "long-cycle file-edit ranking stayed stable after noisy feedback",
      "long-cycle memory correction ranking stayed stable after noisy feedback",
      "long-cycle memory recall ranking stayed stable after noisy feedback",
      "long-cycle skill ranking stayed stable after noisy feedback",
      "long-cycle agent ranking stayed stable after noisy feedback",
      "long-cycle strategy drift remained bounded",
      "mixed-intent task ranked FilePatch for edit step",
      "mixed-intent task ranked Browser for UI step",
      "mixed-intent task ranked SessionSearch for memory recall step",
      "mixed-intent task ranked Agent for parallel dispatch step",
      "mixed-intent task revealed schemas after ranking",
      "mixed-intent task expanded visible tools dynamically",
      "cross-turn mixed-intent task restarted with deferred schemas hidden",
      "cross-turn mixed-intent file-edit ranking stayed stable",
      "cross-turn mixed-intent browser ranking stayed stable",
      "cross-turn mixed-intent memory recall ranking stayed stable",
      "cross-turn mixed-intent agent ranking stayed stable",
      "cross-turn mixed-intent schemas revealed only after select",
      "large-repo task restarted with deferred schemas hidden",
      "large-repo task kept MemoryCorrect available as a core correction tool",
      "large-repo workspace search reused Glob ranking after feedback",
      "large-repo source edit ranked FilePatch",
      "large-repo browser regression ranked Browser",
      "large-repo release archive ranked ArchiveCreate",
      "large-repo memory correction ranked MemoryCorrect",
      "large-repo memory recall ranked SessionSearch",
      "large-repo learning draft ranked LearningDraft",
      "large-repo parallel dispatch ranked Agent",
      "large-repo selected schemas revealed without unrelated deferred tools leaking",
      "ToolSearch context persisted multi-intent routing history"
    ];
    const filesVerified = ["state/tool-usage-stats.json", "state/tool-usage-context.json"];

    const report = harnessReport.buildHarnessReport({
      name: "tool-discovery-eval",
      startedAt,
      scenarios: [
        {
          name: "tool discovery ranking and feedback workflow",
          status: "passed",
          durationMs: Date.now() - startedAt.getTime(),
          score: 1,
          failureKind: null,
          details: {
            provider: provider.summary(),
            assertions,
            filesVerified,
            coreToolsExposed: state.coreToolsExposed,
            deferredToolsHidden: state.deferredToolsHidden,
            fileEditIntentRankedFilePatch: state.fileEditIntentRankedFilePatch,
            browserAutomationRankedBrowser: state.browserAutomationRankedBrowser,
            learningDraftRevealed: state.learningDraftRevealed,
            feedbackResultsReturned: state.feedbackResultsReturned,
            feedbackRankingUsedUsage: state.feedbackRankingUsedUsage,
            intentScopedUsageRecorded: state.intentScopedUsageRecorded,
            failureKindRecorded: state.failureKindRecorded,
            failureKindShownInRanking: state.failureKindShownInRanking,
            failureRecoverySuggested: state.failureRecoverySuggested,
            crossTaskRecoveryRankingSeen: crossTask.rankingSeen,
            crossTaskRecoveryGuidanceSeen: crossTask.recoveryGuidanceSeen,
            crossTaskProviderCalls: crossTask.providerCalls,
            crossTaskIntentScopedRankingSeen: longCycle.intentScopedRankingSeen,
            crossTaskUnrelatedIntentIsolated: longCycle.unrelatedIntentIsolated,
            longCycleWorkspaceNoiseInjected: longCycle.workspaceNoiseInjected,
            longCycleRepeatedWorkspaceStable: longCycle.repeatedWorkspaceStable,
            longCycleRepeatedBrowserStable: longCycle.repeatedBrowserStable,
            longCycleRepeatedFileEditStable: longCycle.repeatedFileEditStable,
            longCycleRepeatedMemoryCorrectStable: longCycle.repeatedMemoryCorrectStable,
            longCycleRepeatedMemoryRecallStable: longCycle.repeatedMemoryRecallStable,
            longCycleRepeatedSkillStable: longCycle.repeatedSkillStable,
            longCycleRepeatedAgentStable: longCycle.repeatedAgentStable,
            longCycleStrategyDriftStable: longCycle.strategyDriftStable,
            longCycleProviderCalls: longCycle.providerCalls,
            mixedIntentFileEditRanked: mixedIntent.fileEditRanked,
            mixedIntentBrowserRanked: mixedIntent.browserRanked,
            mixedIntentMemoryRecallRanked: mixedIntent.memoryRecallRanked,
            mixedIntentAgentRanked: mixedIntent.agentRanked,
            mixedIntentSchemasRevealed: mixedIntent.schemasRevealed,
            mixedIntentDynamicExpansionSeen: mixedIntent.dynamicExpansionSeen,
            mixedIntentProviderCalls: mixedIntent.providerCalls,
            crossTurnMixedIntentInitialDeferredSeen:
              crossTurnMixedIntent.initialDeferredSeen,
            crossTurnMixedIntentFileEditStable: crossTurnMixedIntent.fileEditStable,
            crossTurnMixedIntentBrowserStable: crossTurnMixedIntent.browserStable,
            crossTurnMixedIntentMemoryRecallStable:
              crossTurnMixedIntent.memoryRecallStable,
            crossTurnMixedIntentAgentStable: crossTurnMixedIntent.agentStable,
            crossTurnMixedIntentSchemaIsolationSeen:
              crossTurnMixedIntent.schemaIsolationSeen,
            crossTurnMixedIntentProviderCalls: crossTurnMixedIntent.providerCalls,
            largeRepoInitialDeferredSeen: largeRepo.initialDeferredSeen,
            largeRepoMemoryCorrectCoreAvailable: largeRepo.memoryCorrectCoreAvailable,
            largeRepoWorkspaceRanked: largeRepo.workspaceRanked,
            largeRepoFileEditRanked: largeRepo.fileEditRanked,
            largeRepoBrowserRanked: largeRepo.browserRanked,
            largeRepoArchiveRanked: largeRepo.archiveRanked,
            largeRepoMemoryCorrectRanked: largeRepo.memoryCorrectRanked,
            largeRepoMemoryRecallRanked: largeRepo.memoryRecallRanked,
            largeRepoLearningDraftRanked: largeRepo.learningDraftRanked,
            largeRepoAgentRanked: largeRepo.agentRanked,
            largeRepoSchemasRevealed: largeRepo.schemasRevealed,
            largeRepoSchemaIsolationSeen: largeRepo.schemaIsolationSeen,
            largeRepoProviderCalls: largeRepo.providerCalls,
            largeRepoSelectedToolCount: largeRepo.selectedToolCount,
            toolSearchContextPersisted: true,
            toolSearchContextIntentCoverage: contextIntentCoverage,
            initialToolCount: state.initialToolCount,
            revealedToolCount: state.revealedToolCount,
            grepFailures,
            globSuccesses,
            grepIntentFailures,
            globIntentSuccesses,
            grepPathFailures,
            grepIntentPathFailures
          }
        }
      ]
    });
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(
      `Tool Discovery eval passed (initial tools=${state.initialToolCount}, revealed tools=${state.revealedToolCount}).`
    );
    console.log(`Tool Discovery report: ${reportPath}`);
  } catch (error) {
    console.error("\nTool Discovery provider calls:");
    console.error(JSON.stringify(provider.calls.map(summarizeProviderCall), null, 2));
    throw error;
  } finally {
    await provider.close();
  }
} finally {
  if (!process.env.MAGI_KEEP_TOOL_DISCOVERY_EVAL_TMP) {
    rmSync(root, { recursive: true, force: true });
  }
}

function summarizeProviderCall(call) {
  return {
    model: call.model,
    latestUser: call.latestUser,
    toolNames: call.toolNames,
    transcriptTail: call.transcript.slice(-2_000)
  };
}

function createRouter(state) {
  let turn = 0;
  let crossTaskTurn = 0;
  let longCycleTurn = 0;
  let crossTurnMixedIntentTurn = 0;
  let largeRepoTurn = 0;
  return ({ latestUser, transcript, toolNames }) => {
    if (latestUser.includes("Run long-cycle ToolSearch strategy regression checks.")) {
      longCycleTurn += 1;
      if (longCycleTurn === 1) {
        return toolResponse([
          toolCall("long-cycle-file-edit-initial", "ToolSearch", {
            query: "apply a multi-line patch to a file",
            max_results: 5
          }),
          toolCall("long-cycle-workspace-search", "ToolSearch", {
            query: "search workspace files",
            max_results: 5
          }),
          toolCall("long-cycle-browser-search", "ToolSearch", {
            query: "automate browser click and screenshot",
            max_results: 5
          }),
          toolCall("long-cycle-memory-correct-search", "ToolSearch", {
            query: "correct a wrong outdated memory",
            max_results: 5
          }),
          toolCall("long-cycle-memory-recall-search", "ToolSearch", {
            query: "search previous session memory history",
            max_results: 5
          }),
          toolCall("long-cycle-skill-search", "ToolSearch", {
            query: "load a reusable skill workflow",
            max_results: 5
          }),
          toolCall("long-cycle-agent-search", "ToolSearch", {
            query: "dispatch parallel agent to peer machine",
            max_results: 5
          })
        ]);
      }
      if (longCycleTurn === 2) {
        assertLongCycleRankings(transcript, { minimumOccurrences: 1 });
        return toolResponse([
          toolCall("long-cycle-grep-noise-1", "Grep", { pattern: "needle", path: "../outside" }),
          toolCall("long-cycle-grep-noise-2", "Grep", { pattern: "needle", path: "../outside" }),
          toolCall("long-cycle-glob-noise-1", "Glob", { pattern: "**/*.md" }),
          toolCall("long-cycle-glob-noise-2", "Glob", { pattern: "**/*.md" })
        ]);
      }
      if (longCycleTurn === 3) {
        assert(
          transcript.includes("Search path is outside allowed directories"),
          "long-cycle Grep noise failure was not visible"
        );
        assert(transcript.includes("No matches"), "long-cycle Glob noise success was not visible");
        state.longCycleWorkspaceNoiseInjected = true;
        return toolResponse([
          toolCall("long-cycle-file-edit-repeat", "ToolSearch", {
            query: "apply a multi-line patch to a file",
            max_results: 5
          }),
          toolCall("long-cycle-workspace-repeat", "ToolSearch", {
            query: "search workspace files",
            max_results: 5
          }),
          toolCall("long-cycle-browser-repeat", "ToolSearch", {
            query: "automate browser click and screenshot",
            max_results: 5
          }),
          toolCall("long-cycle-memory-correct-repeat", "ToolSearch", {
            query: "correct a wrong outdated memory",
            max_results: 5
          }),
          toolCall("long-cycle-memory-recall-repeat", "ToolSearch", {
            query: "search previous session memory history",
            max_results: 5
          }),
          toolCall("long-cycle-skill-repeat", "ToolSearch", {
            query: "load a reusable skill workflow",
            max_results: 5
          }),
          toolCall("long-cycle-agent-repeat", "ToolSearch", {
            query: "dispatch parallel agent to peer machine",
            max_results: 5
          })
        ]);
      }
      assertLongCycleRankings(transcript, { minimumOccurrences: 2 });
      assert(
        state.longCycleWorkspaceNoiseInjected,
        "long-cycle workspace noise was not injected before repeated ranking"
      );
      state.crossTaskIntentScopedRankingSeen = true;
      state.crossTaskUnrelatedIntentIsolated = true;
      state.longCycleRepeatedWorkspaceStable = true;
      state.longCycleRepeatedBrowserStable = true;
      state.longCycleRepeatedFileEditStable = true;
      state.longCycleRepeatedMemoryCorrectStable = true;
      state.longCycleRepeatedMemoryRecallStable = true;
      state.longCycleRepeatedSkillStable = true;
      state.longCycleRepeatedAgentStable = true;
      state.longCycleStrategyDriftStable = true;
      return messageText("Long-cycle Tool Discovery strategy verified.");
    }

    if (latestUser.includes("Run mixed-intent dynamic ToolSearch selection checks.")) {
      return routeMixedIntentDynamicSelection({ transcript, toolNames, state });
    }

    if (latestUser.includes("Run cross-turn mixed-intent ToolSearch drift checks.")) {
      crossTurnMixedIntentTurn += 1;
      return routeCrossTurnMixedIntentDrift({
        transcript,
        toolNames,
        state,
        turn: crossTurnMixedIntentTurn
      });
    }

    if (latestUser.includes("Run large-repository ToolSearch routing checks.")) {
      largeRepoTurn += 1;
      return routeLargeRepoRouting({
        transcript,
        toolNames,
        state,
        turn: largeRepoTurn
      });
    }

    if (
      latestUser.includes(
        "Run a new independent ToolSearch task for workspace file search after prior feedback."
      )
    ) {
      crossTaskTurn += 1;
      if (crossTaskTurn === 1) {
        return toolResponse([
          toolCall("cross-task-tool-search", "ToolSearch", {
            query: "search workspace files",
            max_results: 5
          })
        ]);
      }
      assert(
        transcript.includes('ToolSearch results for "search workspace files"'),
        "cross-task ToolSearch result was not visible"
      );
      assert(transcript.includes("1. Glob"), "Glob was not ranked first across tasks");
      assert(transcript.includes("usage:+"), "cross-task positive usage feedback missing");
      assert(transcript.includes("usage:-"), "cross-task negative usage feedback missing");
      assert(transcript.includes("failure:path"), "cross-task failure kind feedback missing");
      assert(
        transcript.includes(
          "recovery:path=use Glob for broad search or pass a workspace-relative path"
        ),
        "cross-task recovery guidance missing"
      );
      state.crossTaskRecoveryRankingSeen = true;
      state.crossTaskRecoveryGuidanceSeen = true;
      return messageText("Cross-task Tool Discovery recovery verified.");
    }

    turn += 1;
    if (turn === 1) {
      state.initialToolCount = toolNames.length;
      assert(toolNames.includes("ToolSearch"), "ToolSearch was not exposed as a core tool");
      assert(toolNames.includes("FilePatch"), "FilePatch was not exposed as a core tool");
      assert(toolNames.includes("Glob"), "Glob was not exposed as a core tool");
      assert(toolNames.includes("Grep"), "Grep was not exposed as a core tool");
      assert(!toolNames.includes("LearningDraft"), "LearningDraft should start deferred");
      assert(!toolNames.includes("Browser"), "Browser should start deferred");
      assert(!toolNames.includes("SessionSearch"), "SessionSearch should start deferred");
      state.coreToolsExposed = true;
      state.deferredToolsHidden = true;
      return toolResponse([
        toolCall("search-file-edit-intent", "ToolSearch", {
          query: "apply a multi-line patch to a file",
          max_results: 5
        }),
        toolCall("search-browser-intent", "ToolSearch", {
          query: "automate browser click and screenshot",
          max_results: 5
        }),
        toolCall("select-learning-draft", "ToolSearch", { query: "select:LearningDraft" })
      ]);
    }

    if (turn === 2) {
      state.revealedToolCount = toolNames.length;
      assert(
        transcript.includes('ToolSearch results for "apply a multi-line patch to a file"'),
        "file edit ToolSearch result was not visible"
      );
      assert(transcript.includes("intent: file-edit"), "file edit intent was not reported");
      assert(transcript.includes("1. FilePatch"), "FilePatch was not ranked first");
      assert(
        transcript.includes('ToolSearch results for "automate browser click and screenshot"'),
        "browser ToolSearch result was not visible"
      );
      assert(transcript.includes("1. Browser"), "Browser was not ranked first");
      assert(transcript.includes("Tool: LearningDraft"), "LearningDraft schema was not selected");
      assert(toolNames.includes("LearningDraft"), "LearningDraft was not revealed after select");
      state.fileEditIntentRankedFilePatch = true;
      state.browserAutomationRankedBrowser = true;
      state.learningDraftRevealed = true;
      return toolResponse([
        toolCall("tool-search-before-feedback", "ToolSearch", {
          query: "search workspace files",
          max_results: 5
        })
      ]);
    }

    if (turn === 3) {
      assert(
        transcript.includes('ToolSearch results for "search workspace files"'),
        "workspace ToolSearch result was not visible before feedback"
      );
      return toolResponse([
        toolCall("grep-bad-path-1", "Grep", { pattern: "needle", path: "../outside" }),
        toolCall("grep-bad-path-2", "Grep", { pattern: "needle", path: "../outside" }),
        toolCall("grep-bad-path-3", "Grep", { pattern: "needle", path: "../outside" }),
        toolCall("grep-bad-path-4", "Grep", { pattern: "needle", path: "../outside" }),
        toolCall("glob-ok-1", "Glob", { pattern: "**/*.md" }),
        toolCall("glob-ok-2", "Glob", { pattern: "**/*.md" }),
        toolCall("glob-ok-3", "Glob", { pattern: "**/*.md" }),
        toolCall("glob-ok-4", "Glob", { pattern: "**/*.md" })
      ]);
    }

    if (turn === 4) {
      assert(
        transcript.includes("Search path is outside allowed directories"),
        "Grep failure feedback was not visible"
      );
      assert(transcript.includes("No matches"), "Glob success feedback was not visible");
      state.feedbackResultsReturned = true;
      return toolResponse([
        toolCall("tool-search-after-feedback", "ToolSearch", {
          query: "search workspace files",
          max_results: 5
        })
      ]);
    }

    assert(transcript.includes("1. Glob"), "Glob was not ranked first after usage feedback");
    assert(transcript.includes("usage:+"), "positive usage feedback was not reported");
    assert(transcript.includes("usage:-"), "negative usage feedback was not reported");
    assert(transcript.includes("failure:path"), "failure kind feedback was not reported");
    assert(
      transcript.includes(
        "recovery:path=use Glob for broad search or pass a workspace-relative path"
      ),
      "failure recovery guidance was not reported"
    );
    state.feedbackRankingUsedUsage = true;
    state.failureKindShownInRanking = true;
    state.failureRecoverySuggested = true;
    return messageText("Tool Discovery eval completed.");
  };
}

async function runCrossTaskRecoveryEval(provider, state) {
  const output = await runCli([
    "--model",
    "main",
    "--output-format",
    "stream-json",
    "-p",
    "Run a new independent ToolSearch task for workspace file search after prior feedback."
  ]);
  const matchingCalls = providerCallsForPrompt("Run a new independent ToolSearch task");
  assert(matchingCalls.length > 0, "cross-task ToolSearch prompt did not call provider");
  assert(
    output.includes("Cross-task Tool Discovery recovery verified"),
    "cross-task recovery final answer missing"
  );
  assert(state.crossTaskRecoveryRankingSeen, "cross-task recovery ranking was not verified");
  assert(state.crossTaskRecoveryGuidanceSeen, "cross-task recovery guidance was not verified");
  return {
    rankingSeen: state.crossTaskRecoveryRankingSeen,
    recoveryGuidanceSeen: state.crossTaskRecoveryGuidanceSeen,
    providerCalls: matchingCalls.length
  };

  function providerCallsForPrompt(prompt) {
    return provider.calls.filter((call) => call.transcript.includes(prompt));
  }
}

async function runLongCycleStrategyEval(provider, state) {
  const output = await runCli([
    "--model",
    "main",
    "--output-format",
    "stream-json",
    "-p",
    "Run long-cycle ToolSearch strategy regression checks."
  ]);
  const matchingCalls = providerCallsForPrompt("Run long-cycle ToolSearch strategy");
  assert(matchingCalls.length > 0, "long-cycle ToolSearch prompt did not call provider");
  assert(
    output.includes("Long-cycle Tool Discovery strategy verified"),
    "long-cycle strategy final answer missing"
  );
  assert(
    state.crossTaskIntentScopedRankingSeen,
    "long-cycle intent scoped ranking was not verified"
  );
  assert(
    state.crossTaskUnrelatedIntentIsolated,
    "long-cycle unrelated intent isolation was not verified"
  );
  assert(
    state.longCycleWorkspaceNoiseInjected,
    "long-cycle workspace noise injection was not verified"
  );
  assert(
    state.longCycleRepeatedWorkspaceStable,
    "long-cycle repeated workspace ranking was not verified"
  );
  assert(
    state.longCycleRepeatedBrowserStable,
    "long-cycle repeated browser ranking was not verified"
  );
  assert(
    state.longCycleRepeatedFileEditStable,
    "long-cycle repeated file-edit ranking was not verified"
  );
  assert(
    state.longCycleRepeatedMemoryCorrectStable,
    "long-cycle repeated memory-correction ranking was not verified"
  );
  assert(
    state.longCycleRepeatedMemoryRecallStable,
    "long-cycle repeated memory-recall ranking was not verified"
  );
  assert(state.longCycleRepeatedSkillStable, "long-cycle repeated skill ranking was not verified");
  assert(state.longCycleRepeatedAgentStable, "long-cycle repeated agent ranking was not verified");
  assert(state.longCycleStrategyDriftStable, "long-cycle strategy drift was not verified");
  return {
    intentScopedRankingSeen: state.crossTaskIntentScopedRankingSeen,
    unrelatedIntentIsolated: state.crossTaskUnrelatedIntentIsolated,
    workspaceNoiseInjected: state.longCycleWorkspaceNoiseInjected,
    repeatedWorkspaceStable: state.longCycleRepeatedWorkspaceStable,
    repeatedBrowserStable: state.longCycleRepeatedBrowserStable,
    repeatedFileEditStable: state.longCycleRepeatedFileEditStable,
    repeatedMemoryCorrectStable: state.longCycleRepeatedMemoryCorrectStable,
    repeatedMemoryRecallStable: state.longCycleRepeatedMemoryRecallStable,
    repeatedSkillStable: state.longCycleRepeatedSkillStable,
    repeatedAgentStable: state.longCycleRepeatedAgentStable,
    strategyDriftStable: state.longCycleStrategyDriftStable,
    providerCalls: matchingCalls.length
  };

  function providerCallsForPrompt(prompt) {
    return provider.calls.filter((call) => call.transcript.includes(prompt));
  }
}

async function runMixedIntentDynamicEval(provider, state) {
  const output = await runCli([
    "--model",
    "main",
    "--output-format",
    "stream-json",
    "-p",
    "Run mixed-intent dynamic ToolSearch selection checks."
  ]);
  const matchingCalls = providerCallsForPrompt("Run mixed-intent dynamic ToolSearch selection");
  assert(matchingCalls.length > 0, "mixed-intent ToolSearch prompt did not call provider");
  assert(
    output.includes("Mixed-intent Tool Discovery selection verified"),
    "mixed-intent strategy final answer missing"
  );
  assert(state.mixedIntentFileEditRanked, "mixed-intent file-edit ranking was not verified");
  assert(state.mixedIntentBrowserRanked, "mixed-intent browser ranking was not verified");
  assert(
    state.mixedIntentMemoryRecallRanked,
    "mixed-intent memory-recall ranking was not verified"
  );
  assert(state.mixedIntentAgentRanked, "mixed-intent agent ranking was not verified");
  assert(state.mixedIntentSchemasRevealed, "mixed-intent schema reveal was not verified");
  assert(
    state.mixedIntentDynamicExpansionSeen,
    "mixed-intent dynamic tool expansion was not verified"
  );
  state.mixedIntentProviderCalls = matchingCalls.length;
  return {
    fileEditRanked: state.mixedIntentFileEditRanked,
    browserRanked: state.mixedIntentBrowserRanked,
    memoryRecallRanked: state.mixedIntentMemoryRecallRanked,
    agentRanked: state.mixedIntentAgentRanked,
    schemasRevealed: state.mixedIntentSchemasRevealed,
    dynamicExpansionSeen: state.mixedIntentDynamicExpansionSeen,
    providerCalls: matchingCalls.length
  };

  function providerCallsForPrompt(prompt) {
    return provider.calls.filter((call) => call.transcript.includes(prompt));
  }
}

async function runCrossTurnMixedIntentDriftEval(provider, state) {
  const output = await runCli([
    "--model",
    "main",
    "--output-format",
    "stream-json",
    "-p",
    "Run cross-turn mixed-intent ToolSearch drift checks."
  ]);
  const matchingCalls = providerCallsForPrompt("Run cross-turn mixed-intent ToolSearch drift");
  assert(matchingCalls.length > 0, "cross-turn mixed-intent prompt did not call provider");
  assert(
    output.includes("Cross-turn mixed-intent Tool Discovery drift verified"),
    "cross-turn mixed-intent final answer missing"
  );
  assert(
    state.crossTurnMixedIntentInitialDeferredSeen,
    "cross-turn mixed-intent initial deferred visibility was not verified"
  );
  assert(
    state.crossTurnMixedIntentFileEditStable,
    "cross-turn mixed-intent file-edit ranking was not verified"
  );
  assert(
    state.crossTurnMixedIntentBrowserStable,
    "cross-turn mixed-intent browser ranking was not verified"
  );
  assert(
    state.crossTurnMixedIntentMemoryRecallStable,
    "cross-turn mixed-intent memory-recall ranking was not verified"
  );
  assert(
    state.crossTurnMixedIntentAgentStable,
    "cross-turn mixed-intent agent ranking was not verified"
  );
  assert(
    state.crossTurnMixedIntentSchemaIsolationSeen,
    "cross-turn mixed-intent schema isolation was not verified"
  );
  state.crossTurnMixedIntentProviderCalls = matchingCalls.length;
  return {
    initialDeferredSeen: state.crossTurnMixedIntentInitialDeferredSeen,
    fileEditStable: state.crossTurnMixedIntentFileEditStable,
    browserStable: state.crossTurnMixedIntentBrowserStable,
    memoryRecallStable: state.crossTurnMixedIntentMemoryRecallStable,
    agentStable: state.crossTurnMixedIntentAgentStable,
    schemaIsolationSeen: state.crossTurnMixedIntentSchemaIsolationSeen,
    providerCalls: matchingCalls.length
  };

  function providerCallsForPrompt(prompt) {
    return provider.calls.filter((call) => call.transcript.includes(prompt));
  }
}

async function runLargeRepoRoutingEval(provider, state) {
  const output = await runCli([
    "--model",
    "main",
    "--output-format",
    "stream-json",
    "-p",
    [
      "Run large-repository ToolSearch routing checks.",
      "Pretend this is a multi-package migration that needs source discovery, file edits, UI regression, release archive packaging, memory correction, memory recall, learning capture, and parallel agent review.",
      "Use ToolSearch only for tools whose schema is not already visible."
    ].join(" ")
  ]);
  const matchingCalls = providerCallsForPrompt("Run large-repository ToolSearch routing checks");
  assert(matchingCalls.length > 0, "large-repo routing prompt did not call provider");
  assert(
    output.includes("Large-repository Tool Discovery routing verified"),
    "large-repo routing final answer missing"
  );
  assert(state.largeRepoInitialDeferredSeen, "large-repo deferred visibility was not verified");
  assert(
    state.largeRepoMemoryCorrectCoreAvailable,
    "large-repo MemoryCorrect core availability was not verified"
  );
  assert(state.largeRepoWorkspaceRanked, "large-repo workspace ranking was not verified");
  assert(state.largeRepoFileEditRanked, "large-repo file-edit ranking was not verified");
  assert(state.largeRepoBrowserRanked, "large-repo browser ranking was not verified");
  assert(state.largeRepoArchiveRanked, "large-repo archive ranking was not verified");
  assert(
    state.largeRepoMemoryCorrectRanked,
    "large-repo memory-correction ranking was not verified"
  );
  assert(state.largeRepoMemoryRecallRanked, "large-repo memory-recall ranking was not verified");
  assert(state.largeRepoLearningDraftRanked, "large-repo learning ranking was not verified");
  assert(state.largeRepoAgentRanked, "large-repo agent ranking was not verified");
  assert(state.largeRepoSchemasRevealed, "large-repo schema reveal was not verified");
  assert(state.largeRepoSchemaIsolationSeen, "large-repo schema isolation was not verified");
  state.largeRepoProviderCalls = matchingCalls.length;
  return {
    initialDeferredSeen: state.largeRepoInitialDeferredSeen,
    memoryCorrectCoreAvailable: state.largeRepoMemoryCorrectCoreAvailable,
    workspaceRanked: state.largeRepoWorkspaceRanked,
    fileEditRanked: state.largeRepoFileEditRanked,
    browserRanked: state.largeRepoBrowserRanked,
    archiveRanked: state.largeRepoArchiveRanked,
    memoryCorrectRanked: state.largeRepoMemoryCorrectRanked,
    memoryRecallRanked: state.largeRepoMemoryRecallRanked,
    learningDraftRanked: state.largeRepoLearningDraftRanked,
    agentRanked: state.largeRepoAgentRanked,
    schemasRevealed: state.largeRepoSchemasRevealed,
    schemaIsolationSeen: state.largeRepoSchemaIsolationSeen,
    providerCalls: matchingCalls.length,
    selectedToolCount: state.largeRepoSelectedToolCount
  };

  function providerCallsForPrompt(prompt) {
    return provider.calls.filter((call) => call.transcript.includes(prompt));
  }
}

function routeLargeRepoRouting({ transcript, toolNames, state, turn }) {
  if (turn === 1) {
    assert(toolNames.includes("ToolSearch"), "ToolSearch was not visible in large-repo task");
    assert(toolNames.includes("FilePatch"), "FilePatch was not visible in large-repo task");
    assert(toolNames.includes("Glob"), "Glob was not visible in large-repo task");
    assert(toolNames.includes("Grep"), "Grep was not visible in large-repo task");
    assert(
      toolNames.includes("MemoryCorrect"),
      "MemoryCorrect should be a core tool in large-repo task"
    );
    assert(!toolNames.includes("Browser"), "Browser leaked into fresh large-repo tool context");
    assert(
      !toolNames.includes("ArchiveCreate"),
      "ArchiveCreate leaked into fresh large-repo tool context"
    );
    assert(
      !toolNames.includes("SessionSearch"),
      "SessionSearch leaked into fresh large-repo tool context"
    );
    assert(
      !toolNames.includes("LearningDraft"),
      "LearningDraft leaked into fresh large-repo tool context"
    );
    assert(!toolNames.includes("Agent"), "Agent leaked into fresh large-repo tool context");
    state.largeRepoInitialDeferredSeen = true;
    state.largeRepoMemoryCorrectCoreAvailable = true;
    return toolResponse([
      toolCall("large-repo-workspace-search", "ToolSearch", {
        query: "search workspace files across a large repository",
        max_results: 5
      }),
      toolCall("large-repo-file-edit-search", "ToolSearch", {
        query: "apply a multi-line patch to a file",
        max_results: 5
      }),
      toolCall("large-repo-browser-search", "ToolSearch", {
        query: "automate browser click and screenshot",
        max_results: 5
      }),
      toolCall("large-repo-archive-search", "ToolSearch", {
        query: "create zip release archive",
        max_results: 5
      }),
      toolCall("large-repo-memory-correct-search", "ToolSearch", {
        query: "correct a wrong outdated memory",
        max_results: 5
      }),
      toolCall("large-repo-memory-recall-search", "ToolSearch", {
        query: "search previous session memory history",
        max_results: 5
      }),
      toolCall("large-repo-learning-search", "ToolSearch", {
        query: "propose learning draft for stable workflow",
        max_results: 5
      }),
      toolCall("large-repo-agent-search", "ToolSearch", {
        query: "dispatch parallel agent to peer machine",
        max_results: 5
      })
    ]);
  }

  if (turn === 2) {
    assertLargeRepoRankings(transcript);
    state.largeRepoWorkspaceRanked = true;
    state.largeRepoFileEditRanked = true;
    state.largeRepoBrowserRanked = true;
    state.largeRepoArchiveRanked = true;
    state.largeRepoMemoryCorrectRanked = true;
    state.largeRepoMemoryRecallRanked = true;
    state.largeRepoLearningDraftRanked = true;
    state.largeRepoAgentRanked = true;
    return toolResponse([
      toolCall("large-repo-select-browser", "ToolSearch", { query: "select:Browser" }),
      toolCall("large-repo-select-archive", "ToolSearch", { query: "select:ArchiveCreate" }),
      toolCall("large-repo-select-session-search", "ToolSearch", {
        query: "select:SessionSearch"
      }),
      toolCall("large-repo-select-learning-draft", "ToolSearch", {
        query: "select:LearningDraft"
      }),
      toolCall("large-repo-select-agent", "ToolSearch", { query: "select:Agent" })
    ]);
  }

  assert(transcript.includes("Tool: Browser"), "large-repo Browser schema was not selected");
  assert(
    transcript.includes("Tool: ArchiveCreate"),
    "large-repo ArchiveCreate schema was not selected"
  );
  assert(
    transcript.includes("Tool: SessionSearch"),
    "large-repo SessionSearch schema was not selected"
  );
  assert(
    transcript.includes("Tool: LearningDraft"),
    "large-repo LearningDraft schema was not selected"
  );
  assert(transcript.includes("Tool: Agent"), "large-repo Agent schema was not selected");
  assert(toolNames.includes("Browser"), "Browser was not visible after large-repo select");
  assert(
    toolNames.includes("ArchiveCreate"),
    "ArchiveCreate was not visible after large-repo select"
  );
  assert(
    toolNames.includes("SessionSearch"),
    "SessionSearch was not visible after large-repo select"
  );
  assert(
    toolNames.includes("LearningDraft"),
    "LearningDraft was not visible after large-repo select"
  );
  assert(toolNames.includes("Agent"), "Agent was not visible after large-repo select");
  assert(!toolNames.includes("ArchiveExtract"), "unselected ArchiveExtract schema leaked");
  assert(!toolNames.includes("WebBrowser"), "unselected WebBrowser schema leaked");
  assert(!toolNames.includes("SkillManage"), "unselected SkillManage schema leaked");
  state.largeRepoSchemasRevealed = true;
  state.largeRepoSchemaIsolationSeen = true;
  state.largeRepoSelectedToolCount = [
    "Browser",
    "ArchiveCreate",
    "SessionSearch",
    "LearningDraft",
    "Agent"
  ].filter((toolName) => toolNames.includes(toolName)).length;
  return messageText("Large-repository Tool Discovery routing verified.");
}

function routeMixedIntentDynamicSelection({ transcript, toolNames, state }) {
  const schemaRevealSeen =
    transcript.includes("Tool: FilePatch") &&
    transcript.includes("Tool: Browser") &&
    transcript.includes("Tool: SessionSearch") &&
    transcript.includes("Tool: Agent");
  if (schemaRevealSeen) {
    assert(toolNames.includes("Browser"), "Browser was not visible after mixed-intent select");
    assert(
      toolNames.includes("SessionSearch"),
      "SessionSearch was not visible after mixed-intent select"
    );
    assert(toolNames.includes("Agent"), "Agent was not visible after mixed-intent select");
    state.mixedIntentSchemasRevealed = true;
    state.mixedIntentDynamicExpansionSeen = toolNames.length > state.initialToolCount;
    return messageText("Mixed-intent Tool Discovery selection verified.");
  }

  if (
    transcript.includes('ToolSearch results for "apply a multi-line patch to a file"') &&
    transcript.includes('ToolSearch results for "automate browser click and screenshot"') &&
    transcript.includes('ToolSearch results for "search previous session memory history"') &&
    transcript.includes('ToolSearch results for "dispatch parallel agent to peer machine"')
  ) {
    assert(transcript.includes("1. FilePatch"), "mixed-intent FilePatch ranking missing");
    assert(transcript.includes("1. Browser"), "mixed-intent Browser ranking missing");
    assert(transcript.includes("1. SessionSearch"), "mixed-intent SessionSearch ranking missing");
    assert(transcript.includes("1. Agent"), "mixed-intent Agent ranking missing");
    state.mixedIntentFileEditRanked = true;
    state.mixedIntentBrowserRanked = true;
    state.mixedIntentMemoryRecallRanked = true;
    state.mixedIntentAgentRanked = true;
    return toolResponse([
      toolCall("mixed-select-filepatch", "ToolSearch", { query: "select:FilePatch" }),
      toolCall("mixed-select-browser", "ToolSearch", { query: "select:Browser" }),
      toolCall("mixed-select-session-search", "ToolSearch", { query: "select:SessionSearch" }),
      toolCall("mixed-select-agent", "ToolSearch", { query: "select:Agent" })
    ]);
  }

  assert(!toolNames.includes("Browser"), "Browser should start deferred in mixed-intent task");
  assert(
    !toolNames.includes("SessionSearch"),
    "SessionSearch should start deferred in mixed-intent task"
  );
  assert(!toolNames.includes("Agent"), "Agent should start deferred in mixed-intent task");
  return toolResponse([
    toolCall("mixed-file-edit-search", "ToolSearch", {
      query: "apply a multi-line patch to a file",
      max_results: 5
    }),
    toolCall("mixed-browser-search", "ToolSearch", {
      query: "automate browser click and screenshot",
      max_results: 5
    }),
    toolCall("mixed-memory-recall-search", "ToolSearch", {
      query: "search previous session memory history",
      max_results: 5
    }),
    toolCall("mixed-agent-search", "ToolSearch", {
      query: "dispatch parallel agent to peer machine",
      max_results: 5
    })
  ]);
}

function routeCrossTurnMixedIntentDrift({ transcript, toolNames, state, turn }) {
  if (turn === 1) {
    assert(toolNames.includes("ToolSearch"), "ToolSearch was not visible in cross-turn task");
    assert(toolNames.includes("FilePatch"), "FilePatch was not visible in cross-turn task");
    assert(!toolNames.includes("Browser"), "Browser leaked into a fresh cross-turn tool context");
    assert(
      !toolNames.includes("SessionSearch"),
      "SessionSearch leaked into a fresh cross-turn tool context"
    );
    assert(!toolNames.includes("Agent"), "Agent leaked into a fresh cross-turn tool context");
    state.crossTurnMixedIntentInitialDeferredSeen = true;
    return toolResponse([
      toolCall("cross-turn-file-edit-search", "ToolSearch", {
        query: "apply a multi-line patch to a file",
        max_results: 5
      }),
      toolCall("cross-turn-browser-search", "ToolSearch", {
        query: "automate browser click and screenshot",
        max_results: 5
      }),
      toolCall("cross-turn-memory-recall-search", "ToolSearch", {
        query: "search previous session memory history",
        max_results: 5
      }),
      toolCall("cross-turn-agent-search", "ToolSearch", {
        query: "dispatch parallel agent to peer machine",
        max_results: 5
      })
    ]);
  }

  if (turn === 2) {
    assert(
      transcript.includes('ToolSearch results for "apply a multi-line patch to a file"'),
      "cross-turn file-edit ToolSearch result was not visible"
    );
    assert(
      transcript.includes('ToolSearch results for "automate browser click and screenshot"'),
      "cross-turn browser ToolSearch result was not visible"
    );
    assert(
      transcript.includes('ToolSearch results for "search previous session memory history"'),
      "cross-turn memory-recall ToolSearch result was not visible"
    );
    assert(
      transcript.includes('ToolSearch results for "dispatch parallel agent to peer machine"'),
      "cross-turn agent ToolSearch result was not visible"
    );
    assert(transcript.includes("1. FilePatch"), "cross-turn FilePatch ranking missing");
    assert(transcript.includes("1. Browser"), "cross-turn Browser ranking missing");
    assert(transcript.includes("1. SessionSearch"), "cross-turn SessionSearch ranking missing");
    assert(transcript.includes("1. Agent"), "cross-turn Agent ranking missing");
    state.crossTurnMixedIntentFileEditStable = true;
    state.crossTurnMixedIntentBrowserStable = true;
    state.crossTurnMixedIntentMemoryRecallStable = true;
    state.crossTurnMixedIntentAgentStable = true;
    return toolResponse([
      toolCall("cross-turn-select-browser", "ToolSearch", { query: "select:Browser" }),
      toolCall("cross-turn-select-session-search", "ToolSearch", {
        query: "select:SessionSearch"
      }),
      toolCall("cross-turn-select-agent", "ToolSearch", { query: "select:Agent" })
    ]);
  }

  assert(transcript.includes("Tool: Browser"), "cross-turn Browser schema was not selected");
  assert(
    transcript.includes("Tool: SessionSearch"),
    "cross-turn SessionSearch schema was not selected"
  );
  assert(transcript.includes("Tool: Agent"), "cross-turn Agent schema was not selected");
  assert(toolNames.includes("Browser"), "Browser was not visible after cross-turn select");
  assert(
    toolNames.includes("SessionSearch"),
    "SessionSearch was not visible after cross-turn select"
  );
  assert(toolNames.includes("Agent"), "Agent was not visible after cross-turn select");
  state.crossTurnMixedIntentSchemaIsolationSeen = true;
  return messageText("Cross-turn mixed-intent Tool Discovery drift verified.");
}

function assertLongCycleRankings(transcript, { minimumOccurrences }) {
  assert(
    countOccurrences(transcript, 'ToolSearch results for "apply a multi-line patch to a file"') >=
      minimumOccurrences,
    "long-cycle file-edit ToolSearch result was not visible"
  );
  assert(
    countOccurrences(transcript, 'ToolSearch results for "search workspace files"') >=
      minimumOccurrences,
    "long-cycle workspace ToolSearch result was not visible"
  );
  assert(
    countOccurrences(transcript, 'ToolSearch results for "automate browser click and screenshot"') >=
      minimumOccurrences,
    "long-cycle browser ToolSearch result was not visible"
  );
  assert(
    countOccurrences(transcript, 'ToolSearch results for "correct a wrong outdated memory"') >=
      minimumOccurrences,
    "long-cycle memory-correction ToolSearch result was not visible"
  );
  assert(
    countOccurrences(transcript, 'ToolSearch results for "search previous session memory history"') >=
      minimumOccurrences,
    "long-cycle memory-recall ToolSearch result was not visible"
  );
  assert(
    countOccurrences(transcript, 'ToolSearch results for "load a reusable skill workflow"') >=
      minimumOccurrences,
    "long-cycle skill ToolSearch result was not visible"
  );
  assert(
    countOccurrences(transcript, 'ToolSearch results for "dispatch parallel agent to peer machine"') >=
      minimumOccurrences,
    "long-cycle agent ToolSearch result was not visible"
  );
  assert(
    countOccurrences(transcript, "1. FilePatch") >= minimumOccurrences,
    "long-cycle file-edit search did not rank FilePatch first"
  );
  assert(
    countOccurrences(transcript, "1. Glob") >= minimumOccurrences,
    "long-cycle workspace search did not rank Glob first"
  );
  assert(
    countOccurrences(transcript, "1. Browser") >= minimumOccurrences,
    "unrelated browser intent was polluted by search history"
  );
  assert(
    countOccurrences(transcript, "1. MemoryCorrect") >= minimumOccurrences,
    "long-cycle memory-correction search did not rank MemoryCorrect first"
  );
  assert(
    countOccurrences(transcript, "1. SessionSearch") >= minimumOccurrences,
    "long-cycle memory-recall search did not rank SessionSearch first"
  );
  assert(
    countOccurrences(transcript, "1. Skill") >= minimumOccurrences,
    "long-cycle skill search did not rank Skill first"
  );
  assert(
    countOccurrences(transcript, "1. Agent") >= minimumOccurrences,
    "long-cycle agent search did not rank Agent first"
  );
  assert(
    transcript.includes("intent:workspace-search"),
    "long-cycle workspace intent feedback missing"
  );
  assert(transcript.includes("failure:path"), "long-cycle workspace failure feedback missing");
}

function assertLargeRepoRankings(transcript) {
  assert(
    transcript.includes('ToolSearch results for "search workspace files across a large repository"'),
    "large-repo workspace ToolSearch result was not visible"
  );
  assert(
    transcript.includes('ToolSearch results for "apply a multi-line patch to a file"'),
    "large-repo file-edit ToolSearch result was not visible"
  );
  assert(
    transcript.includes('ToolSearch results for "automate browser click and screenshot"'),
    "large-repo browser ToolSearch result was not visible"
  );
  assert(
    transcript.includes('ToolSearch results for "create zip release archive"'),
    "large-repo archive ToolSearch result was not visible"
  );
  assert(
    transcript.includes('ToolSearch results for "correct a wrong outdated memory"'),
    "large-repo memory-correction ToolSearch result was not visible"
  );
  assert(
    transcript.includes('ToolSearch results for "search previous session memory history"'),
    "large-repo memory-recall ToolSearch result was not visible"
  );
  assert(
    transcript.includes('ToolSearch results for "propose learning draft for stable workflow"'),
    "large-repo learning ToolSearch result was not visible"
  );
  assert(
    transcript.includes('ToolSearch results for "dispatch parallel agent to peer machine"'),
    "large-repo agent ToolSearch result was not visible"
  );
  assert(transcript.includes("1. Glob"), "large-repo workspace search did not rank Glob first");
  assert(
    transcript.includes("1. FilePatch"),
    "large-repo file-edit search did not rank FilePatch first"
  );
  assert(transcript.includes("1. Browser"), "large-repo browser search did not rank Browser first");
  assert(
    transcript.includes("1. ArchiveCreate"),
    "large-repo archive search did not rank ArchiveCreate first"
  );
  assert(
    transcript.includes("1. MemoryCorrect"),
    "large-repo memory-correction search did not rank MemoryCorrect first"
  );
  assert(
    transcript.includes("1. SessionSearch"),
    "large-repo memory-recall search did not rank SessionSearch first"
  );
  assert(
    transcript.includes("1. LearningDraft"),
    "large-repo learning search did not rank LearningDraft first"
  );
  assert(transcript.includes("1. Agent"), "large-repo agent search did not rank Agent first");
  assertTranscriptIntent(transcript, "workspace-search", "large-repo workspace intent missing");
  assertTranscriptIntent(transcript, "file-edit", "large-repo file-edit intent missing");
  assertTranscriptIntent(transcript, "browser-automation", "large-repo browser intent missing");
  assertTranscriptIntent(transcript, "archive-management", "large-repo archive intent missing");
  assertTranscriptIntent(
    transcript,
    "memory-correction",
    "large-repo memory-correction intent missing"
  );
  assertTranscriptIntent(transcript, "memory-recall", "large-repo memory-recall intent missing");
  assertTranscriptIntent(transcript, "skill-learning", "large-repo skill intent missing");
  assertTranscriptIntent(transcript, "parallel-agent", "large-repo agent intent missing");
  assert(transcript.includes("usage:+"), "large-repo persisted positive usage feedback missing");
  assert(transcript.includes("usage:-"), "large-repo persisted negative usage feedback missing");
}

function assertTranscriptIntent(transcript, intent, message) {
  const seen = transcript
    .split(/\r?\n/)
    .filter((line) => line.startsWith("intent:"))
    .flatMap((line) =>
      line
        .slice("intent:".length)
        .split(",")
        .map((value) => value.trim())
    );
  assert(seen.includes(intent), message);
}

function countOccurrences(value, pattern) {
  let count = 0;
  let index = 0;
  while (index < value.length) {
    const next = value.indexOf(pattern, index);
    if (next === -1) {
      return count;
    }
    count += 1;
    index = next + pattern.length;
  }
  return count;
}

async function startProvider({ routeRequest }) {
  const calls = [];
  const toolCounts = {};
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const toolNames = (body.tools ?? []).map((tool) => tool.function?.name).filter(Boolean);
        const call = {
          model: body.model ?? "unknown",
          latestUser: latestUserFromBody(body),
          transcript: transcriptFromBody(body),
          toolNames
        };
        calls.push(call);
        const result = routeRequest(call);
        for (const toolCall of (result.body ?? result).choices?.[0]?.message?.tool_calls ?? []) {
          const toolName = toolCall.function?.name;
          if (toolName) {
            toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1;
          }
        }
        response.writeHead(result.status ?? 200, { "content-type": "application/json" });
        response.end(JSON.stringify(result.body ?? result));
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: error instanceof Error ? error.message : String(error) }
          })
        );
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object", "tool discovery provider did not bind");
  return {
    calls,
    port: address.port,
    summary() {
      const exposedTools = new Set();
      const models = new Set();
      for (const call of calls) {
        if (call.model) models.add(call.model);
        for (const toolName of call.toolNames) {
          exposedTools.add(toolName);
        }
      }
      return {
        callCount: calls.length,
        models: Array.from(models).sort(),
        exposedToolCount: exposedTools.size,
        exposedTools: Array.from(exposedTools).sort(),
        toolCounts
      };
    },
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function runCli(args, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "--no-color", ...args], {
      cwd: workDir,
      env: {
        ...process.env,
        MAGI_CONFIG_DIR: configDir,
        MAGI_OPENAI_API_KEY: "test-key",
        NO_COLOR: "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `tool discovery eval timed out after ${timeoutMs}ms\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`
          )
        );
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `tool discovery eval failed with exit ${code ?? signal}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`
          )
        );
        return;
      }
      resolve(stdout);
    });
  });
}

function renderConfig({ port }) {
  return [
    "defaultProvider: openai",
    "defaultModel: main",
    "providers:",
    "  openai:",
    "    type: openai",
    "    apiKeyEnv: MAGI_OPENAI_API_KEY",
    `    baseUrl: http://127.0.0.1:${port}/v1`,
    "models:",
    "  aliases:",
    "    main: openai:mock-main",
    "  fallbacks: {}",
    ""
  ].join("\n");
}

function messageText(text) {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "mock-main",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: text }
      }
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 }
  };
}

function toolResponse(toolCalls) {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "mock-main",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: { role: "assistant", content: "", tool_calls: toolCalls }
      }
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 }
  };
}

function toolCall(id, name, input) {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(input)
    }
  };
}

function transcriptFromBody(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.map(textFromMessage).join("\n");
}

function latestUserFromBody(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      return textFromMessage(messages[index]);
    }
  }
  return "";
}

function textFromMessage(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .join("\n");
  }
  return "";
}

function readNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
