#!/usr/bin/env node

import { spawn } from "node:child_process";
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
const reportPath =
  process.env.MAGI_MODEL_TASK_REPORT ||
  path.join(repoRoot, ".magi-reports", "model-task-benchmark.json");
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

function transcriptFromBody(body) {
  return (body.messages ?? []).map(textFromMessage).join("\n");
}

function messageText(text, model = "mock-main") {
  return {
    id: "msg_" + Math.random().toString(36).slice(2),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
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

function toolResponse(toolCalls, model = "mock-main") {
  return {
    id: "msg_" + Math.random().toString(36).slice(2),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
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

function fail(status, message) {
  return {
    status,
    body: {
      error: { message, type: "mock_assertion_failed" }
    }
  };
}

function renderConfig(port) {
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
    ""
  ].join("\n");
}

async function withWorkspace(name, fn) {
  const root = mkdtempSync(path.join(os.tmpdir(), `magi-model-task-${name}-`));
  const configDir = path.join(root, "config");
  const workDir = path.join(root, "work");
  await mkdir(configDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  try {
    return await fn({ root, configDir, workDir });
  } finally {
    if (!process.env.MAGI_KEEP_MODEL_TASK_TMP) {
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function startProvider({ logPath, routeRequest }) {
  const calls = [];
  const toolCounts = {};
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
      writeFileSync(logPath, JSON.stringify(calls, null, 2), "utf8");

      let result;
      try {
        result = routeRequest({ body, transcript, toolNames, model, calls });
      } catch (error) {
        result = fail(500, error instanceof Error ? error.message : String(error));
      }
      for (const call of (result.body ?? result).choices?.[0]?.message?.tool_calls ?? []) {
        const toolName = call.function?.name;
        if (toolName) {
          toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1;
        }
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
      for (const call of calls) {
        for (const toolName of call.toolNames ?? []) {
          exposedTools.add(toolName);
        }
      }
      return {
        callCount: calls.length,
        exposedToolCount: exposedTools.size,
        exposedTools: Array.from(exposedTools).sort(),
        toolCounts
      };
    },
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function runCommand({ command, args, cwd, configDir, label, timeoutMs = 30_000 }) {
  console.log(`+ ${label}: ${[command, ...args].map((part) => JSON.stringify(part)).join(" ")}`);
  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        MAGI_CONFIG_DIR: configDir,
        MAGI_OPENAI_API_KEY: "test-key",
        NO_COLOR: "1"
      },
      detached,
      stdio: ["ignore", "pipe", "pipe"]
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
            `${label} timed out after ${timeoutMs}ms\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`
          )
        );
        return;
      }
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function runCli({ args, cwd, configDir, label, timeoutMs = 30_000, expectExit = 0 }) {
  const result = await runCommand({
    command: nodeBin,
    args: [cliPath, "--no-color", ...args],
    cwd,
    configDir,
    label,
    timeoutMs
  });
  if (result.code !== expectExit) {
    throw new Error(
      `${label} failed with exit ${result.code ?? result.signal}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
    );
  }
  if (result.stderr.trim()) {
    console.error(result.stderr.trim());
  }
  return result.stdout;
}

function parseDraftId(output) {
  const match = output.match(/(?:id:|Memory Draft:)\s*([a-z0-9_-]+)/i);
  assert(match, `could not parse draft id from output:\n${output}`);
  return match[1];
}

async function seedMemory({ workDir, configDir, text }) {
  await runCli({ args: ["memory", "init"], cwd: workDir, configDir, label: "memory init" });
  const draftId = parseDraftId(
    await runCli({
      args: ["memory", "append", "project", text],
      cwd: workDir,
      configDir,
      label: "memory append project"
    })
  );
  await runCli({
    args: ["memory", "draft", "apply", draftId],
    cwd: workDir,
    configDir,
    label: "memory apply project"
  });
}

function printProviderLog(providerLog) {
  if (existsSync(providerLog)) {
    console.error("\nProvider log:");
    console.error(readFileSync(providerLog, "utf8"));
  }
}

async function scenarioProjectEditTask() {
  return await withWorkspace("project-edit", async ({ root, configDir, workDir }) => {
    writeFileSync(
      path.join(workDir, "README.md"),
      ["# Release Checklist", "", "- run broad checks", "- paste raw logs", ""].join("\n"),
      "utf8"
    );
    const providerLog = path.join(root, "provider-log.json");
    let turn = 0;
    const provider = await startProvider({
      logPath: providerLog,
      routeRequest: ({ transcript, toolNames }) => {
        turn += 1;
        if (turn === 1) {
          assert(toolNames.includes("FilePatch"), "FilePatch was not available");
          assert(
            transcript.includes("use FilePatch for multi-line edits"),
            "FilePatch edit guidance was not injected"
          );
          return toolResponse([
            toolCall("read-readme", "FileRead", { file_path: "README.md" }),
            toolCall("patch-readme", "FilePatch", {
              file_path: "README.md",
              patch: [
                "@@",
                " # Release Checklist",
                " ",
                "- run broad checks",
                "- paste raw logs",
                "+- run focused tests first",
                "+- summarize only failures and next action"
              ].join("\n")
            })
          ]);
        }
        if (turn === 2) {
          assert(
            transcript.includes("FilePatch failed for README.md"),
            "FilePatch recovery failure was not visible"
          );
          assert(
            transcript.includes("Recovery guidance:"),
            "FilePatch recovery guidance was not visible"
          );
          return toolResponse([
            toolCall("patch-readme-retry", "FilePatch", {
              file_path: "README.md",
              patch: [
                "@@",
                " # Release Checklist",
                " ",
                "-- run broad checks",
                "-- paste raw logs",
                "+- run focused tests first",
                "+- summarize only failures and next action"
              ].join("\n")
            })
          ]);
        }
        assert(transcript.includes("Patched README.md"), "FilePatch result was not visible");
        return messageText("Release checklist updated with focused verification guidance.");
      }
    });
    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig(provider.port), "utf8");
      const output = await runCli({
        args: [
          "--permission-mode",
          "acceptEdits",
          "--model",
          "main",
          "--output-format",
          "stream-json",
          "-p",
          "Update README.md release checklist so it prefers focused verification and concise summaries."
        ],
        cwd: workDir,
        configDir,
        label: "project edit task"
      });
      assert(output.includes("session.completed"), "project edit task did not complete");
      const readme = readFileSync(path.join(workDir, "README.md"), "utf8");
      assert(readme.includes("run focused tests first"), "README focused verification missing");
      assert(
        readme.includes("summarize only failures and next action"),
        "README concise summary guidance missing"
      );
      return {
        score: 1,
        assertions: [
          "FilePatch guidance injected",
          "FilePatch recovery guidance visible",
          "README patched",
          "final response completed"
        ],
        filesVerified: ["README.md"],
        provider: provider.summary(),
        taskClass: "project_edit"
      };
    } catch (error) {
      printProviderLog(providerLog);
      throw error;
    } finally {
      await provider.close();
    }
  });
}

async function scenarioMemoryDrivenTask() {
  return await withWorkspace("memory-driven", async ({ root, configDir, workDir }) => {
    await seedMemory({
      workDir,
      configDir,
      text:
        "Project release workflow: before broad checks, run focused CLI E2E and summarize only key failures."
    });
    const providerLog = path.join(root, "provider-log.json");
    let turn = 0;
    const provider = await startProvider({
      logPath: providerLog,
      routeRequest: ({ transcript }) => {
        turn += 1;
        if (turn === 1) {
          assert(transcript.includes("[Relevant Memory]"), "relevant memory was not injected");
          assert(
            transcript.includes("focused CLI E2E"),
            "memory-driven task missed project workflow memory"
          );
          return toolResponse([
            toolCall("write-release-plan", "FileWrite", {
              file_path: "release-plan.md",
              content:
                "# Release Plan\n\n- Run focused CLI E2E before broad checks.\n- Summarize only key failures and next action.\n"
            })
          ]);
        }
        assert(transcript.includes("Wrote release-plan.md"), "FileWrite result was not visible");
        return messageText("Release plan created from project memory.");
      }
    });
    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig(provider.port), "utf8");
      const output = await runCli({
        args: [
          "--permission-mode",
          "acceptEdits",
          "--model",
          "main",
          "--output-format",
          "stream-json",
          "-c",
          "-p",
          "Create a release plan using any durable project workflow memory."
        ],
        cwd: workDir,
        configDir,
        label: "memory driven task"
      });
      assert(output.includes("session.completed"), "memory-driven task did not complete");
      const plan = readFileSync(path.join(workDir, "release-plan.md"), "utf8");
      assert(plan.includes("focused CLI E2E"), "release plan missed focused E2E memory");
      assert(plan.includes("key failures"), "release plan missed concise summary memory");
      return {
        score: 1,
        assertions: [
          "relevant memory injected",
          "memory shaped output",
          "release plan written"
        ],
        filesVerified: ["release-plan.md"],
        provider: provider.summary(),
        taskClass: "memory_driven"
      };
    } catch (error) {
      printProviderLog(providerLog);
      throw error;
    } finally {
      await provider.close();
    }
  });
}

async function scenarioToolDiscoveryTask() {
  return await withWorkspace("tool-discovery", async ({ root, configDir, workDir }) => {
    mkdirSync(path.join(workDir, "docs"), { recursive: true });
    writeFileSync(
      path.join(workDir, "docs", "ops.md"),
      "# Ops\n\nThe deployment keyword is SKYLINE-42.\n",
      "utf8"
    );
    const providerLog = path.join(root, "provider-log.json");
    let turn = 0;
    const provider = await startProvider({
      logPath: providerLog,
      routeRequest: ({ transcript }) => {
        turn += 1;
        if (turn === 1) {
          return toolResponse([
            toolCall("search-tools", "ToolSearch", {
              query: "find files and search text in workspace",
              max_results: 4
            }),
            toolCall("find-docs", "Glob", { pattern: "docs/*.md" })
          ]);
        }
        if (turn === 2) {
          assert(transcript.includes("ToolSearch results"), "ToolSearch result was not visible");
          assert(transcript.includes("docs/ops.md"), "Glob result did not find docs/ops.md");
          return toolResponse([
            toolCall("grep-keyword", "Grep", {
              pattern: "SKYLINE-42",
              path: "docs",
              output_mode: "content"
            })
          ]);
        }
        assert(transcript.includes("SKYLINE-42"), "Grep result was not visible");
        return messageText("The deployment keyword is SKYLINE-42.");
      }
    });
    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig(provider.port), "utf8");
      const output = await runCli({
        args: [
          "--model",
          "main",
          "--output-format",
          "stream-json",
          "-p",
          "Find the deployment keyword in workspace docs and answer with only the keyword."
        ],
        cwd: workDir,
        configDir,
        label: "tool discovery task"
      });
      assert(output.includes("SKYLINE-42"), "tool discovery answer missed keyword");
      return {
        score: 1,
        assertions: [
          "ToolSearch used for search strategy",
          "Glob found docs",
          "Grep extracted keyword"
        ],
        filesVerified: ["docs/ops.md"],
        provider: provider.summary(),
        taskClass: "tool_discovery"
      };
    } catch (error) {
      printProviderLog(providerLog);
      throw error;
    } finally {
      await provider.close();
    }
  });
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
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Model task benchmark report: ${reportPath}`);
}

async function main() {
  assert(existsSync(cliPath), "dist/cli.js not found; run npm run build first");
  assert(
    existsSync(harnessReportPath),
    "dist/harness-report.js not found; run npm run build first"
  );
  harnessReport = await import("../dist/harness-report.js");
  const scenarios = [
    ["project edit task", scenarioProjectEditTask],
    ["memory driven task", scenarioMemoryDrivenTask],
    ["tool discovery task", scenarioToolDiscoveryTask]
  ];
  const results = [];
  for (const [name, fn] of scenarios) {
    results.push(await runScenario(name, fn));
  }
  const report = harnessReport.buildHarnessReport({
    name: "model-task-benchmark",
    startedAt,
    scenarios: results
  });
  writeReport(report);
  if (report.status !== "passed") {
    console.error(
      `\nModel task benchmark failed (${report.summary.failed}/${report.summary.total} scenarios).`
    );
    process.exit(1);
  }
  console.log(
    `\nModel task benchmark passed (${report.summary.passed} scenarios, score=${report.summary.score.toFixed(2)}).`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
