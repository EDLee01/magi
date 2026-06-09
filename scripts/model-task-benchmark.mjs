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
          "--allowed-tools",
          "FileRead,FileWrite,FileEdit,FilePatch,FileMove,Glob,Grep,ToolSearch,Bash",
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
      text: "Project release workflow: before broad checks, run focused CLI E2E and summarize only key failures."
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
          "--allowed-tools",
          "FileRead,FileWrite,FileEdit,FilePatch,FileMove,Glob,Grep,ToolSearch,Bash",
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
        assertions: ["relevant memory injected", "memory shaped output", "release plan written"],
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

async function scenarioCrossFileVerifiedEditTask() {
  return await withWorkspace("cross-file-edit", async ({ root, configDir, workDir }) => {
    mkdirSync(path.join(workDir, "src"), { recursive: true });
    mkdirSync(path.join(workDir, "docs"), { recursive: true });
    mkdirSync(path.join(workDir, "scripts"), { recursive: true });
    writeFileSync(
      path.join(workDir, "src", "pricing.ts"),
      [
        'export type Tier = "starter" | "pro";',
        "",
        "export function monthlyPrice(tier: Tier): number {",
        '  if (tier === "starter") return 12;',
        "  return 30;",
        "}",
        "",
        "export function annualPrice(tier: Tier): number {",
        "  return monthlyPrice(tier) * 12;",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "docs", "pricing.md"),
      ["# Pricing", "", "- Starter: $12/mo", "- Pro: $30/mo", ""].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "scripts", "check-pricing.mjs"),
      [
        'import { readFileSync } from "node:fs";',
        "",
        'const pricing = readFileSync("src/pricing.ts", "utf8");',
        'const docs = readFileSync("docs/pricing.md", "utf8");',
        "",
        "if (!pricing.includes('return 10;')) throw new Error(\"starter monthly price missing\");",
        'if (!pricing.includes("monthlyPrice(tier) * 10")) throw new Error("annual discount missing");',
        'if (!docs.includes("Starter: $10/mo")) throw new Error("docs monthly price missing");',
        'if (!docs.includes("10 months")) throw new Error("docs annual note missing");',
        'console.log("pricing ok");',
        ""
      ].join("\n"),
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
          assert(toolNames.includes("Bash"), "Bash was not available");
          assert(
            transcript.includes("use FilePatch for multi-line edits"),
            "FilePatch edit guidance was not injected"
          );
          return toolResponse([
            toolCall("read-pricing-source", "FileRead", { file_path: "src/pricing.ts" }),
            toolCall("read-pricing-docs", "FileRead", { file_path: "docs/pricing.md" })
          ]);
        }
        if (turn === 2) {
          assert(transcript.includes("monthlyPrice"), "source file was not visible");
          assert(transcript.includes("Starter: $12/mo"), "pricing docs were not visible");
          return toolResponse([
            toolCall("patch-pricing-source", "FilePatch", {
              file_path: "src/pricing.ts",
              patch: [
                "@@",
                " export function monthlyPrice(tier: Tier): number {",
                '-  if (tier === "starter") return 12;',
                '+  if (tier === "starter") return 10;',
                "   return 30;",
                " }",
                " ",
                " export function annualPrice(tier: Tier): number {",
                "-  return monthlyPrice(tier) * 12;",
                "+  return monthlyPrice(tier) * 10;",
                " }"
              ].join("\n")
            }),
            toolCall("patch-pricing-docs", "FilePatch", {
              file_path: "docs/pricing.md",
              patch: [
                "@@",
                " # Pricing",
                " ",
                "-- Starter: $12/mo",
                "+- Starter: $10/mo",
                " - Pro: $30/mo",
                "+- Annual plans charge 10 months for a yearly commitment."
              ].join("\n")
            })
          ]);
        }
        if (turn === 3) {
          assert(
            transcript.includes("Patched src/pricing.ts"),
            "source FilePatch result was not visible"
          );
          assert(
            transcript.includes("Patched docs/pricing.md"),
            "docs FilePatch result was not visible"
          );
          return toolResponse([
            toolCall("verify-pricing", "Bash", {
              command: "node scripts/check-pricing.mjs",
              timeout_ms: 5000
            })
          ]);
        }
        assert(transcript.includes("pricing ok"), "Bash verification output was not visible");
        return messageText("Pricing source and docs updated, then verified with focused check.");
      }
    });

    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig(provider.port), "utf8");
      const output = await runCli({
        args: [
          "--permission-mode",
          "acceptEdits",
          "--allowed-tools",
          "FileRead,FileWrite,FileEdit,FilePatch,FileMove,Glob,Grep,ToolSearch,Bash",
          "--model",
          "main",
          "--output-format",
          "stream-json",
          "-p",
          [
            "Update pricing across source and docs.",
            "Starter should be 10 per month and annual billing should charge 10 months.",
            "Use FilePatch for existing file edits and run the focused pricing check after editing."
          ].join(" ")
        ],
        cwd: workDir,
        configDir,
        label: "cross-file verified edit task"
      });
      assert(
        output.includes("session.completed"),
        "cross-file verified edit task did not complete"
      );
      const source = readFileSync(path.join(workDir, "src", "pricing.ts"), "utf8");
      const docs = readFileSync(path.join(workDir, "docs", "pricing.md"), "utf8");
      assert(source.includes("return 10;"), "source starter price was not updated");
      assert(
        source.includes("monthlyPrice(tier) * 10"),
        "source annual multiplier was not updated"
      );
      assert(docs.includes("Starter: $10/mo"), "docs starter price was not updated");
      assert(docs.includes("10 months"), "docs annual note was not updated");
      return {
        score: 1,
        assertions: [
          "source and docs read before edit",
          "source updated with FilePatch",
          "docs updated with FilePatch",
          "focused Bash verification ran",
          "final response completed"
        ],
        filesVerified: ["src/pricing.ts", "docs/pricing.md", "scripts/check-pricing.mjs"],
        provider: provider.summary(),
        taskClass: "cross_file_verified_edit"
      };
    } catch (error) {
      printProviderLog(providerLog);
      throw error;
    } finally {
      await provider.close();
    }
  });
}

async function scenarioPatchStrategyTask() {
  return await withWorkspace("patch-strategy", async ({ root, configDir, workDir }) => {
    mkdirSync(path.join(workDir, "src"), { recursive: true });
    writeFileSync(
      path.join(workDir, "src", "formatter.ts"),
      [
        "export function formatReport(title: string, lines: string[]): string {",
        "  const heading = `Report: ${title}`;",
        '  const body = lines.map((line) => `- ${line}`).join("\\n");',
        '  return [heading, body].join("\\n");',
        "}",
        "",
        'export const FORMAT_VERSION = "format-v1";',
        ""
      ].join("\n"),
      "utf8"
    );

    const providerLog = path.join(root, "provider-log.json");
    let turn = 0;
    const provider = await startProvider({
      logPath: providerLog,
      routeRequest: ({ transcript, toolNames }) => {
        turn += 1;
        if (turn === 1) {
          assert(toolNames.includes("ToolSearch"), "ToolSearch was not available");
          assert(toolNames.includes("FilePatch"), "FilePatch was not available");
          assert(toolNames.includes("FileEdit"), "FileEdit was not available");
          assert(
            transcript.includes("use FilePatch for multi-line edits"),
            "FilePatch guidance was not injected"
          );
          return toolResponse([
            toolCall("find-patch-tool", "ToolSearch", {
              query: "modify existing file with multi-line patch and exact string replacement",
              max_results: 4
            }),
            toolCall("read-formatter", "FileRead", { file_path: "src/formatter.ts" })
          ]);
        }
        if (turn === 2) {
          assert(transcript.includes("1. FilePatch"), "ToolSearch did not rank FilePatch first");
          assert(transcript.includes("formatReport"), "FileRead did not expose formatter source");
          return toolResponse([
            toolCall("patch-formatter", "FilePatch", {
              file_path: "src/formatter.ts",
              patch: [
                "@@",
                " export function formatReport(title: string, lines: string[]): string {",
                "-  const heading = `Report: ${title}`;",
                '-  const body = lines.map((line) => `- ${line}`).join("\\n");',
                '-  return [heading, body].join("\\n");',
                "+  const heading = `Report: ${title.trim()}`;",
                "+  const body = lines",
                "+    .filter((line) => line.trim().length > 0)",
                "+    .map((line) => `* ${line.trim()}`)",
                '+    .join("\\n");',
                '+  return [heading, body || "(empty)"].join("\\n");',
                " }"
              ].join("\n")
            })
          ]);
        }
        if (turn === 3) {
          assert(
            transcript.includes("Patched src/formatter.ts"),
            "FilePatch result was not visible"
          );
          return toolResponse([
            toolCall("edit-format-version", "FileEdit", {
              file_path: "src/formatter.ts",
              old_string: 'export const FORMAT_VERSION = "format-v1";',
              new_string: 'export const FORMAT_VERSION = "format-v2";'
            })
          ]);
        }
        assert(transcript.includes("Wrote src/formatter.ts"), "FileEdit result was not visible");
        return messageText(
          "Formatter updated with FilePatch for the body and FileEdit for version."
        );
      }
    });

    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig(provider.port), "utf8");
      const output = await runCli({
        args: [
          "--permission-mode",
          "acceptEdits",
          "--allowed-tools",
          "FileRead,FileWrite,FileEdit,FilePatch,FileMove,Glob,Grep,ToolSearch,Bash",
          "--model",
          "main",
          "--output-format",
          "stream-json",
          "-p",
          [
            "Update src/formatter.ts.",
            "Use FilePatch for the multi-line formatReport behavior change.",
            "Use FileEdit only for the exact FORMAT_VERSION replacement.",
            "Do not rewrite the whole file."
          ].join(" ")
        ],
        cwd: workDir,
        configDir,
        label: "patch strategy task"
      });
      assert(output.includes("session.completed"), "patch strategy task did not complete");
      const source = readFileSync(path.join(workDir, "src", "formatter.ts"), "utf8");
      assert(source.includes("title.trim()"), "formatter title normalization missing");
      assert(
        source.includes(".filter((line) => line.trim().length > 0)"),
        "formatter blank-line filtering missing"
      );
      assert(source.includes('body || "(empty)"'), "formatter empty fallback missing");
      assert(source.includes('FORMAT_VERSION = "format-v2"'), "format version edit missing");

      const summary = provider.summary();
      const toolCounts = summary.toolCounts;
      const patchToolCalls =
        (toolCounts.FilePatch ?? 0) + (toolCounts.FileEdit ?? 0) + (toolCounts.FileWrite ?? 0);
      const patchUsageRate =
        patchToolCalls === 0 ? 0 : (toolCounts.FilePatch ?? 0) / patchToolCalls;
      assert(toolCounts.FilePatch === 1, "patch strategy should use one FilePatch call");
      assert(toolCounts.FileEdit === 1, "patch strategy should use one FileEdit call");
      assert(!toolCounts.FileWrite, "patch strategy should not use FileWrite for existing file");
      assert(patchUsageRate >= 0.5, "patch strategy FilePatch usage rate was too low");
      return {
        score: 1,
        assertions: [
          "ToolSearch ranked FilePatch",
          "FilePatch handled multi-line edit",
          "FileEdit handled exact version replacement",
          "FileWrite avoided for existing file",
          "final response completed"
        ],
        filesVerified: ["src/formatter.ts"],
        provider: summary,
        taskClass: "patch_strategy",
        toolCounts,
        patchUsageRate,
        fileWriteAvoided: !toolCounts.FileWrite
      };
    } catch (error) {
      printProviderLog(providerLog);
      throw error;
    } finally {
      await provider.close();
    }
  });
}

async function scenarioDependencyRefactorTask() {
  return await withWorkspace("dependency-refactor", async ({ root, configDir, workDir }) => {
    mkdirSync(path.join(workDir, "src"), { recursive: true });
    mkdirSync(path.join(workDir, "tests"), { recursive: true });
    mkdirSync(path.join(workDir, "docs"), { recursive: true });
    writeFileSync(
      path.join(workDir, "src", "usage.js"),
      [
        "export function calculateUsage(events) {",
        "  return events.length;",
        "}",
        "",
        "export function usageLabel(events) {",
        "  return `${calculateUsage(events)} events`;",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "tests", "usage.test.mjs"),
      [
        'import assert from "node:assert/strict";',
        'import { calculateUsage, usageLabel } from "../src/usage.js";',
        "",
        "const events = [",
        '  { type: "click", weight: 2 },',
        '  { type: "view", weight: 1 }',
        "];",
        "",
        "assert.equal(calculateUsage(events), 3);",
        'assert.equal(usageLabel(events), "3 weighted events");',
        'console.log("usage ok");',
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "docs", "usage.md"),
      [
        "# Usage",
        "",
        "Usage is currently reported as the number of events.",
        ""
      ].join("\n"),
      "utf8"
    );

    const providerLog = path.join(root, "provider-log.json");
    let turn = 0;
    const provider = await startProvider({
      logPath: providerLog,
      routeRequest: ({ transcript, toolNames }) => {
        turn += 1;
        if (turn === 1) {
          assert(toolNames.includes("Bash"), "Bash was not available");
          assert(toolNames.includes("FilePatch"), "FilePatch was not available");
          assert(
            transcript.includes("use FilePatch for multi-line edits"),
            "FilePatch guidance was not injected"
          );
          return toolResponse([
            toolCall("run-usage-test-before", "Bash", {
              command: "node tests/usage.test.mjs",
              timeout_ms: 5000
            }),
            toolCall("read-usage-source", "FileRead", { file_path: "src/usage.js" }),
            toolCall("read-usage-docs", "FileRead", { file_path: "docs/usage.md" })
          ]);
        }
        if (turn === 2) {
          assert(transcript.includes("AssertionError"), "failing usage test was not visible");
          assert(transcript.includes("calculateUsage"), "usage source was not visible");
          assert(transcript.includes("number of events"), "usage docs were not visible");
          return toolResponse([
            toolCall("patch-usage-source", "FilePatch", {
              file_path: "src/usage.js",
              patch: [
                "@@",
                " export function calculateUsage(events) {",
                "-  return events.length;",
                "+  return events.reduce((total, event) => total + (event.weight ?? 1), 0);",
                " }",
                " ",
                " export function usageLabel(events) {",
                '-  return `${calculateUsage(events)} events`;',
                '+  return `${calculateUsage(events)} weighted events`;',
                " }"
              ].join("\n")
            }),
            toolCall("patch-usage-docs", "FilePatch", {
              file_path: "docs/usage.md",
              patch: [
                "@@",
                " # Usage",
                " ",
                "-Usage is currently reported as the number of events.",
                "+Usage is reported as the sum of event weights.",
                "+Events without an explicit weight count as 1."
              ].join("\n")
            })
          ]);
        }
        if (turn === 3) {
          assert(transcript.includes("Patched src/usage.js"), "usage source patch was not visible");
          assert(transcript.includes("Patched docs/usage.md"), "usage docs patch was not visible");
          return toolResponse([
            toolCall("run-usage-test-after", "Bash", {
              command: "node tests/usage.test.mjs",
              timeout_ms: 5000
            })
          ]);
        }
        assert(transcript.includes("usage ok"), "passing usage test was not visible");
        return messageText("Usage dependency refactor updated source and docs, then passed tests.");
      }
    });

    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig(provider.port), "utf8");
      const output = await runCli({
        args: [
          "--permission-mode",
          "acceptEdits",
          "--allowed-tools",
          "FileRead,FileWrite,FileEdit,FilePatch,FileMove,Glob,Grep,ToolSearch,Bash",
          "--model",
          "main",
          "--output-format",
          "stream-json",
          "-p",
          [
            "Refactor usage calculation across source and docs.",
            "The tests now expect weighted usage, so run the focused usage test first,",
            "update dependent source and docs with FilePatch, then rerun the focused test."
          ].join(" ")
        ],
        cwd: workDir,
        configDir,
        label: "dependency refactor task"
      });
      assert(output.includes("session.completed"), "dependency refactor task did not complete");
      const source = readFileSync(path.join(workDir, "src", "usage.js"), "utf8");
      const docs = readFileSync(path.join(workDir, "docs", "usage.md"), "utf8");
      assert(source.includes("event.weight ?? 1"), "weighted usage fallback missing");
      assert(source.includes("weighted events"), "usage label was not updated");
      assert(docs.includes("sum of event weights"), "usage docs did not describe weighted usage");
      const summary = provider.summary();
      const toolCounts = summary.toolCounts;
      assert(toolCounts.Bash === 2, "dependency refactor should run focused test before and after");
      assert(toolCounts.FilePatch === 2, "dependency refactor should patch source and docs");
      assert(!toolCounts.FileWrite, "dependency refactor should not rewrite existing files");
      return {
        score: 1,
        assertions: [
          "focused failing dependency test ran first",
          "dependent source and docs read before edit",
          "source dependency behavior patched",
          "docs dependency contract patched",
          "focused passing dependency test ran after edit",
          "FileWrite avoided for existing files",
          "final response completed"
        ],
        filesVerified: ["src/usage.js", "tests/usage.test.mjs", "docs/usage.md"],
        provider: summary,
        taskClass: "dependency_refactor",
        toolCounts,
        fileWriteAvoided: !toolCounts.FileWrite
      };
    } catch (error) {
      printProviderLog(providerLog);
      throw error;
    } finally {
      await provider.close();
    }
  });
}

async function scenarioTestDrivenRecoveryTask() {
  return await withWorkspace("test-driven-recovery", async ({ root, configDir, workDir }) => {
    mkdirSync(path.join(workDir, "src"), { recursive: true });
    mkdirSync(path.join(workDir, "tests"), { recursive: true });
    mkdirSync(path.join(workDir, "reports"), { recursive: true });
    writeFileSync(
      path.join(workDir, "src", "totals.js"),
      [
        "export function summarize(items) {",
        "  const total = items.reduce((sum, item) => sum + item.amount, 0);",
        "  return { total };",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "tests", "totals.test.mjs"),
      [
        'import assert from "node:assert/strict";',
        'import { summarize } from "../src/totals.js";',
        "",
        "const result = summarize([",
        '  { amount: 12, type: "income" },',
        '  { amount: 4, type: "expense" },',
        '  { amount: 1, type: "expense" }',
        "]);",
        "",
        "assert.deepEqual(result, { income: 12, expense: 5, balance: 7 });",
        'console.log("totals ok");',
        ""
      ].join("\n"),
      "utf8"
    );

    const providerLog = path.join(root, "provider-log.json");
    let turn = 0;
    const provider = await startProvider({
      logPath: providerLog,
      routeRequest: ({ transcript, toolNames }) => {
        turn += 1;
        if (turn === 1) {
          assert(toolNames.includes("Bash"), "Bash was not available");
          assert(toolNames.includes("FilePatch"), "FilePatch was not available");
          assert(
            transcript.includes("use FilePatch for multi-line edits"),
            "FilePatch guidance was not injected"
          );
          return toolResponse([
            toolCall("run-failing-test", "Bash", {
              command: "node tests/totals.test.mjs",
              timeout_ms: 5000
            }),
            toolCall("read-totals", "FileRead", { file_path: "src/totals.js" })
          ]);
        }
        if (turn === 2) {
          assert(transcript.includes("AssertionError"), "failing test output was not visible");
          assert(transcript.includes("export function summarize"), "source read was not visible");
          return toolResponse([
            toolCall("bad-totals-patch", "FilePatch", {
              file_path: "src/totals.js",
              patch: [
                "@@",
                " export function summarize(items) {",
                "-  const total = items.reduce((sum, item) => sum + item.amount, 0);",
                "-  return { total: total };",
                '+  const income = items.filter((item) => item.type === "income").reduce((sum, item) => sum + item.amount, 0);',
                '+  const expense = items.filter((item) => item.type === "expense").reduce((sum, item) => sum + item.amount, 0);',
                "+  return { income, expense, balance: income - expense };",
                " }"
              ].join("\n")
            })
          ]);
        }
        if (turn === 3) {
          assert(
            transcript.includes("FilePatch failed for src/totals.js"),
            "FilePatch failure was not visible"
          );
          assert(transcript.includes("Recovery guidance:"), "FilePatch recovery guidance missing");
          return toolResponse([
            toolCall("retry-totals-patch", "FilePatch", {
              file_path: "src/totals.js",
              patch: [
                "@@",
                " export function summarize(items) {",
                "-  const total = items.reduce((sum, item) => sum + item.amount, 0);",
                "-  return { total };",
                "+  const income = items",
                '+    .filter((item) => item.type === "income")',
                "+    .reduce((sum, item) => sum + item.amount, 0);",
                "+  const expense = items",
                '+    .filter((item) => item.type === "expense")',
                "+    .reduce((sum, item) => sum + item.amount, 0);",
                "+  return { income, expense, balance: income - expense };",
                " }"
              ].join("\n")
            })
          ]);
        }
        if (turn === 4) {
          assert(
            transcript.includes("Patched src/totals.js"),
            "retry patch result was not visible"
          );
          return toolResponse([
            toolCall("run-passing-test", "Bash", {
              command: "node tests/totals.test.mjs",
              timeout_ms: 5000
            })
          ]);
        }
        if (turn === 5) {
          assert(transcript.includes("totals ok"), "passing test output was not visible");
          return toolResponse([
            toolCall("write-repair-report", "FileWrite", {
              file_path: "reports/totals-fix.md",
              content:
                "# Totals Repair\n\n- Reproduced failing test.\n- Recovered from failed FilePatch using current context.\n- Verified with node tests/totals.test.mjs.\n"
            })
          ]);
        }
        assert(transcript.includes("Wrote reports/totals-fix.md"), "repair report write missing");
        return messageText("Totals bug fixed with patch recovery and focused verification.");
      }
    });

    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig(provider.port), "utf8");
      const output = await runCli({
        args: [
          "--permission-mode",
          "acceptEdits",
          "--allowed-tools",
          "FileRead,FileWrite,FileEdit,FilePatch,FileMove,Glob,Grep,ToolSearch,Bash",
          "--model",
          "main",
          "--output-format",
          "stream-json",
          "-p",
          [
            "Fix the failing totals test.",
            "Run the focused test first, repair src/totals.js with FilePatch, recover if the patch fails,",
            "rerun the focused test, then write a concise repair report."
          ].join(" ")
        ],
        cwd: workDir,
        configDir,
        label: "test-driven recovery task"
      });
      assert(output.includes("session.completed"), "test-driven recovery task did not complete");
      const source = readFileSync(path.join(workDir, "src", "totals.js"), "utf8");
      const report = readFileSync(path.join(workDir, "reports", "totals-fix.md"), "utf8");
      assert(source.includes("balance: income - expense"), "balance computation missing");
      assert(report.includes("Recovered from failed FilePatch"), "repair report missed recovery");
      assert(
        report.includes("Verified with node tests/totals.test.mjs"),
        "repair report missed verification"
      );
      const summary = provider.summary();
      const toolCounts = summary.toolCounts;
      assert(toolCounts.Bash === 2, "test-driven task should run failing and passing checks");
      assert(
        toolCounts.FilePatch === 2,
        "test-driven task should use failed and recovered patches"
      );
      assert(toolCounts.FileWrite === 1, "test-driven task should write one report");
      return {
        score: 1,
        assertions: [
          "focused failing test ran before edit",
          "source read before patch",
          "failed FilePatch recovery guidance visible",
          "retry FilePatch fixed source",
          "focused passing test ran after edit",
          "repair report written",
          "final response completed"
        ],
        filesVerified: ["src/totals.js", "tests/totals.test.mjs", "reports/totals-fix.md"],
        provider: summary,
        taskClass: "test_driven_recovery",
        toolCounts,
        recoverySeen: true
      };
    } catch (error) {
      printProviderLog(providerLog);
      throw error;
    } finally {
      await provider.close();
    }
  });
}

async function scenarioContinuousPatchRecoveryTask() {
  return await withWorkspace("continuous-patch-recovery", async ({ root, configDir, workDir }) => {
    mkdirSync(path.join(workDir, "src"), { recursive: true });
    mkdirSync(path.join(workDir, "tests"), { recursive: true });
    mkdirSync(path.join(workDir, "docs"), { recursive: true });
    writeFileSync(
      path.join(workDir, "src", "discounts.js"),
      [
        "export function summarizeCart(cart) {",
        "  const subtotal = cart.items.reduce((total, item) => total + item.price, 0);",
        "  return { subtotal, discount: 0, total: subtotal };",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "tests", "discounts.test.mjs"),
      [
        'import assert from "node:assert/strict";',
        'import { summarizeCart } from "../src/discounts.js";',
        "",
        "const cart = {",
        "  customerTier: \"vip\",",
        "  items: [{ price: 80 }, { price: 20 }]",
        "};",
        "",
        "assert.deepEqual(summarizeCart(cart), { subtotal: 100, discount: 15, total: 85 });",
        'console.log("discounts ok");',
        ""
      ].join("\n"),
      "utf8"
    );
    const unrelatedBefore = "# Operations\n\nDo not edit this file during discount fixes.\n";
    writeFileSync(path.join(workDir, "docs", "operations.md"), unrelatedBefore, "utf8");

    const providerLog = path.join(root, "provider-log.json");
    let turn = 0;
    const provider = await startProvider({
      logPath: providerLog,
      routeRequest: ({ transcript, toolNames }) => {
        turn += 1;
        if (turn === 1) {
          assert(toolNames.includes("Bash"), "Bash was not available");
          assert(toolNames.includes("FilePatch"), "FilePatch was not available");
          assert(
            transcript.includes("use FilePatch for multi-line edits"),
            "FilePatch guidance was not injected"
          );
          return toolResponse([
            toolCall("run-discounts-test-before", "Bash", {
              command: "node tests/discounts.test.mjs",
              timeout_ms: 5000
            }),
            toolCall("read-discounts-source", "FileRead", { file_path: "src/discounts.js" })
          ]);
        }
        if (turn === 2) {
          assert(transcript.includes("AssertionError"), "failing discounts test was not visible");
          assert(transcript.includes("summarizeCart"), "discount source was not visible");
          return toolResponse([
            toolCall("bad-discounts-patch-1", "FilePatch", {
              file_path: "src/discounts.js",
              patch: [
                "@@",
                " export function summarizeCart(cart) {",
                "   const subtotal = cart.items.reduce((total, item) => total + item.price, 0);",
                "-  return { subtotal: subtotal, discount: 0, total: subtotal };",
                "+  const discount = cart.customerTier === \"vip\" ? subtotal * 0.15 : 0;",
                "+  return { subtotal, discount, total: subtotal - discount };",
                " }"
              ].join("\n")
            })
          ]);
        }
        if (turn === 3) {
          assert(
            transcript.includes("FilePatch failed for src/discounts.js"),
            "first FilePatch failure was not visible"
          );
          assert(transcript.includes("Current file snippet:"), "first recovery snippet missing");
          return toolResponse([
            toolCall("bad-discounts-patch-2", "FilePatch", {
              file_path: "src/discounts.js",
              patch: [
                "@@",
                " export function summarizeCart(cart) {",
                "-  const subtotal = cart.items.reduce((sum, item) => sum + item.price, 0);",
                "-  return { subtotal, discount: 0, total: subtotal };",
                "+  const discount = cart.customerTier === \"vip\" ? subtotal * 0.15 : 0;",
                "+  return { subtotal, discount, total: subtotal - discount };",
                " }"
              ].join("\n")
            })
          ]);
        }
        if (turn === 4) {
          assert(
            transcript.includes("FilePatch failed for src/discounts.js"),
            "second FilePatch failure was not visible"
          );
          assert(transcript.includes("Recovery guidance:"), "second recovery guidance missing");
          return toolResponse([
            toolCall("reread-discounts-source", "FileRead", { file_path: "src/discounts.js" })
          ]);
        }
        if (turn === 5) {
          assert(
            transcript.includes("return { subtotal, discount: 0, total: subtotal };"),
            "re-read current source was not visible before recovery patch"
          );
          return toolResponse([
            toolCall("recover-discounts-patch", "FilePatch", {
              file_path: "src/discounts.js",
              patch: [
                "@@",
                " export function summarizeCart(cart) {",
                "   const subtotal = cart.items.reduce((total, item) => total + item.price, 0);",
                "-  return { subtotal, discount: 0, total: subtotal };",
                "+  const discount = cart.customerTier === \"vip\" ? subtotal * 0.15 : 0;",
                "+  return { subtotal, discount, total: subtotal - discount };",
                " }"
              ].join("\n")
            })
          ]);
        }
        if (turn === 6) {
          assert(
            transcript.includes("Patched src/discounts.js"),
            "recovery patch result was not visible"
          );
          return toolResponse([
            toolCall("run-discounts-test-after", "Bash", {
              command: "node tests/discounts.test.mjs",
              timeout_ms: 5000
            })
          ]);
        }
        assert(transcript.includes("discounts ok"), "passing discounts test was not visible");
        return messageText("Discount fix recovered after repeated patch failures and passed tests.");
      }
    });

    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig(provider.port), "utf8");
      const output = await runCli({
        args: [
          "--permission-mode",
          "acceptEdits",
          "--allowed-tools",
          "FileRead,FileWrite,FileEdit,FilePatch,FileMove,Glob,Grep,ToolSearch,Bash",
          "--model",
          "main",
          "--output-format",
          "stream-json",
          "-p",
          [
            "Fix the failing VIP discount test.",
            "Use FilePatch for the existing source file.",
            "If repeated patch attempts fail, use the recovery feedback and re-read the file before retrying.",
            "Do not edit unrelated docs, and rerun the focused discount test after the fix."
          ].join(" ")
        ],
        cwd: workDir,
        configDir,
        label: "continuous patch recovery task"
      });
      assert(
        output.includes("session.completed"),
        "continuous patch recovery task did not complete"
      );
      const source = readFileSync(path.join(workDir, "src", "discounts.js"), "utf8");
      const unrelatedAfter = readFileSync(path.join(workDir, "docs", "operations.md"), "utf8");
      assert(source.includes('customerTier === "vip"'), "VIP discount branch missing");
      assert(source.includes("subtotal * 0.15"), "VIP discount rate missing");
      assert(
        source.includes("total: subtotal - discount"),
        "discount total computation missing"
      );
      assert(unrelatedAfter === unrelatedBefore, "unrelated docs file changed");
      const summary = provider.summary();
      const toolCounts = summary.toolCounts;
      assert(toolCounts.Bash === 2, "continuous recovery should run failing and passing tests");
      assert(toolCounts.FilePatch === 3, "continuous recovery should use two failed patches and one recovery patch");
      assert(toolCounts.FileRead === 2, "continuous recovery should re-read after repeated patch failures");
      assert(!toolCounts.FileWrite, "continuous recovery should not rewrite existing files");
      assert(!toolCounts.FileEdit, "continuous recovery should not switch to FileEdit");
      return {
        score: 1,
        assertions: [
          "focused failing discount test ran first",
          "first failed FilePatch exposed recovery snippet",
          "second failed FilePatch exposed recovery guidance",
          "source re-read after repeated patch failures",
          "third FilePatch used exact current context",
          "focused passing discount test ran after recovery",
          "unrelated docs file stayed unchanged",
          "FileWrite avoided for existing source",
          "final response completed"
        ],
        filesVerified: ["src/discounts.js", "tests/discounts.test.mjs", "docs/operations.md"],
        provider: summary,
        taskClass: "continuous_patch_recovery",
        toolCounts,
        failedPatchAttempts: 2,
        reReadAfterRepeatedPatchFailures: true,
        finalDiffQualityVerified: true,
        unrelatedFileUnchanged: true
      };
    } catch (error) {
      printProviderLog(providerLog);
      throw error;
    } finally {
      await provider.close();
    }
  });
}

async function scenarioApiMigrationTask() {
  return await withWorkspace("api-migration", async ({ root, configDir, workDir }) => {
    mkdirSync(path.join(workDir, "src", "billing"), { recursive: true });
    mkdirSync(path.join(workDir, "src", "orders"), { recursive: true });
    mkdirSync(path.join(workDir, "tests"), { recursive: true });
    mkdirSync(path.join(workDir, "docs"), { recursive: true });
    writeFileSync(
      path.join(workDir, "src", "billing", "client.js"),
      [
        "export function charge(amount) {",
        "  return { status: \"charged\", amount };",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "src", "orders", "checkout.js"),
      [
        'import { charge } from "../billing/client.js";',
        "",
        "export function checkout(order) {",
        "  const payment = charge(order.total);",
        "  return { id: order.id, payment };",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "tests", "checkout.test.mjs"),
      [
        'import assert from "node:assert/strict";',
        'import { readFileSync, existsSync } from "node:fs";',
        'import { checkout } from "../src/orders/checkout.js";',
        "",
        'const result = checkout({ id: "ord_1", total: 42 });',
        "assert.deepEqual(result, {",
        '  id: "ord_1",',
        '  payment: { status: "processed", amount: 42, provider: "stripe" }',
        "});",
        "",
        'assert.equal(existsSync("src/billing/client.js"), false);',
        'assert.equal(existsSync("src/payments/gateway.js"), true);',
        'assert.match(readFileSync("docs/payments.md", "utf8"), /payments\\/gateway\\.js/);',
        'console.log("checkout migration ok");',
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "docs", "payments.md"),
      ["# Payments", "", "Use src/billing/client.js and call charge(amount).", ""].join("\n"),
      "utf8"
    );

    const providerLog = path.join(root, "provider-log.json");
    let turn = 0;
    const provider = await startProvider({
      logPath: providerLog,
      routeRequest: ({ transcript, toolNames }) => {
        turn += 1;
        if (turn === 1) {
          assert(toolNames.includes("ToolSearch"), "ToolSearch was not available");
          assert(toolNames.includes("FilePatch"), "FilePatch was not available");
          assert(toolNames.includes("Bash"), "Bash was not available");
          assert(!toolNames.includes("FileMove"), "FileMove should start deferred");
          return toolResponse([
            toolCall("run-checkout-before", "Bash", {
              command: "node tests/checkout.test.mjs",
              timeout_ms: 5000
            }),
            toolCall("find-move-tool", "ToolSearch", {
              query: "select:FileMove"
            }),
            toolCall("read-billing-client", "FileRead", { file_path: "src/billing/client.js" }),
            toolCall("read-checkout", "FileRead", { file_path: "src/orders/checkout.js" }),
            toolCall("read-payments-docs", "FileRead", { file_path: "docs/payments.md" })
          ]);
        }
        if (turn === 2) {
          assert(transcript.includes("AssertionError"), "failing checkout test was not visible");
          assert(transcript.includes("Tool: FileMove"), "FileMove schema was not revealed");
          assert(transcript.includes("charge(amount)"), "billing client source was not visible");
          assert(transcript.includes("../billing/client.js"), "checkout import was not visible");
          assert(transcript.includes("Use src/billing/client.js"), "payments docs were not visible");
          return toolResponse([
            toolCall("move-billing-client", "FileMove", {
              source: "src/billing/client.js",
              destination: "src/payments/gateway.js"
            }),
            toolCall("patch-payment-gateway", "FilePatch", {
              file_path: "src/payments/gateway.js",
              patch: [
                "@@",
                "-export function charge(amount) {",
                "-  return { status: \"charged\", amount };",
                "+export function processPayment(amount) {",
                '+  return { status: "processed", amount, provider: "stripe" };',
                " }"
              ].join("\n")
            }),
            toolCall("patch-checkout-import", "FilePatch", {
              file_path: "src/orders/checkout.js",
              patch: [
                "@@",
                '-import { charge } from "../billing/client.js";',
                '+import { processPayment } from "../payments/gateway.js";',
                " ",
                " export function checkout(order) {",
                "-  const payment = charge(order.total);",
                "+  const payment = processPayment(order.total);",
                "   return { id: order.id, payment };",
                " }"
              ].join("\n")
            }),
            toolCall("patch-payments-docs", "FilePatch", {
              file_path: "docs/payments.md",
              patch: [
                "@@",
                " # Payments",
                " ",
                "-Use src/billing/client.js and call charge(amount).",
                "+Use src/payments/gateway.js and call processPayment(amount).",
                "+The gateway returns the provider used for the transaction."
              ].join("\n")
            })
          ]);
        }
        if (turn === 3) {
          assert(
            transcript.includes("Moved src/billing/client.js"),
            "FileMove result was not visible"
          );
          assert(
            transcript.includes("Patched src/payments/gateway.js"),
            "gateway patch result was not visible"
          );
          assert(
            transcript.includes("Patched src/orders/checkout.js"),
            "checkout patch result was not visible"
          );
          assert(
            transcript.includes("Patched docs/payments.md"),
            "docs patch result was not visible"
          );
          return toolResponse([
            toolCall("run-checkout-after", "Bash", {
              command: "node tests/checkout.test.mjs",
              timeout_ms: 5000
            })
          ]);
        }
        assert(
          transcript.includes("checkout migration ok"),
          "passing checkout migration test was not visible"
        );
        return messageText("Payment API migration completed with file move, patches, and tests.");
      }
    });

    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig(provider.port), "utf8");
      const output = await runCli({
        args: [
          "--permission-mode",
          "acceptEdits",
          "--allowed-tools",
          "FileRead,FileWrite,FileEdit,FilePatch,FileMove,Glob,Grep,ToolSearch,Bash",
          "--model",
          "main",
          "--output-format",
          "stream-json",
          "-p",
          [
            "Migrate the payment API from src/billing/client.js to src/payments/gateway.js.",
            "Run the focused checkout test first, use ToolSearch to reveal the file move tool,",
            "move the file, update source imports/API names and docs, then rerun the focused checkout test."
          ].join(" ")
        ],
        cwd: workDir,
        configDir,
        label: "api migration task"
      });
      assert(output.includes("session.completed"), "api migration task did not complete");
      const gateway = readFileSync(path.join(workDir, "src", "payments", "gateway.js"), "utf8");
      const checkout = readFileSync(path.join(workDir, "src", "orders", "checkout.js"), "utf8");
      const docs = readFileSync(path.join(workDir, "docs", "payments.md"), "utf8");
      assert(!existsSync(path.join(workDir, "src", "billing", "client.js")), "old billing client still exists");
      assert(gateway.includes("processPayment"), "gateway API rename missing");
      assert(gateway.includes('provider: "stripe"'), "gateway provider metadata missing");
      assert(checkout.includes("../payments/gateway.js"), "checkout import not migrated");
      assert(checkout.includes("processPayment(order.total)"), "checkout call not migrated");
      assert(docs.includes("src/payments/gateway.js"), "docs path not migrated");
      assert(docs.includes("processPayment(amount)"), "docs API name not migrated");
      const summary = provider.summary();
      const toolCounts = summary.toolCounts;
      assert(toolCounts.Bash === 2, "api migration should run focused test before and after");
      assert(toolCounts.ToolSearch === 1, "api migration should reveal FileMove through ToolSearch");
      assert(toolCounts.FileMove === 1, "api migration should move exactly one file");
      assert(toolCounts.FilePatch === 3, "api migration should patch gateway, checkout, and docs");
      assert(!toolCounts.FileWrite, "api migration should not rewrite existing files");
      return {
        score: 1,
        assertions: [
          "focused failing checkout test ran first",
          "FileMove revealed through ToolSearch",
          "billing client moved to payments gateway",
          "gateway API renamed with FilePatch",
          "checkout import and call migrated with FilePatch",
          "payments docs migrated with FilePatch",
          "focused passing checkout test ran after migration",
          "old billing client path removed",
          "FileWrite avoided for existing files",
          "final response completed"
        ],
        filesVerified: [
          "src/payments/gateway.js",
          "src/orders/checkout.js",
          "tests/checkout.test.mjs",
          "docs/payments.md"
        ],
        provider: summary,
        taskClass: "api_migration",
        toolCounts,
        fileMoveRevealed: true,
        movedFileVerified: true,
        oldPathRemoved: true,
        batchApiMigrationVerified: true,
        fileWriteAvoided: !toolCounts.FileWrite
      };
    } catch (error) {
      printProviderLog(providerLog);
      throw error;
    } finally {
      await provider.close();
    }
  });
}

async function scenarioMonorepoGeneratedBoundaryTask() {
  return await withWorkspace("monorepo-generated-boundary", async ({ root, configDir, workDir }) => {
    mkdirSync(path.join(workDir, "packages", "shared", "src"), { recursive: true });
    mkdirSync(path.join(workDir, "packages", "shared", "generated"), { recursive: true });
    mkdirSync(path.join(workDir, "packages", "payments", "src"), { recursive: true });
    mkdirSync(path.join(workDir, "packages", "storefront", "src"), { recursive: true });
    mkdirSync(path.join(workDir, "tests"), { recursive: true });
    mkdirSync(path.join(workDir, "docs"), { recursive: true });
    writeFileSync(
      path.join(workDir, "packages", "shared", "src", "tax.js"),
      [
        "export function calculateTax(subtotal) {",
        "  return Math.round(subtotal * 0.08 * 100) / 100;",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    const generatedBefore = [
      "// AUTO-GENERATED FILE. DO NOT EDIT.",
      "export const generatedTaxRate = 0.08;",
      ""
    ].join("\n");
    writeFileSync(
      path.join(workDir, "packages", "shared", "generated", "tax-client.js"),
      generatedBefore,
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "packages", "storefront", "src", "cart.js"),
      [
        'import { calculateTax } from "../../shared/src/tax.js";',
        "",
        "export function cartTotal(items) {",
        "  const subtotal = items.reduce((total, item) => total + item.price, 0);",
        "  const tax = calculateTax(subtotal);",
        "  return { subtotal, tax, total: subtotal + tax };",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "tests", "cart.test.mjs"),
      [
        'import assert from "node:assert/strict";',
        'import { existsSync, readFileSync } from "node:fs";',
        'import { cartTotal } from "../packages/storefront/src/cart.js";',
        "",
        "assert.deepEqual(cartTotal([{ price: 50 }, { price: 50 }]), {",
        "  subtotal: 100,",
        "  tax: 10,",
        "  total: 110",
        "});",
        "",
        'assert.equal(existsSync("packages/shared/src/tax.js"), false);',
        'assert.equal(existsSync("packages/payments/src/taxPolicy.js"), true);',
        'assert.match(readFileSync("docs/tax.md", "utf8"), /packages\\/payments\\/src\\/taxPolicy\\.js/);',
        'assert.match(readFileSync("docs/tax.md", "utf8"), /generated clients stay untouched/i);',
        'const generated = readFileSync("packages/shared/generated/tax-client.js", "utf8");',
        'assert.match(generated, /AUTO-GENERATED FILE\\. DO NOT EDIT/);',
        "assert.match(generated, /generatedTaxRate = 0\\.08/);",
        'console.log("monorepo tax migration ok");',
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "docs", "tax.md"),
      [
        "# Tax",
        "",
        "Use packages/shared/src/tax.js and call calculateTax(subtotal).",
        "Generated clients live under packages/shared/generated.",
        ""
      ].join("\n"),
      "utf8"
    );

    const providerLog = path.join(root, "provider-log.json");
    let turn = 0;
    const provider = await startProvider({
      logPath: providerLog,
      routeRequest: ({ transcript, toolNames }) => {
        turn += 1;
        if (turn === 1) {
          assert(toolNames.includes("ToolSearch"), "ToolSearch was not available");
          assert(toolNames.includes("FilePatch"), "FilePatch was not available");
          assert(toolNames.includes("Bash"), "Bash was not available");
          assert(!toolNames.includes("FileMove"), "FileMove should start deferred");
          return toolResponse([
            toolCall("run-cart-before", "Bash", {
              command: "node tests/cart.test.mjs",
              timeout_ms: 5000
            }),
            toolCall("find-move-tool", "ToolSearch", {
              query: "select:FileMove"
            }),
            toolCall("read-shared-tax", "FileRead", {
              file_path: "packages/shared/src/tax.js"
            }),
            toolCall("read-storefront-cart", "FileRead", {
              file_path: "packages/storefront/src/cart.js"
            }),
            toolCall("read-tax-docs", "FileRead", { file_path: "docs/tax.md" }),
            toolCall("read-generated-tax-client", "FileRead", {
              file_path: "packages/shared/generated/tax-client.js"
            })
          ]);
        }
        if (turn === 2) {
          assert(transcript.includes("AssertionError"), "failing monorepo test was not visible");
          assert(transcript.includes("Tool: FileMove"), "FileMove schema was not revealed");
          assert(transcript.includes("calculateTax"), "shared tax source was not visible");
          assert(transcript.includes("../../shared/src/tax.js"), "storefront import was not visible");
          assert(transcript.includes("AUTO-GENERATED FILE"), "generated file boundary was not visible");
          return toolResponse([
            toolCall("move-shared-tax", "FileMove", {
              source: "packages/shared/src/tax.js",
              destination: "packages/payments/src/taxPolicy.js"
            }),
            toolCall("patch-tax-policy", "FilePatch", {
              file_path: "packages/payments/src/taxPolicy.js",
              patch: [
                "@@",
                "-export function calculateTax(subtotal) {",
                "-  return Math.round(subtotal * 0.08 * 100) / 100;",
                "+export function applyTaxPolicy(subtotal) {",
                "+  return Math.round(subtotal * 0.1 * 100) / 100;",
                " }"
              ].join("\n")
            }),
            toolCall("patch-storefront-cart", "FilePatch", {
              file_path: "packages/storefront/src/cart.js",
              patch: [
                "@@",
                '-import { calculateTax } from "../../shared/src/tax.js";',
                '+import { applyTaxPolicy } from "../../payments/src/taxPolicy.js";',
                " ",
                " export function cartTotal(items) {",
                "   const subtotal = items.reduce((total, item) => total + item.price, 0);",
                "-  const tax = calculateTax(subtotal);",
                "+  const tax = applyTaxPolicy(subtotal);",
                "   return { subtotal, tax, total: subtotal + tax };",
                " }"
              ].join("\n")
            }),
            toolCall("patch-tax-docs", "FilePatch", {
              file_path: "docs/tax.md",
              patch: [
                "@@",
                " # Tax",
                " ",
                "-Use packages/shared/src/tax.js and call calculateTax(subtotal).",
                "-Generated clients live under packages/shared/generated.",
                "+Use packages/payments/src/taxPolicy.js and call applyTaxPolicy(subtotal).",
                "+Generated clients stay untouched under packages/shared/generated."
              ].join("\n")
            })
          ]);
        }
        if (turn === 3) {
          assert(
            transcript.includes("Moved packages/shared/src/tax.js"),
            "monorepo FileMove result was not visible"
          );
          assert(
            transcript.includes("Patched packages/payments/src/taxPolicy.js"),
            "tax policy patch result was not visible"
          );
          assert(
            transcript.includes("Patched packages/storefront/src/cart.js"),
            "storefront patch result was not visible"
          );
          assert(transcript.includes("Patched docs/tax.md"), "tax docs patch result was not visible");
          return toolResponse([
            toolCall("run-cart-after", "Bash", {
              command: "node tests/cart.test.mjs",
              timeout_ms: 5000
            })
          ]);
        }
        assert(
          transcript.includes("monorepo tax migration ok"),
          "passing monorepo tax test was not visible"
        );
        return messageText(
          "Monorepo tax migration completed while preserving generated client files."
        );
      }
    });

    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig(provider.port), "utf8");
      const output = await runCli({
        args: [
          "--permission-mode",
          "acceptEdits",
          "--allowed-tools",
          "FileRead,FileWrite,FileEdit,FilePatch,FileMove,Glob,Grep,ToolSearch,Bash",
          "--model",
          "main",
          "--output-format",
          "stream-json",
          "-p",
          [
            "Migrate tax policy in this monorepo from packages/shared/src/tax.js",
            "to packages/payments/src/taxPolicy.js.",
            "Run the focused cart test first, reveal FileMove with ToolSearch,",
            "move only the source file, patch storefront and docs,",
            "do not edit generated files under packages/shared/generated,",
            "then rerun the focused cart test."
          ].join(" ")
        ],
        cwd: workDir,
        configDir,
        label: "monorepo generated boundary task"
      });
      assert(
        output.includes("session.completed"),
        "monorepo generated boundary task did not complete"
      );
      const taxPolicy = readFileSync(
        path.join(workDir, "packages", "payments", "src", "taxPolicy.js"),
        "utf8"
      );
      const cart = readFileSync(
        path.join(workDir, "packages", "storefront", "src", "cart.js"),
        "utf8"
      );
      const docs = readFileSync(path.join(workDir, "docs", "tax.md"), "utf8");
      const generatedAfter = readFileSync(
        path.join(workDir, "packages", "shared", "generated", "tax-client.js"),
        "utf8"
      );
      assert(!existsSync(path.join(workDir, "packages", "shared", "src", "tax.js")), "old shared tax source still exists");
      assert(taxPolicy.includes("applyTaxPolicy"), "tax policy API rename missing");
      assert(taxPolicy.includes("subtotal * 0.1"), "tax policy rate change missing");
      assert(cart.includes("../../payments/src/taxPolicy.js"), "storefront import not migrated");
      assert(cart.includes("applyTaxPolicy(subtotal)"), "storefront call not migrated");
      assert(docs.includes("packages/payments/src/taxPolicy.js"), "tax docs path not migrated");
      assert(docs.includes("Generated clients stay untouched"), "tax docs boundary note missing");
      assert(generatedAfter === generatedBefore, "generated tax client was modified");
      const summary = provider.summary();
      const toolCounts = summary.toolCounts;
      assert(toolCounts.Bash === 2, "monorepo migration should run focused test before and after");
      assert(toolCounts.ToolSearch === 1, "monorepo migration should reveal FileMove through ToolSearch");
      assert(toolCounts.FileMove === 1, "monorepo migration should move exactly one source file");
      assert(toolCounts.FilePatch === 3, "monorepo migration should patch tax policy, consumer, and docs");
      assert(!toolCounts.FileWrite, "monorepo migration should not rewrite existing files");
      assert(!toolCounts.FileEdit, "monorepo migration should not use FileEdit for generated boundaries");
      return {
        score: 1,
        assertions: [
          "focused failing cart test ran first",
          "FileMove revealed through ToolSearch",
          "source package file moved across monorepo packages",
          "payments tax policy patched with new API",
          "storefront package import and call migrated",
          "tax docs migrated with generated boundary note",
          "generated client file stayed unchanged",
          "focused passing cart test ran after migration",
          "old shared tax path removed",
          "FileWrite avoided for existing files",
          "FileEdit avoided for generated boundary task",
          "final response completed"
        ],
        filesVerified: [
          "packages/payments/src/taxPolicy.js",
          "packages/storefront/src/cart.js",
          "packages/shared/generated/tax-client.js",
          "tests/cart.test.mjs",
          "docs/tax.md"
        ],
        provider: summary,
        taskClass: "monorepo_generated_boundary",
        toolCounts,
        fileMoveRevealed: true,
        sourcePackageMoved: true,
        oldSourcePackagePathRemoved: true,
        generatedFileUntouched: true,
        monorepoPackageMigrationVerified: true,
        fileWriteAvoided: !toolCounts.FileWrite,
        fileEditAvoided: !toolCounts.FileEdit
      };
    } catch (error) {
      printProviderLog(providerLog);
      throw error;
    } finally {
      await provider.close();
    }
  });
}

async function scenarioWorkspacePolicyMigrationTask() {
  return await withWorkspace("workspace-policy-migration", async ({ root, configDir, workDir }) => {
    mkdirSync(path.join(workDir, "packages", "api", "src"), { recursive: true });
    mkdirSync(path.join(workDir, "packages", "web", "src"), { recursive: true });
    mkdirSync(path.join(workDir, "packages", "web", "generated"), { recursive: true });
    mkdirSync(path.join(workDir, "vendor"), { recursive: true });
    mkdirSync(path.join(workDir, "tests"), { recursive: true });
    mkdirSync(path.join(workDir, "docs"), { recursive: true });
    writeFileSync(
      path.join(workDir, "workspace.json"),
      [
        "{",
        '  "policy": "legacy",',
        '  "packages": ["api", "web"],',
        '  "requiredNode": "18"',
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "packages", "api", "package.json"),
      [
        "{",
        '  "name": "@acme/api",',
        '  "scripts": {',
        '    "verify": "node ../../tests/policy.test.mjs --legacy"',
        "  }",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "packages", "web", "package.json"),
      [
        "{",
        '  "name": "@acme/web",',
        '  "scripts": {',
        '    "verify": "node ../../tests/policy.test.mjs --legacy"',
        "  }",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "packages", "api", "src", "policy.js"),
      [
        'export const policyMode = "legacy";',
        "",
        "export function requestHeaders() {",
        '  return { "x-policy-mode": policyMode };',
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "packages", "web", "src", "client.js"),
      [
        'export const clientPolicy = "legacy";',
        "",
        "export function renderPolicyBadge() {",
        "  return `Policy: ${clientPolicy}`;",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    const generatedBefore = [
      "// AUTO-GENERATED API TYPES. DO NOT EDIT.",
      'export const generatedPolicy = "legacy";',
      ""
    ].join("\n");
    const vendorBefore = [
      "// third party shim",
      'export const vendorPolicy = "legacy";',
      ""
    ].join("\n");
    writeFileSync(
      path.join(workDir, "packages", "web", "generated", "api-types.js"),
      generatedBefore,
      "utf8"
    );
    writeFileSync(path.join(workDir, "vendor", "legacy-policy.js"), vendorBefore, "utf8");
    writeFileSync(
      path.join(workDir, "docs", "workspace-policy.md"),
      [
        "# Workspace Policy",
        "",
        "Current policy: legacy.",
        "API and web package verify scripts use --legacy.",
        "Generated web API types and vendor shims must not be edited.",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "tests", "policy.test.mjs"),
      [
        'import assert from "node:assert/strict";',
        'import { readFileSync } from "node:fs";',
        'import { policyMode, requestHeaders } from "../packages/api/src/policy.js";',
        'import { clientPolicy, renderPolicyBadge } from "../packages/web/src/client.js";',
        "",
        'const workspace = JSON.parse(readFileSync("workspace.json", "utf8"));',
        'const apiPkg = JSON.parse(readFileSync("packages/api/package.json", "utf8"));',
        'const webPkg = JSON.parse(readFileSync("packages/web/package.json", "utf8"));',
        'assert.equal(workspace.policy, "strict");',
        'assert.equal(workspace.requiredNode, "20");',
        'assert.equal(apiPkg.scripts.verify, "node ../../tests/policy.test.mjs --strict");',
        'assert.equal(webPkg.scripts.verify, "node ../../tests/policy.test.mjs --strict");',
        'assert.equal(policyMode, "strict");',
        'assert.deepEqual(requestHeaders(), { "x-policy-mode": "strict" });',
        'assert.equal(clientPolicy, "strict");',
        'assert.equal(renderPolicyBadge(), "Policy: strict");',
        'const docs = readFileSync("docs/workspace-policy.md", "utf8");',
        'assert.match(docs, /Current policy: strict/);',
        'assert.match(docs, /--strict/);',
        'const generated = readFileSync("packages/web/generated/api-types.js", "utf8");',
        'assert.match(generated, /AUTO-GENERATED API TYPES\\. DO NOT EDIT/);',
        'assert.match(generated, /generatedPolicy = "legacy"/);',
        'const vendor = readFileSync("vendor/legacy-policy.js", "utf8");',
        'assert.match(vendor, /vendorPolicy = "legacy"/);',
        'console.log("workspace policy migration ok");',
        ""
      ].join("\n"),
      "utf8"
    );

    const providerLog = path.join(root, "provider-log.json");
    let turn = 0;
    const provider = await startProvider({
      logPath: providerLog,
      routeRequest: ({ transcript, toolNames }) => {
        turn += 1;
        if (turn === 1) {
          assert(toolNames.includes("Bash"), "Bash was not available");
          assert(toolNames.includes("FileRead"), "FileRead was not available");
          assert(toolNames.includes("FilePatch"), "FilePatch was not available");
          return toolResponse([
            toolCall("run-policy-before", "Bash", {
              command: "node tests/policy.test.mjs",
              timeout_ms: 5000
            }),
            toolCall("read-workspace-config", "FileRead", { file_path: "workspace.json" }),
            toolCall("read-api-package", "FileRead", { file_path: "packages/api/package.json" }),
            toolCall("read-web-package", "FileRead", { file_path: "packages/web/package.json" }),
            toolCall("read-api-policy", "FileRead", { file_path: "packages/api/src/policy.js" }),
            toolCall("read-web-client", "FileRead", { file_path: "packages/web/src/client.js" }),
            toolCall("read-policy-docs", "FileRead", { file_path: "docs/workspace-policy.md" }),
            toolCall("read-generated-api-types", "FileRead", {
              file_path: "packages/web/generated/api-types.js"
            }),
            toolCall("read-vendor-policy", "FileRead", { file_path: "vendor/legacy-policy.js" })
          ]);
        }
        if (turn === 2) {
          assert(transcript.includes("AssertionError"), "failing policy test was not visible");
          assert(transcript.includes('"policy": "legacy"'), "workspace config was not visible");
          assert(transcript.includes("--legacy"), "package verify scripts were not visible");
          assert(
            transcript.includes("AUTO-GENERATED API TYPES"),
            "generated API type boundary was not visible"
          );
          assert(transcript.includes("third party shim"), "vendor boundary was not visible");
          return toolResponse([
            toolCall("patch-workspace-config", "FilePatch", {
              file_path: "workspace.json",
              patch: [
                "@@",
                " {",
                '-  "policy": "legacy",',
                '+  "policy": "strict",',
                '   "packages": ["api", "web"],',
                '-  "requiredNode": "18"',
                '+  "requiredNode": "20"',
                " }"
              ].join("\n")
            }),
            toolCall("patch-api-package-script", "FilePatch", {
              file_path: "packages/api/package.json",
              patch: [
                "@@",
                '   "scripts": {',
                '-    "verify": "node ../../tests/policy.test.mjs --legacy"',
                '+    "verify": "node ../../tests/policy.test.mjs --strict"',
                "   }"
              ].join("\n")
            }),
            toolCall("patch-web-package-script", "FilePatch", {
              file_path: "packages/web/package.json",
              patch: [
                "@@",
                '   "scripts": {',
                '-    "verify": "node ../../tests/policy.test.mjs --legacy"',
                '+    "verify": "node ../../tests/policy.test.mjs --strict"',
                "   }"
              ].join("\n")
            }),
            toolCall("patch-api-policy-source", "FilePatch", {
              file_path: "packages/api/src/policy.js",
              patch: [
                "@@",
                '-export const policyMode = "legacy";',
                '+export const policyMode = "strict";'
              ].join("\n")
            }),
            toolCall("patch-web-client-source", "FilePatch", {
              file_path: "packages/web/src/client.js",
              patch: [
                "@@",
                '-export const clientPolicy = "legacy";',
                '+export const clientPolicy = "strict";'
              ].join("\n")
            }),
            toolCall("patch-workspace-policy-docs", "FilePatch", {
              file_path: "docs/workspace-policy.md",
              patch: [
                "@@",
                " # Workspace Policy",
                " ",
                "-Current policy: legacy.",
                "-API and web package verify scripts use --legacy.",
                "+Current policy: strict.",
                "+API and web package verify scripts use --strict.",
                " Generated web API types and vendor shims must not be edited."
              ].join("\n")
            })
          ]);
        }
        if (turn === 3) {
          assert(transcript.includes("Patched workspace.json"), "workspace config patch missing");
          assert(
            transcript.includes("Patched packages/api/package.json"),
            "api package patch missing"
          );
          assert(
            transcript.includes("Patched packages/web/package.json"),
            "web package patch missing"
          );
          assert(
            transcript.includes("Patched packages/api/src/policy.js"),
            "api source patch missing"
          );
          assert(
            transcript.includes("Patched packages/web/src/client.js"),
            "web source patch missing"
          );
          assert(transcript.includes("Patched docs/workspace-policy.md"), "docs patch missing");
          return toolResponse([
            toolCall("run-policy-after", "Bash", {
              command: "node tests/policy.test.mjs",
              timeout_ms: 5000
            })
          ]);
        }
        assert(
          transcript.includes("workspace policy migration ok"),
          "passing workspace policy test was not visible"
        );
        return messageText(
          "Workspace policy migration completed while preserving generated and vendor files."
        );
      }
    });

    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig(provider.port), "utf8");
      const output = await runCli({
        args: [
          "--permission-mode",
          "acceptEdits",
          "--allowed-tools",
          "FileRead,FileWrite,FileEdit,FilePatch,FileMove,Glob,Grep,ToolSearch,Bash",
          "--model",
          "main",
          "--output-format",
          "stream-json",
          "-p",
          [
            "Migrate this workspace policy from legacy to strict across workspace config,",
            "api/web package verify scripts, api/web source code, and docs.",
            "Run the focused policy test before editing, inspect generated and vendor boundaries,",
            "do not modify packages/web/generated or vendor files, then rerun the focused policy test."
          ].join(" ")
        ],
        cwd: workDir,
        configDir,
        label: "workspace policy migration task"
      });
      assert(output.includes("session.completed"), "workspace policy task did not complete");
      const workspace = readFileSync(path.join(workDir, "workspace.json"), "utf8");
      const apiPackage = readFileSync(
        path.join(workDir, "packages", "api", "package.json"),
        "utf8"
      );
      const webPackage = readFileSync(
        path.join(workDir, "packages", "web", "package.json"),
        "utf8"
      );
      const apiPolicy = readFileSync(path.join(workDir, "packages", "api", "src", "policy.js"), "utf8");
      const webClient = readFileSync(path.join(workDir, "packages", "web", "src", "client.js"), "utf8");
      const docs = readFileSync(path.join(workDir, "docs", "workspace-policy.md"), "utf8");
      const generatedAfter = readFileSync(
        path.join(workDir, "packages", "web", "generated", "api-types.js"),
        "utf8"
      );
      const vendorAfter = readFileSync(path.join(workDir, "vendor", "legacy-policy.js"), "utf8");
      assert(workspace.includes('"policy": "strict"'), "workspace policy not migrated");
      assert(workspace.includes('"requiredNode": "20"'), "workspace node requirement not migrated");
      assert(apiPackage.includes("--strict"), "api verify script not migrated");
      assert(webPackage.includes("--strict"), "web verify script not migrated");
      assert(apiPolicy.includes('policyMode = "strict"'), "api policy source not migrated");
      assert(webClient.includes('clientPolicy = "strict"'), "web client source not migrated");
      assert(docs.includes("Current policy: strict"), "workspace policy docs not migrated");
      assert(generatedAfter === generatedBefore, "generated API types were modified");
      assert(vendorAfter === vendorBefore, "vendor shim was modified");
      const summary = provider.summary();
      const toolCounts = summary.toolCounts;
      assert(toolCounts.Bash === 2, "workspace policy task should run tests before and after");
      assert(toolCounts.FileRead === 8, "workspace policy task should inspect all boundaries");
      assert(toolCounts.FilePatch === 6, "workspace policy task should patch six owned files");
      assert(!toolCounts.FileWrite, "workspace policy task should not rewrite existing files");
      assert(!toolCounts.FileEdit, "workspace policy task should not use FileEdit");
      return {
        score: 1,
        assertions: [
          "focused failing policy test ran first",
          "workspace config inspected",
          "api and web package scripts inspected",
          "api and web source inspected",
          "generated and vendor boundaries inspected",
          "workspace config patched",
          "package verify scripts patched",
          "api and web source patched",
          "workspace policy docs patched",
          "focused passing policy test ran after migration",
          "generated API types stayed unchanged",
          "vendor shim stayed unchanged",
          "FileWrite avoided for workspace policy migration",
          "FileEdit avoided for workspace policy migration",
          "final response completed"
        ],
        filesVerified: [
          "workspace.json",
          "packages/api/package.json",
          "packages/web/package.json",
          "packages/api/src/policy.js",
          "packages/web/src/client.js",
          "packages/web/generated/api-types.js",
          "vendor/legacy-policy.js",
          "docs/workspace-policy.md",
          "tests/policy.test.mjs"
        ],
        provider: summary,
        taskClass: "workspace_policy_migration",
        toolCounts,
        configMigrated: true,
        packageScriptsMigrated: true,
        sourceMigrated: true,
        docsMigrated: true,
        generatedFileUntouched: true,
        vendorFileUntouched: true,
        workspacePolicyMigrationVerified: true,
        fileWriteAvoided: !toolCounts.FileWrite,
        fileEditAvoided: !toolCounts.FileEdit
      };
    } catch (error) {
      printProviderLog(providerLog);
      throw error;
    } finally {
      await provider.close();
    }
  });
}

async function scenarioMixedLanguageContractMigrationTask() {
  return await withWorkspace("mixed-language-contract", async ({ root, configDir, workDir }) => {
    mkdirSync(path.join(workDir, "services", "web", "src"), { recursive: true });
    mkdirSync(path.join(workDir, "services", "worker"), { recursive: true });
    mkdirSync(path.join(workDir, "generated"), { recursive: true });
    mkdirSync(path.join(workDir, "tests"), { recursive: true });
    mkdirSync(path.join(workDir, "docs"), { recursive: true });
    writeFileSync(
      path.join(workDir, "services", "web", "src", "signup.ts"),
      [
        'export const DEFAULT_REGION = "us";',
        "",
        "export function buildSignupPayload(email: string) {",
        '  return { email, tier: "free", region: DEFAULT_REGION };',
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "services", "worker", "signup.py"),
      [
        'DEFAULT_REGION = "us"',
        "",
        "def build_signup_payload(email):",
        '    return {"email": email, "tier": "free", "region": DEFAULT_REGION}',
        ""
      ].join("\n"),
      "utf8"
    );
    const generatedBefore = [
      "// AUTO-GENERATED CLIENT. DO NOT EDIT.",
      'export const generatedSignupTier = "free";',
      'export const generatedSignupRegion = "us";',
      ""
    ].join("\n");
    writeFileSync(path.join(workDir, "generated", "signup-client.ts"), generatedBefore, "utf8");
    writeFileSync(
      path.join(workDir, "docs", "signup-contract.md"),
      [
        "# Signup Contract",
        "",
        "The web and worker signup payloads default to free tier in the us region.",
        "Generated signup clients are produced by OpenAPI and must not be edited by hand.",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "tests", "signup-contract.test.mjs"),
      [
        'import assert from "node:assert/strict";',
        'import { readFileSync } from "node:fs";',
        "",
        'const web = readFileSync("services/web/src/signup.ts", "utf8");',
        'const worker = readFileSync("services/worker/signup.py", "utf8");',
        'const docs = readFileSync("docs/signup-contract.md", "utf8");',
        'const generated = readFileSync("generated/signup-client.ts", "utf8");',
        "",
        'assert.match(web, /DEFAULT_REGION = "eu"/);',
        'assert.match(web, /tier: "pro"/);',
        'assert.match(worker, /DEFAULT_REGION = "eu"/);',
        'assert.match(worker, /"tier": "pro"/);',
        'assert.match(docs, /pro tier in the eu region/);',
        'assert.match(docs, /Generated signup clients stay untouched/);',
        'assert.match(generated, /AUTO-GENERATED CLIENT\\. DO NOT EDIT/);',
        'assert.match(generated, /generatedSignupTier = "free"/);',
        'assert.match(generated, /generatedSignupRegion = "us"/);',
        'console.log("mixed language signup contract ok");',
        ""
      ].join("\n"),
      "utf8"
    );

    const providerLog = path.join(root, "provider-log.json");
    let turn = 0;
    const provider = await startProvider({
      logPath: providerLog,
      routeRequest: ({ transcript, toolNames }) => {
        turn += 1;
        if (turn === 1) {
          assert(toolNames.includes("Bash"), "Bash was not available");
          assert(toolNames.includes("FileRead"), "FileRead was not available");
          assert(toolNames.includes("FilePatch"), "FilePatch was not available");
          assert(
            transcript.includes("use FilePatch for multi-line edits"),
            "FilePatch guidance was not injected"
          );
          return toolResponse([
            toolCall("run-signup-contract-before", "Bash", {
              command: "node tests/signup-contract.test.mjs",
              timeout_ms: 5000
            }),
            toolCall("read-web-signup", "FileRead", {
              file_path: "services/web/src/signup.ts"
            }),
            toolCall("read-worker-signup", "FileRead", {
              file_path: "services/worker/signup.py"
            }),
            toolCall("read-signup-docs", "FileRead", {
              file_path: "docs/signup-contract.md"
            }),
            toolCall("read-generated-signup-client", "FileRead", {
              file_path: "generated/signup-client.ts"
            })
          ]);
        }
        if (turn === 2) {
          assert(transcript.includes("AssertionError"), "failing signup contract test was not visible");
          assert(transcript.includes('tier: "free"'), "TypeScript signup contract was not visible");
          assert(transcript.includes('"tier": "free"'), "Python signup contract was not visible");
          assert(
            transcript.includes("AUTO-GENERATED CLIENT"),
            "generated signup client boundary was not visible"
          );
          return toolResponse([
            toolCall("patch-web-signup-contract", "FilePatch", {
              file_path: "services/web/src/signup.ts",
              patch: [
                "@@",
                '-export const DEFAULT_REGION = "us";',
                '+export const DEFAULT_REGION = "eu";',
                " ",
                " export function buildSignupPayload(email: string) {",
                '-  return { email, tier: "free", region: DEFAULT_REGION };',
                '+  return { email, tier: "pro", region: DEFAULT_REGION };',
                " }"
              ].join("\n")
            }),
            toolCall("patch-worker-signup-contract", "FilePatch", {
              file_path: "services/worker/signup.py",
              patch: [
                "@@",
                '-DEFAULT_REGION = "us"',
                '+DEFAULT_REGION = "eu"',
                " ",
                " def build_signup_payload(email):",
                '-    return {"email": email, "tier": "free", "region": DEFAULT_REGION}',
                '+    return {"email": email, "tier": "pro", "region": DEFAULT_REGION}'
              ].join("\n")
            }),
            toolCall("patch-signup-contract-docs", "FilePatch", {
              file_path: "docs/signup-contract.md",
              patch: [
                "@@",
                " # Signup Contract",
                " ",
                "-The web and worker signup payloads default to free tier in the us region.",
                "-Generated signup clients are produced by OpenAPI and must not be edited by hand.",
                "+The web and worker signup payloads default to pro tier in the eu region.",
                "+Generated signup clients stay untouched because they are produced by OpenAPI."
              ].join("\n")
            })
          ]);
        }
        if (turn === 3) {
          assert(
            transcript.includes("Patched services/web/src/signup.ts"),
            "TypeScript signup patch was not visible"
          );
          assert(
            transcript.includes("Patched services/worker/signup.py"),
            "Python signup patch was not visible"
          );
          assert(
            transcript.includes("Patched docs/signup-contract.md"),
            "signup docs patch was not visible"
          );
          return toolResponse([
            toolCall("run-signup-contract-after", "Bash", {
              command: "node tests/signup-contract.test.mjs",
              timeout_ms: 5000
            })
          ]);
        }
        assert(
          transcript.includes("mixed language signup contract ok"),
          "passing mixed language contract test was not visible"
        );
        return messageText(
          "Mixed-language signup contract migration completed while preserving generated clients."
        );
      }
    });

    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig(provider.port), "utf8");
      const output = await runCli({
        args: [
          "--permission-mode",
          "acceptEdits",
          "--allowed-tools",
          "FileRead,FileWrite,FileEdit,FilePatch,FileMove,Glob,Grep,ToolSearch,Bash",
          "--model",
          "main",
          "--output-format",
          "stream-json",
          "-p",
          [
            "Migrate the signup contract across TypeScript web code, Python worker code, and docs.",
            "The new default is pro tier in the eu region.",
            "Run the focused signup contract test before editing, inspect generated client boundaries,",
            "do not edit generated files, then rerun the focused contract test."
          ].join(" ")
        ],
        cwd: workDir,
        configDir,
        label: "mixed language contract migration task"
      });
      assert(output.includes("session.completed"), "mixed language contract task did not complete");
      const web = readFileSync(path.join(workDir, "services", "web", "src", "signup.ts"), "utf8");
      const worker = readFileSync(path.join(workDir, "services", "worker", "signup.py"), "utf8");
      const docs = readFileSync(path.join(workDir, "docs", "signup-contract.md"), "utf8");
      const generatedAfter = readFileSync(
        path.join(workDir, "generated", "signup-client.ts"),
        "utf8"
      );
      assert(web.includes('DEFAULT_REGION = "eu"'), "TypeScript default region not migrated");
      assert(web.includes('tier: "pro"'), "TypeScript tier not migrated");
      assert(worker.includes('DEFAULT_REGION = "eu"'), "Python default region not migrated");
      assert(worker.includes('"tier": "pro"'), "Python tier not migrated");
      assert(docs.includes("pro tier in the eu region"), "signup docs contract not migrated");
      assert(docs.includes("Generated signup clients stay untouched"), "generated boundary docs missing");
      assert(generatedAfter === generatedBefore, "generated signup client was modified");
      const summary = provider.summary();
      const toolCounts = summary.toolCounts;
      assert(toolCounts.Bash === 2, "mixed language task should run tests before and after");
      assert(toolCounts.FileRead === 4, "mixed language task should inspect code, docs, and generated boundary");
      assert(toolCounts.FilePatch === 3, "mixed language task should patch TS, Python, and docs");
      assert(!toolCounts.FileWrite, "mixed language task should not rewrite existing files");
      assert(!toolCounts.FileEdit, "mixed language task should not use FileEdit");
      return {
        score: 1,
        assertions: [
          "focused failing mixed-language contract test ran first",
          "TypeScript signup contract inspected",
          "Python signup contract inspected",
          "generated client boundary inspected",
          "TypeScript signup contract patched",
          "Python signup contract patched",
          "signup docs contract patched",
          "focused passing mixed-language contract test ran after migration",
          "generated signup client stayed unchanged",
          "FileWrite avoided for mixed-language migration",
          "FileEdit avoided for mixed-language migration",
          "final response completed"
        ],
        filesVerified: [
          "services/web/src/signup.ts",
          "services/worker/signup.py",
          "generated/signup-client.ts",
          "docs/signup-contract.md",
          "tests/signup-contract.test.mjs"
        ],
        provider: summary,
        taskClass: "mixed_language_contract_migration",
        toolCounts,
        tsContractMigrated: true,
        pythonContractMigrated: true,
        docsContractMigrated: true,
        generatedClientUntouched: true,
        mixedLanguageContractVerified: true,
        fileWriteAvoided: !toolCounts.FileWrite,
        fileEditAvoided: !toolCounts.FileEdit
      };
    } catch (error) {
      printProviderLog(providerLog);
      throw error;
    } finally {
      await provider.close();
    }
  });
}

async function scenarioLargeRepoLongChainMigrationTask() {
  return await withWorkspace("large-repo-long-chain", async ({ root, configDir, workDir }) => {
    mkdirSync(path.join(workDir, "services", "api", "src"), { recursive: true });
    mkdirSync(path.join(workDir, "services", "web", "src"), { recursive: true });
    mkdirSync(path.join(workDir, "services", "worker", "jobs"), { recursive: true });
    mkdirSync(path.join(workDir, "packages", "shared", "src"), { recursive: true });
    mkdirSync(path.join(workDir, "packages", "audit", "src"), { recursive: true });
    mkdirSync(path.join(workDir, "apps", "admin", "src"), { recursive: true });
    mkdirSync(path.join(workDir, "apps", "mobile", "src"), { recursive: true });
    mkdirSync(path.join(workDir, "generated", "openapi"), { recursive: true });
    mkdirSync(path.join(workDir, "vendor", "sdk"), { recursive: true });
    mkdirSync(path.join(workDir, "fixtures", "workspaces"), { recursive: true });
    mkdirSync(path.join(workDir, "scripts"), { recursive: true });
    mkdirSync(path.join(workDir, "tests"), { recursive: true });
    mkdirSync(path.join(workDir, "docs"), { recursive: true });
    writeFileSync(
      path.join(workDir, "services", "api", "src", "workspaceContext.js"),
      [
        "export function buildContext(user, legacyProjectId) {",
        "  return { user, legacyProjectId };",
        "}",
        "",
        "export function workspaceHeader(context) {",
        '  return { "x-project-id": context.legacyProjectId };',
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "services", "api", "src", "audit.js"),
      [
        "export function auditWorkspaceRead(actor, legacyProjectId) {",
        '  return { actor, legacyProjectId, event: "project.read" };',
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "packages", "shared", "src", "workspace-schema.js"),
      [
        'export const idField = "legacyProjectId";',
        'export const routePrefix = "/projects";',
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "services", "web", "src", "workspaceClient.ts"),
      [
        "export type WorkspaceRouteParams = { legacyProjectId: string };",
        "",
        "export function workspacePath(params: WorkspaceRouteParams): string {",
        '  return `/projects/${params.legacyProjectId}/overview`;',
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "services", "web", "src", "dashboardCopy.ts"),
      [
        'export const dashboardIdLabel = "legacyProjectId";',
        'export const dashboardRouteHint = "/projects/:legacyProjectId/overview";',
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "services", "worker", "jobs", "project_sync.py"),
      [
        'ID_FIELD = "legacyProjectId"',
        "",
        "def sync_project(legacy_project_id):",
        '    return {"path": f"/projects/{legacy_project_id}/sync", "field": ID_FIELD}',
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "packages", "audit", "src", "events.js"),
      [
        'export const workspaceReadEvent = "project.read";',
        "",
        "export function serializeWorkspaceEvent(legacyProjectId) {",
        "  return { legacyProjectId, event: workspaceReadEvent };",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "docs", "api-contract.md"),
      [
        "# API Contract",
        "",
        "Clients send legacyProjectId in the x-project-id header.",
        "Workspace overview routes are under /projects/:legacyProjectId/overview.",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "docs", "runbook.md"),
      [
        "# Runbook",
        "",
        "Use legacyProjectId when tracing project.read events.",
        "Worker sync jobs call /projects/{legacyProjectId}/sync.",
        ""
      ].join("\n"),
      "utf8"
    );
    const generatedBefore = [
      "// AUTO-GENERATED OPENAPI CLIENT. DO NOT EDIT.",
      "export type GeneratedWorkspaceParams = { legacyProjectId: string };",
      'export const generatedProjectPath = "/projects/{legacyProjectId}";',
      ""
    ].join("\n");
    const vendorBefore = [
      "// third party SDK shim",
      'export const sdkIdField = "legacyProjectId";',
      'export const sdkRoute = "/projects/{legacyProjectId}";',
      ""
    ].join("\n");
    writeFileSync(
      path.join(workDir, "generated", "openapi", "workspace-client.ts"),
      generatedBefore,
      "utf8"
    );
    writeFileSync(path.join(workDir, "vendor", "sdk", "legacy-project.js"), vendorBefore, "utf8");
    writeFileSync(
      path.join(workDir, "apps", "admin", "src", "overview.ts"),
      'export const adminPanel = "workspace overview";\n',
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "apps", "mobile", "src", "settings.ts"),
      'export const mobileSettingsPanel = "workspace settings";\n',
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "fixtures", "workspaces", "sample.json"),
      '{ "workspaceId": "ws_123", "name": "Acme" }\n',
      "utf8"
    );
    writeFileSync(path.join(workDir, "scripts", "README.md"), "# Scripts\n\nNo migration needed.\n", "utf8");
    writeFileSync(
      path.join(workDir, "tests", "workspace-contract.test.mjs"),
      [
        'import assert from "node:assert/strict";',
        'import { readFileSync } from "node:fs";',
        'import { buildContext, workspaceHeader } from "../services/api/src/workspaceContext.js";',
        "",
        'const context = buildContext("ada", "ws_123");',
        'assert.deepEqual(context, { user: "ada", workspaceId: "ws_123" });',
        'assert.deepEqual(workspaceHeader(context), { "x-workspace-id": "ws_123" });',
        "",
        "const mutableFiles = [",
        '  "services/api/src/workspaceContext.js",',
        '  "services/api/src/audit.js",',
        '  "packages/shared/src/workspace-schema.js",',
        '  "services/web/src/workspaceClient.ts",',
        '  "services/web/src/dashboardCopy.ts",',
        '  "services/worker/jobs/project_sync.py",',
        '  "packages/audit/src/events.js",',
        '  "docs/api-contract.md",',
        '  "docs/runbook.md"',
        "];",
        "for (const file of mutableFiles) {",
        '  const content = readFileSync(file, "utf8");',
        "  assert.doesNotMatch(content, /legacyProjectId/);",
        '  assert.doesNotMatch(content, /x-project-id/);',
        '  assert.doesNotMatch(content, /\\/projects\\//);',
        "  assert.match(content, /workspaceId|workspace\\.read|workspaces|x-workspace-id/);",
        "}",
        "",
        'const web = readFileSync("services/web/src/workspaceClient.ts", "utf8");',
        'assert.match(web, /WorkspaceRouteParams = \\{ workspaceId: string \\}/);',
        'assert.match(web, /\\/workspaces\\/\\$\\{params\\.workspaceId\\}\\/overview/);',
        'const worker = readFileSync("services/worker/jobs/project_sync.py", "utf8");',
        'assert.match(worker, /def sync_workspace\\(workspace_id\\):/);',
        'assert.match(worker, /\\/workspaces\\/\\{workspace_id\\}\\/sync/);',
        'const generated = readFileSync("generated/openapi/workspace-client.ts", "utf8");',
        'assert.match(generated, /AUTO-GENERATED OPENAPI CLIENT\\. DO NOT EDIT/);',
        'assert.match(generated, /legacyProjectId/);',
        'const vendor = readFileSync("vendor/sdk/legacy-project.js", "utf8");',
        'assert.match(vendor, /third party SDK shim/);',
        'assert.match(vendor, /legacyProjectId/);',
        'console.log("large repo workspace migration ok");',
        ""
      ].join("\n"),
      "utf8"
    );

    const providerLog = path.join(root, "provider-log.json");
    let turn = 0;
    const provider = await startProvider({
      logPath: providerLog,
      routeRequest: ({ transcript, toolNames }) => {
        turn += 1;
        if (turn === 1) {
          assert(toolNames.includes("Bash"), "Bash was not available");
          assert(toolNames.includes("Glob"), "Glob was not available");
          assert(toolNames.includes("Grep"), "Grep was not available");
          assert(toolNames.includes("FileRead"), "FileRead was not available");
          assert(toolNames.includes("FilePatch"), "FilePatch was not available");
          return toolResponse([
            toolCall("run-workspace-contract-before", "Bash", {
              command: "node tests/workspace-contract.test.mjs",
              timeout_ms: 5000
            }),
            toolCall("glob-large-repo", "Glob", {
              pattern: "**/*.{js,ts,py,md,json,mjs}",
              max_matches: 40
            }),
            toolCall("grep-legacy-project-id", "Grep", {
              pattern: "legacyProjectId",
              path: ".",
              output_mode: "content",
              max_matches: 40
            }),
            toolCall("read-workspace-contract-test", "FileRead", {
              file_path: "tests/workspace-contract.test.mjs"
            }),
            toolCall("read-api-context", "FileRead", {
              file_path: "services/api/src/workspaceContext.js"
            }),
            toolCall("read-api-audit", "FileRead", {
              file_path: "services/api/src/audit.js"
            }),
            toolCall("read-shared-schema", "FileRead", {
              file_path: "packages/shared/src/workspace-schema.js"
            }),
            toolCall("read-web-client", "FileRead", {
              file_path: "services/web/src/workspaceClient.ts"
            }),
            toolCall("read-dashboard-copy", "FileRead", {
              file_path: "services/web/src/dashboardCopy.ts"
            }),
            toolCall("read-worker-sync", "FileRead", {
              file_path: "services/worker/jobs/project_sync.py"
            }),
            toolCall("read-audit-events", "FileRead", {
              file_path: "packages/audit/src/events.js"
            }),
            toolCall("read-api-contract-docs", "FileRead", {
              file_path: "docs/api-contract.md"
            }),
            toolCall("read-runbook-docs", "FileRead", {
              file_path: "docs/runbook.md"
            }),
            toolCall("read-generated-openapi-client", "FileRead", {
              file_path: "generated/openapi/workspace-client.ts"
            }),
            toolCall("read-vendor-sdk", "FileRead", {
              file_path: "vendor/sdk/legacy-project.js"
            })
          ]);
        }
        if (turn === 2) {
          assert(transcript.includes("AssertionError"), "failing workspace contract test missing");
          assert(transcript.includes("services/api/src/workspaceContext.js"), "large repo file list missing");
          assert(transcript.includes("legacyProjectId"), "legacy id search results missing");
          assert(
            transcript.includes("AUTO-GENERATED OPENAPI CLIENT"),
            "generated OpenAPI boundary missing"
          );
          assert(transcript.includes("third party SDK shim"), "vendor SDK boundary missing");
          return toolResponse([
            toolCall("patch-api-context", "FilePatch", {
              file_path: "services/api/src/workspaceContext.js",
              patch: [
                "@@",
                "-export function buildContext(user, legacyProjectId) {",
                "-  return { user, legacyProjectId };",
                "+export function buildContext(user, workspaceId) {",
                "+  return { user, workspaceId };",
                " }",
                " ",
                " export function workspaceHeader(context) {",
                '-  return { "x-project-id": context.legacyProjectId };',
                '+  return { "x-workspace-id": context.workspaceId };',
                " }"
              ].join("\n")
            }),
            toolCall("patch-api-audit", "FilePatch", {
              file_path: "services/api/src/audit.js",
              patch: [
                "@@",
                "-export function auditWorkspaceRead(actor, legacyProjectId) {",
                '-  return { actor, legacyProjectId, event: "project.read" };',
                "+export function auditWorkspaceRead(actor, workspaceId) {",
                '+  return { actor, workspaceId, event: "workspace.read" };',
                " }"
              ].join("\n")
            }),
            toolCall("patch-shared-schema", "FilePatch", {
              file_path: "packages/shared/src/workspace-schema.js",
              patch: [
                "@@",
                '-export const idField = "legacyProjectId";',
                '-export const routePrefix = "/projects";',
                '+export const idField = "workspaceId";',
                '+export const routePrefix = "/workspaces";'
              ].join("\n")
            }),
            toolCall("patch-web-client", "FilePatch", {
              file_path: "services/web/src/workspaceClient.ts",
              patch: [
                "@@",
                "-export type WorkspaceRouteParams = { legacyProjectId: string };",
                "+export type WorkspaceRouteParams = { workspaceId: string };",
                " ",
                " export function workspacePath(params: WorkspaceRouteParams): string {",
                "-  return `/projects/${params.legacyProjectId}/overview`;",
                "+  return `/workspaces/${params.workspaceId}/overview`;",
                " }"
              ].join("\n")
            }),
            toolCall("patch-dashboard-copy", "FilePatch", {
              file_path: "services/web/src/dashboardCopy.ts",
              patch: [
                "@@",
                '-export const dashboardIdLabel = "legacyProjectId";',
                '-export const dashboardRouteHint = "/projects/:legacyProjectId/overview";',
                '+export const dashboardIdLabel = "workspaceId";',
                '+export const dashboardRouteHint = "/workspaces/:workspaceId/overview";'
              ].join("\n")
            }),
            toolCall("patch-worker-sync", "FilePatch", {
              file_path: "services/worker/jobs/project_sync.py",
              patch: [
                "@@",
                '-ID_FIELD = "legacyProjectId"',
                '+ID_FIELD = "workspaceId"',
                " ",
                "-def sync_project(legacy_project_id):",
                '-    return {"path": f"/projects/{legacy_project_id}/sync", "field": ID_FIELD}',
                "+def sync_workspace(workspace_id):",
                '+    return {"path": f"/workspaces/{workspace_id}/sync", "field": ID_FIELD}'
              ].join("\n")
            }),
            toolCall("patch-audit-events", "FilePatch", {
              file_path: "packages/audit/src/events.js",
              patch: [
                "@@",
                '-export const workspaceReadEvent = "project.read";',
                '+export const workspaceReadEvent = "workspace.read";',
                " ",
                "-export function serializeWorkspaceEvent(legacyProjectId) {",
                "-  return { legacyProjectId, event: workspaceReadEvent };",
                "+export function serializeWorkspaceEvent(workspaceId) {",
                "+  return { workspaceId, event: workspaceReadEvent };",
                " }"
              ].join("\n")
            }),
            toolCall("patch-api-contract-docs", "FilePatch", {
              file_path: "docs/api-contract.md",
              patch: [
                "@@",
                " # API Contract",
                " ",
                "-Clients send legacyProjectId in the x-project-id header.",
                "-Workspace overview routes are under /projects/:legacyProjectId/overview.",
                "+Clients send workspaceId in the x-workspace-id header.",
                "+Workspace overview routes are under /workspaces/:workspaceId/overview."
              ].join("\n")
            }),
            toolCall("patch-runbook-docs", "FilePatch", {
              file_path: "docs/runbook.md",
              patch: [
                "@@",
                " # Runbook",
                " ",
                "-Use legacyProjectId when tracing project.read events.",
                "-Worker sync jobs call /projects/{legacyProjectId}/sync.",
                "+Use workspaceId when tracing workspace.read events.",
                "+Worker sync jobs call /workspaces/{workspaceId}/sync."
              ].join("\n")
            })
          ]);
        }
        if (turn === 3) {
          assert(
            transcript.includes("Patched services/api/src/workspaceContext.js"),
            "api context patch result missing"
          );
          assert(transcript.includes("Patched services/api/src/audit.js"), "api audit patch missing");
          assert(
            transcript.includes("Patched packages/shared/src/workspace-schema.js"),
            "shared schema patch missing"
          );
          assert(
            transcript.includes("Patched services/web/src/workspaceClient.ts"),
            "web client patch missing"
          );
          assert(
            transcript.includes("Patched services/worker/jobs/project_sync.py"),
            "worker sync patch missing"
          );
          assert(transcript.includes("Patched docs/runbook.md"), "runbook docs patch missing");
          return toolResponse([
            toolCall("run-workspace-contract-after", "Bash", {
              command: "node tests/workspace-contract.test.mjs",
              timeout_ms: 5000
            })
          ]);
        }
        assert(
          transcript.includes("large repo workspace migration ok"),
          "passing large repo migration test missing"
        );
        return messageText(
          "Large repo workspace contract migration completed with generated and vendor boundaries preserved."
        );
      }
    });

    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig(provider.port), "utf8");
      const output = await runCli({
        args: [
          "--permission-mode",
          "acceptEdits",
          "--allowed-tools",
          "FileRead,FileWrite,FileEdit,FilePatch,FileMove,Glob,Grep,ToolSearch,Bash",
          "--model",
          "main",
          "--output-format",
          "stream-json",
          "-p",
          [
            "Migrate this larger repo from legacyProjectId/project routes to workspaceId/workspace routes.",
            "Run the focused workspace contract test before editing, discover the repo with Glob and Grep,",
            "inspect owned files plus generated and vendor boundaries, patch source/docs across packages,",
            "do not modify generated/openapi or vendor/sdk files, then rerun the focused contract test."
          ].join(" ")
        ],
        cwd: workDir,
        configDir,
        label: "large repo long-chain migration task",
        timeoutMs: 45_000
      });
      assert(output.includes("session.completed"), "large repo migration task did not complete");
      const mutableFiles = [
        "services/api/src/workspaceContext.js",
        "services/api/src/audit.js",
        "packages/shared/src/workspace-schema.js",
        "services/web/src/workspaceClient.ts",
        "services/web/src/dashboardCopy.ts",
        "services/worker/jobs/project_sync.py",
        "packages/audit/src/events.js",
        "docs/api-contract.md",
        "docs/runbook.md"
      ];
      for (const file of mutableFiles) {
        const content = readFileSync(path.join(workDir, file), "utf8");
        assert(!content.includes("legacyProjectId"), `${file} still contains legacyProjectId`);
        assert(!content.includes("x-project-id"), `${file} still contains x-project-id`);
        assert(!content.includes("/projects/"), `${file} still contains /projects/ route`);
      }
      const context = readFileSync(
        path.join(workDir, "services", "api", "src", "workspaceContext.js"),
        "utf8"
      );
      const webClient = readFileSync(
        path.join(workDir, "services", "web", "src", "workspaceClient.ts"),
        "utf8"
      );
      const worker = readFileSync(
        path.join(workDir, "services", "worker", "jobs", "project_sync.py"),
        "utf8"
      );
      const docs = readFileSync(path.join(workDir, "docs", "api-contract.md"), "utf8");
      const generatedAfter = readFileSync(
        path.join(workDir, "generated", "openapi", "workspace-client.ts"),
        "utf8"
      );
      const vendorAfter = readFileSync(
        path.join(workDir, "vendor", "sdk", "legacy-project.js"),
        "utf8"
      );
      assert(context.includes("workspaceHeader"), "workspace context missing exported header");
      assert(context.includes('"x-workspace-id"'), "workspace header not migrated");
      assert(webClient.includes("workspaceId: string"), "web route param not migrated");
      assert(webClient.includes("/workspaces/${params.workspaceId}/overview"), "web route not migrated");
      assert(worker.includes("def sync_workspace(workspace_id):"), "worker sync function not migrated");
      assert(docs.includes("x-workspace-id"), "API contract docs not migrated");
      assert(generatedAfter === generatedBefore, "generated OpenAPI client was modified");
      assert(vendorAfter === vendorBefore, "vendor SDK shim was modified");
      const summary = provider.summary();
      const toolCounts = summary.toolCounts;
      assert(toolCounts.Bash === 2, "large repo task should run focused tests before and after");
      assert(toolCounts.Glob === 1, "large repo task should discover files with Glob");
      assert(toolCounts.Grep === 1, "large repo task should search old id with Grep");
      assert(toolCounts.FileRead === 12, "large repo task should inspect owned and boundary files");
      assert(toolCounts.FilePatch === 9, "large repo task should patch nine owned files");
      assert(!toolCounts.FileWrite, "large repo task should not rewrite existing files");
      assert(!toolCounts.FileEdit, "large repo task should not use FileEdit");
      return {
        score: 1,
        assertions: [
          "focused failing workspace contract test ran first",
          "large repo file discovery ran with Glob",
          "legacy id search ran with Grep",
          "owned source files inspected before patching",
          "generated OpenAPI boundary inspected",
          "vendor SDK boundary inspected",
          "api context migrated to workspaceId header",
          "api audit migrated to workspace events",
          "shared schema route prefix migrated",
          "web route contract migrated",
          "worker sync contract migrated",
          "docs migrated across API contract and runbook",
          "focused passing workspace contract test ran after migration",
          "old owned legacy references removed",
          "generated OpenAPI client stayed unchanged",
          "vendor SDK shim stayed unchanged",
          "FileWrite avoided for large repo migration",
          "FileEdit avoided for large repo migration",
          "final response completed"
        ],
        filesVerified: [
          "services/api/src/workspaceContext.js",
          "services/api/src/audit.js",
          "packages/shared/src/workspace-schema.js",
          "services/web/src/workspaceClient.ts",
          "services/web/src/dashboardCopy.ts",
          "services/worker/jobs/project_sync.py",
          "packages/audit/src/events.js",
          "docs/api-contract.md",
          "docs/runbook.md",
          "generated/openapi/workspace-client.ts",
          "vendor/sdk/legacy-project.js",
          "tests/workspace-contract.test.mjs"
        ],
        provider: summary,
        taskClass: "large_repo_long_chain_migration",
        toolCounts,
        repoDiscoveryVerified: true,
        sourceContractsMigrated: true,
        docsMigrated: true,
        oldOwnedReferencesRemoved: true,
        generatedClientUntouched: true,
        vendorShimUntouched: true,
        largeRepoLongChainVerified: true,
        fileWriteAvoided: !toolCounts.FileWrite,
        fileEditAvoided: !toolCounts.FileEdit
      };
    } catch (error) {
      printProviderLog(providerLog);
      throw error;
    } finally {
      await provider.close();
    }
  });
}

async function scenarioPluginApiCompatibilityMigrationTask() {
  return await withWorkspace("plugin-api-compatibility", async ({ root, configDir, workDir }) => {
    mkdirSync(path.join(workDir, "packages", "core", "src"), { recursive: true });
    mkdirSync(path.join(workDir, "packages", "plugin-auth", "src"), { recursive: true });
    mkdirSync(path.join(workDir, "packages", "plugin-cache", "src"), { recursive: true });
    mkdirSync(path.join(workDir, "packages", "adapter-legacy", "src"), { recursive: true });
    mkdirSync(path.join(workDir, "examples", "express"), { recursive: true });
    mkdirSync(path.join(workDir, "docs"), { recursive: true });
    mkdirSync(path.join(workDir, "changelog"), { recursive: true });
    mkdirSync(path.join(workDir, "generated"), { recursive: true });
    mkdirSync(path.join(workDir, "vendor"), { recursive: true });
    mkdirSync(path.join(workDir, "tests"), { recursive: true });
    writeFileSync(
      path.join(workDir, "packages", "core", "src", "pluginRuntime.js"),
      [
        "export function runPlugin(plugin, request) {",
        '  if (typeof plugin.onRequest !== "function") {',
        '    throw new Error("plugin must expose onRequest");',
        "  }",
        "  return plugin.onRequest(request);",
        "}",
        "",
        "export function pluginHookName() {",
        '  return "onRequest";',
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "packages", "plugin-auth", "src", "index.js"),
      [
        "export const authPlugin = {",
        '  name: "auth",',
        "  onRequest(request) {",
        "    return { ...request, auth: true };",
        "  }",
        "};",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "packages", "plugin-cache", "src", "index.js"),
      [
        "export const cachePlugin = {",
        '  name: "cache",',
        "  onRequest(request) {",
        '    return { ...request, cache: "hit" };',
        "  }",
        "};",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "packages", "adapter-legacy", "src", "index.js"),
      [
        "export function adaptLegacyPlugin(plugin) {",
        "  return {",
        "    name: plugin.name,",
        "    onRequest: plugin.onRequest",
        "  };",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "examples", "express", "server.js"),
      [
        'import { runPlugin } from "../../packages/core/src/pluginRuntime.js";',
        'import { authPlugin } from "../../packages/plugin-auth/src/index.js";',
        "",
        'export const pluginHook = "onRequest";',
        'export const result = runPlugin(authPlugin, { path: "/secure" });',
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "docs", "plugin-api.md"),
      [
        "# Plugin API",
        "",
        "Plugins expose `onRequest(request)`.",
        "Use the legacy adapter for older onRequest plugins.",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "changelog", "unreleased.md"),
      [
        "# Unreleased",
        "",
        "- Pending plugin onRequest migration.",
        ""
      ].join("\n"),
      "utf8"
    );
    const generatedBefore = [
      "// AUTO-GENERATED PLUGIN TYPES. DO NOT EDIT.",
      "export interface GeneratedPlugin {",
      "  onRequest?: (request: unknown) => unknown;",
      "}",
      ""
    ].join("\n");
    const vendorBefore = [
      "// third party plugin shim",
      'export const vendorPluginHook = "onRequest";',
      ""
    ].join("\n");
    writeFileSync(path.join(workDir, "generated", "plugin-types.d.ts"), generatedBefore, "utf8");
    writeFileSync(path.join(workDir, "vendor", "legacy-plugin.js"), vendorBefore, "utf8");
    writeFileSync(
      path.join(workDir, "tests", "plugin-api.test.mjs"),
      [
        'import assert from "node:assert/strict";',
        'import { readFileSync } from "node:fs";',
        'import { runPlugin, pluginHookName } from "../packages/core/src/pluginRuntime.js";',
        'import { authPlugin } from "../packages/plugin-auth/src/index.js";',
        'import { cachePlugin } from "../packages/plugin-cache/src/index.js";',
        'import { adaptLegacyPlugin } from "../packages/adapter-legacy/src/index.js";',
        'import { pluginHook, result } from "../examples/express/server.js";',
        "",
        'assert.equal(pluginHookName(), "handleRequest");',
        'assert.equal(pluginHook, "handleRequest");',
        'assert.deepEqual(result, { path: "/secure", auth: true });',
        'assert.deepEqual(runPlugin(cachePlugin, { path: "/cached" }), {',
        '  path: "/cached",',
        '  cache: "hit"',
        "});",
        "const legacyPlugin = {",
        '  name: "legacy",',
        "  onRequest(request) {",
        "    return { ...request, legacy: true };",
        "  }",
        "};",
        'assert.deepEqual(runPlugin(adaptLegacyPlugin(legacyPlugin), { path: "/old" }), {',
        '  path: "/old",',
        "  legacy: true",
        "});",
        "",
        "const migratedOwnedFiles = [",
        '  "packages/core/src/pluginRuntime.js",',
        '  "packages/plugin-auth/src/index.js",',
        '  "packages/plugin-cache/src/index.js",',
        '  "examples/express/server.js",',
        '  "docs/plugin-api.md",',
        '  "changelog/unreleased.md"',
        "];",
        "for (const file of migratedOwnedFiles) {",
        '  const content = readFileSync(file, "utf8");',
        '  assert.doesNotMatch(content, /onRequest/);',
        '  assert.match(content, /handleRequest/);',
        "}",
        'const adapter = readFileSync("packages/adapter-legacy/src/index.js", "utf8");',
        'assert.match(adapter, /handleRequest/);',
        'assert.match(adapter, /onRequest/);',
        'const generated = readFileSync("generated/plugin-types.d.ts", "utf8");',
        'assert.match(generated, /AUTO-GENERATED PLUGIN TYPES\\. DO NOT EDIT/);',
        'assert.match(generated, /onRequest/);',
        'const vendor = readFileSync("vendor/legacy-plugin.js", "utf8");',
        'assert.match(vendor, /third party plugin shim/);',
        'assert.match(vendor, /onRequest/);',
        'console.log("plugin api compatibility migration ok");',
        ""
      ].join("\n"),
      "utf8"
    );

    const providerLog = path.join(root, "provider-log.json");
    let turn = 0;
    const provider = await startProvider({
      logPath: providerLog,
      routeRequest: ({ transcript, toolNames }) => {
        turn += 1;
        if (turn === 1) {
          assert(toolNames.includes("Bash"), "Bash was not available");
          assert(toolNames.includes("Glob"), "Glob was not available");
          assert(toolNames.includes("Grep"), "Grep was not available");
          assert(toolNames.includes("FileRead"), "FileRead was not available");
          assert(toolNames.includes("FilePatch"), "FilePatch was not available");
          return toolResponse([
            toolCall("run-plugin-api-before", "Bash", {
              command: "node tests/plugin-api.test.mjs",
              timeout_ms: 5000
            }),
            toolCall("glob-plugin-api-repo", "Glob", {
              pattern: "**/*.{js,md,ts,mjs}",
              max_matches: 50
            }),
            toolCall("grep-on-request", "Grep", {
              pattern: "onRequest",
              path: ".",
              output_mode: "content",
              max_matches: 50
            }),
            toolCall("read-plugin-api-test", "FileRead", {
              file_path: "tests/plugin-api.test.mjs"
            }),
            toolCall("read-plugin-runtime", "FileRead", {
              file_path: "packages/core/src/pluginRuntime.js"
            }),
            toolCall("read-auth-plugin-api", "FileRead", {
              file_path: "packages/plugin-auth/src/index.js"
            }),
            toolCall("read-cache-plugin-api", "FileRead", {
              file_path: "packages/plugin-cache/src/index.js"
            }),
            toolCall("read-legacy-adapter", "FileRead", {
              file_path: "packages/adapter-legacy/src/index.js"
            }),
            toolCall("read-express-example", "FileRead", {
              file_path: "examples/express/server.js"
            }),
            toolCall("read-plugin-api-docs", "FileRead", {
              file_path: "docs/plugin-api.md"
            }),
            toolCall("read-plugin-api-changelog", "FileRead", {
              file_path: "changelog/unreleased.md"
            }),
            toolCall("read-generated-plugin-types", "FileRead", {
              file_path: "generated/plugin-types.d.ts"
            }),
            toolCall("read-vendor-plugin", "FileRead", {
              file_path: "vendor/legacy-plugin.js"
            })
          ]);
        }
        if (turn === 2) {
          assert(transcript.includes("AssertionError"), "failing plugin API test missing");
          assert(transcript.includes("packages/core/src/pluginRuntime.js"), "plugin repo file list missing");
          assert(transcript.includes("onRequest"), "legacy onRequest search results missing");
          assert(transcript.includes("AUTO-GENERATED PLUGIN TYPES"), "generated plugin boundary missing");
          assert(transcript.includes("third party plugin shim"), "vendor plugin boundary missing");
          return toolResponse([
            toolCall("patch-plugin-runtime", "FilePatch", {
              file_path: "packages/core/src/pluginRuntime.js",
              patch: [
                "@@",
                " export function runPlugin(plugin, request) {",
                '-  if (typeof plugin.onRequest !== "function") {',
                '-    throw new Error("plugin must expose onRequest");',
                '+  if (typeof plugin.handleRequest !== "function") {',
                '+    throw new Error("plugin must expose handleRequest");',
                "   }",
                "-  return plugin.onRequest(request);",
                "+  return plugin.handleRequest(request);",
                " }",
                " ",
                " export function pluginHookName() {",
                '-  return "onRequest";',
                '+  return "handleRequest";',
                " }"
              ].join("\n")
            }),
            toolCall("patch-auth-plugin-api", "FilePatch", {
              file_path: "packages/plugin-auth/src/index.js",
              patch: [
                "@@",
                " export const authPlugin = {",
                '   name: "auth",',
                "-  onRequest(request) {",
                "+  handleRequest(request) {",
                "     return { ...request, auth: true };",
                "   }",
                " };"
              ].join("\n")
            }),
            toolCall("patch-cache-plugin-api", "FilePatch", {
              file_path: "packages/plugin-cache/src/index.js",
              patch: [
                "@@",
                " export const cachePlugin = {",
                '   name: "cache",',
                "-  onRequest(request) {",
                "+  handleRequest(request) {",
                '     return { ...request, cache: "hit" };',
                "   }",
                " };"
              ].join("\n")
            }),
            toolCall("patch-legacy-adapter", "FilePatch", {
              file_path: "packages/adapter-legacy/src/index.js",
              patch: [
                "@@",
                " export function adaptLegacyPlugin(plugin) {",
                "   return {",
                "     name: plugin.name,",
                "-    onRequest: plugin.onRequest",
                "+    handleRequest(request) {",
                "+      return plugin.onRequest(request);",
                "+    }",
                "   };",
                " }"
              ].join("\n")
            }),
            toolCall("patch-express-example", "FilePatch", {
              file_path: "examples/express/server.js",
              patch: [
                "@@",
                ' import { authPlugin } from "../../packages/plugin-auth/src/index.js";',
                " ",
                '-export const pluginHook = "onRequest";',
                '+export const pluginHook = "handleRequest";',
                ' export const result = runPlugin(authPlugin, { path: "/secure" });'
              ].join("\n")
            }),
            toolCall("patch-plugin-api-docs", "FilePatch", {
              file_path: "docs/plugin-api.md",
              patch: [
                "@@",
                " # Plugin API",
                " ",
                "-Plugins expose `onRequest(request)`.",
                "-Use the legacy adapter for older onRequest plugins.",
                "+Plugins expose `handleRequest(request)`.",
                "+Use the legacy adapter when wrapping older plugin hooks."
              ].join("\n")
            }),
            toolCall("patch-plugin-api-changelog", "FilePatch", {
              file_path: "changelog/unreleased.md",
              patch: [
                "@@",
                " # Unreleased",
                " ",
                "-- Pending plugin onRequest migration.",
                "+- Migrated the public plugin hook to handleRequest while preserving the legacy adapter."
              ].join("\n")
            })
          ]);
        }
        if (turn === 3) {
          assert(
            transcript.includes("Patched packages/core/src/pluginRuntime.js"),
            "plugin runtime patch result missing"
          );
          assert(
            transcript.includes("Patched packages/plugin-auth/src/index.js"),
            "auth plugin API patch result missing"
          );
          assert(
            transcript.includes("Patched packages/adapter-legacy/src/index.js"),
            "legacy adapter patch result missing"
          );
          assert(transcript.includes("Patched docs/plugin-api.md"), "plugin docs patch missing");
          return toolResponse([
            toolCall("run-plugin-api-after", "Bash", {
              command: "node tests/plugin-api.test.mjs",
              timeout_ms: 5000
            })
          ]);
        }
        assert(
          transcript.includes("plugin api compatibility migration ok"),
          "passing plugin API compatibility test missing"
        );
        return messageText(
          "Plugin API compatibility migration completed while generated types and vendor shims stayed unchanged."
        );
      }
    });

    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig(provider.port), "utf8");
      const output = await runCli({
        args: [
          "--permission-mode",
          "acceptEdits",
          "--allowed-tools",
          "FileRead,FileWrite,FileEdit,FilePatch,FileMove,Glob,Grep,ToolSearch,Bash",
          "--model",
          "main",
          "--output-format",
          "stream-json",
          "-p",
          [
            "In this OSS-style plugin repository, migrate the public plugin hook",
            "from onRequest to handleRequest across core runtime, first-party plugins,",
            "examples, docs, and changelog. Keep the legacy adapter compatible with old",
            "onRequest plugins. Run the focused plugin API test before editing, discover",
            "the repo with Glob and Grep, inspect generated and vendor boundaries, do not",
            "modify generated or vendor files, then rerun the focused plugin API test."
          ].join(" ")
        ],
        cwd: workDir,
        configDir,
        label: "plugin API compatibility migration task",
        timeoutMs: 45_000
      });
      assert(output.includes("session.completed"), "plugin API compatibility task did not complete");
      const migratedFiles = [
        "packages/core/src/pluginRuntime.js",
        "packages/plugin-auth/src/index.js",
        "packages/plugin-cache/src/index.js",
        "examples/express/server.js",
        "docs/plugin-api.md",
        "changelog/unreleased.md"
      ];
      for (const file of migratedFiles) {
        const content = readFileSync(path.join(workDir, file), "utf8");
        assert(!content.includes("onRequest"), `${file} still contains onRequest`);
        assert(content.includes("handleRequest"), `${file} missing handleRequest`);
      }
      const adapter = readFileSync(
        path.join(workDir, "packages", "adapter-legacy", "src", "index.js"),
        "utf8"
      );
      const generatedAfter = readFileSync(path.join(workDir, "generated", "plugin-types.d.ts"), "utf8");
      const vendorAfter = readFileSync(path.join(workDir, "vendor", "legacy-plugin.js"), "utf8");
      assert(adapter.includes("handleRequest"), "legacy adapter missing handleRequest");
      assert(adapter.includes("onRequest"), "legacy adapter no longer wraps onRequest");
      assert(generatedAfter === generatedBefore, "generated plugin types were modified");
      assert(vendorAfter === vendorBefore, "vendor plugin shim was modified");
      const summary = provider.summary();
      const toolCounts = summary.toolCounts;
      assert(toolCounts.Bash === 2, "plugin API task should run tests before and after");
      assert(toolCounts.Glob === 1, "plugin API task should discover files with Glob");
      assert(toolCounts.Grep === 1, "plugin API task should search legacy hook with Grep");
      assert(toolCounts.FileRead === 10, "plugin API task should inspect owned and boundary files");
      assert(toolCounts.FilePatch === 7, "plugin API task should patch seven owned files");
      assert(!toolCounts.FileWrite, "plugin API task should not rewrite existing files");
      assert(!toolCounts.FileEdit, "plugin API task should not use FileEdit");
      return {
        score: 1,
        assertions: [
          "focused failing plugin API test ran first",
          "plugin API repo discovery ran with Glob",
          "legacy hook search ran with Grep",
          "core plugin runtime inspected before patching",
          "first-party plugins inspected before patching",
          "legacy adapter inspected before patching",
          "example docs and changelog inspected before patching",
          "generated plugin types boundary inspected",
          "vendor plugin shim boundary inspected",
          "core plugin runtime migrated to handleRequest",
          "first-party plugin hooks migrated",
          "legacy adapter preserved old plugin compatibility",
          "example plugin usage migrated",
          "plugin API docs migrated",
          "plugin API changelog migrated",
          "focused passing plugin API test ran after migration",
          "old owned onRequest references removed",
          "generated plugin types stayed unchanged",
          "vendor plugin shim stayed unchanged",
          "FileWrite avoided for plugin API migration",
          "FileEdit avoided for plugin API migration",
          "final response completed"
        ],
        filesVerified: [
          "packages/core/src/pluginRuntime.js",
          "packages/plugin-auth/src/index.js",
          "packages/plugin-cache/src/index.js",
          "packages/adapter-legacy/src/index.js",
          "examples/express/server.js",
          "docs/plugin-api.md",
          "changelog/unreleased.md",
          "generated/plugin-types.d.ts",
          "vendor/legacy-plugin.js",
          "tests/plugin-api.test.mjs"
        ],
        provider: summary,
        taskClass: "plugin_api_compatibility_migration",
        toolCounts,
        pluginApiRepoDiscoveryVerified: true,
        pluginRuntimeMigrated: true,
        firstPartyPluginsMigrated: true,
        legacyAdapterCompatibilityPreserved: true,
        examplesDocsChangelogMigrated: true,
        oldOwnedHookReferencesRemoved: true,
        generatedPluginTypesUntouched: true,
        vendorPluginShimUntouched: true,
        pluginApiCompatibilityVerified: true,
        fileWriteAvoided: !toolCounts.FileWrite,
        fileEditAvoided: !toolCounts.FileEdit
      };
    } catch (error) {
      printProviderLog(providerLog);
      throw error;
    } finally {
      await provider.close();
    }
  });
}

async function scenarioSecurityMiddlewarePolicyMigrationTask() {
  return await withWorkspace("security-middleware-policy", async ({ root, configDir, workDir }) => {
    mkdirSync(path.join(workDir, "packages", "server", "src"), { recursive: true });
    mkdirSync(path.join(workDir, "packages", "config"), { recursive: true });
    mkdirSync(path.join(workDir, "packages", "client", "src"), { recursive: true });
    mkdirSync(path.join(workDir, "examples", "express"), { recursive: true });
    mkdirSync(path.join(workDir, "docs"), { recursive: true });
    mkdirSync(path.join(workDir, "changelog"), { recursive: true });
    mkdirSync(path.join(workDir, "generated"), { recursive: true });
    mkdirSync(path.join(workDir, "vendor"), { recursive: true });
    mkdirSync(path.join(workDir, "tests"), { recursive: true });
    writeFileSync(
      path.join(workDir, "packages", "server", "src", "securityPolicy.js"),
      [
        "export const defaultSecurityPolicy = {",
        '  trustedOrigins: ["https://app.example"],',
        '  frameAncestors: ["\'self\'"],',
        "  reportOnly: false",
        "};",
        "",
        "export function normalizeSecurityPolicy(options = {}) {",
        "  return {",
        "    trustedOrigins: options.trustedOrigins ?? defaultSecurityPolicy.trustedOrigins,",
        "    frameAncestors: options.frameAncestors ?? defaultSecurityPolicy.frameAncestors,",
        "    reportOnly: options.reportOnly ?? defaultSecurityPolicy.reportOnly",
        "  };",
        "}",
        "",
        "export function createSecurityHeaders(options = {}) {",
        "  const policy = normalizeSecurityPolicy(options);",
        "  return {",
        '    "access-control-allow-origin": policy.trustedOrigins.join(" "),',
        '    "content-security-policy": `frame-ancestors ${policy.frameAncestors.join(" ")}`',
        "  };",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "packages", "server", "src", "middleware.js"),
      [
        'import { createSecurityHeaders } from "./securityPolicy.js";',
        "",
        "export function createSecurityMiddleware(options = {}) {",
        '  const trustedOrigins = options.trustedOrigins ?? ["https://app.example"];',
        "  return (request, response, next) => {",
        "    const origin = request.origin ?? trustedOrigins[0];",
        "    response.headers = createSecurityHeaders({ ...options, trustedOrigins: [origin] });",
        "    next?.();",
        "  };",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "packages", "config", "security-defaults.json"),
      [
        "{",
        '  "trustedOrigins": ["https://app.example"],',
        '  "frameAncestors": ["\'self\'"],',
        '  "reportOnly": false',
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "packages", "client", "src", "securityClient.js"),
      [
        "export function summarizeSecurityPolicy(policy) {",
        '  return `trustedOrigins: ${(policy.trustedOrigins ?? []).join(", ")}`;',
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "examples", "express", "server.js"),
      [
        'import { createSecurityMiddleware } from "../../packages/server/src/middleware.js";',
        "",
        "export const securityOptions = {",
        '  trustedOrigins: ["https://admin.example"],',
        '  frameAncestors: ["\'self\'"]',
        "};",
        "",
        "export const securityMiddleware = createSecurityMiddleware(securityOptions);",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "docs", "security.md"),
      [
        "# Security Policy",
        "",
        "Set `trustedOrigins` to configure allowed browser origins.",
        "Middleware forwards trustedOrigins into response headers.",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "changelog", "unreleased.md"),
      [
        "# Unreleased",
        "",
        "- Pending trustedOrigins security policy rename.",
        ""
      ].join("\n"),
      "utf8"
    );
    const generatedBefore = [
      "{",
      '  "$comment": "AUTO-GENERATED SECURITY SCHEMA. DO NOT EDIT.",',
      '  "properties": {',
      '    "trustedOrigins": { "type": "array", "items": { "type": "string" } }',
      "  }",
      "}",
      ""
    ].join("\n");
    const vendorBefore = [
      "// third party security shim",
      'export const legacySecurityOption = "trustedOrigins";',
      ""
    ].join("\n");
    writeFileSync(path.join(workDir, "generated", "security-schema.json"), generatedBefore, "utf8");
    writeFileSync(path.join(workDir, "vendor", "helmet-compat.js"), vendorBefore, "utf8");
    writeFileSync(
      path.join(workDir, "tests", "security-policy.test.mjs"),
      [
        'import assert from "node:assert/strict";',
        'import { readFileSync } from "node:fs";',
        "import {",
        "  createSecurityHeaders,",
        "  defaultSecurityPolicy,",
        "  normalizeSecurityPolicy",
        '} from "../packages/server/src/securityPolicy.js";',
        'import { createSecurityMiddleware } from "../packages/server/src/middleware.js";',
        'import { summarizeSecurityPolicy } from "../packages/client/src/securityClient.js";',
        "",
        'const defaults = JSON.parse(readFileSync("packages/config/security-defaults.json", "utf8"));',
        'assert.deepEqual(defaultSecurityPolicy.allowedOrigins, ["https://app.example"]);',
        'assert.equal("trustedOrigins" in defaultSecurityPolicy, false);',
        "const normalized = normalizeSecurityPolicy({",
        '  allowedOrigins: ["https://admin.example"],',
        '  frameAncestors: ["\'self\'"]',
        "});",
        'assert.deepEqual(normalized.allowedOrigins, ["https://admin.example"]);',
        'assert.equal("trustedOrigins" in normalized, false);',
        "const headers = createSecurityHeaders({",
        '  allowedOrigins: ["https://admin.example"],',
        '  frameAncestors: ["\'self\'"]',
        "});",
        'assert.equal(headers["access-control-allow-origin"], "https://admin.example");',
        'assert.match(headers["content-security-policy"], /frame-ancestors \'self\'/);',
        "const middleware = createSecurityMiddleware({",
        '  allowedOrigins: ["https://portal.example"]',
        "});",
        "const response = {};",
        'middleware({ origin: "https://portal.example" }, response, () => {});',
        'assert.equal(response.headers["access-control-allow-origin"], "https://portal.example");',
        "assert.equal(",
        '  summarizeSecurityPolicy({ allowedOrigins: ["https://admin.example"] }),',
        '  "allowedOrigins: https://admin.example"',
        ");",
        'assert.deepEqual(defaults.allowedOrigins, ["https://app.example"]);',
        "const ownedFiles = [",
        '  "packages/server/src/securityPolicy.js",',
        '  "packages/server/src/middleware.js",',
        '  "packages/config/security-defaults.json",',
        '  "packages/client/src/securityClient.js",',
        '  "examples/express/server.js",',
        '  "docs/security.md",',
        '  "changelog/unreleased.md"',
        "];",
        "for (const file of ownedFiles) {",
        '  const content = readFileSync(file, "utf8");',
        "  assert.doesNotMatch(content, /trustedOrigins/);",
        "  assert.match(content, /allowedOrigins/);",
        "}",
        'const generated = readFileSync("generated/security-schema.json", "utf8");',
        'assert.match(generated, /AUTO-GENERATED SECURITY SCHEMA\\. DO NOT EDIT/);',
        "assert.match(generated, /trustedOrigins/);",
        'const vendor = readFileSync("vendor/helmet-compat.js", "utf8");',
        "assert.match(vendor, /third party security shim/);",
        "assert.match(vendor, /trustedOrigins/);",
        'console.log("security middleware policy migration ok");',
        ""
      ].join("\n"),
      "utf8"
    );

    const providerLog = path.join(root, "provider-log.json");
    let turn = 0;
    const provider = await startProvider({
      logPath: providerLog,
      routeRequest: ({ transcript, toolNames }) => {
        turn += 1;
        if (turn === 1) {
          assert(toolNames.includes("Bash"), "Bash was not available");
          assert(toolNames.includes("Glob"), "Glob was not available");
          assert(toolNames.includes("Grep"), "Grep was not available");
          assert(toolNames.includes("FileRead"), "FileRead was not available");
          assert(toolNames.includes("FilePatch"), "FilePatch was not available");
          return toolResponse([
            toolCall("run-security-policy-before", "Bash", {
              command: "node tests/security-policy.test.mjs",
              timeout_ms: 5000
            }),
            toolCall("glob-security-policy-repo", "Glob", {
              pattern: "**/*.{js,json,md,mjs}",
              max_matches: 50
            }),
            toolCall("grep-trusted-origins", "Grep", {
              pattern: "trustedOrigins",
              path: ".",
              output_mode: "content",
              max_matches: 50
            }),
            toolCall("read-security-policy-test", "FileRead", {
              file_path: "tests/security-policy.test.mjs"
            }),
            toolCall("read-security-policy-source", "FileRead", {
              file_path: "packages/server/src/securityPolicy.js"
            }),
            toolCall("read-security-middleware", "FileRead", {
              file_path: "packages/server/src/middleware.js"
            }),
            toolCall("read-security-defaults", "FileRead", {
              file_path: "packages/config/security-defaults.json"
            }),
            toolCall("read-security-client", "FileRead", {
              file_path: "packages/client/src/securityClient.js"
            }),
            toolCall("read-security-example", "FileRead", {
              file_path: "examples/express/server.js"
            }),
            toolCall("read-security-docs", "FileRead", {
              file_path: "docs/security.md"
            }),
            toolCall("read-security-changelog", "FileRead", {
              file_path: "changelog/unreleased.md"
            }),
            toolCall("read-generated-security-schema", "FileRead", {
              file_path: "generated/security-schema.json"
            }),
            toolCall("read-vendor-security-shim", "FileRead", {
              file_path: "vendor/helmet-compat.js"
            })
          ]);
        }
        if (turn === 2) {
          assert(transcript.includes("AssertionError"), "failing security policy test missing");
          assert(
            transcript.includes("packages/server/src/securityPolicy.js"),
            "security policy repo file list missing"
          );
          assert(transcript.includes("trustedOrigins"), "trustedOrigins search results missing");
          assert(
            transcript.includes("AUTO-GENERATED SECURITY SCHEMA"),
            "generated security schema boundary missing"
          );
          assert(transcript.includes("third party security shim"), "vendor security boundary missing");
          return toolResponse([
            toolCall("patch-security-policy-source", "FilePatch", {
              file_path: "packages/server/src/securityPolicy.js",
              patch: [
                "@@",
                " export const defaultSecurityPolicy = {",
                '-  trustedOrigins: ["https://app.example"],',
                '+  allowedOrigins: ["https://app.example"],',
                "   frameAncestors: [\"'self'\"],",
                "   reportOnly: false",
                " };",
                "@@",
                " export function normalizeSecurityPolicy(options = {}) {",
                "   return {",
                "-    trustedOrigins: options.trustedOrigins ?? defaultSecurityPolicy.trustedOrigins,",
                "+    allowedOrigins: options.allowedOrigins ?? defaultSecurityPolicy.allowedOrigins,",
                "     frameAncestors: options.frameAncestors ?? defaultSecurityPolicy.frameAncestors,",
                "     reportOnly: options.reportOnly ?? defaultSecurityPolicy.reportOnly",
                "   };",
                " }",
                "@@",
                "   const policy = normalizeSecurityPolicy(options);",
                "   return {",
                '-    "access-control-allow-origin": policy.trustedOrigins.join(" "),',
                '+    "access-control-allow-origin": policy.allowedOrigins.join(" "),',
                '     "content-security-policy": `frame-ancestors ${policy.frameAncestors.join(" ")}`',
                "   };"
              ].join("\n")
            }),
            toolCall("patch-security-middleware", "FilePatch", {
              file_path: "packages/server/src/middleware.js",
              patch: [
                "@@",
                " export function createSecurityMiddleware(options = {}) {",
                '-  const trustedOrigins = options.trustedOrigins ?? ["https://app.example"];',
                "+  const allowedOrigins = options.allowedOrigins ?? [\"https://app.example\"];",
                "   return (request, response, next) => {",
                "-    const origin = request.origin ?? trustedOrigins[0];",
                "-    response.headers = createSecurityHeaders({ ...options, trustedOrigins: [origin] });",
                "+    const origin = request.origin ?? allowedOrigins[0];",
                "+    response.headers = createSecurityHeaders({ ...options, allowedOrigins: [origin] });",
                "     next?.();"
              ].join("\n")
            }),
            toolCall("patch-security-defaults", "FilePatch", {
              file_path: "packages/config/security-defaults.json",
              patch: [
                "@@",
                " {",
                '-  "trustedOrigins": ["https://app.example"],',
                '+  "allowedOrigins": ["https://app.example"],',
                "   \"frameAncestors\": [\"'self'\"],",
                '   "reportOnly": false'
              ].join("\n")
            }),
            toolCall("patch-security-client", "FilePatch", {
              file_path: "packages/client/src/securityClient.js",
              patch: [
                "@@",
                " export function summarizeSecurityPolicy(policy) {",
                '-  return `trustedOrigins: ${(policy.trustedOrigins ?? []).join(", ")}`;',
                '+  return `allowedOrigins: ${(policy.allowedOrigins ?? []).join(", ")}`;',
                " }"
              ].join("\n")
            }),
            toolCall("patch-security-example", "FilePatch", {
              file_path: "examples/express/server.js",
              patch: [
                "@@",
                " export const securityOptions = {",
                '-  trustedOrigins: ["https://admin.example"],',
                '+  allowedOrigins: ["https://admin.example"],',
                "   frameAncestors: [\"'self'\"]",
                " };"
              ].join("\n")
            }),
            toolCall("patch-security-docs", "FilePatch", {
              file_path: "docs/security.md",
              patch: [
                "@@",
                " # Security Policy",
                " ",
                "-Set `trustedOrigins` to configure allowed browser origins.",
                "-Middleware forwards trustedOrigins into response headers.",
                "+Set `allowedOrigins` to configure allowed browser origins.",
                "+Middleware forwards allowedOrigins into response headers."
              ].join("\n")
            }),
            toolCall("patch-security-changelog", "FilePatch", {
              file_path: "changelog/unreleased.md",
              patch: [
                "@@",
                " # Unreleased",
                " ",
                "-- Pending trustedOrigins security policy rename.",
                "+- Renamed the security policy option to allowedOrigins across server, config, client, examples, and docs."
              ].join("\n")
            })
          ]);
        }
        if (turn === 3) {
          assert(
            transcript.includes("Patched packages/server/src/securityPolicy.js"),
            "security policy source patch result missing"
          );
          assert(
            transcript.includes("Patched packages/server/src/middleware.js"),
            "security middleware patch result missing"
          );
          assert(
            transcript.includes("Patched packages/config/security-defaults.json"),
            "security defaults patch result missing"
          );
          assert(transcript.includes("Patched docs/security.md"), "security docs patch missing");
          return toolResponse([
            toolCall("run-security-policy-after", "Bash", {
              command: "node tests/security-policy.test.mjs",
              timeout_ms: 5000
            })
          ]);
        }
        assert(
          transcript.includes("security middleware policy migration ok"),
          "passing security policy migration test missing"
        );
        return messageText(
          "Security middleware policy migration completed with generated schema and vendor shim preserved."
        );
      }
    });

    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig(provider.port), "utf8");
      const output = await runCli({
        args: [
          "--permission-mode",
          "acceptEdits",
          "--allowed-tools",
          "FileRead,FileWrite,FileEdit,FilePatch,FileMove,Glob,Grep,ToolSearch,Bash",
          "--model",
          "main",
          "--output-format",
          "stream-json",
          "-p",
          [
            "In this security middleware repository, rename the public policy option",
            "from trustedOrigins to allowedOrigins across server policy, middleware,",
            "config defaults, client summary, examples, docs, and changelog.",
            "Run the focused security policy test before editing, discover files with",
            "Glob and Grep, inspect generated and vendor boundaries, do not modify",
            "generated or vendor files, then rerun the focused security policy test."
          ].join(" ")
        ],
        cwd: workDir,
        configDir,
        label: "security middleware policy migration task",
        timeoutMs: 45_000
      });
      assert(output.includes("session.completed"), "security policy migration task did not complete");
      const migratedFiles = [
        "packages/server/src/securityPolicy.js",
        "packages/server/src/middleware.js",
        "packages/config/security-defaults.json",
        "packages/client/src/securityClient.js",
        "examples/express/server.js",
        "docs/security.md",
        "changelog/unreleased.md"
      ];
      for (const file of migratedFiles) {
        const content = readFileSync(path.join(workDir, file), "utf8");
        assert(!content.includes("trustedOrigins"), `${file} still contains trustedOrigins`);
        assert(content.includes("allowedOrigins"), `${file} missing allowedOrigins`);
      }
      const generatedAfter = readFileSync(path.join(workDir, "generated", "security-schema.json"), "utf8");
      const vendorAfter = readFileSync(path.join(workDir, "vendor", "helmet-compat.js"), "utf8");
      assert(generatedAfter === generatedBefore, "generated security schema was modified");
      assert(vendorAfter === vendorBefore, "vendor security shim was modified");
      const summary = provider.summary();
      const toolCounts = summary.toolCounts;
      assert(toolCounts.Bash === 2, "security policy task should run tests before and after");
      assert(toolCounts.Glob === 1, "security policy task should discover files with Glob");
      assert(toolCounts.Grep === 1, "security policy task should search old option with Grep");
      assert(toolCounts.FileRead === 10, "security policy task should inspect owned and boundary files");
      assert(toolCounts.FilePatch === 7, "security policy task should patch seven owned files");
      assert(!toolCounts.FileWrite, "security policy task should not rewrite existing files");
      assert(!toolCounts.FileEdit, "security policy task should not use FileEdit");
      return {
        score: 1,
        assertions: [
          "focused failing security policy test ran first",
          "security policy repo discovery ran with Glob",
          "legacy security option search ran with Grep",
          "server security policy inspected before patching",
          "security middleware inspected before patching",
          "config defaults inspected before patching",
          "client summary inspected before patching",
          "example docs and changelog inspected before patching",
          "generated security schema boundary inspected",
          "vendor security shim boundary inspected",
          "server security policy migrated to allowedOrigins",
          "security middleware migrated to allowedOrigins",
          "config defaults migrated to allowedOrigins",
          "client summary migrated to allowedOrigins",
          "example usage migrated to allowedOrigins",
          "security docs migrated",
          "security changelog migrated",
          "focused passing security policy test ran after migration",
          "old owned trustedOrigins references removed",
          "generated security schema stayed unchanged",
          "vendor security shim stayed unchanged",
          "FileWrite avoided for security policy migration",
          "FileEdit avoided for security policy migration",
          "final response completed"
        ],
        filesVerified: [
          "packages/server/src/securityPolicy.js",
          "packages/server/src/middleware.js",
          "packages/config/security-defaults.json",
          "packages/client/src/securityClient.js",
          "examples/express/server.js",
          "docs/security.md",
          "changelog/unreleased.md",
          "generated/security-schema.json",
          "vendor/helmet-compat.js",
          "tests/security-policy.test.mjs"
        ],
        provider: summary,
        taskClass: "security_middleware_policy_migration",
        toolCounts,
        securityPolicyRepoDiscoveryVerified: true,
        securityPolicyConfigMigrated: true,
        securityMiddlewareMigrated: true,
        securityClientMigrated: true,
        securityExamplesDocsChangelogMigrated: true,
        oldOwnedSecurityReferencesRemoved: true,
        generatedSecuritySchemaUntouched: true,
        vendorSecurityShimUntouched: true,
        securityMiddlewarePolicyVerified: true,
        fileWriteAvoided: !toolCounts.FileWrite,
        fileEditAvoided: !toolCounts.FileEdit
      };
    } catch (error) {
      printProviderLog(providerLog);
      throw error;
    } finally {
      await provider.close();
    }
  });
}

async function scenarioOssSecurityAdvisoryFixTask() {
  return await withWorkspace("oss-security-advisory-fix", async ({ root, configDir, workDir }) => {
    mkdirSync(path.join(workDir, "advisories"), { recursive: true });
    mkdirSync(path.join(workDir, "packages", "server", "src"), { recursive: true });
    mkdirSync(path.join(workDir, "packages", "client", "src"), { recursive: true });
    mkdirSync(path.join(workDir, "examples", "express"), { recursive: true });
    mkdirSync(path.join(workDir, "docs"), { recursive: true });
    mkdirSync(path.join(workDir, "changelog"), { recursive: true });
    mkdirSync(path.join(workDir, "generated"), { recursive: true });
    mkdirSync(path.join(workDir, "vendor"), { recursive: true });
    mkdirSync(path.join(workDir, "tests"), { recursive: true });
    writeFileSync(
      path.join(workDir, "advisories", "GHSA-session-cookie.md"),
      [
        "# GHSA-session-cookie: insecure session cookie defaults",
        "",
        "The public session cookie helper defaults to SameSite=None and Secure=false.",
        "That leaves browser session cookies exposed during cross-site requests.",
        "",
        "Acceptance:",
        "- reproduce with `node tests/session-cookie-security.test.mjs` before editing",
        "- change owned source defaults to SameSite=Lax and Secure=true",
        "- update client summary, example, docs, and changelog",
        "- do not edit generated schema or vendored compatibility files",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "packages", "server", "src", "sessionCookie.js"),
      [
        "export const defaultCookieOptions = {",
        '  sameSite: "none",',
        "  secure: false,",
        "  httpOnly: true",
        "};",
        "",
        "export function normalizeCookieOptions(options = {}) {",
        "  return {",
        "    sameSite: options.sameSite ?? defaultCookieOptions.sameSite,",
        "    secure: options.secure ?? defaultCookieOptions.secure,",
        "    httpOnly: options.httpOnly ?? defaultCookieOptions.httpOnly",
        "  };",
        "}",
        "",
        "export function serializeSessionCookie(value, options = {}) {",
        "  const normalized = normalizeCookieOptions(options);",
        "  return [",
        "    `sid=${value}`,",
        "    `SameSite=${normalized.sameSite[0].toUpperCase()}${normalized.sameSite.slice(1)}`,",
        '    normalized.secure ? "Secure" : "",',
        '    normalized.httpOnly ? "HttpOnly" : ""',
        '  ].filter(Boolean).join("; ");',
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "packages", "client", "src", "sessionClient.js"),
      [
        "export function describeCookiePolicy(policy = {}) {",
        '  return `Cookie policy: SameSite=${policy.sameSite ?? "none"}; secure=${policy.secure ?? false}`;',
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "examples", "express", "session.js"),
      [
        'import { serializeSessionCookie } from "../../packages/server/src/sessionCookie.js";',
        "",
        "export const sessionCookieOptions = {",
        '  sameSite: "none",',
        "  secure: false,",
        "  httpOnly: true",
        "};",
        "",
        'export const sampleCookie = serializeSessionCookie("example", sessionCookieOptions);',
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "docs", "session-security.md"),
      [
        "# Session Cookie Security",
        "",
        "Session cookies default to SameSite=None and Secure=false.",
        "Operators should override both values in production.",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "changelog", "unreleased.md"),
      ["# Unreleased", "", "- Documented session cookie defaults.", ""].join("\n"),
      "utf8"
    );
    const generatedBefore = [
      "{",
      '  "$comment": "AUTO-GENERATED COOKIE SCHEMA. DO NOT EDIT.",',
      '  "properties": {',
      '    "sameSite": { "enum": ["none", "lax", "strict"] },',
      '    "secure": { "type": "boolean" }',
      "  }",
      "}",
      ""
    ].join("\n");
    const vendorBefore = [
      "// vendored cookie compatibility shim",
      'export const legacyCookieDefaults = { sameSite: "none", secure: false };',
      ""
    ].join("\n");
    writeFileSync(path.join(workDir, "generated", "cookie-schema.json"), generatedBefore, "utf8");
    writeFileSync(path.join(workDir, "vendor", "cookie-legacy.js"), vendorBefore, "utf8");
    writeFileSync(
      path.join(workDir, "tests", "session-cookie-security.test.mjs"),
      [
        'import assert from "node:assert/strict";',
        'import { readFileSync } from "node:fs";',
        "import {",
        "  defaultCookieOptions,",
        "  normalizeCookieOptions,",
        "  serializeSessionCookie",
        '} from "../packages/server/src/sessionCookie.js";',
        'import { describeCookiePolicy } from "../packages/client/src/sessionClient.js";',
        'import { sessionCookieOptions, sampleCookie } from "../examples/express/session.js";',
        "",
        'assert.equal(defaultCookieOptions.sameSite, "lax");',
        "assert.equal(defaultCookieOptions.secure, true);",
        "assert.deepEqual(normalizeCookieOptions(), {",
        '  sameSite: "lax",',
        "  secure: true,",
        "  httpOnly: true",
        "});",
        'assert.equal(serializeSessionCookie("abc"), "sid=abc; SameSite=Lax; Secure; HttpOnly");',
        'assert.equal(describeCookiePolicy(), "Cookie policy: SameSite=lax; secure=true");',
        'assert.deepEqual(sessionCookieOptions, { sameSite: "lax", secure: true, httpOnly: true });',
        "assert.match(sampleCookie, /SameSite=Lax/);",
        "assert.match(sampleCookie, /Secure/);",
        "",
        "const ownedFiles = [",
        '  "packages/server/src/sessionCookie.js",',
        '  "packages/client/src/sessionClient.js",',
        '  "examples/express/session.js",',
        '  "docs/session-security.md",',
        '  "changelog/unreleased.md"',
        "];",
        "for (const file of ownedFiles) {",
        '  const content = readFileSync(file, "utf8");',
        '  assert.doesNotMatch(content, /sameSite: "none"|SameSite=None|Secure=false|secure: false/);',
        "  assert.match(content, /lax|Lax|Secure=true|secure: true|Secure/);",
        "}",
        "",
        'const docs = readFileSync("docs/session-security.md", "utf8");',
        "assert.match(docs, /SameSite=Lax and Secure=true/);",
        'const changelog = readFileSync("changelog/unreleased.md", "utf8");',
        "assert.match(changelog, /GHSA-session-cookie/);",
        "",
        'const generated = readFileSync("generated/cookie-schema.json", "utf8");',
        "assert.match(generated, /AUTO-GENERATED COOKIE SCHEMA/);",
        "assert.match(generated, /none/);",
        'const vendor = readFileSync("vendor/cookie-legacy.js", "utf8");',
        "assert.match(vendor, /vendored cookie compatibility shim/);",
        'assert.match(vendor, /sameSite: "none"/);',
        'console.log("session cookie security advisory ok");',
        ""
      ].join("\n"),
      "utf8"
    );

    const providerLog = path.join(root, "provider-log.json");
    let turn = 0;
    const provider = await startProvider({
      logPath: providerLog,
      routeRequest: ({ transcript, toolNames }) => {
        turn += 1;
        if (turn === 1) {
          assert(toolNames.includes("Bash"), "Bash was not available");
          assert(toolNames.includes("Glob"), "Glob was not available");
          assert(toolNames.includes("Grep"), "Grep was not available");
          assert(toolNames.includes("FileRead"), "FileRead was not available");
          assert(toolNames.includes("FilePatch"), "FilePatch was not available");
          return toolResponse([
            toolCall("run-cookie-security-before", "Bash", {
              command: "node tests/session-cookie-security.test.mjs",
              timeout_ms: 5000
            }),
            toolCall("glob-cookie-security-repo", "Glob", {
              pattern: "**/*.{js,json,md,mjs}",
              max_matches: 50
            }),
            toolCall("grep-cookie-same-site", "Grep", {
              pattern: "sameSite",
              path: ".",
              output_mode: "content",
              max_matches: 50
            }),
            toolCall("read-cookie-advisory", "FileRead", {
              file_path: "advisories/GHSA-session-cookie.md"
            }),
            toolCall("read-cookie-security-test", "FileRead", {
              file_path: "tests/session-cookie-security.test.mjs"
            }),
            toolCall("read-session-cookie-source", "FileRead", {
              file_path: "packages/server/src/sessionCookie.js"
            }),
            toolCall("read-session-client", "FileRead", {
              file_path: "packages/client/src/sessionClient.js"
            }),
            toolCall("read-session-example", "FileRead", {
              file_path: "examples/express/session.js"
            }),
            toolCall("read-session-security-docs", "FileRead", {
              file_path: "docs/session-security.md"
            }),
            toolCall("read-cookie-changelog", "FileRead", {
              file_path: "changelog/unreleased.md"
            }),
            toolCall("read-generated-cookie-schema", "FileRead", {
              file_path: "generated/cookie-schema.json"
            }),
            toolCall("read-vendor-cookie-legacy", "FileRead", {
              file_path: "vendor/cookie-legacy.js"
            })
          ]);
        }
        if (turn === 2) {
          assert(transcript.includes("AssertionError"), "failing cookie security test missing");
          assert(transcript.includes("GHSA-session-cookie"), "security advisory context missing");
          assert(transcript.includes("SameSite=None"), "insecure cookie default context missing");
          assert(
            transcript.includes("packages/server/src/sessionCookie.js"),
            "repo discovery missing"
          );
          assert(
            transcript.includes("AUTO-GENERATED COOKIE SCHEMA"),
            "generated cookie boundary missing"
          );
          assert(
            transcript.includes("vendored cookie compatibility shim"),
            "vendor cookie boundary missing"
          );
          return toolResponse([
            toolCall("patch-session-cookie-source", "FilePatch", {
              file_path: "packages/server/src/sessionCookie.js",
              patch: [
                "@@",
                " export const defaultCookieOptions = {",
                '-  sameSite: "none",',
                "-  secure: false,",
                '+  sameSite: "lax",',
                "+  secure: true,",
                "   httpOnly: true",
                " };"
              ].join("\n")
            }),
            toolCall("patch-session-client", "FilePatch", {
              file_path: "packages/client/src/sessionClient.js",
              patch: [
                "@@",
                " export function describeCookiePolicy(policy = {}) {",
                '-  return `Cookie policy: SameSite=${policy.sameSite ?? "none"}; secure=${policy.secure ?? false}`;',
                '+  return `Cookie policy: SameSite=${policy.sameSite ?? "lax"}; secure=${policy.secure ?? true}`;',
                " }"
              ].join("\n")
            }),
            toolCall("patch-session-example", "FilePatch", {
              file_path: "examples/express/session.js",
              patch: [
                "@@",
                " export const sessionCookieOptions = {",
                '-  sameSite: "none",',
                "-  secure: false,",
                '+  sameSite: "lax",',
                "+  secure: true,",
                "   httpOnly: true",
                " };"
              ].join("\n")
            }),
            toolCall("patch-session-security-docs", "FilePatch", {
              file_path: "docs/session-security.md",
              patch: [
                "@@",
                " # Session Cookie Security",
                " ",
                "-Session cookies default to SameSite=None and Secure=false.",
                "-Operators should override both values in production.",
                "+Session cookies now default to SameSite=Lax and Secure=true.",
                "+Operators can override these values, but the built-in default is safe for browser sessions."
              ].join("\n")
            }),
            toolCall("patch-cookie-changelog", "FilePatch", {
              file_path: "changelog/unreleased.md",
              patch: [
                "@@",
                " # Unreleased",
                " ",
                "-- Documented session cookie defaults.",
                "+- Fixed GHSA-session-cookie by defaulting session cookies to SameSite=Lax and Secure=true."
              ].join("\n")
            })
          ]);
        }
        if (turn === 3) {
          assert(
            transcript.includes("Patched packages/server/src/sessionCookie.js"),
            "session cookie source patch result missing"
          );
          assert(
            transcript.includes("Patched packages/client/src/sessionClient.js"),
            "session client patch result missing"
          );
          assert(
            transcript.includes("Patched examples/express/session.js"),
            "session example patch missing"
          );
          assert(
            transcript.includes("Patched docs/session-security.md"),
            "session docs patch missing"
          );
          assert(
            transcript.includes("Patched changelog/unreleased.md"),
            "session changelog patch missing"
          );
          return toolResponse([
            toolCall("run-cookie-security-after", "Bash", {
              command: "node tests/session-cookie-security.test.mjs",
              timeout_ms: 5000
            })
          ]);
        }
        assert(
          transcript.includes("session cookie security advisory ok"),
          "passing cookie security advisory test missing"
        );
        return messageText(
          "OSS security advisory fixed with safer session cookie defaults and generated/vendor boundaries preserved."
        );
      }
    });

    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig(provider.port), "utf8");
      const output = await runCli({
        args: [
          "--permission-mode",
          "acceptEdits",
          "--allowed-tools",
          "FileRead,FileWrite,FileEdit,FilePatch,FileMove,Glob,Grep,ToolSearch,Bash",
          "--model",
          "main",
          "--output-format",
          "stream-json",
          "-p",
          [
            "Fix the OSS security advisory GHSA-session-cookie in this repository.",
            "First reproduce the failing session cookie security test, discover files with Glob and Grep,",
            "read the advisory, source, client, example, docs, changelog, generated schema, and vendor shim,",
            "change owned defaults to SameSite=Lax and Secure=true, update docs and changelog,",
            "do not modify generated or vendor files, then rerun the focused security test."
          ].join(" ")
        ],
        cwd: workDir,
        configDir,
        label: "OSS security advisory fix task",
        timeoutMs: 45_000
      });
      assert(output.includes("session.completed"), "OSS security advisory fix did not complete");
      const ownedFiles = [
        "packages/server/src/sessionCookie.js",
        "packages/client/src/sessionClient.js",
        "examples/express/session.js",
        "docs/session-security.md",
        "changelog/unreleased.md"
      ];
      for (const file of ownedFiles) {
        const content = readFileSync(path.join(workDir, file), "utf8");
        assert(
          !/sameSite: "none"|SameSite=None|Secure=false|secure: false/.test(content),
          `${file} still contains insecure cookie defaults`
        );
        assert(
          /lax|Lax|Secure=true|secure: true|Secure/.test(content),
          `${file} missing secure cookie defaults`
        );
      }
      const generatedAfter = readFileSync(
        path.join(workDir, "generated", "cookie-schema.json"),
        "utf8"
      );
      const vendorAfter = readFileSync(path.join(workDir, "vendor", "cookie-legacy.js"), "utf8");
      assert(generatedAfter === generatedBefore, "generated cookie schema was modified");
      assert(vendorAfter === vendorBefore, "vendor cookie shim was modified");
      const summary = provider.summary();
      const toolCounts = summary.toolCounts;
      assert(toolCounts.Bash === 2, "OSS security advisory should run tests before and after");
      assert(toolCounts.Glob === 1, "OSS security advisory should discover files with Glob");
      assert(toolCounts.Grep === 1, "OSS security advisory should search sameSite with Grep");
      assert(
        toolCounts.FileRead === 9,
        "OSS security advisory should inspect advisory, source, docs, and boundaries"
      );
      assert(toolCounts.FilePatch === 5, "OSS security advisory should patch five owned files");
      assert(!toolCounts.FileWrite, "OSS security advisory should not rewrite existing files");
      assert(!toolCounts.FileEdit, "OSS security advisory should not use FileEdit");
      return {
        score: 1,
        assertions: [
          "focused failing session cookie security test ran first",
          "OSS security advisory was read before editing",
          "cookie security repo discovery ran with Glob",
          "sameSite search ran with Grep",
          "server session cookie source inspected before patching",
          "client cookie summary inspected before patching",
          "session example inspected before patching",
          "generated cookie schema boundary inspected",
          "vendor cookie shim boundary inspected",
          "session cookie defaults changed to SameSite=Lax and Secure=true",
          "client cookie summary default updated",
          "session example default updated",
          "session security docs updated",
          "session security changelog updated",
          "focused session cookie security test passed after fix",
          "generated cookie schema stayed unchanged",
          "vendor cookie shim stayed unchanged",
          "FileWrite avoided for OSS security advisory fix",
          "FileEdit avoided for OSS security advisory fix",
          "final response completed"
        ],
        filesVerified: [
          "advisories/GHSA-session-cookie.md",
          "packages/server/src/sessionCookie.js",
          "packages/client/src/sessionClient.js",
          "examples/express/session.js",
          "docs/session-security.md",
          "changelog/unreleased.md",
          "generated/cookie-schema.json",
          "vendor/cookie-legacy.js",
          "tests/session-cookie-security.test.mjs"
        ],
        provider: summary,
        taskClass: "oss_security_advisory_fix",
        toolCounts,
        securityAdvisoryReadBeforePatch: true,
        securityAdvisoryReproduced: true,
        sessionCookieDefaultsHardened: true,
        clientCookieSummaryUpdated: true,
        sessionExampleUpdated: true,
        sessionSecurityDocsChangelogUpdated: true,
        generatedCookieSchemaUntouched: true,
        vendorCookieShimUntouched: true,
        securityAdvisoryVerified: true,
        fileWriteAvoided: !toolCounts.FileWrite,
        fileEditAvoided: !toolCounts.FileEdit
      };
    } catch (error) {
      printProviderLog(providerLog);
      throw error;
    } finally {
      await provider.close();
    }
  });
}

async function scenarioCiFailureDiagnosisFixTask() {
  return await withWorkspace("ci-failure-diagnosis-fix", async ({ root, configDir, workDir }) => {
    mkdirSync(path.join(workDir, ".github", "workflows"), { recursive: true });
    mkdirSync(path.join(workDir, "artifacts"), { recursive: true });
    mkdirSync(path.join(workDir, "packages", "router", "src"), { recursive: true });
    mkdirSync(path.join(workDir, "docs"), { recursive: true });
    mkdirSync(path.join(workDir, "changelog"), { recursive: true });
    mkdirSync(path.join(workDir, "generated"), { recursive: true });
    mkdirSync(path.join(workDir, "vendor"), { recursive: true });
    mkdirSync(path.join(workDir, "tests"), { recursive: true });
    writeFileSync(
      path.join(workDir, ".github", "workflows", "ci.yml"),
      [
        "name: CI",
        "",
        "on:",
        "  pull_request:",
        "  push:",
        "",
        "jobs:",
        "  test:",
        "    name: Test on ubuntu-latest with Node 22",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - uses: actions/setup-node@v4",
        "        with:",
        "          node-version: 22",
        "      - run: node tests/ci-release-routing.test.mjs",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "artifacts", "ci-node22.log"),
      [
        "CI / Test on ubuntu-latest with Node 22",
        "$ node tests/ci-release-routing.test.mjs",
        "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
        "+ actual - expected",
        '+ "Release-Notes-2026"',
        '- "release-notes-2026"',
        "at tests/ci-release-routing.test.mjs:7:8",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "packages", "router", "src", "slug.js"),
      [
        "export function slugifySegment(value) {",
        '  return String(value).trim().replace(/\\s+/g, "-");',
        "}",
        "",
        "export function buildReleasePath(project, title) {",
        "  return `/projects/${project}/releases/${slugifySegment(title)}`;",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "docs", "routing.md"),
      [
        "# Routing",
        "",
        "Release paths preserve title casing and only replace spaces.",
        "Project path segments are inserted as provided.",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "changelog", "unreleased.md"),
      ["# Unreleased", "", "- Documented release route slugs.", ""].join("\n"),
      "utf8"
    );
    const generatedBefore = [
      "{",
      '  "$comment": "AUTO-GENERATED ROUTE SCHEMA. DO NOT EDIT.",',
      '  "properties": {',
      '    "releaseSlug": { "type": "string" }',
      "  }",
      "}",
      ""
    ].join("\n");
    const vendorBefore = [
      "// vendored legacy slug shim",
      'export function legacySlug(value) { return String(value).trim().replace(/\\s+/g, "-"); }',
      ""
    ].join("\n");
    writeFileSync(path.join(workDir, "generated", "route-schema.json"), generatedBefore, "utf8");
    writeFileSync(path.join(workDir, "vendor", "legacy-slug.js"), vendorBefore, "utf8");
    writeFileSync(
      path.join(workDir, "tests", "ci-release-routing.test.mjs"),
      [
        'import assert from "node:assert/strict";',
        'import { readFileSync } from "node:fs";',
        'import { slugifySegment, buildReleasePath } from "../packages/router/src/slug.js";',
        "",
        'assert.equal(slugifySegment(" Release Notes 2026 "), "release-notes-2026");',
        'assert.equal(slugifySegment("Bugfix: API Tokens"), "bugfix-api-tokens");',
        "assert.equal(",
        '  buildReleasePath("core team", " Release Notes 2026 "),',
        '  "/projects/core%20team/releases/release-notes-2026"',
        ");",
        "",
        'const source = readFileSync("packages/router/src/slug.js", "utf8");',
        "assert.match(source, /toLowerCase\\(\\)/);",
        "assert.match(source, /encodeURIComponent\\(project\\)/);",
        "",
        'const docs = readFileSync("docs/routing.md", "utf8");',
        "assert.match(docs, /lowercase ASCII slug/);",
        "assert.match(docs, /URL-encoded/);",
        'const changelog = readFileSync("changelog/unreleased.md", "utf8");',
        "assert.match(changelog, /CI release routing/);",
        "",
        'const generated = readFileSync("generated/route-schema.json", "utf8");',
        "assert.match(generated, /AUTO-GENERATED ROUTE SCHEMA/);",
        'const vendor = readFileSync("vendor/legacy-slug.js", "utf8");',
        "assert.match(vendor, /vendored legacy slug shim/);",
        'assert.match(vendor, /replace\\(\\/\\\\s\\+\\/g, "-"/);',
        'console.log("ci release routing ok");',
        ""
      ].join("\n"),
      "utf8"
    );

    const providerLog = path.join(root, "provider-log.json");
    let turn = 0;
    const provider = await startProvider({
      logPath: providerLog,
      routeRequest: ({ transcript, toolNames }) => {
        turn += 1;
        if (turn === 1) {
          assert(toolNames.includes("Bash"), "Bash was not available");
          assert(toolNames.includes("Glob"), "Glob was not available");
          assert(toolNames.includes("Grep"), "Grep was not available");
          assert(toolNames.includes("FileRead"), "FileRead was not available");
          assert(toolNames.includes("FilePatch"), "FilePatch was not available");
          return toolResponse([
            toolCall("run-ci-routing-before", "Bash", {
              command: "node tests/ci-release-routing.test.mjs",
              timeout_ms: 5000
            }),
            toolCall("glob-ci-failure-repo", "Glob", {
              pattern: "**/*.{js,json,md,mjs,yml,log}",
              max_matches: 50
            }),
            toolCall("grep-slugify", "Grep", {
              pattern: "slugifySegment",
              path: ".",
              output_mode: "content",
              max_matches: 50
            }),
            toolCall("read-ci-workflow", "FileRead", {
              file_path: ".github/workflows/ci.yml"
            }),
            toolCall("read-ci-node22-log", "FileRead", {
              file_path: "artifacts/ci-node22.log"
            }),
            toolCall("read-ci-routing-test", "FileRead", {
              file_path: "tests/ci-release-routing.test.mjs"
            }),
            toolCall("read-router-slug-source", "FileRead", {
              file_path: "packages/router/src/slug.js"
            }),
            toolCall("read-routing-docs", "FileRead", {
              file_path: "docs/routing.md"
            }),
            toolCall("read-routing-changelog", "FileRead", {
              file_path: "changelog/unreleased.md"
            }),
            toolCall("read-generated-route-schema", "FileRead", {
              file_path: "generated/route-schema.json"
            }),
            toolCall("read-vendor-legacy-slug", "FileRead", {
              file_path: "vendor/legacy-slug.js"
            })
          ]);
        }
        if (turn === 2) {
          assert(transcript.includes("AssertionError"), "failing CI routing test missing");
          assert(transcript.includes("CI / Test on ubuntu-latest with Node 22"), "CI log missing");
          assert(transcript.includes(".github/workflows/ci.yml"), "CI workflow context missing");
          assert(transcript.includes("slugifySegment"), "slug search context missing");
          assert(
            transcript.includes("AUTO-GENERATED ROUTE SCHEMA"),
            "generated route schema boundary missing"
          );
          assert(transcript.includes("vendored legacy slug shim"), "vendor slug boundary missing");
          return toolResponse([
            toolCall("patch-router-slug-source", "FilePatch", {
              file_path: "packages/router/src/slug.js",
              patch: [
                "@@",
                " export function slugifySegment(value) {",
                '-  return String(value).trim().replace(/\\s+/g, "-");',
                "+  return String(value)",
                "+    .trim()",
                "+    .toLowerCase()",
                '+    .replace(/[^a-z0-9]+/g, "-")',
                '+    .replace(/^-+|-+$/g, "");',
                " }",
                " ",
                " export function buildReleasePath(project, title) {",
                "-  return `/projects/${project}/releases/${slugifySegment(title)}`;",
                "+  return `/projects/${encodeURIComponent(project)}/releases/${slugifySegment(title)}`;",
                " }"
              ].join("\n")
            }),
            toolCall("patch-routing-docs", "FilePatch", {
              file_path: "docs/routing.md",
              patch: [
                "@@",
                " # Routing",
                " ",
                "-Release paths preserve title casing and only replace spaces.",
                "-Project path segments are inserted as provided.",
                "+Release paths use a lowercase ASCII slug derived from the release title.",
                "+Project path segments are URL-encoded before the release slug is appended."
              ].join("\n")
            }),
            toolCall("patch-routing-changelog", "FilePatch", {
              file_path: "changelog/unreleased.md",
              patch: [
                "@@",
                " # Unreleased",
                " ",
                "-- Documented release route slugs.",
                "+- Fixed CI release routing failures by normalizing release slugs and encoding project path segments."
              ].join("\n")
            })
          ]);
        }
        if (turn === 3) {
          assert(
            transcript.includes("Patched packages/router/src/slug.js"),
            "router slug patch result missing"
          );
          assert(transcript.includes("Patched docs/routing.md"), "routing docs patch missing");
          assert(
            transcript.includes("Patched changelog/unreleased.md"),
            "routing changelog patch missing"
          );
          return toolResponse([
            toolCall("run-ci-routing-after", "Bash", {
              command: "node tests/ci-release-routing.test.mjs",
              timeout_ms: 5000
            })
          ]);
        }
        assert(transcript.includes("ci release routing ok"), "passing CI routing test missing");
        return messageText(
          "CI release routing failure fixed after reading the workflow, failure log, and owned routing files."
        );
      }
    });

    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig(provider.port), "utf8");
      const output = await runCli({
        args: [
          "--permission-mode",
          "acceptEdits",
          "--allowed-tools",
          "FileRead,FileWrite,FileEdit,FilePatch,FileMove,Glob,Grep,ToolSearch,Bash",
          "--model",
          "main",
          "--output-format",
          "stream-json",
          "-p",
          [
            "Diagnose and fix the Node 22 CI failure for release routing.",
            "Read the GitHub Actions workflow and saved CI log, reproduce the focused test failure,",
            "discover files with Glob and Grep, inspect source, docs, changelog, generated schema, and vendor shim,",
            "fix owned routing code and docs, do not modify generated or vendor files, then rerun the focused CI test."
          ].join(" ")
        ],
        cwd: workDir,
        configDir,
        label: "CI failure diagnosis fix task",
        timeoutMs: 45_000
      });
      assert(output.includes("session.completed"), "CI failure diagnosis task did not complete");
      const source = readFileSync(path.join(workDir, "packages", "router", "src", "slug.js"), "utf8");
      assert(source.includes("toLowerCase()"), "release slug does not lowercase");
      assert(source.includes("encodeURIComponent(project)"), "project path segment is not encoded");
      const docs = readFileSync(path.join(workDir, "docs", "routing.md"), "utf8");
      assert(docs.includes("lowercase ASCII slug"), "routing docs missing slug normalization");
      assert(docs.includes("URL-encoded"), "routing docs missing project encoding");
      const changelog = readFileSync(path.join(workDir, "changelog", "unreleased.md"), "utf8");
      assert(changelog.includes("CI release routing"), "changelog missing CI failure fix");
      const generatedAfter = readFileSync(
        path.join(workDir, "generated", "route-schema.json"),
        "utf8"
      );
      const vendorAfter = readFileSync(path.join(workDir, "vendor", "legacy-slug.js"), "utf8");
      assert(generatedAfter === generatedBefore, "generated route schema was modified");
      assert(vendorAfter === vendorBefore, "vendor slug shim was modified");
      const summary = provider.summary();
      const toolCounts = summary.toolCounts;
      assert(toolCounts.Bash === 2, "CI diagnosis should run tests before and after");
      assert(toolCounts.Glob === 1, "CI diagnosis should discover files with Glob");
      assert(toolCounts.Grep === 1, "CI diagnosis should search slug references with Grep");
      assert(toolCounts.FileRead === 8, "CI diagnosis should inspect logs, source, docs, and boundaries");
      assert(toolCounts.FilePatch === 3, "CI diagnosis should patch source, docs, and changelog");
      assert(!toolCounts.FileWrite, "CI diagnosis should not rewrite existing files");
      assert(!toolCounts.FileEdit, "CI diagnosis should not use FileEdit");
      return {
        score: 1,
        assertions: [
          "focused failing CI routing test ran first",
          "CI workflow inspected before patching",
          "CI failure log inspected before patching",
          "CI failure repo discovery ran with Glob",
          "slug reference search ran with Grep",
          "routing source inspected before patching",
          "routing docs and changelog inspected before patching",
          "generated route schema boundary inspected",
          "vendor slug shim boundary inspected",
          "release slug normalization fixed",
          "project path segment encoding fixed",
          "routing docs updated",
          "routing changelog updated",
          "focused passing CI routing test ran after fix",
          "generated route schema stayed unchanged",
          "vendor slug shim stayed unchanged",
          "FileWrite avoided for CI diagnosis fix",
          "FileEdit avoided for CI diagnosis fix",
          "final response completed"
        ],
        filesVerified: [
          ".github/workflows/ci.yml",
          "artifacts/ci-node22.log",
          "packages/router/src/slug.js",
          "docs/routing.md",
          "changelog/unreleased.md",
          "generated/route-schema.json",
          "vendor/legacy-slug.js",
          "tests/ci-release-routing.test.mjs"
        ],
        provider: summary,
        taskClass: "ci_failure_diagnosis_fix",
        toolCounts,
        ciWorkflowReadBeforePatch: true,
        ciFailureLogReadBeforePatch: true,
        ciFailureReproduced: true,
        releaseSlugFixed: true,
        projectPathEncodingFixed: true,
        ciDocsChangelogUpdated: true,
        generatedRouteSchemaUntouched: true,
        vendorSlugShimUntouched: true,
        ciFailureVerified: true,
        fileWriteAvoided: !toolCounts.FileWrite,
        fileEditAvoided: !toolCounts.FileEdit
      };
    } catch (error) {
      printProviderLog(providerLog);
      throw error;
    } finally {
      await provider.close();
    }
  });
}

async function scenarioOssStyleOpenSourceMigrationTask() {
  return await withWorkspace("oss-style-open-source", async ({ root, configDir, workDir }) => {
    mkdirSync(path.join(workDir, "packages", "core", "src"), { recursive: true });
    mkdirSync(path.join(workDir, "packages", "plugin-auth", "src"), { recursive: true });
    mkdirSync(path.join(workDir, "packages", "plugin-telemetry", "src"), { recursive: true });
    mkdirSync(path.join(workDir, "examples", "node"), { recursive: true });
    mkdirSync(path.join(workDir, "docs"), { recursive: true });
    mkdirSync(path.join(workDir, "changelog"), { recursive: true });
    mkdirSync(path.join(workDir, "generated"), { recursive: true });
    mkdirSync(path.join(workDir, "vendor"), { recursive: true });
    mkdirSync(path.join(workDir, "tests"), { recursive: true });
    writeFileSync(
      path.join(workDir, "packages", "core", "src", "options.js"),
      [
        "export const defaultOptions = {",
        '  cacheTTL: 60,',
        '  retryLimit: 2',
        "};",
        "",
        "export function normalizeOptions(options = {}) {",
        "  return {",
        "    cacheTTL: options.cacheTTL ?? defaultOptions.cacheTTL,",
        "    retryLimit: options.retryLimit ?? defaultOptions.retryLimit",
        "  };",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "packages", "core", "src", "client.js"),
      [
        'import { normalizeOptions } from "./options.js";',
        "",
        "export function createClient(options = {}) {",
        "  const normalized = normalizeOptions(options);",
        "  return {",
        "    cacheTTL: normalized.cacheTTL,",
        "    retryLimit: normalized.retryLimit",
        "  };",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "packages", "plugin-auth", "src", "index.js"),
      [
        "export function authPlugin(options = {}) {",
        "  return {",
        '    name: "auth",',
        "    cacheTTL: options.cacheTTL ?? 60",
        "  };",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "packages", "plugin-telemetry", "src", "index.js"),
      [
        "export function telemetryPlugin(options = {}) {",
        "  return {",
        '    name: "telemetry",',
        "    cacheTTL: options.cacheTTL ?? 60",
        "  };",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "examples", "node", "basic.js"),
      [
        'import { createClient } from "../../packages/core/src/client.js";',
        "",
        "export const client = createClient({ cacheTTL: 60 });",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "docs", "configuration.md"),
      [
        "# Configuration",
        "",
        "`cacheTTL` controls cache expiry in seconds.",
        "Plugins accept the same `cacheTTL` option.",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "changelog", "unreleased.md"),
      [
        "# Unreleased",
        "",
        "- Documented cacheTTL for core and plugins.",
        ""
      ].join("\n"),
      "utf8"
    );
    const generatedBefore = [
      "// AUTO-GENERATED OPTIONS. DO NOT EDIT.",
      "export interface GeneratedClientOptions {",
      "  cacheTTL?: number;",
      "}",
      ""
    ].join("\n");
    const vendorBefore = [
      "// vendored compatibility shim",
      "export const vendorOptionName = \"cacheTTL\";",
      ""
    ].join("\n");
    writeFileSync(path.join(workDir, "generated", "options.d.ts"), generatedBefore, "utf8");
    writeFileSync(path.join(workDir, "vendor", "legacy-options.js"), vendorBefore, "utf8");
    writeFileSync(
      path.join(workDir, "tests", "oss-options.test.mjs"),
      [
        'import assert from "node:assert/strict";',
        'import { readFileSync } from "node:fs";',
        'import { createClient } from "../packages/core/src/client.js";',
        'import { authPlugin } from "../packages/plugin-auth/src/index.js";',
        'import { telemetryPlugin } from "../packages/plugin-telemetry/src/index.js";',
        "",
        "assert.deepEqual(createClient(), {",
        "  cacheTtlSeconds: 60,",
        "  retryLimit: 2",
        "});",
        "assert.deepEqual(createClient({ cacheTtlSeconds: 90 }), {",
        "  cacheTtlSeconds: 90,",
        "  retryLimit: 2",
        "});",
        'assert.equal(authPlugin().cacheTtlSeconds, 60);',
        'assert.equal(telemetryPlugin({ cacheTtlSeconds: 45 }).cacheTtlSeconds, 45);',
        "",
        "const ownedFiles = [",
        '  "packages/core/src/options.js",',
        '  "packages/core/src/client.js",',
        '  "packages/plugin-auth/src/index.js",',
        '  "packages/plugin-telemetry/src/index.js",',
        '  "examples/node/basic.js",',
        '  "docs/configuration.md",',
        '  "changelog/unreleased.md"',
        "];",
        "for (const file of ownedFiles) {",
        '  const content = readFileSync(file, "utf8");',
        '  assert.doesNotMatch(content, /cacheTTL/);',
        '  assert.match(content, /cacheTtlSeconds/);',
        "}",
        "",
        'const generated = readFileSync("generated/options.d.ts", "utf8");',
        'assert.match(generated, /AUTO-GENERATED OPTIONS\\. DO NOT EDIT/);',
        'assert.match(generated, /cacheTTL\\?: number/);',
        'const vendor = readFileSync("vendor/legacy-options.js", "utf8");',
        'assert.match(vendor, /vendored compatibility shim/);',
        'assert.match(vendor, /cacheTTL/);',
        'console.log("oss options migration ok");',
        ""
      ].join("\n"),
      "utf8"
    );

    const providerLog = path.join(root, "provider-log.json");
    let turn = 0;
    const provider = await startProvider({
      logPath: providerLog,
      routeRequest: ({ transcript, toolNames }) => {
        turn += 1;
        if (turn === 1) {
          assert(toolNames.includes("Bash"), "Bash was not available");
          assert(toolNames.includes("Glob"), "Glob was not available");
          assert(toolNames.includes("Grep"), "Grep was not available");
          assert(toolNames.includes("FileRead"), "FileRead was not available");
          assert(toolNames.includes("FilePatch"), "FilePatch was not available");
          return toolResponse([
            toolCall("run-oss-options-before", "Bash", {
              command: "node tests/oss-options.test.mjs",
              timeout_ms: 5000
            }),
            toolCall("glob-oss-repo", "Glob", {
              pattern: "**/*.{js,md,ts,mjs}",
              max_matches: 40
            }),
            toolCall("grep-cache-ttl", "Grep", {
              pattern: "cacheTTL",
              path: ".",
              output_mode: "content",
              max_matches: 40
            }),
            toolCall("read-oss-test", "FileRead", {
              file_path: "tests/oss-options.test.mjs"
            }),
            toolCall("read-core-options", "FileRead", {
              file_path: "packages/core/src/options.js"
            }),
            toolCall("read-core-client", "FileRead", {
              file_path: "packages/core/src/client.js"
            }),
            toolCall("read-auth-plugin", "FileRead", {
              file_path: "packages/plugin-auth/src/index.js"
            }),
            toolCall("read-telemetry-plugin", "FileRead", {
              file_path: "packages/plugin-telemetry/src/index.js"
            }),
            toolCall("read-node-example", "FileRead", {
              file_path: "examples/node/basic.js"
            }),
            toolCall("read-config-docs", "FileRead", {
              file_path: "docs/configuration.md"
            }),
            toolCall("read-changelog", "FileRead", {
              file_path: "changelog/unreleased.md"
            }),
            toolCall("read-generated-options", "FileRead", {
              file_path: "generated/options.d.ts"
            }),
            toolCall("read-vendor-options", "FileRead", {
              file_path: "vendor/legacy-options.js"
            })
          ]);
        }
        if (turn === 2) {
          assert(transcript.includes("AssertionError"), "failing OSS options test missing");
          assert(transcript.includes("packages/core/src/options.js"), "OSS repo file list missing");
          assert(transcript.includes("cacheTTL"), "legacy cacheTTL search results missing");
          assert(transcript.includes("AUTO-GENERATED OPTIONS"), "generated options boundary missing");
          assert(transcript.includes("vendored compatibility shim"), "vendor boundary missing");
          return toolResponse([
            toolCall("patch-core-options", "FilePatch", {
              file_path: "packages/core/src/options.js",
              patch: [
                "@@",
                " export const defaultOptions = {",
                "-  cacheTTL: 60,",
                "+  cacheTtlSeconds: 60,",
                "   retryLimit: 2",
                " };",
                " ",
                " export function normalizeOptions(options = {}) {",
                "   return {",
                "-    cacheTTL: options.cacheTTL ?? defaultOptions.cacheTTL,",
                "+    cacheTtlSeconds: options.cacheTtlSeconds ?? defaultOptions.cacheTtlSeconds,",
                "     retryLimit: options.retryLimit ?? defaultOptions.retryLimit",
                "   };",
                " }"
              ].join("\n")
            }),
            toolCall("patch-core-client", "FilePatch", {
              file_path: "packages/core/src/client.js",
              patch: [
                "@@",
                " export function createClient(options = {}) {",
                "   const normalized = normalizeOptions(options);",
                "   return {",
                "-    cacheTTL: normalized.cacheTTL,",
                "+    cacheTtlSeconds: normalized.cacheTtlSeconds,",
                "     retryLimit: normalized.retryLimit",
                "   };",
                " }"
              ].join("\n")
            }),
            toolCall("patch-auth-plugin", "FilePatch", {
              file_path: "packages/plugin-auth/src/index.js",
              patch: [
                "@@",
                " export function authPlugin(options = {}) {",
                "   return {",
                '     name: "auth",',
                "-    cacheTTL: options.cacheTTL ?? 60",
                "+    cacheTtlSeconds: options.cacheTtlSeconds ?? 60",
                "   };",
                " }"
              ].join("\n")
            }),
            toolCall("patch-telemetry-plugin", "FilePatch", {
              file_path: "packages/plugin-telemetry/src/index.js",
              patch: [
                "@@",
                " export function telemetryPlugin(options = {}) {",
                "   return {",
                '     name: "telemetry",',
                "-    cacheTTL: options.cacheTTL ?? 60",
                "+    cacheTtlSeconds: options.cacheTtlSeconds ?? 60",
                "   };",
                " }"
              ].join("\n")
            }),
            toolCall("patch-node-example", "FilePatch", {
              file_path: "examples/node/basic.js",
              patch: [
                "@@",
                ' import { createClient } from "../../packages/core/src/client.js";',
                " ",
                "-export const client = createClient({ cacheTTL: 60 });",
                "+export const client = createClient({ cacheTtlSeconds: 60 });"
              ].join("\n")
            }),
            toolCall("patch-config-docs", "FilePatch", {
              file_path: "docs/configuration.md",
              patch: [
                "@@",
                " # Configuration",
                " ",
                "-`cacheTTL` controls cache expiry in seconds.",
                "-Plugins accept the same `cacheTTL` option.",
                "+`cacheTtlSeconds` controls cache expiry in seconds.",
                "+Plugins accept the same `cacheTtlSeconds` option."
              ].join("\n")
            }),
            toolCall("patch-changelog", "FilePatch", {
              file_path: "changelog/unreleased.md",
              patch: [
                "@@",
                " # Unreleased",
                " ",
                "-- Documented cacheTTL for core and plugins.",
                "+- Renamed the cache option to cacheTtlSeconds across core, plugins, examples, and docs."
              ].join("\n")
            })
          ]);
        }
        if (turn === 3) {
          assert(
            transcript.includes("Patched packages/core/src/options.js"),
            "core options patch result missing"
          );
          assert(
            transcript.includes("Patched packages/plugin-auth/src/index.js"),
            "auth plugin patch result missing"
          );
          assert(
            transcript.includes("Patched examples/node/basic.js"),
            "example patch result missing"
          );
          assert(transcript.includes("Patched changelog/unreleased.md"), "changelog patch missing");
          return toolResponse([
            toolCall("run-oss-options-after", "Bash", {
              command: "node tests/oss-options.test.mjs",
              timeout_ms: 5000
            })
          ]);
        }
        assert(transcript.includes("oss options migration ok"), "passing OSS options test missing");
        return messageText(
          "OSS-style cache option migration completed with generated and vendor boundaries preserved."
        );
      }
    });

    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig(provider.port), "utf8");
      const output = await runCli({
        args: [
          "--permission-mode",
          "acceptEdits",
          "--allowed-tools",
          "FileRead,FileWrite,FileEdit,FilePatch,FileMove,Glob,Grep,ToolSearch,Bash",
          "--model",
          "main",
          "--output-format",
          "stream-json",
          "-p",
          [
            "In this OSS-style multi-package repository, rename the public option cacheTTL",
            "to cacheTtlSeconds across owned source, plugins, examples, docs, and changelog.",
            "Run the focused options test before editing, discover files with Glob and Grep,",
            "inspect generated and vendor boundaries, do not modify generated or vendor files,",
            "then rerun the focused options test."
          ].join(" ")
        ],
        cwd: workDir,
        configDir,
        label: "oss-style open source migration task",
        timeoutMs: 45_000
      });
      assert(output.includes("session.completed"), "OSS-style migration task did not complete");
      const ownedFiles = [
        "packages/core/src/options.js",
        "packages/core/src/client.js",
        "packages/plugin-auth/src/index.js",
        "packages/plugin-telemetry/src/index.js",
        "examples/node/basic.js",
        "docs/configuration.md",
        "changelog/unreleased.md"
      ];
      for (const file of ownedFiles) {
        const content = readFileSync(path.join(workDir, file), "utf8");
        assert(!content.includes("cacheTTL"), `${file} still contains cacheTTL`);
        assert(content.includes("cacheTtlSeconds"), `${file} missing cacheTtlSeconds`);
      }
      const generatedAfter = readFileSync(path.join(workDir, "generated", "options.d.ts"), "utf8");
      const vendorAfter = readFileSync(path.join(workDir, "vendor", "legacy-options.js"), "utf8");
      assert(generatedAfter === generatedBefore, "generated options file was modified");
      assert(vendorAfter === vendorBefore, "vendor options shim was modified");
      const summary = provider.summary();
      const toolCounts = summary.toolCounts;
      assert(toolCounts.Bash === 2, "OSS-style migration should run tests before and after");
      assert(toolCounts.Glob === 1, "OSS-style migration should discover files with Glob");
      assert(toolCounts.Grep === 1, "OSS-style migration should search old option with Grep");
      assert(toolCounts.FileRead === 10, "OSS-style migration should inspect owned and boundary files");
      assert(toolCounts.FilePatch === 7, "OSS-style migration should patch seven owned files");
      assert(!toolCounts.FileWrite, "OSS-style migration should not rewrite existing files");
      assert(!toolCounts.FileEdit, "OSS-style migration should not use FileEdit");
      return {
        score: 1,
        assertions: [
          "focused failing OSS options test ran first",
          "OSS-style repo discovery ran with Glob",
          "legacy option search ran with Grep",
          "core source inspected before patching",
          "plugin source inspected before patching",
          "example docs and changelog inspected before patching",
          "generated options boundary inspected",
          "vendor compatibility boundary inspected",
          "core option normalization migrated",
          "core client output migrated",
          "auth plugin option migrated",
          "telemetry plugin option migrated",
          "example usage migrated",
          "configuration docs migrated",
          "changelog migrated",
          "focused passing OSS options test ran after migration",
          "old owned cacheTTL references removed",
          "generated options file stayed unchanged",
          "vendor options shim stayed unchanged",
          "FileWrite avoided for OSS-style migration",
          "FileEdit avoided for OSS-style migration",
          "final response completed"
        ],
        filesVerified: [
          "packages/core/src/options.js",
          "packages/core/src/client.js",
          "packages/plugin-auth/src/index.js",
          "packages/plugin-telemetry/src/index.js",
          "examples/node/basic.js",
          "docs/configuration.md",
          "changelog/unreleased.md",
          "generated/options.d.ts",
          "vendor/legacy-options.js",
          "tests/oss-options.test.mjs"
        ],
        provider: summary,
        taskClass: "oss_style_open_source_migration",
        toolCounts,
        ossRepoDiscoveryVerified: true,
        coreContractsMigrated: true,
        pluginContractsMigrated: true,
        examplesDocsChangelogMigrated: true,
        oldOwnedOptionReferencesRemoved: true,
        generatedOptionsUntouched: true,
        vendorOptionsUntouched: true,
        ossStyleMigrationVerified: true,
        fileWriteAvoided: !toolCounts.FileWrite,
        fileEditAvoided: !toolCounts.FileEdit
      };
    } catch (error) {
      printProviderLog(providerLog);
      throw error;
    } finally {
      await provider.close();
    }
  });
}

async function scenarioOssIssueRegressionFixTask() {
  return await withWorkspace("oss-issue-regression-fix", async ({ root, configDir, workDir }) => {
    mkdirSync(path.join(workDir, "issues"), { recursive: true });
    mkdirSync(path.join(workDir, "packages", "core", "src"), { recursive: true });
    mkdirSync(path.join(workDir, "packages", "client", "src"), { recursive: true });
    mkdirSync(path.join(workDir, "packages", "plugin-github", "src"), { recursive: true });
    mkdirSync(path.join(workDir, "docs"), { recursive: true });
    mkdirSync(path.join(workDir, "changelog"), { recursive: true });
    mkdirSync(path.join(workDir, "generated"), { recursive: true });
    mkdirSync(path.join(workDir, "vendor"), { recursive: true });
    mkdirSync(path.join(workDir, "tests"), { recursive: true });
    writeFileSync(
      path.join(workDir, "issues", "429.md"),
      [
        "# Issue 429: issue URLs break when path segments contain spaces or slashes",
        "",
        "Customers report 404 responses when owner, repo, or issue ids contain reserved URL characters.",
        "",
        "Acceptance:",
        "- reproduce the failure with `node tests/issue-url.test.mjs` before editing",
        "- encode owner, repo, and issueId path segments in owned source packages",
        "- update docs and changelog",
        "- do not edit generated or vendor files",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "packages", "core", "src", "url-builder.js"),
      [
        "export function trimTrailingSlash(baseUrl) {",
        '  return baseUrl.replace(/\\/+$/, "");',
        "}",
        "",
        "export function issuePath(owner, repo, issueId) {",
        "  return `/repos/${owner}/${repo}/issues/${issueId}`;",
        "}",
        "",
        "export function buildIssueUrl(baseUrl, owner, repo, issueId) {",
        "  return `${trimTrailingSlash(baseUrl)}${issuePath(owner, repo, issueId)}`;",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "packages", "client", "src", "issues.js"),
      [
        "export function issueRequest(baseUrl, owner, repo, issueId) {",
        "  return {",
        '    method: "GET",',
        "    url: `${baseUrl}/repos/${owner}/${repo}/issues/${issueId}`",
        "  };",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "packages", "plugin-github", "src", "index.js"),
      [
        "export function githubIssueLink(owner, repo, issueId) {",
        "  return `/repos/${owner}/${repo}/issues/${issueId}`;",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "docs", "issues.md"),
      [
        "# Issue URLs",
        "",
        "The issue URL helpers place owner, repo, and issueId directly into the path.",
        "Callers should only pass simple path-safe ids.",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workDir, "changelog", "unreleased.md"),
      ["# Unreleased", "", "- Documented issue URL helpers.", ""].join("\n"),
      "utf8"
    );
    const generatedBefore = [
      "{",
      '  "resource": "issue",',
      '  "path": "/repos/{owner}/{repo}/issues/{issueId}",',
      '  "generated": true',
      "}",
      ""
    ].join("\n");
    const vendorBefore = [
      "// vendored GitHub route shim",
      "export const issueRoute = \"/repos/{owner}/{repo}/issues/{issueId}\";",
      ""
    ].join("\n");
    writeFileSync(path.join(workDir, "generated", "openapi.json"), generatedBefore, "utf8");
    writeFileSync(path.join(workDir, "vendor", "github-route.js"), vendorBefore, "utf8");
    writeFileSync(
      path.join(workDir, "tests", "issue-url.test.mjs"),
      [
        'import assert from "node:assert/strict";',
        'import { readFileSync } from "node:fs";',
        'import { issuePath, buildIssueUrl } from "../packages/core/src/url-builder.js";',
        'import { issueRequest } from "../packages/client/src/issues.js";',
        'import { githubIssueLink } from "../packages/plugin-github/src/index.js";',
        "",
        'const owner = "edward lee";',
        'const repo = "magi/next";',
        'const issueId = "A-42/beta";',
        'const expectedPath = "/repos/edward%20lee/magi%2Fnext/issues/A-42%2Fbeta";',
        'const expectedUrl = `https://api.example.test${expectedPath}`;',
        "",
        "assert.equal(issuePath(owner, repo, issueId), expectedPath);",
        'assert.equal(buildIssueUrl("https://api.example.test/", owner, repo, issueId), expectedUrl);',
        "assert.deepEqual(issueRequest(\"https://api.example.test\", owner, repo, issueId), {",
        '  method: "GET",',
        "  url: expectedUrl",
        "});",
        "assert.equal(githubIssueLink(owner, repo, issueId), expectedPath);",
        "",
        'const docs = readFileSync("docs/issues.md", "utf8");',
        'assert.match(docs, /URL-encodes owner, repo, and issueId/);',
        'const changelog = readFileSync("changelog/unreleased.md", "utf8");',
        'assert.match(changelog, /issue URL encoding regression/);',
        "",
        'const generated = readFileSync("generated/openapi.json", "utf8");',
        'assert.match(generated, /"generated": true/);',
        'assert.match(generated, /\\{issueId\\}/);',
        'const vendor = readFileSync("vendor/github-route.js", "utf8");',
        'assert.match(vendor, /vendored GitHub route shim/);',
        'assert.match(vendor, /\\{issueId\\}/);',
        'console.log("issue url regression ok");',
        ""
      ].join("\n"),
      "utf8"
    );

    const providerLog = path.join(root, "provider-log.json");
    let turn = 0;
    const provider = await startProvider({
      logPath: providerLog,
      routeRequest: ({ transcript, toolNames }) => {
        turn += 1;
        if (turn === 1) {
          assert(toolNames.includes("Bash"), "Bash was not available");
          assert(toolNames.includes("Glob"), "Glob was not available");
          assert(toolNames.includes("Grep"), "Grep was not available");
          assert(toolNames.includes("FileRead"), "FileRead was not available");
          assert(toolNames.includes("FilePatch"), "FilePatch was not available");
          return toolResponse([
            toolCall("run-issue-url-before", "Bash", {
              command: "node tests/issue-url.test.mjs",
              timeout_ms: 5000
            }),
            toolCall("glob-issue-repo", "Glob", {
              pattern: "**/*.{js,md,json,mjs}",
              max_matches: 40
            }),
            toolCall("grep-issue-id", "Grep", {
              pattern: "issueId",
              path: ".",
              output_mode: "content",
              max_matches: 40
            }),
            toolCall("read-issue-report", "FileRead", {
              file_path: "issues/429.md"
            }),
            toolCall("read-issue-test", "FileRead", {
              file_path: "tests/issue-url.test.mjs"
            }),
            toolCall("read-core-url-builder", "FileRead", {
              file_path: "packages/core/src/url-builder.js"
            }),
            toolCall("read-client-issues", "FileRead", {
              file_path: "packages/client/src/issues.js"
            }),
            toolCall("read-github-plugin", "FileRead", {
              file_path: "packages/plugin-github/src/index.js"
            }),
            toolCall("read-issue-docs", "FileRead", {
              file_path: "docs/issues.md"
            }),
            toolCall("read-issue-changelog", "FileRead", {
              file_path: "changelog/unreleased.md"
            }),
            toolCall("read-generated-openapi", "FileRead", {
              file_path: "generated/openapi.json"
            }),
            toolCall("read-vendor-github-route", "FileRead", {
              file_path: "vendor/github-route.js"
            })
          ]);
        }
        if (turn === 2) {
          assert(transcript.includes("AssertionError"), "failing issue URL test missing");
          assert(transcript.includes("Issue 429"), "issue report context missing");
          assert(transcript.includes("reserved URL characters"), "issue business context missing");
          assert(transcript.includes("packages/core/src/url-builder.js"), "repo discovery missing");
          assert(transcript.includes("issueId"), "issueId search output missing");
          assert(transcript.includes('"generated": true'), "generated boundary missing");
          assert(transcript.includes("vendored GitHub route shim"), "vendor boundary missing");
          return toolResponse([
            toolCall("patch-core-url-builder", "FilePatch", {
              file_path: "packages/core/src/url-builder.js",
              patch: [
                "@@",
                " export function issuePath(owner, repo, issueId) {",
                "-  return `/repos/${owner}/${repo}/issues/${issueId}`;",
                "+  const safeOwner = encodeURIComponent(owner);",
                "+  const safeRepo = encodeURIComponent(repo);",
                "+  const safeIssueId = encodeURIComponent(issueId);",
                "+  return `/repos/${safeOwner}/${safeRepo}/issues/${safeIssueId}`;",
                " }"
              ].join("\n")
            }),
            toolCall("patch-client-issues", "FilePatch", {
              file_path: "packages/client/src/issues.js",
              patch: [
                "@@",
                "+import { buildIssueUrl } from \"../../core/src/url-builder.js\";",
                "+",
                " export function issueRequest(baseUrl, owner, repo, issueId) {",
                "   return {",
                "     method: \"GET\",",
                "-    url: `${baseUrl}/repos/${owner}/${repo}/issues/${issueId}`",
                "+    url: buildIssueUrl(baseUrl, owner, repo, issueId)",
                "   };",
                " }"
              ].join("\n")
            }),
            toolCall("patch-github-plugin", "FilePatch", {
              file_path: "packages/plugin-github/src/index.js",
              patch: [
                "@@",
                " export function githubIssueLink(owner, repo, issueId) {",
                "-  return `/repos/${owner}/${repo}/issues/${issueId}`;",
                "+  const safeOwner = encodeURIComponent(owner);",
                "+  const safeRepo = encodeURIComponent(repo);",
                "+  const safeIssueId = encodeURIComponent(issueId);",
                "+  return `/repos/${safeOwner}/${safeRepo}/issues/${safeIssueId}`;",
                " }"
              ].join("\n")
            }),
            toolCall("patch-issue-docs", "FilePatch", {
              file_path: "docs/issues.md",
              patch: [
                "@@",
                " # Issue URLs",
                " ",
                "-The issue URL helpers place owner, repo, and issueId directly into the path.",
                "-Callers should only pass simple path-safe ids.",
                "+The issue URL helpers URL-encodes owner, repo, and issueId path segments.",
                "+Callers can pass ids with spaces or slashes; owned helpers encode them before routing."
              ].join("\n")
            }),
            toolCall("patch-issue-changelog", "FilePatch", {
              file_path: "changelog/unreleased.md",
              patch: [
                "@@",
                " # Unreleased",
                " ",
                "-- Documented issue URL helpers.",
                "+- Fixed the issue URL encoding regression for owner, repo, and issueId path segments."
              ].join("\n")
            })
          ]);
        }
        if (turn === 3) {
          assert(
            transcript.includes("Patched packages/core/src/url-builder.js"),
            "core URL patch result missing"
          );
          assert(
            transcript.includes("Patched packages/client/src/issues.js"),
            "client URL patch result missing"
          );
          assert(
            transcript.includes("Patched packages/plugin-github/src/index.js"),
            "plugin URL patch result missing"
          );
          assert(transcript.includes("Patched docs/issues.md"), "docs patch result missing");
          assert(transcript.includes("Patched changelog/unreleased.md"), "changelog patch missing");
          return toolResponse([
            toolCall("run-issue-url-after", "Bash", {
              command: "node tests/issue-url.test.mjs",
              timeout_ms: 5000
            })
          ]);
        }
        assert(transcript.includes("issue url regression ok"), "passing issue URL test missing");
        return messageText(
          "OSS issue URL regression fixed with source packages updated and generated/vendor boundaries preserved."
        );
      }
    });

    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig(provider.port), "utf8");
      const output = await runCli({
        args: [
          "--permission-mode",
          "acceptEdits",
          "--allowed-tools",
          "FileRead,FileWrite,FileEdit,FilePatch,FileMove,Glob,Grep,ToolSearch,Bash",
          "--model",
          "main",
          "--output-format",
          "stream-json",
          "-p",
          [
            "Fix OSS issue 429 in this multi-package repository.",
            "First reproduce the failing issue URL regression test, discover the repo with Glob and Grep,",
            "read the issue report, source packages, docs, changelog, generated schema, and vendor shim,",
            "encode owner, repo, and issueId path segments in owned source only, update docs and changelog,",
            "do not modify generated or vendor files, then rerun the focused test."
          ].join(" ")
        ],
        cwd: workDir,
        configDir,
        label: "OSS issue regression fix task",
        timeoutMs: 45_000
      });
      assert(output.includes("session.completed"), "OSS issue regression fix did not complete");
      const core = readFileSync(path.join(workDir, "packages/core/src/url-builder.js"), "utf8");
      const client = readFileSync(path.join(workDir, "packages/client/src/issues.js"), "utf8");
      const plugin = readFileSync(
        path.join(workDir, "packages", "plugin-github", "src", "index.js"),
        "utf8"
      );
      const docs = readFileSync(path.join(workDir, "docs", "issues.md"), "utf8");
      const changelog = readFileSync(path.join(workDir, "changelog", "unreleased.md"), "utf8");
      assert(core.includes("encodeURIComponent(owner)"), "core owner encoding missing");
      assert(core.includes("encodeURIComponent(repo)"), "core repo encoding missing");
      assert(core.includes("encodeURIComponent(issueId)"), "core issueId encoding missing");
      assert(client.includes("buildIssueUrl(baseUrl, owner, repo, issueId)"), "client not routed through encoded helper");
      assert(plugin.includes("encodeURIComponent(issueId)"), "plugin issueId encoding missing");
      assert(docs.includes("URL-encodes owner, repo, and issueId"), "issue docs not updated");
      assert(changelog.includes("issue URL encoding regression"), "issue changelog not updated");
      const generatedAfter = readFileSync(path.join(workDir, "generated", "openapi.json"), "utf8");
      const vendorAfter = readFileSync(path.join(workDir, "vendor", "github-route.js"), "utf8");
      assert(generatedAfter === generatedBefore, "generated OpenAPI schema was modified");
      assert(vendorAfter === vendorBefore, "vendor GitHub route shim was modified");
      const summary = provider.summary();
      const toolCounts = summary.toolCounts;
      assert(toolCounts.Bash === 2, "OSS issue fix should run tests before and after");
      assert(toolCounts.Glob === 1, "OSS issue fix should discover files with Glob");
      assert(toolCounts.Grep === 1, "OSS issue fix should search issueId with Grep");
      assert(toolCounts.FileRead === 9, "OSS issue fix should inspect issue, source, docs, and boundaries");
      assert(toolCounts.FilePatch === 5, "OSS issue fix should patch five owned files");
      assert(!toolCounts.FileWrite, "OSS issue fix should not rewrite existing files");
      assert(!toolCounts.FileEdit, "OSS issue fix should not use FileEdit");
      return {
        score: 1,
        assertions: [
          "focused failing issue URL test ran first",
          "OSS issue report was read before editing",
          "repo discovery ran with Glob",
          "issueId search ran with Grep",
          "core URL builder inspected before patching",
          "client issue request inspected before patching",
          "GitHub plugin inspected before patching",
          "generated OpenAPI boundary inspected",
          "vendor route boundary inspected",
          "core path segments encoded",
          "client request routed through encoded helper",
          "plugin issue link encoded",
          "issue docs updated",
          "issue changelog updated",
          "focused issue URL test passed after fix",
          "generated OpenAPI schema stayed unchanged",
          "vendor GitHub route shim stayed unchanged",
          "FileWrite avoided for OSS issue fix",
          "FileEdit avoided for OSS issue fix",
          "final response completed"
        ],
        filesVerified: [
          "issues/429.md",
          "packages/core/src/url-builder.js",
          "packages/client/src/issues.js",
          "packages/plugin-github/src/index.js",
          "docs/issues.md",
          "changelog/unreleased.md",
          "generated/openapi.json",
          "vendor/github-route.js",
          "tests/issue-url.test.mjs"
        ],
        provider: summary,
        taskClass: "oss_issue_regression_fix",
        toolCounts,
        ossIssueRegressionTaskSeen: true,
        issueReportReadBeforePatch: true,
        issueRegressionReproduced: true,
        coreUrlEncodingFixed: true,
        clientUrlEncodingFixed: true,
        pluginUrlEncodingFixed: true,
        issueDocsChangelogUpdated: true,
        generatedOpenapiUntouched: true,
        vendorRouteUntouched: true,
        issueRegressionVerified: true,
        fileWriteAvoided: !toolCounts.FileWrite,
        fileEditAvoided: !toolCounts.FileEdit
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
    ["tool discovery task", scenarioToolDiscoveryTask],
    ["cross-file verified edit task", scenarioCrossFileVerifiedEditTask],
    ["patch strategy task", scenarioPatchStrategyTask],
    ["dependency refactor task", scenarioDependencyRefactorTask],
    ["test-driven recovery task", scenarioTestDrivenRecoveryTask],
    ["continuous patch recovery task", scenarioContinuousPatchRecoveryTask],
    ["api migration task", scenarioApiMigrationTask],
    ["monorepo generated boundary task", scenarioMonorepoGeneratedBoundaryTask],
    ["workspace policy migration task", scenarioWorkspacePolicyMigrationTask],
    ["mixed language contract migration task", scenarioMixedLanguageContractMigrationTask],
    ["large repo long-chain migration task", scenarioLargeRepoLongChainMigrationTask],
    ["plugin API compatibility migration task", scenarioPluginApiCompatibilityMigrationTask],
    ["security middleware policy migration task", scenarioSecurityMiddlewarePolicyMigrationTask],
    ["OSS security advisory fix task", scenarioOssSecurityAdvisoryFixTask],
    ["CI failure diagnosis fix task", scenarioCiFailureDiagnosisFixTask],
    ["OSS issue regression fix task", scenarioOssIssueRegressionFixTask],
    ["oss-style open source migration task", scenarioOssStyleOpenSourceMigrationTask]
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
