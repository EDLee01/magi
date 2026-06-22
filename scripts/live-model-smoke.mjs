#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");
const nodeBin = process.execPath;
const startedAt = new Date();
const reportPath =
  process.env.MAGI_LIVE_SMOKE_REPORT ||
  path.join(repoRoot, ".magi-reports", "live-model-smoke.json");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function writeReport(report) {
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        name: "live-model-smoke",
        version: 1,
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        ...report
      },
      null,
      2
    ),
    "utf8"
  );
}

function splitModelRef(modelRef) {
  const index = modelRef.indexOf(":");
  if (index === -1) {
    return { providerName: "openai", model: modelRef };
  }
  return {
    providerName: modelRef.slice(0, index),
    model: modelRef.slice(index + 1)
  };
}

function shouldSkip() {
  if (process.env.MAGI_LIVE_SMOKE !== "1") {
    return "Set MAGI_LIVE_SMOKE=1 to run the live model smoke task.";
  }
  if (process.env.MAGI_LIVE_SMOKE_CONFIG_DIR) {
    return undefined;
  }
  if (
    process.env.MAGI_LIVE_PROVIDER_TYPE === "messages-compatible" &&
    !process.env.MAGI_LIVE_BASE_URL
  ) {
    return "Set MAGI_LIVE_BASE_URL when MAGI_LIVE_PROVIDER_TYPE=messages-compatible.";
  }
  const apiKeyEnv = process.env.MAGI_LIVE_API_KEY_ENV || "MAGI_OPENAI_API_KEY";
  if (!process.env[apiKeyEnv]) {
    return `Set ${apiKeyEnv} or MAGI_LIVE_SMOKE_CONFIG_DIR before enabling the live smoke task.`;
  }
  return undefined;
}

function renderLiveConfig({ modelRef, apiKeyEnv, baseUrl, providerType, endpoint }) {
  const { providerName, model } = splitModelRef(modelRef);
  const resolvedModelRef = modelRef.includes(":") ? modelRef : `${providerName}:${model}`;
  const lines = [
    "defaultProvider: " + providerName,
    "defaultModel: live",
    "providers:",
    "  " + providerName + ":",
    "    type: " + providerType,
    "    apiKeyEnv: " + apiKeyEnv
  ];
  if (baseUrl) {
    lines.push("    baseUrl: " + baseUrl);
  }
  if (endpoint) {
    lines.push("    endpoint: " + endpoint);
  }
  if (providerType === "messages-compatible") {
    lines.push("    defaultModel: " + model);
  }
  lines.push("models:", "  aliases:", "    live: " + resolvedModelRef, "  fallbacks: {}", "");
  return lines.join("\n");
}

function createFixture(workDir) {
  mkdirSync(path.join(workDir, "src"), { recursive: true });
  mkdirSync(path.join(workDir, "tests"), { recursive: true });
  writeFileSync(
    path.join(workDir, "src", "ledger.js"),
    [
      "export function summarize(entries) {",
      "  return entries.reduce(",
      "    (acc, entry) => ({",
      "      income: acc.income + entry.amount,",
      "      expense: acc.expense + entry.amount,",
      "      balance: acc.balance + entry.amount",
      "    }),",
      "    { income: 0, expense: 0, balance: 0 }",
      "  );",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    path.join(workDir, "tests", "ledger.test.mjs"),
    [
      "import assert from 'node:assert/strict';",
      "import { summarize } from '../src/ledger.js';",
      "",
      "const summary = summarize([",
      "  { type: 'income', amount: 8000 },",
      "  { type: 'expense', amount: 125.5 },",
      "  { type: 'expense', amount: 74.5 }",
      "]);",
      "",
      "assert.deepEqual(summary, { income: 8000, expense: 200, balance: 7800 });",
      ""
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    path.join(workDir, "package.json"),
    JSON.stringify({ type: "module" }, null, 2) + "\n",
    "utf8"
  );
}

function runCommand(command, args, { cwd, env, timeoutMs = 180_000 }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, signal, stdout, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, signal: undefined, stdout, stderr: String(error) });
    });
  });
}

function parseStreamJson(stdout) {
  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      events.push(JSON.parse(line));
    } catch {
      events.push({ type: "unparsed", line });
    }
  }
  return events;
}

function toolCountsFromEvents(events) {
  const counts = {};
  for (const event of events) {
    if (event.type !== "agent.tool_use") {
      continue;
    }
    const name = event.event?.toolUse?.name;
    if (typeof name === "string" && name) {
      counts[name] = (counts[name] ?? 0) + 1;
    }
  }
  return counts;
}

function tail(text, limit = 4_000) {
  if (text.length <= limit) {
    return text;
  }
  return text.slice(text.length - limit);
}

async function main() {
  const skippedReason = shouldSkip();
  if (skippedReason) {
    writeReport({
      status: "skipped",
      skippedReason,
      assertions: [],
      filesVerified: []
    });
    console.log(`live-model-smoke skipped: ${skippedReason}`);
    return;
  }

  assert(existsSync(cliPath), "dist/cli.js does not exist. Run npm run build first.");

  const root = mkdtempSync(path.join(os.tmpdir(), "magi-live-smoke-"));
  const workDir = path.join(root, "work");
  const generatedConfigDir = path.join(root, "config");
  const keepTmp = process.env.MAGI_KEEP_LIVE_SMOKE_TMP === "1";
  mkdirSync(workDir, { recursive: true });
  mkdirSync(generatedConfigDir, { recursive: true });

  try {
    createFixture(workDir);

    const externalConfigDir = process.env.MAGI_LIVE_SMOKE_CONFIG_DIR;
    const modelRef = process.env.MAGI_LIVE_MODEL || "openai:gpt-5.5";
    const modelAlias = externalConfigDir
      ? process.env.MAGI_LIVE_MODEL_ALIAS || process.env.MAGI_LIVE_MODEL || "main"
      : "live";
    const configDir = externalConfigDir ? path.resolve(externalConfigDir) : generatedConfigDir;

    if (!externalConfigDir) {
      writeFileSync(
        path.join(configDir, "config.yaml"),
        renderLiveConfig({
          modelRef,
          apiKeyEnv: process.env.MAGI_LIVE_API_KEY_ENV || "MAGI_OPENAI_API_KEY",
          baseUrl: process.env.MAGI_LIVE_BASE_URL,
          providerType: process.env.MAGI_LIVE_PROVIDER_TYPE || "openai",
          endpoint: process.env.MAGI_LIVE_OPENAI_ENDPOINT
        }),
        "utf8"
      );
    }

    const prompt = [
      "Fix the failing ledger test in this workspace.",
      "First inspect the relevant files and run `node tests/ledger.test.mjs`.",
      "Then edit the source with the smallest correct change, rerun the same test,",
      "and write `reports/live-smoke.md` with the command and final outcome."
    ].join(" ");
    const env = {
      ...process.env,
      MAGI_CONFIG_DIR: configDir,
      NO_COLOR: "1"
    };
    const cli = await runCommand(
      nodeBin,
      [
        cliPath,
        "--no-color",
        "--permission-mode",
        "acceptEdits",
        "--allowed-tools",
        "FileRead,FileWrite,FileEdit,FilePatch,Glob,Grep,ToolSearch,WorkspaceDiagnostics,Bash(node*)",
        "--model",
        modelAlias,
        "--output-format",
        "stream-json",
        "-p",
        prompt
      ],
      { cwd: workDir, env }
    );

    const events = parseStreamJson(cli.stdout);
    if (cli.code !== 0) {
      writeReport({
        status: "failed",
        failure: "cli-exit",
        exitCode: cli.code,
        stderr: tail(cli.stderr),
        stdout: tail(cli.stdout),
        events: events.slice(-20),
        assertions: [],
        filesVerified: []
      });
      process.exitCode = 1;
      return;
    }

    const verify = await runCommand(nodeBin, ["tests/ledger.test.mjs"], {
      cwd: workDir,
      env,
      timeoutMs: 30_000
    });
    const reportFile = path.join(workDir, "reports", "live-smoke.md");
    const sourceFile = path.join(workDir, "src", "ledger.js");
    const testFile = path.join(workDir, "tests", "ledger.test.mjs");
    const reportText = existsSync(reportFile) ? readFileSync(reportFile, "utf8") : "";
    const sourceText = readFileSync(sourceFile, "utf8");
    const assertions = [
      { id: "cli-exit-zero", passed: cli.code === 0 },
      { id: "focused-test-passes-after-agent-run", passed: verify.code === 0 },
      { id: "agent-wrote-live-smoke-report", passed: reportText.trim().length > 0 },
      {
        id: "source-keeps-income-expense-branches",
        passed: sourceText.includes("income") && sourceText.includes("expense")
      }
    ];
    const failures = assertions.filter((assertion) => !assertion.passed);
    const filesVerified = [sourceFile, testFile, reportFile].filter((file) => existsSync(file));
    writeReport({
      status: failures.length === 0 ? "passed" : "failed",
      providerMode: externalConfigDir ? "external-config" : "generated-config",
      model: modelAlias,
      assertions,
      filesVerified: filesVerified.map((file) => path.relative(workDir, file)),
      toolCounts: toolCountsFromEvents(events),
      eventCount: events.length,
      verifyExitCode: verify.code,
      verifyOutput: tail(`${verify.stdout}${verify.stderr}`, 2_000)
    });
    if (failures.length > 0) {
      console.error(`live-model-smoke failed: ${failures.map((failure) => failure.id).join(", ")}`);
      process.exitCode = 1;
      return;
    }
    console.log("live-model-smoke passed");
  } finally {
    if (!keepTmp) {
      rmSync(root, { recursive: true, force: true });
    } else {
      console.log(`live-model-smoke kept workspace: ${root}`);
    }
  }
}

main().catch((error) => {
  writeReport({
    status: "failed",
    failure: "uncaught",
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? tail(error.stack ?? "") : undefined,
    assertions: [],
    filesVerified: []
  });
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
