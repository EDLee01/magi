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
  process.env.MAGI_PATCH_EVAL_REPORT ??
  path.join(repoRoot, ".magi-reports", "patch-engine-eval.json");
const startedAt = new Date();

const root = process.env.MAGI_KEEP_PATCH_EVAL_TMP
  ? mkdtempSync(path.join(os.tmpdir(), "magi-patch-eval-keep-"))
  : mkdtempSync(path.join(os.tmpdir(), "magi-patch-eval-"));
const configDir = path.join(root, "config");
const workDir = path.join(root, "work");

let harnessReport;

try {
  assert(existsSync(cliPath), "dist/cli.js does not exist. Run npm run build first.");
  harnessReport = await import("../dist/harness-report.js");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(path.join(workDir, "src"), { recursive: true });
  writeFileSync(path.join(configDir, "config.yaml"), renderConfig({ port: 9 }), "utf8");
  writeFileSync(path.join(workDir, "src", "widget.ts"), initialWidget(), "utf8");

  const provider = await startProvider();
  try {
    writeFileSync(
      path.join(configDir, "config.yaml"),
      renderConfig({ port: provider.port }),
      "utf8"
    );
    const result = await runCli([
      "--permission-mode",
      "acceptEdits",
      "--model",
      "main",
      "--output-format",
      "stream-json",
      "-p",
      [
        "Run the Patch Engine eval.",
        "Update src/widget.ts with a multi-line behavior change.",
        "Use FilePatch for the multi-line edit and recover if the first patch fails.",
        "Use FileEdit only for the exact VERSION_LABEL replacement.",
        "Do not use FileWrite for the existing file."
      ].join(" ")
    ]);
    assert(result.includes("session.completed"), "patch eval headless session did not complete");
    const file = readFileSync(path.join(workDir, "src", "widget.ts"), "utf8");
    assert(file.includes("title.trim()"), "FilePatch did not update title normalization");
    assert(
      file.includes(".filter((item) => item.trim().length > 0)"),
      "FilePatch did not add filtering"
    );
    assert(file.includes('body || "(empty)"'), "FilePatch did not add empty fallback");
    assert(file.includes('VERSION_LABEL = "widget-v2"'), "FileEdit did not update version label");
    assert(!file.includes("Widget: ${title}`"), "old widget header survived patch");

    const metrics = provider.metrics();
    assert(
      metrics.toolCounts.FilePatch === 2,
      "expected one failed and one successful FilePatch call"
    );
    assert(metrics.toolCounts.FileEdit === 1, "expected one exact FileEdit call");
    assert(!metrics.toolCounts.FileWrite, "FileWrite should not be used for existing file edits");
    assert(metrics.recoverySeen, "FilePatch recovery feedback was not returned to the model");
    assert(metrics.toolSearchRankedFilePatch, "ToolSearch did not rank FilePatch first");

    const patchToolCalls =
      (metrics.toolCounts.FilePatch ?? 0) +
      (metrics.toolCounts.FileEdit ?? 0) +
      (metrics.toolCounts.FileWrite ?? 0);
    const patchUsageRate =
      patchToolCalls === 0 ? 0 : (metrics.toolCounts.FilePatch ?? 0) / patchToolCalls;
    const report = harnessReport.buildHarnessReport({
      name: "patch-engine-eval",
      startedAt,
      scenarios: [
        {
          name: "filepatch recovery workflow",
          status: "passed",
          durationMs: Date.now() - startedAt.getTime(),
          score: 1,
          failureKind: null,
          details: {
            provider: { callCount: provider.calls.length },
            toolCounts: metrics.toolCounts,
            patchUsageRate,
            recoverySeen: metrics.recoverySeen,
            toolSearchRankedFilePatch: metrics.toolSearchRankedFilePatch
          }
        }
      ]
    });
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(
      `Patch Engine eval passed (FilePatch rate=${patchUsageRate.toFixed(2)}, provider calls=${provider.calls.length}).`
    );
    console.log(`Patch Engine report: ${reportPath}`);
  } finally {
    await provider.close();
  }
} finally {
  if (!process.env.MAGI_KEEP_PATCH_EVAL_TMP) {
    rmSync(root, { recursive: true, force: true });
  }
}

function initialWidget() {
  return [
    "export function renderWidget(title: string, items: string[]): string {",
    "  const header = `Widget: ${title}`;",
    '  const body = items.map((item) => `- ${item}`).join("\\n");',
    '  return [header, body].join("\\n");',
    "}",
    "",
    'export const VERSION_LABEL = "widget-v1";',
    ""
  ].join("\n");
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

async function startProvider() {
  const calls = [];
  const plannedToolCounts = {};
  let turn = 0;
  let recoverySeen = false;
  let toolSearchRankedFilePatch = false;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const transcript = transcriptFromBody(body);
        const toolNames = (body.tools ?? []).map((tool) => tool.function?.name).filter(Boolean);
        calls.push({ model: body.model, transcript, toolNames });
        const result = routePatchEval({ transcript, toolNames, turn });
        turn += 1;
        const responseBody = result.body ?? result;
        for (const call of responseBody.choices?.[0]?.message?.tool_calls ?? []) {
          plannedToolCounts[call.function.name] = (plannedToolCounts[call.function.name] ?? 0) + 1;
        }
        if (
          transcript.includes("Recovery guidance:") &&
          transcript.includes("Current file snippet:")
        ) {
          recoverySeen = true;
        }
        if (transcript.includes("1. FilePatch") && transcript.includes("intent: file-edit")) {
          toolSearchRankedFilePatch = true;
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
  assert(address && typeof address === "object", "patch eval provider did not bind");
  return {
    calls,
    port: address.port,
    metrics() {
      return {
        toolCounts: plannedToolCounts,
        recoverySeen,
        toolSearchRankedFilePatch
      };
    },
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function routePatchEval({ transcript, toolNames, turn }) {
  if (turn === 0) {
    assert(toolNames.includes("ToolSearch"), "ToolSearch was not exposed");
    assert(toolNames.includes("FilePatch"), "FilePatch was not exposed");
    assert(transcript.includes("use FilePatch for multi-line edits"), "missing FilePatch guidance");
    assert(
      transcript.includes("use FileEdit only for one exact string replacement"),
      "missing FileEdit boundary guidance"
    );
    assert(transcript.includes("If FilePatch fails"), "missing FilePatch recovery guidance");
    return toolResponse([
      toolCall("patch-search", "ToolSearch", {
        query: "apply multi-line patch to existing file",
        max_results: 3
      }),
      toolCall("read-widget", "FileRead", { file_path: "src/widget.ts" })
    ]);
  }
  if (turn === 1) {
    assert(transcript.includes("1. FilePatch"), "ToolSearch did not rank FilePatch first");
    assert(transcript.includes("renderWidget"), "FileRead did not return widget source");
    return toolResponse([
      toolCall("bad-patch", "FilePatch", {
        file_path: "src/widget.ts",
        patch: [
          "@@",
          " export function renderWidget(title: string, items: string[]): string {",
          "-  const header = `Widget: ${title} stale`;",
          "+  const header = `Widget: ${title.trim()}`;"
        ].join("\n")
      })
    ]);
  }
  if (turn === 2) {
    assert(
      transcript.includes("Patch context did not match file"),
      "failed FilePatch was not visible"
    );
    assert(
      transcript.includes("Recovery guidance:"),
      "FilePatch recovery guidance was not visible"
    );
    return toolResponse([
      toolCall("good-patch", "FilePatch", {
        file_path: "src/widget.ts",
        patch: [
          "@@",
          " export function renderWidget(title: string, items: string[]): string {",
          "-  const header = `Widget: ${title}`;",
          '-  const body = items.map((item) => `- ${item}`).join("\\n");',
          '-  return [header, body].join("\\n");',
          "+  const header = `Widget: ${title.trim()}`;",
          "+  const body = items",
          "+    .filter((item) => item.trim().length > 0)",
          "+    .map((item) => `* ${item.trim()}`)",
          '+    .join("\\n");',
          '+  return [header, body || "(empty)"].join("\\n");',
          " }"
        ].join("\n")
      })
    ]);
  }
  if (turn === 3) {
    assert(
      transcript.includes("Patched src/widget.ts"),
      "successful FilePatch result was not visible"
    );
    return toolResponse([
      toolCall("version-edit", "FileEdit", {
        file_path: "src/widget.ts",
        old_string: 'export const VERSION_LABEL = "widget-v1";',
        new_string: 'export const VERSION_LABEL = "widget-v2";'
      })
    ]);
  }
  if (turn === 4) {
    assert(transcript.includes("Wrote src/widget.ts"), "FileEdit result was not visible");
    return messageText("Patch Engine eval completed with FilePatch recovery and exact FileEdit.");
  }
  return messageText("Patch Engine eval already completed.");
}

function runCli(args, timeoutMs = 45_000) {
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
            `patch eval timed out after ${timeoutMs}ms\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`
          )
        );
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `patch eval failed with exit ${code ?? signal}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`
          )
        );
        return;
      }
      resolve(stdout);
    });
  });
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
        if (part && typeof part.content === "string") return part.content;
        return "";
      })
      .join("\n");
  }
  return "";
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
