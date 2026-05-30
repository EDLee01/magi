#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");
const harnessReportPath = path.join(repoRoot, "dist", "harness-report.js");
const fixturesRoot = path.join(repoRoot, "tests", "fixtures", "complex-harness");
const reportPath =
  process.env.MAGI_COMPLEX_HARNESS_REPORT ??
  path.join(repoRoot, ".magi-reports", "complex-harness.json");
const archiveRoot =
  process.env.MAGI_COMPLEX_HARNESS_LOG_DIR ??
  path.join(repoRoot, ".magi-reports", "harness", compactTimestamp(new Date()));
const nodeBin = process.execPath;
const startedAt = new Date();
let harnessReport;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function messageText(text, model = "mock-main") {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
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
    id: `msg_${Math.random().toString(36).slice(2)}`,
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
    "  fallbacks: {}",
    ""
  ].join("\n");
}

async function startProvider({ logPath, routeRequest }) {
  const calls = [];
  const toolCounts = {};
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Invalid JSON" } }));
        return;
      }

      const transcript = transcriptFromBody(body);
      const toolNames = (body.tools ?? []).map((tool) => tool.function?.name).filter(Boolean);
      calls.push({ path: request.url, model: body.model ?? "unknown", transcript, toolNames });
      writeFileSync(logPath, `${JSON.stringify(calls, null, 2)}\n`, "utf8");

      let result;
      try {
        result = routeRequest({ body, transcript, toolNames, calls });
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
  assert(address && typeof address === "object", "mock provider did not bind to a port");
  return {
    calls,
    port: address.port,
    summary() {
      const exposedTools = new Set();
      for (const call of calls) {
        for (const toolName of call.toolNames) {
          exposedTools.add(toolName);
        }
      }
      return {
        callCount: calls.length,
        exposedToolCount: exposedTools.size,
        exposedTools: Array.from(exposedTools).sort()
      };
    },
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function transcriptFromBody(body) {
  return (body.messages ?? []).map(textFromMessage).join("\n");
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

function createH1Router() {
  let turn = 0;
  return ({ transcript, toolNames }) => {
    if (!transcript.includes("Fix the failing discount test")) {
      return messageText("OK");
    }
    turn += 1;

    if (turn === 1) {
      assert(toolNames.includes("FileRead"), "H1 missing FileRead");
      assert(toolNames.includes("FilePatch"), "H1 missing FilePatch");
      assert(toolNames.includes("Bash"), "H1 missing Bash");
      assert(
        transcript.includes("Only edit src/discount.ts"),
        "H1 task constraints were not visible"
      );
      return toolResponse([
        toolCall("h1-read-package", "FileRead", { file_path: "package.json" }),
        toolCall("h1-read-source", "FileRead", { file_path: "src/discount.ts" }),
        toolCall("h1-run-failing-test", "Bash", { command: "npm test", timeout_ms: 10_000 })
      ]);
    }

    if (turn === 2) {
      assert(transcript.includes("return total - percent"), "H1 source bug was not visible");
      assert(transcript.includes("Command exited 1"), "H1 failing test was not visible");
      assert(transcript.includes("99.9 !== 90"), "H1 failure output missed expected discount case");
      return toolResponse([
        toolCall("h1-patch-source-first", "FilePatch", {
          file_path: "src/discount.ts",
          patch: [
            "@@",
            " export function applyDiscount(total, percent) {",
            "   if (percent < 0 || percent > 1) {",
            '     throw new Error("percent must be between 0 and 1");',
            "   }",
            "-  return total - percent;",
            "+  return total - total * percent;",
            " }"
          ].join("\n")
        })
      ]);
    }

    if (turn === 3) {
      assert(transcript.includes("FilePatch failed for src/discount.ts"), "H1 patch failure was not visible");
      assert(transcript.includes("Current file snippet:"), "H1 patch recovery snippet was missing");
      return toolResponse([
        toolCall("h1-patch-source-retry", "FilePatch", {
          file_path: "src/discount.ts",
          patch: [
            "@@",
            " export function applyDiscount(total: number, percent: number): number {",
            "   if (percent < 0 || percent > 1) {",
            '     throw new Error("percent must be between 0 and 1");',
            "   }",
            "-  return total - percent;",
            "+  return total - total * percent;",
            " }"
          ].join("\n")
        })
      ]);
    }

    if (turn === 4) {
      assert(transcript.includes("Patched src/discount.ts"), "H1 patch result was not visible");
      return toolResponse([
        toolCall("h1-run-passing-test", "Bash", { command: "npm test", timeout_ms: 10_000 })
      ]);
    }

    if (turn === 5) {
      assert(transcript.includes("Command exited 0"), "H1 passing test command was not visible");
      assert(transcript.includes("discount tests passed"), "H1 passing test output was missing");
      return messageText("Fixed src/discount.ts and verified npm test passes.");
    }

    throw new Error(`H1 exceeded expected provider turns: ${turn}`);
  };
}

async function runCommand({ command, args, cwd, configDir, label, timeoutMs = 30_000 }) {
  console.log(`+ ${label}: ${JSON.stringify(command)} ${args.map(JSON.stringify).join(" ")}`);
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
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
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
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

async function runCli({ args, cwd, configDir, label, timeoutMs = 30_000 }) {
  const result = await runCommand({
    command: nodeBin,
    args: [cliPath, "--no-color", ...args],
    cwd,
    configDir,
    label,
    timeoutMs
  });
  if (result.code !== 0) {
    throw new Error(
      `${label} failed with exit ${result.code ?? result.signal}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
    );
  }
  return result;
}

async function runTask(taskName) {
  const taskRoot = path.join(fixturesRoot, taskName);
  const repoFixture = path.join(taskRoot, "repo");
  const expected = readJson(path.join(taskRoot, "expected.json"));
  const limits = readJson(path.join(taskRoot, "limits.json"));
  const forbidden = readLines(path.join(taskRoot, "forbidden.txt"));
  const root = mkdtempSync(path.join(os.tmpdir(), `magi-complex-${taskName}-`));
  const configDir = path.join(root, "config");
  const workDir = path.join(root, "repo");
  const archiveDir = path.join(archiveRoot, taskName);
  const providerLog = path.join(archiveDir, "provider-log.json");
  const sentinelPath = path.join(root, "outside-sentinel.txt");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  mkdirSync(archiveDir, { recursive: true });
  cpSync(repoFixture, workDir, { recursive: true });
  writeFileSync(sentinelPath, "do not touch\n", "utf8");

  const before = snapshotFiles(workDir);
  const started = Date.now();
  const provider = await startProvider({
    logPath: providerLog,
    routeRequest: createH1Router()
  });

  try {
    writeFileSync(path.join(configDir, "config.yaml"), renderConfig(provider.port), "utf8");
    const taskPrompt = readFileSync(path.join(taskRoot, "task.md"), "utf8");
    const result = await runCli({
      args: [
        "--permission-mode",
        "acceptEdits",
        "--model",
        "main",
        "--output-format",
        "stream-json",
        "-p",
        taskPrompt
      ],
      cwd: workDir,
      configDir,
      label: `${taskName} prompt`,
      timeoutMs: limits.maxTimeMs
    });
    writeFileSync(path.join(archiveDir, "stdout.jsonl"), result.stdout, "utf8");
    writeFileSync(path.join(archiveDir, "stderr.txt"), result.stderr, "utf8");

    const events = parseStreamEvents(result.stdout);
    const completed = events.at(-1);
    assert(completed?.type === "session.completed", "stream-json did not complete");
    assert(completed.status === "completed", "session did not finish completed");
    assert(
      completed.message === "Fixed src/discount.ts and verified npm test passes.",
      "final message did not report H1 verification"
    );

    const checks = await runCommand({
      command: "bash",
      args: [path.join(taskRoot, "checks.sh")],
      cwd: workDir,
      configDir,
      label: `${taskName} checks`,
      timeoutMs: 15_000
    });
    writeFileSync(path.join(archiveDir, "checks.stdout.txt"), checks.stdout, "utf8");
    writeFileSync(path.join(archiveDir, "checks.stderr.txt"), checks.stderr, "utf8");
    assert(
      checks.code === 0,
      `checks.sh failed with exit ${checks.code ?? checks.signal}\nSTDOUT:\n${checks.stdout}\nSTDERR:\n${checks.stderr}`
    );

    const after = snapshotFiles(workDir);
    const changedFiles = diffSnapshots(before, after);
    const forbiddenChanges = changedFiles.filter((file) => matchesForbidden(file, forbidden));
    const sentinelUnchanged = readFileSync(sentinelPath, "utf8") === "do not touch\n";
    const elapsedMs = Date.now() - started;
    const toolCounts = countStreamTools(events);
    const session = readSessionEvidence(path.join(configDir, "state", "sessions.sqlite"), completed.sessionId);
    const diffText = renderChangedFileDiffs(before, after, changedFiles);
    writeFileSync(path.join(archiveDir, "diff.txt"), diffText, "utf8");

    const commandCount = toolCounts.Bash ?? 0;
    const assertions = [
      "H1 fixture copied into isolated workspace",
      "H1 provider saw task constraints",
      "H1 failing npm test reproduced",
      "H1 source bug read before patch",
      "H1 first FilePatch failure returned recovery context",
      "H1 source patched with FilePatch retry",
      "H1 npm test passed after patch",
      "H1 checks.sh passed",
      "H1 changed only expected source file",
      "H1 forbidden paths unchanged",
      "H1 session and audit persisted"
    ];
    assert(
      JSON.stringify(changedFiles) === JSON.stringify(expected.expectedChangedFiles),
      `changed files ${JSON.stringify(changedFiles)} did not match expected ${JSON.stringify(expected.expectedChangedFiles)}`
    );
    assert(forbiddenChanges.length === 0, `forbidden changes: ${forbiddenChanges.join(", ")}`);
    assert(sentinelUnchanged, "outside sentinel changed");
    assert(elapsedMs <= limits.maxTimeMs, `elapsed ${elapsedMs}ms exceeded limit`);
    assert(commandCount <= limits.maxCommandCount, `command count ${commandCount} exceeded limit`);
    assert(
      changedFiles.length <= limits.maxFileChanges,
      `file changes ${changedFiles.length} exceeded limit`
    );
    assert((toolCounts.FileRead ?? 0) >= 2, "H1 did not read enough evidence");
    assert((toolCounts.FilePatch ?? 0) >= 2, "H1 should recover with FilePatch retry");
    assert((toolCounts.Bash ?? 0) === 2, "H1 should run failing and passing tests");
    assert((toolCounts.FileWrite ?? 0) === 0, "H1 should not use FileWrite");
    assert((toolCounts.FileEdit ?? 0) === 0, "H1 should not use FileEdit");
    assert(session.auditEventCount > 0, "H1 audit events were not persisted");
    assert(session.messageCount >= 2, "H1 session messages were not persisted");

    return {
      name: expected.name,
      status: "passed",
      durationMs: elapsedMs,
      score: 1,
      failureKind: null,
      details: {
        taskId: expected.id,
        taskClass: expected.taskClass,
        fixture: taskName,
        provider: provider.summary(),
        toolCounts,
        assertions,
        filesVerified: [
          "src/discount.ts",
          "tests/discount.test.mjs",
          "checks.sh",
          "state/sessions.sqlite"
        ],
        changedFiles,
        forbiddenChanges,
        checksPassed: true,
        checksExitCode: checks.code,
        streamJsonLifecycleVerified: true,
        session,
        limits,
        limitResults: {
          withinTime: elapsedMs <= limits.maxTimeMs,
          withinCommands: commandCount <= limits.maxCommandCount,
          withinFileChanges: changedFiles.length <= limits.maxFileChanges
        },
        archive: path.relative(repoRoot, archiveDir)
      }
    };
  } finally {
    await provider.close();
    if (!process.env.MAGI_KEEP_COMPLEX_HARNESS_TMP) {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

function readSessionEvidence(dbFile, sessionId) {
  assert(existsSync(dbFile), "sessions.sqlite was not created");
  const db = new Database(dbFile, { readonly: true });
  try {
    const messageCount = db
      .prepare("select count(*) as count from messages where session_id = ?")
      .get(sessionId).count;
    const auditEventCount = db
      .prepare("select count(*) as count from audit_events where session_id = ?")
      .get(sessionId).count;
    return { sessionId, messageCount, auditEventCount };
  } finally {
    db.close();
  }
}

function parseStreamEvents(output) {
  const events = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      throw new Error(`stream-json output contained non-JSON line: ${line}`);
    }
  }
  assert(events.length > 0, "stream-json emitted no events");
  return events;
}

function countStreamTools(events) {
  const counts = {};
  for (const event of events) {
    if (event.type === "tool.started" && typeof event.tool === "string") {
      counts[event.tool] = (counts[event.tool] ?? 0) + 1;
    }
  }
  return counts;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function readLines(file) {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function snapshotFiles(root) {
  const files = {};
  for (const file of walkFiles(root)) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    const content = readFileSync(file);
    files[relative] = {
      hash: createHash("sha256").update(content).digest("hex"),
      text: content.toString("utf8")
    };
  }
  return files;
}

function walkFiles(root) {
  const output = [];
  for (const entry of readdirSync(root)) {
    if (entry === ".git" || entry === "node_modules") continue;
    const fullPath = path.join(root, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      output.push(...walkFiles(fullPath));
    } else if (stat.isFile()) {
      output.push(fullPath);
    }
  }
  return output.sort();
}

function diffSnapshots(before, after) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return Array.from(names)
    .filter((name) => before[name]?.hash !== after[name]?.hash)
    .sort();
}

function matchesForbidden(file, patterns) {
  return patterns.some((pattern) => {
    if (pattern.endsWith("/**")) {
      return file.startsWith(pattern.slice(0, -3));
    }
    return file === pattern;
  });
}

function renderChangedFileDiffs(before, after, changedFiles) {
  return changedFiles
    .map((file) => {
      const beforeText = before[file]?.text ?? "";
      const afterText = after[file]?.text ?? "";
      return [`--- ${file} before`, beforeText, `+++ ${file} after`, afterText].join("\n");
    })
    .join("\n\n");
}

function compactTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
}

async function main() {
  assert(existsSync(cliPath), "dist/cli.js not found; run npm run build first");
  assert(
    existsSync(harnessReportPath),
    "dist/harness-report.js not found; run npm run build first"
  );
  harnessReport = await import("../dist/harness-report.js");
  mkdirSync(path.dirname(reportPath), { recursive: true });
  mkdirSync(archiveRoot, { recursive: true });

  const scenarios = [];
  for (const taskName of ["h1-single-file-bug-fix"]) {
    const started = Date.now();
    console.log(`\n=== ${taskName} ===`);
    try {
      const result = await runTask(taskName);
      console.log(`✓ ${taskName} (${result.durationMs}ms)`);
      scenarios.push(result);
    } catch (error) {
      const durationMs = Date.now() - started;
      const failureKind = harnessReport.classifyHarnessFailure(error);
      console.error(`✗ ${taskName} (${durationMs}ms) [${failureKind}]`);
      scenarios.push({
        name: taskName,
        status: "failed",
        durationMs,
        score: 0,
        failureKind,
        error: harnessReport.summarizeHarnessError(error),
        details: {}
      });
    }
  }

  const report = harnessReport.buildHarnessReport({
    name: "complex-task-harness",
    startedAt,
    scenarios
  });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Complex harness report: ${reportPath}`);
  console.log(`Complex harness archive: ${archiveRoot}`);
  if (report.status !== "passed") {
    console.error(`Complex harness failed (${report.summary.failed}/${report.summary.total}).`);
    process.exit(1);
  }
  console.log(
    `Complex harness passed (${report.summary.passed} scenarios, score=${report.summary.score.toFixed(2)}).`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
