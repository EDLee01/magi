#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");
const harnessReportPath = path.join(repoRoot, "dist", "harness-report.js");
const nodeBin = process.execPath;
const startedAt = new Date();
const reportPath = process.env.MAGI_BLACKBOX_REPORT || path.join(repoRoot, ".magi-reports", "blackbox-e2e.json");
let harnessReport;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function textFromMessage(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part.text === "string") return part.text;
      return "";
    }).join("\n");
  }
  return "";
}

function transcriptFromBody(body) {
  return (body.messages ?? []).map(textFromMessage).join("\n");
}

function messageText(text, model = "mock-main") {
  return {
    id: "msg_" + Math.random().toString(36).slice(2),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content: text },
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
}

function toolResponse(toolCalls, model = "mock-main") {
  return {
    id: "msg_" + Math.random().toString(36).slice(2),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      finish_reason: "tool_calls",
      message: { role: "assistant", content: "", tool_calls: toolCalls },
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
}

function toolCall(id, name, input) {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(input),
    },
  };
}

function fail(status, message) {
  return {
    status,
    body: {
      error: { message, type: "mock_assertion_failed" },
    },
  };
}

function renderConfig({ port, fallbacks = false }) {
  return [
    "defaultProvider: openai",
    "defaultModel: main",
    "providers:",
    "  openai:",
    "    type: openai",
    "    apiKeyEnv: MAGI_OPENAI_API_KEY",
    `    baseUrl: http://127.0.0.1:${port}/v1`,
    "  backup:",
    "    type: openai",
    "    apiKeyEnv: MAGI_OPENAI_API_KEY",
    `    baseUrl: http://127.0.0.1:${port}/v1`,
    "models:",
    "  aliases:",
    "    main: openai:mock-main",
    "    backup: backup:mock-backup",
    "  fallbacks:",
    fallbacks ? "    main:\n      - backup:mock-backup" : "    {}",
    "",
  ].join("\n");
}

async function withTempWorkspace(name, fn) {
  const root = mkdtempSync(path.join(os.tmpdir(), `magi-blackbox-${name}-`));
  const configDir = path.join(root, "config");
  const workDir = path.join(root, "work");
  await mkdir(configDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  try {
    return await fn({ root, configDir, workDir });
  } finally {
    if (!process.env.MAGI_KEEP_BLACKBOX_TMP) {
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function startProvider({ logPath, routeRequest }) {
  const calls = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Invalid JSON" } }));
        return;
      }

      const transcript = transcriptFromBody(body);
      const toolNames = (body.tools ?? []).map((tool) => tool.function?.name).filter(Boolean);
      const model = body.model ?? "unknown";
      calls.push({ path: request.url, model, transcript, toolNames });
      writeFileSync(logPath, JSON.stringify(calls, null, 2));

      let result;
      try {
        result = routeRequest({ body, transcript, toolNames, model, calls });
      } catch (error) {
        result = fail(500, error instanceof Error ? error.message : String(error));
      }

      response.writeHead(result.status ?? 200, { "content-type": "application/json" });
      response.end(JSON.stringify(result.body ?? result));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object", "mock provider did not bind to a TCP port");
  return {
    calls,
    port: address.port,
    summary() {
      const exposedTools = new Set();
      const models = new Set();
      for (const call of calls) {
        if (call.model) models.add(call.model);
        for (const toolName of call.toolNames ?? []) {
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
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function randomControlPort() {
  return 30_000 + Math.floor(Math.random() * 20_000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(url, { method = "GET", body, headers = {}, expectedStatus = 200 } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = {};
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Expected JSON from ${method} ${url}, got:\n${text}`);
    }
  }
  if (response.status !== expectedStatus) {
    throw new Error(
      `${method} ${url} returned ${response.status}, expected ${expectedStatus}\n${text}`
    );
  }
  return parsed;
}

function getJson(url, headers = {}, expectedStatus = 200) {
  return requestJson(url, { headers, expectedStatus });
}

function postJson(url, body, headers = {}, expectedStatus = 200) {
  return requestJson(url, { method: "POST", body, headers, expectedStatus });
}

function authHeaders(pairing) {
  return {
    authorization: `Bearer ${pairing.token}`,
    "x-magi-device-id": pairing.deviceId,
  };
}

async function waitFor(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(25);
  }
  const suffix = lastError instanceof Error ? `\nLast error: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${label}${suffix}`);
}

async function readSseUntil(url, headers, predicate, onChunk, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let text = "";
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok || !response.body) {
      throw new Error(`SSE request failed: ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        text += decoder.decode(result.value, { stream: true });
        onChunk?.(text);
        if (predicate(text)) {
          return text;
        }
      }
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Timed out waiting for SSE event from ${url}\nReceived:\n${text}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  throw new Error(`SSE predicate was not satisfied. Received:\n${text}`);
}

async function startServe({ configDir, workDir, controlPort }) {
  const child = spawn(nodeBin, [cliPath, "--no-color", "serve"], {
    cwd: workDir,
    env: {
      ...process.env,
      MAGI_CONFIG_DIR: configDir,
      MAGI_CONTROL_PORT: String(controlPort),
      MAGI_INTERACTION_TIMEOUT_MS: "10000",
      MAGI_OPENAI_API_KEY: "test-key",
      NO_COLOR: "1",
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    } else {
      child.kill("SIGTERM");
    }
    const closed = new Promise((resolve) => child.once("close", resolve));
    await Promise.race([closed, sleep(2_000)]);
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
      await Promise.race([closed, sleep(2_000)]);
    }
  };

  try {
    await waitFor(
      () => stdout.includes("Magi Control API listening on"),
      `control server on port ${controlPort}`,
      10_000
    );
  } catch (error) {
    await close();
    throw new Error(
      `magi serve did not start\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}\n${error instanceof Error ? error.message : String(error)}`
    );
  }

  return {
    url: `http://127.0.0.1:${controlPort}`,
    stdout: () => stdout,
    stderr: () => stderr,
    close,
  };
}

function runCommand({ command, args, cwd, configDir, label, inputText, timeoutMs = 30_000 }) {
  console.log(`+ ${label}: ${[command, ...args].map((part) => JSON.stringify(part)).join(" ")}`);
  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        MAGI_CONFIG_DIR: configDir,
        MAGI_OPENAI_API_KEY: "test-key",
        NO_COLOR: "1",
      },
      detached,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (detached && child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
        setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }, 2_000).unref();
      } else {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      }
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${label} timed out after ${timeoutMs}ms\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
        return;
      }
      resolve({ code, signal, stdout, stderr });
    });

    if (inputText !== undefined) {
      child.stdin.end(inputText);
    } else {
      child.stdin.end();
    }
  });
}

async function runCli({ args, cwd, configDir, label, timeoutMs = 30_000, expectExit = 0 }) {
  const result = await runCommand({
    command: nodeBin,
    args: [cliPath, "--no-color", ...args],
    cwd,
    configDir,
    label,
    timeoutMs,
  });
  if (result.code !== expectExit) {
    throw new Error(`${label} failed with exit ${result.code ?? result.signal}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  if (result.stderr.trim()) {
    console.error(result.stderr.trim());
  }
  return result.stdout;
}

async function runCliAllowFailure(input) {
  return runCommand({
    command: nodeBin,
    args: [cliPath, "--no-color", ...input.args],
    cwd: input.cwd,
    configDir: input.configDir,
    label: input.label,
    timeoutMs: input.timeoutMs ?? 30_000,
  });
}

function parseDraftId(output) {
  const match = output.match(/(?:id:|Memory Draft:)\s*([a-z0-9_-]+)/i);
  assert(match, `could not parse draft id from output:\n${output}`);
  return match[1];
}

function parseDreamId(output) {
  const match = output.match(/Experimental Dream created:\s*([a-z0-9_-]+)/i);
  assert(match, `could not parse dream id from output:\n${output}`);
  return match[1];
}

async function seedMemoryAndGoal({ workDir, configDir }) {
  await runCli({ args: ["memory", "init"], cwd: workDir, configDir, label: "memory init" });
  const userDraft = parseDraftId(await runCli({
    args: ["memory", "append", "user", "User prefers focused CLI black-box verification for complex Magi work."],
    cwd: workDir,
    configDir,
    label: "memory append user",
  }));
  await runCli({ args: ["memory", "draft", "apply", userDraft], cwd: workDir, configDir, label: "memory apply user" });

  const projectDraft = parseDraftId(await runCli({
    args: ["memory", "append", "project", "Run focused CLI E2E before internal unit tests for Magi changes."],
    cwd: workDir,
    configDir,
    label: "memory append project",
  }));
  await runCli({ args: ["memory", "draft", "apply", projectDraft], cwd: workDir, configDir, label: "memory apply project" });
  await runCli({ args: ["goal", "complex black-box E2E"], cwd: workDir, configDir, label: "goal start" });
}

function createComplexRouter() {
  let complexTurns = 0;
  return ({ transcript, toolNames }) => {
    if (transcript.includes("What should you remember about my verification preference?")) {
      assert(transcript.includes("focused CLI black-box verification"), "memory recall request did not receive hot user memory");
      return messageText("You prefer focused CLI black-box verification for complex Magi work, with concise summaries.");
    }

    if (!transcript.includes("Run the complex Magi black-box E2E")) {
      return messageText("OK");
    }

    complexTurns += 1;
    if (complexTurns === 1) {
      assert(transcript.includes("<active_thread_goal>"), "complex task missed active goal context");
      assert(transcript.includes("Objective: complex black-box E2E"), "complex task missed goal objective");
      assert(transcript.includes("[Relevant Memory]"), "complex task missed relevant memory");
      assert(transcript.includes("[Hot Memory]"), "complex task missed hot memory");
      assert(transcript.includes("focused CLI black-box verification"), "complex task missed user verification memory");
      assert(transcript.includes("Run focused CLI E2E before internal unit tests"), "complex task missed project workflow memory");
      assert(transcript.includes("use FilePatch for multi-line edits"), "complex task missed FilePatch edit-shape guidance");
      assert(transcript.includes("use FileEdit only for one exact string replacement"), "complex task missed FileEdit boundary guidance");
      assert(transcript.includes("If FilePatch fails, use its recovery feedback"), "complex task missed FilePatch recovery guidance");
      assert(toolNames.includes("ToolSearch"), "ToolSearch was not available as a core tool");
      assert(toolNames.includes("FilePatch"), "FilePatch was not available as a core tool");
      assert(!toolNames.includes("LearningDraft"), "LearningDraft should start as a deferred tool");
      return toolResponse([
        toolCall("tool-search-patch", "ToolSearch", { query: "apply a multi-line patch to a file", max_results: 3 }),
        toolCall("tool-select-learning", "ToolSearch", { query: "select:LearningDraft" }),
        toolCall("workspace-diag", "WorkspaceDiagnostics", {}),
      ]);
    }

    if (complexTurns === 2) {
      assert(toolNames.includes("LearningDraft"), "LearningDraft was not revealed after ToolSearch");
      assert(transcript.includes("1. FilePatch"), "ToolSearch did not rank FilePatch first for patch intent");
      assert(transcript.includes("intent: file-edit"), "ToolSearch did not report file-edit intent");
      assert(transcript.includes("Workspace Diagnostics"), "WorkspaceDiagnostics result was not returned");
      return toolResponse([
        toolCall("write-report", "FileWrite", {
          file_path: "reports/e2e-result.md",
          content: "# Magi Black-Box E2E\n\nFocused CLI business flow passed.\n\n- goal context loaded\n- hot memory loaded\n- deferred tool revealed\n",
        }),
        toolCall("todo-update", "TodoWrite", {
          todos: [
            { id: "bb-1", content: "Create black-box report", status: "completed" },
            { id: "bb-2", content: "Persist learned verification workflow", status: "completed" },
          ],
        }),
        toolCall("memorize-workflow", "Memorize", {
          type: "workflow",
          name: "Focused CLI E2E workflow",
          description: "Run focused CLI E2E before internal unit tests for Magi changes.",
          body: "Run focused CLI E2E before internal unit tests for Magi changes, especially when validating harness behavior.",
          weight: 0.92,
        }),
      ]);
    }

    if (complexTurns === 3) {
      assert(transcript.includes("Focused CLI business flow passed"), "FileWrite result was not visible");
      assert(transcript.includes("Todo list replaced"), "TodoWrite result was not visible");
      assert(transcript.includes("Wrote Memory node"), "Memorize result was not visible");
      return toolResponse([
        toolCall("memorize-workflow-duplicate", "Memorize", {
          type: "workflow",
          name: "Focused CLI E2E workflow",
          description: "Run focused CLI E2E before internal unit tests for Magi changes.",
          body: "Run focused CLI E2E before internal unit tests for Magi changes, especially when checking harness regressions.",
          weight: 0.43,
        }),
        toolCall("patch-report", "FilePatch", {
          file_path: "reports/e2e-result.md",
          patch: [
            "@@",
            " - goal context loaded",
            "-stale patch context",
            "+- FilePatch recovery first attempt",
          ].join("\n"),
        }),
      ]);
    }

    if (complexTurns === 4) {
      assert(transcript.includes("FilePatch failed for reports/e2e-result.md"), "FilePatch failure did not name the target");
      assert(transcript.includes("Recovery guidance:"), "FilePatch failure did not include recovery guidance");
      assert(transcript.includes("Current file snippet:"), "FilePatch failure did not include current file context");
      return toolResponse([
        toolCall("patch-report-retry", "FilePatch", {
          file_path: "reports/e2e-result.md",
          patch: [
            "@@",
            " - goal context loaded",
            " - hot memory loaded",
            " - deferred tool revealed",
            "+- FilePatch core edit verified",
          ].join("\n"),
        }),
      ]);
    }

    if (complexTurns === 5) {
      assert(transcript.includes("Patched reports/e2e-result.md"), "FilePatch result was not visible");
      return toolResponse([
        toolCall("learning-propose", "LearningDraft", {
          action: "propose",
          kind: "memory",
          target: "workflows/focused-cli-e2e.md",
          content: "# Focused CLI E2E workflow\n\nRun the real CLI with an isolated MAGI_CONFIG_DIR and a mock provider, then verify files, memory, goals, and learning drafts.\n",
          reason: "Use real Magi CLI commands with a temp config and mock provider before relying on unit tests.",
          evidence: ["Validated by scripts/blackbox-e2e.mjs"],
          confidence: 0.91,
        }),
        toolCall("notify-user", "SendUserMessage", { message: "Complex black-box E2E finished." }),
      ]);
    }

    assert(transcript.includes("Created LearningDraft"), "LearningDraft proposal was not created");
    assert(transcript.includes("User message delivered"), "SendUserMessage result was not visible");
    return messageText("Complex black-box E2E completed with real CLI, memory, goal, tools, and learning draft.");
  };
}

async function scenarioComplexWorkflow() {
  return await withTempWorkspace("complex", async ({ root, configDir, workDir }) => {
    const providerLog = path.join(root, "provider-log.json");
    const provider = await startProvider({ logPath: providerLog, routeRequest: createComplexRouter() });
    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig({ port: provider.port }));
      await seedMemoryAndGoal({ workDir, configDir });

      const complexOutput = await runCli({
        args: [
          "--permission-mode", "acceptEdits",
          "--model", "main",
          "--output-format", "stream-json",
          "-c",
          "-p",
          "Run the complex Magi black-box E2E using focused CLI E2E workflow. Write a report, track todo state, memorize the workflow, and create a learning draft.",
        ],
        cwd: workDir,
        configDir,
        label: "complex prompt",
        timeoutMs: 45_000,
      });
      assert(complexOutput.includes("session.completed") && complexOutput.includes("Complex black-box E2E completed"), "complex headless prompt did not complete");

      const reportPath = path.join(workDir, "reports", "e2e-result.md");
      assert(existsSync(reportPath), "complex task did not create report file");
      assert(readFileSync(reportPath, "utf8").includes("Focused CLI business flow passed"), "report file content was not written correctly");
      assert(readFileSync(reportPath, "utf8").includes("FilePatch core edit verified"), "FilePatch did not update the report file");

      const todosPath = path.join(configDir, "state", "todos.json");
      assert(existsSync(todosPath), "TodoWrite did not persist todo state");
      assert(readFileSync(todosPath, "utf8").includes("Persist learned verification workflow"), "todo state missing item");

      const recall = await runCli({
        args: ["--model", "main", "-c", "-p", "What should you remember about my verification preference?"],
        cwd: workDir,
        configDir,
        label: "memory recall",
      });
      assert(recall.includes("focused CLI black-box verification"), "memory recall answer missed verification preference");

      const learningList = await runCli({ args: ["learning", "list"], cwd: workDir, configDir, label: "learning list" });
      assert(learningList.includes("LearningDrafts:"), "learning draft list was empty");
      assert(learningList.includes("workflows/focused-cli-e2e.md"), "learning draft target was not listed");

      const memorySearch = await runCli({ args: ["memory", "search", "CLI E2E workflow"], cwd: workDir, configDir, label: "memory search" });
      assert(memorySearch.includes("focused CLI E2E"), "memory search did not find memorized workflow");
      await runCli({
        args: [
          "memory",
          "link",
          "--from",
          "Run focused CLI E2E before internal unit tests for Magi changes, especially when checking harness regressions.",
          "--to",
          "User prefers focused CLI black-box verification for complex Magi work.",
          "--relation",
          "relates_to",
          "--weight",
          "0.8",
        ],
        cwd: workDir,
        configDir,
        label: "complex duplicate memory link",
      });
      const dream = await runCli({ args: ["memory", "dream"], cwd: workDir, configDir, label: "complex memory dream duplicate" });
      assert(dream.includes("duplicate"), "memory dream did not detect duplicate graph workflow");
      const dreamId = parseDreamId(dream);
      const appliedDream = await runCli({
        args: ["memory", "dream", "apply", dreamId],
        cwd: workDir,
        configDir,
        label: "complex memory dream apply duplicate",
      });
      assert(appliedDream.includes("Archived graph nodes: 1"), "memory dream did not archive duplicate graph workflow");
      assert(appliedDream.includes("Redirected graph edges: 1"), "memory dream did not redirect duplicate graph edges");
      assert(appliedDream.includes("Fused graph node weights: 1"), "memory dream did not fuse duplicate graph node weight");
      assert(appliedDream.includes("Resolved graph edge conflicts: 0"), "memory dream reported unexpected graph edge conflicts");
      const mergeAudit = await runCli({ args: ["memory", "merges", "--limit", "5"], cwd: workDir, configDir, label: "complex memory merges" });
      assert(mergeAudit.includes("Memory graph merges: 1"), "memory merges did not list duplicate workflow merge");
      assert(mergeAudit.includes("Focused CLI E2E workflow -> Focused CLI E2E workflow"), "memory merges did not show duplicate workflow titles");
      assert(mergeAudit.includes("redirected edges: 1"), "memory merges did not show redirected edge count");
      assert(mergeAudit.includes("dream:"), "memory merges did not include dream id");
      const evalCaseFile = path.join(workDir, "memory-recall-eval.json");
      writeFileSync(evalCaseFile, JSON.stringify({
        name: "complex memory recall",
        cases: [{
          name: "workflow and preference recall",
          query: "CLI E2E workflow verification preference",
          expect: ["Focused CLI E2E workflow", "focused CLI black-box verification"],
          forbid: ["verbose terminal dumps"],
          minResults: 2,
        }],
      }, null, 2));
      const memoryEval = await runCli({
        args: ["memory", "eval", "--case-file", evalCaseFile, "--max-results", "5"],
        cwd: workDir,
        configDir,
        label: "complex memory recall eval",
      });
      assert(memoryEval.includes("Memory recall eval: complex memory recall"), "memory eval did not run named suite");
      assert(memoryEval.includes("1. PASS workflow and preference recall"), "memory eval did not pass complex recall case");
      assert(memoryEval.includes("score: 1.00"), "memory eval did not report perfect score");

      await runCli({ args: ["goal", "done", "verified"], cwd: workDir, configDir, label: "goal done" });
      const goalStatus = await runCli({ args: ["goal"], cwd: workDir, configDir, label: "goal status" });
      assert(goalStatus.includes("No active goal"), "goal was not completed");
      assert(provider.calls.length >= 5, "provider was not exercised enough for a complex flow");
      return {
        score: 1,
        assertions: [
          "goal context loaded",
          "hot and relevant memory loaded",
          "deferred tool revealed",
          "report file written and patched",
          "todo state persisted",
          "memory search found learned workflow",
          "Dream archived duplicate workflow memory",
          "Dream redirected duplicate workflow graph edge",
          "Dream fused duplicate workflow weight",
          "memory merge audit listed duplicate workflow",
          "memory recall quality eval passed",
          "learning draft listed"
        ],
        filesVerified: ["reports/e2e-result.md", "state/todos.json"],
        provider: provider.summary()
      };
    } catch (error) {
      printProviderLog(providerLog);
      throw error;
    } finally {
      await provider.close();
    }
  });
}

async function scenarioDefaultPermissionDenied() {
  return await withTempWorkspace("permission", async ({ root, configDir, workDir }) => {
    const providerLog = path.join(root, "provider-log.json");
    let turn = 0;
    const provider = await startProvider({
      logPath: providerLog,
      routeRequest: ({ transcript }) => {
        turn += 1;
        if (turn === 1) {
          return toolResponse([toolCall("denied-write", "FileWrite", { file_path: "denied.txt", content: "no" })]);
        }
        assert(transcript.includes("Permission ask: FileWrite requires approval"), "default permission denial was not returned to the model");
        return messageText("Default permission denial observed.");
      },
    });
    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig({ port: provider.port }));
      const output = await runCli({
        args: ["--model", "main", "--output-format", "stream-json", "-p", "Try to write a file without permission mode."],
        cwd: workDir,
        configDir,
        label: "default permission denied",
      });
      assert(output.includes("approval_request"), "default permission path did not emit approval_request");
      assert(output.includes("Default permission denial observed"), "model did not observe permission denial");
      assert(!existsSync(path.join(workDir, "denied.txt")), "denied write unexpectedly created a file");
      assert(turn === 2, "permission denial scenario should complete in two provider turns");
      return {
        score: 1,
        assertions: ["approval request emitted", "permission denial returned to model", "denied write did not mutate workspace"],
        provider: provider.summary()
      };
    } catch (error) {
      printProviderLog(providerLog);
      throw error;
    } finally {
      await provider.close();
    }
  });
}

async function scenarioRetryAndFallback() {
  return await withTempWorkspace("retry-fallback", async ({ root, configDir, workDir }) => {
    const providerLog = path.join(root, "provider-log.json");
    let primaryCalls = 0;
    let backupCalls = 0;
    const provider = await startProvider({
      logPath: providerLog,
      routeRequest: ({ model }) => {
        if (model === "mock-main") {
          primaryCalls += 1;
          if (primaryCalls <= 3) {
            return fail(500, "primary transient failure");
          }
          return messageText("unexpected primary success", "mock-main");
        }
        if (model === "mock-backup") {
          backupCalls += 1;
          return messageText("fallback recovered", "mock-backup");
        }
        return fail(400, `unexpected model ${model}`);
      },
    });
    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig({ port: provider.port, fallbacks: true }));
      const output = await runCli({
        args: ["--model", "main", "--output-format", "stream-json", "-p", "Exercise retry and fallback."],
        cwd: workDir,
        configDir,
        label: "retry fallback",
        timeoutMs: 45_000,
      });
      assert(output.includes("fallback_switched"), "fallback event was not present in stream-json output");
      assert(output.includes("fallback recovered"), "fallback route did not provide the final answer");
      assert(primaryCalls === 3, `expected three fast attempts before fallback, got ${primaryCalls} primary calls`);
      assert(backupCalls === 1, `expected one backup call, got ${backupCalls}`);
      return {
        score: 1,
        assertions: ["retry attempts exhausted on primary", "fallback event emitted", "backup model recovered"],
        provider: provider.summary(),
        retry: { primaryCalls, backupCalls }
      };
    } catch (error) {
      printProviderLog(providerLog);
      throw error;
    } finally {
      await provider.close();
    }
  });
}

async function scenarioMemoryGraphLink() {
  return await withTempWorkspace("memory-graph-link", async ({ configDir, workDir }) => {
    writeFileSync(path.join(configDir, "config.yaml"), renderConfig({ port: 9 }));
    await runCli({ args: ["memory", "init"], cwd: workDir, configDir, label: "memory graph init" });
    const draftId = parseDraftId(await runCli({
      args: [
        "memory",
        "append",
        "project",
        [
          "## Graph CLI anchor",
          "Magi CLI exposes durable graph memory linking.",
          "",
          "## Linked workflow neighbor",
          "Run business-level verification after graph memory changes.",
        ].join("\n"),
      ],
      cwd: workDir,
      configDir,
      label: "memory graph append",
    }));
    await runCli({ args: ["memory", "draft", "apply", draftId], cwd: workDir, configDir, label: "memory graph apply" });
    const linked = await runCli({
      args: [
        "memory",
        "link",
        "--from",
        "Graph CLI anchor",
        "--to",
        "Linked workflow neighbor",
        "--relation",
        "relates_to",
        "--weight",
        "0.9",
      ],
      cwd: workDir,
      configDir,
      label: "memory graph link",
    });
    assert(linked.includes("Linked Memory nodes:"), "memory link did not create an edge");
    assert(linked.includes("relates_to -> Linked workflow neighbor"), "memory link did not show the target node");

    const search = await runCli({
      args: ["memory", "search", "durable graph memory linking"],
      cwd: workDir,
      configDir,
      label: "memory graph search",
    });
    assert(search.includes("Graph CLI anchor"), "memory graph search missed direct anchor");
    assert(search.includes("Linked workflow neighbor"), "memory graph search missed linked neighbor");
    return {
      score: 1,
      assertions: ["memory draft applied", "graph edge created", "linked neighbor retrieved through graph search"]
    };
  });
}

async function scenarioMemoryCorrection() {
  return await withTempWorkspace("memory-correction", async ({ configDir, workDir }) => {
    writeFileSync(path.join(configDir, "config.yaml"), renderConfig({ port: 9 }));
    await runCli({ args: ["memory", "init"], cwd: workDir, configDir, label: "memory correction init" });
    const draftId = parseDraftId(await runCli({
      args: [
        "memory",
        "append",
        "user",
        "The user prefers verbose terminal dumps after verification."
      ],
      cwd: workDir,
      configDir,
      label: "memory correction append",
    }));
    await runCli({ args: ["memory", "draft", "apply", draftId], cwd: workDir, configDir, label: "memory correction apply" });
    const before = await runCli({
      args: ["memory", "search", "verbose terminal dumps verification"],
      cwd: workDir,
      configDir,
      label: "memory correction search before",
    });
    assert(before.includes("verbose terminal dumps"), "correction precondition did not retrieve stale memory");

    const corrected = await runCli({
      args: [
        "memory",
        "correct",
        "--target",
        "verbose terminal dumps",
        "--reason",
        "User corrected the stale verification output preference.",
        "--replacement",
        "The user prefers concise verification summaries with only key outcomes.",
        "--replacement-summary",
        "Correct verification output preference.",
        "--type",
        "preference"
      ],
      cwd: workDir,
      configDir,
      label: "memory correction correct",
    });
    assert(corrected.includes("Corrected Memory node:"), "memory correction did not dispute a node");
    assert(corrected.includes("replacement:"), "memory correction did not create a replacement");
    const correctedNodeId = parseCorrectedNodeId(corrected);

    const after = await runCli({
      args: ["memory", "search", "verbose terminal dumps verification"],
      cwd: workDir,
      configDir,
      label: "memory correction search after",
    });
    assert(after.includes("concise verification summaries"), "replacement memory was not recalled");
    assert(!after.includes("prefers verbose terminal dumps"), "disputed stale memory was still recalled");
    const conflicts = await runCli({
      args: ["memory", "conflicts"],
      cwd: workDir,
      configDir,
      label: "memory conflicts",
    });
    assert(conflicts.includes("Memory graph conflicts:"), "memory conflicts did not list graph conflicts");
    assert(conflicts.includes("recommendation: prefer_from"), "memory conflicts did not recommend active replacement");
    assert(conflicts.includes("edge reason:"), "memory conflicts did not include correction edge reason");
    const dream = await runCli({
      args: ["memory", "dream"],
      cwd: workDir,
      configDir,
      label: "memory dream graph cleanup",
    });
    assert(dream.includes("archive_candidate"), "memory dream did not include graph archive candidate");
    assert(dream.includes("Drafts:"), "memory dream did not create reviewable drafts");
    const dreamId = parseDreamId(dream);
    const appliedDream = await runCli({
      args: ["memory", "dream", "apply", dreamId],
      cwd: workDir,
      configDir,
      label: "memory dream apply graph cleanup",
    });
    assert(appliedDream.includes("Archived graph nodes: 1"), "memory dream apply did not archive graph node");
    assertGraphNodeStatus(configDir, correctedNodeId, "archived");
    const maintenanceConfig = await runCli({
      args: [
        "memory",
        "maintain",
        "config",
        "--older-than-days",
        "0",
        "--decay",
        "0.1",
        "--min-weight",
        "0.4",
        "--limit",
        "5"
      ],
      cwd: workDir,
      configDir,
      label: "memory maintenance config",
    });
    assert(maintenanceConfig.includes("Memory maintenance policy"), "memory maintenance config did not run");
    assert(maintenanceConfig.includes("decay: 0.100"), "memory maintenance config did not persist decay");
    const maintenancePreview = await runCli({
      args: ["memory", "maintain"],
      cwd: workDir,
      configDir,
      label: "memory maintenance preview",
    });
    assert(maintenancePreview.includes("Memory maintenance preview"), "memory maintenance preview did not run");
    assert(maintenancePreview.includes("changed:"), "memory maintenance preview did not report changed count");
    assert(maintenancePreview.includes("decay: 0.100"), "memory maintenance preview did not use configured policy");
    const maintenanceApply = await runCli({
      args: ["memory", "maintain", "--apply"],
      cwd: workDir,
      configDir,
      label: "memory maintenance apply",
    });
    assert(maintenanceApply.includes("Memory maintenance applied"), "memory maintenance apply did not run");
    assert(maintenanceApply.includes("->"), "memory maintenance did not report weight decay");
    const auditPath = path.join(configDir, "memory", "logs", "audit.jsonl");
    assert(existsSync(auditPath), "memory correction audit log was not written");
    const audit = readFileSync(auditPath, "utf8");
    assert(audit.includes("memory.corrected"), "memory correction audit event missing");
    assert(audit.includes("memory.dream.applied"), "memory dream apply audit event missing");
    assert(audit.includes("memory.maintenance.configured"), "memory maintenance config audit event missing");
    assert(audit.includes("memory.maintenance.applied"), "memory maintenance audit event missing");
    return {
      score: 1,
      assertions: [
        "stale memory retrieved before correction",
        "memory correct disputed old node",
        "replacement memory recalled through graph search",
        "disputed stale memory excluded from search results",
        "memory conflict audit view recommends active replacement",
        "memory dream suggests corrected stale graph cleanup",
        "memory dream apply archives corrected disputed graph node",
        "memory maintenance policy persisted and reused",
        "memory maintenance decayed stale node weights",
        "memory correction and maintenance audit persisted"
      ]
    };
  });
}

function parseCorrectedNodeId(output) {
  const match = output.match(/Corrected Memory node:\s*([a-z0-9-]+)/i);
  assert(match, `could not parse corrected node id from output:\n${output}`);
  return match[1];
}

function assertGraphNodeStatus(configDir, nodeId, expectedStatus) {
  const script = [
    "import Database from 'better-sqlite3';",
    "const [dbFile, nodeId, expectedStatus] = process.argv.slice(1);",
    "const db = new Database(dbFile);",
    "const row = db.prepare('select status from memory_nodes where id = ?').get(nodeId);",
    "db.close();",
    "if (!row) throw new Error(`node not found: ${nodeId}`);",
    "if (row.status !== expectedStatus) throw new Error(`expected ${expectedStatus}, got ${row.status}`);",
  ].join("\n");
  const result = spawnSync(nodeBin, ["--input-type=module", "-e", script, path.join(configDir, "state", "sessions.sqlite"), nodeId, expectedStatus], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MAGI_CONFIG_DIR: configDir,
      MAGI_OPENAI_API_KEY: "test-key",
      NO_COLOR: "1",
    },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`graph node status check failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
}

async function scenarioToolFeedbackRanking() {
  return await withTempWorkspace("tool-feedback", async ({ root, configDir, workDir }) => {
    const providerLog = path.join(root, "provider-log.json");
    let turn = 0;
    const provider = await startProvider({
      logPath: providerLog,
      routeRequest: ({ transcript }) => {
        turn += 1;
        if (turn === 1) {
          return toolResponse([
            toolCall("grep-bad-path-1", "Grep", { pattern: "needle", path: "../outside" }),
            toolCall("grep-bad-path-2", "Grep", { pattern: "needle", path: "../outside" }),
            toolCall("grep-bad-path-3", "Grep", { pattern: "needle", path: "../outside" }),
            toolCall("grep-bad-path-4", "Grep", { pattern: "needle", path: "../outside" }),
            toolCall("glob-ok-1", "Glob", { pattern: "**/*.md" }),
            toolCall("glob-ok-2", "Glob", { pattern: "**/*.md" }),
            toolCall("glob-ok-3", "Glob", { pattern: "**/*.md" }),
            toolCall("glob-ok-4", "Glob", { pattern: "**/*.md" }),
          ]);
        }
        assert(transcript.includes("Search path is outside allowed directories"), "Grep failure was not visible to the model");
        assert(transcript.includes("No matches"), "Glob success was not visible to the model");
        return toolResponse([
          toolCall("tool-search-after-feedback", "ToolSearch", { query: "search workspace files", max_results: 5 }),
        ]);
      },
    });
    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig({ port: provider.port }));
      const output = await runCli({
        args: [
          "--permission-mode", "acceptEdits",
          "--model", "main",
          "--output-format", "stream-json",
          "-p",
          "Exercise tool feedback ranking by trying search tools, then ask ToolSearch for workspace file search.",
        ],
        cwd: workDir,
        configDir,
        label: "tool feedback ranking",
      });
      assert(output.includes("1. Glob"), "ToolSearch did not rank successful Glob ahead after feedback");
      assert(output.includes("usage:+"), "ToolSearch did not report positive usage feedback");
      assert(output.includes("usage:-"), "ToolSearch did not report negative usage feedback");
      const statsPath = path.join(configDir, "state", "tool-usage-stats.json");
      assert(existsSync(statsPath), "tool feedback stats were not persisted");
      const stats = JSON.parse(readFileSync(statsPath, "utf8"));
      assert(stats.tools?.Grep?.failures === 4, "Grep failures were not recorded");
      assert(stats.tools?.Glob?.successes === 4, "Glob successes were not recorded");
      return {
        score: 1,
        assertions: ["tool failures persisted", "tool successes persisted", "ToolSearch ranking used feedback"],
        provider: provider.summary(),
        toolFeedback: {
          grepFailures: stats.tools.Grep.failures,
          globSuccesses: stats.tools.Glob.successes
        }
      };
    } catch (error) {
      printProviderLog(providerLog);
      throw error;
    } finally {
      await provider.close();
    }
  });
}

async function scenarioPlanMode() {
  return await withTempWorkspace("plan", async ({ root, configDir, workDir }) => {
    const providerLog = path.join(root, "provider-log.json");
    let turn = 0;
    const plan = "1. Inspect the requested files\n2. Show this plan before implementation\n3. Wait for approval";
    const provider = await startProvider({
      logPath: providerLog,
      routeRequest: ({ transcript }) => {
        turn += 1;
        if (turn === 1) {
          return toolResponse([toolCall("plan-write-denied", "FileWrite", {
            file_path: "should-not-edit.txt",
            content: "plan mode should block this",
          })]);
        }
        if (turn === 2) {
          assert(transcript.includes("FileWrite is not allowed in plan mode"), "plan mode did not deny a write tool");
          return toolResponse([toolCall("submit-plan", "ExitPlanMode", { plan })]);
        }
        assert(transcript.includes("Plan submitted for user approval"), "headless plan mode did not return a plan review result");
        assert(transcript.includes("Show this plan before implementation"), "plan content was not visible after ExitPlanMode");
        return messageText("Plan mode surfaced the plan and stopped before implementation.");
      },
    });
    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig({ port: provider.port }));
      const output = await runCli({
        args: ["--permission-mode", "plan", "--model", "main", "--output-format", "stream-json", "-p", "Plan a risky implementation before editing."],
        cwd: workDir,
        configDir,
        label: "plan mode",
      });
      assert(output.includes("Plan mode surfaced the plan"), "plan mode final answer missing");
      assert(!existsSync(path.join(workDir, "should-not-edit.txt")), "plan mode should not mutate workspace");
      const planStatus = await runCli({ args: ["plan"], cwd: workDir, configDir, label: "plan status" });
      assert(planStatus.includes("Status: submitted"), "submitted plan was not persisted");
      assert(planStatus.includes("Show this plan before implementation"), "persisted plan did not include plan content");
      return {
        score: 1,
        assertions: ["write denied in plan mode", "ExitPlanMode surfaced plan", "plan review persisted"],
        provider: provider.summary()
      };
    } catch (error) {
      printProviderLog(providerLog);
      throw error;
    } finally {
      await provider.close();
    }
  });
}

async function scenarioControlApprovalFlow() {
  return await withTempWorkspace("control-approval", async ({ root, configDir, workDir }) => {
    const providerLog = path.join(root, "provider-log.json");
    const controlPort = randomControlPort();
    let turn = 0;
    const provider = await startProvider({
      logPath: providerLog,
      routeRequest: ({ transcript }) => {
        turn += 1;
        if (turn === 1) {
          return toolResponse([
            toolCall("approve-mobile", "FileWrite", {
              file_path: "mobile-control.txt",
              content: "approved by mobile control",
            }),
          ]);
        }
        assert(
          transcript.includes("Permission approved") ||
            transcript.includes("Wrote mobile-control.txt"),
          "control approval result was not returned to the model"
        );
        return messageText("CONTROL APPROVAL DONE");
      },
    });
    let serve;
    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig({ port: provider.port }));
      serve = await startServe({ configDir, workDir, controlPort });

      const health = await getJson(`${serve.url}/health`);
      assert(health.ok === true, "control health check failed");
      const pairing = await postJson(`${serve.url}/pairing`, { name: "phone-blackbox" });
      assert(pairing.deviceId && pairing.token, "control pairing did not return credentials");
      const headers = authHeaders(pairing);

      const started = await postJson(
        `${serve.url}/jobs`,
        {
          prompt: "Write a file through mobile Control API approval.",
          model: "main",
          background: true,
        },
        headers,
        202
      );
      assert(started.jobId && started.sessionId, "background control job did not start");

      let sseReady = false;
      const ssePromise = readSseUntil(
        `${serve.url}/events?jobId=${encodeURIComponent(started.jobId)}&limit=20`,
        headers,
        (text) =>
          text.includes("agent.approval.pending") &&
          text.includes("control.approval.resolved"),
        (text) => {
          if (text.includes("event: ready")) {
            sseReady = true;
          }
        }
      );
      await waitFor(() => sseReady, "control SSE ready");

      let pendingInteractions = [];
      await waitFor(async () => {
        const response = await getJson(
          `${serve.url}/jobs/${encodeURIComponent(started.jobId)}/interactions`,
          headers
        );
        pendingInteractions = response.interactions ?? [];
        return pendingInteractions.some(
          (interaction) =>
            interaction.kind === "approval" &&
            interaction.status === "pending" &&
            interaction.toolUseId === "approve-mobile"
        );
      }, "pending mobile approval");

      const resolved = await postJson(
        `${serve.url}/jobs/${encodeURIComponent(started.jobId)}/approvals/approve-mobile`,
        { decision: "approve", responder: "phone-blackbox" },
        headers
      );
      assert(resolved.ok === true, "control approval resolution failed");
      assert(resolved.interaction?.approved === true, "control approval was not approved");

      const sse = await ssePromise;
      await waitFor(async () => {
        const response = await getJson(
          `${serve.url}/jobs/${encodeURIComponent(started.jobId)}`,
          headers
        );
        return response.job?.status === "completed";
      }, "control job completion", 10_000);
      const job = await getJson(`${serve.url}/jobs/${encodeURIComponent(started.jobId)}`, headers);
      const events = await getJson(
        `${serve.url}/jobs/${encodeURIComponent(started.jobId)}/events?limit=50`,
        headers
      );
      const filePath = path.join(workDir, "mobile-control.txt");
      assert(existsSync(filePath), "control-approved FileWrite did not create the file");
      assert(
        readFileSync(filePath, "utf8") === "approved by mobile control",
        "control-approved file content was wrong"
      );
      const actions = (events.events ?? []).map((event) => event.action);
      assert(actions.includes("agent.approval.pending"), "job events missed pending approval");
      assert(actions.includes("control.approval.resolved"), "job events missed approval resolve");
      assert(sse.includes("agent.approval.pending"), "SSE missed pending approval event");
      assert(sse.includes("control.approval.resolved"), "SSE missed resolved approval event");
      assert(job.job?.status === "completed", "control job did not complete");
      assert(turn === 2, "control approval scenario should complete in two provider turns");
      return {
        score: 1,
        assertions: [
          "magi serve started from dist CLI",
          "phone pairing returned auth headers",
          "background job exposed pending approval",
          "SSE streamed pending and resolved approval events",
          "phone approval unblocked FileWrite",
          "control job completed and persisted audit events",
        ],
        control: {
          port: controlPort,
          jobId: started.jobId,
          eventCount: events.events?.length ?? 0,
        },
        provider: provider.summary(),
        filesVerified: ["mobile-control.txt"],
      };
    } catch (error) {
      printProviderLog(providerLog);
      if (serve) {
        console.error("\nControl server stdout:");
        console.error(serve.stdout());
        console.error("\nControl server stderr:");
        console.error(serve.stderr());
      }
      throw error;
    } finally {
      if (serve) {
        await serve.close();
      }
      await provider.close();
    }
  });
}

async function scenarioInteractiveTui() {
  return await withTempWorkspace("tui", async ({ configDir, workDir }) => {
    writeFileSync(path.join(configDir, "config.yaml"), renderConfig({ port: 9 }));
    const inputFile = path.join(workDir, "tui-input.txt");
    writeFileSync(inputFile, "/exit\r");
    const result = process.platform === "darwin"
      ? await runCommand({
        command: "/bin/sh",
        args: ["-c", `script -q /dev/null ${shellQuote(nodeBin)} ${shellQuote(cliPath)} --no-color < ${shellQuote(inputFile)}`],
        cwd: workDir,
        configDir,
        label: "interactive TUI",
        timeoutMs: 15_000,
      })
      : await runCommand({
        command: "/bin/sh",
        args: ["-c", `script -q -e -c ${shellQuote(`${shellQuote(nodeBin)} ${shellQuote(cliPath)} --no-color`)} /dev/null < ${shellQuote(inputFile)}`],
        cwd: workDir,
        configDir,
        label: "interactive TUI",
        timeoutMs: 15_000,
      });

    assert(result.code === 0, `interactive TUI exited ${result.code ?? result.signal}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
    const combined = `${result.stdout}\n${result.stderr}`;
    assert(combined.includes("Magi v"), "TUI banner did not render");
    assert(combined.includes("/help for commands"), "TUI help hint did not render");
    assert(!combined.includes("Interactive terminal requires a TTY"), "TUI did not receive a pseudo-TTY");
    return {
      score: 1,
      assertions: ["TUI banner rendered", "help hint rendered", "pseudo-TTY accepted"]
    };
  });
}

async function scenarioTuiRequiresTty() {
  return await withTempWorkspace("tui-no-tty", async ({ configDir, workDir }) => {
    writeFileSync(path.join(configDir, "config.yaml"), renderConfig({ port: 9 }));
    const result = await runCommand({
      command: nodeBin,
      args: [cliPath, "--no-color"],
      cwd: workDir,
      configDir,
      label: "TUI requires TTY",
      timeoutMs: 15_000,
    });

    assert(result.code === 2, `non-TTY TUI exited ${result.code ?? result.signal}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
    assert(result.stdout.includes("Interactive terminal requires a TTY"), "non-TTY TUI did not explain the TTY requirement");
    return {
      score: 1,
      assertions: ["non-TTY TUI exits clearly", "TTY requirement message emitted"]
    };
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function printProviderLog(providerLog) {
  if (existsSync(providerLog)) {
    console.error("\nProvider log:");
    console.error(readFileSync(providerLog, "utf8"));
  }
}

async function runScenario(name, fn) {
  const startedAt = Date.now();
  console.log(`\n=== ${name} ===`);
  try {
    const details = await fn();
    const durationMs = Date.now() - startedAt;
    console.log(`✓ ${name} (${durationMs}ms)`);
    return {
      name,
      status: "passed",
      durationMs,
      score: typeof details?.score === "number" ? details.score : 1,
      failureKind: null,
      details: details ?? {}
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const failureKind = harnessReport.classifyHarnessFailure(error);
    console.error(`✗ ${name} (${durationMs}ms) [${failureKind}]`);
    return {
      name,
      status: "failed",
      durationMs,
      score: 0,
      failureKind,
      error: harnessReport.summarizeHarnessError(error),
      details: {}
    };
  }
}

function writeReport(report) {
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Black-box report: ${reportPath}`);
}

async function main() {
  assert(existsSync(cliPath), "dist/cli.js not found; run npm run build first");
  assert(existsSync(harnessReportPath), "dist/harness-report.js not found; run npm run build first");
  harnessReport = await import("../dist/harness-report.js");
  const scenarios = [
    ["complex workflow", scenarioComplexWorkflow],
    ["default permission denied", scenarioDefaultPermissionDenied],
    ["retry fallback", scenarioRetryAndFallback],
    ["memory graph link", scenarioMemoryGraphLink],
    ["memory correction", scenarioMemoryCorrection],
    ["tool feedback ranking", scenarioToolFeedbackRanking],
    ["plan mode", scenarioPlanMode],
    ["control approval flow", scenarioControlApprovalFlow],
    ["TUI requires TTY", scenarioTuiRequiresTty],
  ];
  if (process.env.MAGI_BLACKBOX_TUI === "1" && process.env.MAGI_BLACKBOX_TUI_FORCE !== "1" && process.env.CI === "true") {
    console.log("\nSkipping interactive TUI scenario in CI; set MAGI_BLACKBOX_TUI_FORCE=1 to force it.");
  } else if (process.env.MAGI_BLACKBOX_TUI === "1") {
    scenarios.push(["interactive TUI", scenarioInteractiveTui]);
  }
  const results = [];
  for (const [name, fn] of scenarios) {
    results.push(await runScenario(name, fn));
  }
  const report = harnessReport.buildHarnessReport({
    name: "blackbox-e2e",
    startedAt,
    scenarios: results,
  });
  writeReport(report);
  if (report.status !== "passed") {
    console.error(`\nBlack-box E2E matrix failed (${report.summary.failed}/${report.summary.total} scenarios).`);
    process.exit(1);
  }
  console.log(`\nBlack-box E2E matrix passed (${report.summary.passed} scenarios, score=${report.summary.score.toFixed(2)}).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
