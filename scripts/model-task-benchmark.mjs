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
    ["mixed language contract migration task", scenarioMixedLanguageContractMigrationTask]
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
