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
    assert(
      grepIntentPathFailures >= 4,
      "Grep workspace-search path failure kind was not recorded"
    );

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
  } finally {
    await provider.close();
  }
} finally {
  if (!process.env.MAGI_KEEP_TOOL_DISCOVERY_EVAL_TMP) {
    rmSync(root, { recursive: true, force: true });
  }
}

function createRouter(state) {
  let turn = 0;
  return ({ transcript, toolNames }) => {
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

async function startProvider({ routeRequest }) {
  const calls = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const toolNames = (body.tools ?? []).map((tool) => tool.function?.name).filter(Boolean);
        const call = {
          model: body.model ?? "unknown",
          transcript: transcriptFromBody(body),
          toolNames
        };
        calls.push(call);
        const result = routeRequest(call);
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
        exposedTools: Array.from(exposedTools).sort()
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
