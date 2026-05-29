#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");
const nodeBin = process.execPath;

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
    close: () => new Promise((resolve) => server.close(resolve)),
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
        toolCall("patch-report", "FilePatch", {
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

    if (complexTurns === 4) {
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
  await withTempWorkspace("complex", async ({ root, configDir, workDir }) => {
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

      await runCli({ args: ["goal", "done", "verified"], cwd: workDir, configDir, label: "goal done" });
      const goalStatus = await runCli({ args: ["goal"], cwd: workDir, configDir, label: "goal status" });
      assert(goalStatus.includes("No active goal"), "goal was not completed");
      assert(provider.calls.length >= 5, "provider was not exercised enough for a complex flow");
    } catch (error) {
      printProviderLog(providerLog);
      throw error;
    } finally {
      await provider.close();
    }
  });
}

async function scenarioDefaultPermissionDenied() {
  await withTempWorkspace("permission", async ({ root, configDir, workDir }) => {
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
    } catch (error) {
      printProviderLog(providerLog);
      throw error;
    } finally {
      await provider.close();
    }
  });
}

async function scenarioRetryAndFallback() {
  await withTempWorkspace("retry-fallback", async ({ root, configDir, workDir }) => {
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
    } catch (error) {
      printProviderLog(providerLog);
      throw error;
    } finally {
      await provider.close();
    }
  });
}

async function scenarioMemoryGraphLink() {
  await withTempWorkspace("memory-graph-link", async ({ configDir, workDir }) => {
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
  });
}

async function scenarioToolFeedbackRanking() {
  await withTempWorkspace("tool-feedback", async ({ root, configDir, workDir }) => {
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
    } catch (error) {
      printProviderLog(providerLog);
      throw error;
    } finally {
      await provider.close();
    }
  });
}

async function scenarioPlanMode() {
  await withTempWorkspace("plan", async ({ root, configDir, workDir }) => {
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
    } catch (error) {
      printProviderLog(providerLog);
      throw error;
    } finally {
      await provider.close();
    }
  });
}

async function scenarioInteractiveTui() {
  await withTempWorkspace("tui", async ({ configDir, workDir }) => {
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
  });
}

async function scenarioTuiRequiresTty() {
  await withTempWorkspace("tui-no-tty", async ({ configDir, workDir }) => {
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
  await fn();
  console.log(`✓ ${name} (${Date.now() - startedAt}ms)`);
}

async function main() {
  assert(existsSync(cliPath), "dist/cli.js not found; run npm run build first");
  const scenarios = [
    ["complex workflow", scenarioComplexWorkflow],
    ["default permission denied", scenarioDefaultPermissionDenied],
    ["retry fallback", scenarioRetryAndFallback],
    ["memory graph link", scenarioMemoryGraphLink],
    ["tool feedback ranking", scenarioToolFeedbackRanking],
    ["plan mode", scenarioPlanMode],
    ["TUI requires TTY", scenarioTuiRequiresTty],
  ];
  if (process.env.MAGI_BLACKBOX_TUI === "1") {
    scenarios.push(["interactive TUI", scenarioInteractiveTui]);
  }
  for (const [name, fn] of scenarios) {
    await runScenario(name, fn);
  }
  console.log(`\nBlack-box E2E matrix passed (${scenarios.length} scenarios).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
