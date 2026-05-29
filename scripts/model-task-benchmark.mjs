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
    ["test-driven recovery task", scenarioTestDrivenRecoveryTask]
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
