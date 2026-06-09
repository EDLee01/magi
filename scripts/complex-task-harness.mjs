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

function renderConfig(port, { fallbacks = false } = {}) {
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
      assert(
        transcript.includes("FilePatch failed for src/discount.ts"),
        "H1 patch failure was not visible"
      );
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

function createH2Router() {
  let turn = 0;
  return ({ transcript, toolNames }) => {
    if (!transcript.includes("Add --dry-run support to the notes CLI")) {
      return messageText("OK");
    }
    turn += 1;

    if (turn === 1) {
      assert(toolNames.includes("FileRead"), "H2 missing FileRead");
      assert(toolNames.includes("FilePatch"), "H2 missing FilePatch");
      assert(toolNames.includes("Bash"), "H2 missing Bash");
      assert(
        transcript.includes("Dry run writes no files") ||
          transcript.includes("reports what would be saved without modifying"),
        "H2 dry-run constraint was not visible"
      );
      return toolResponse([
        toolCall("h2-read-cli", "FileRead", { file_path: "src/cli.js" }),
        toolCall("h2-read-store", "FileRead", { file_path: "src/store.js" }),
        toolCall("h2-read-tests", "FileRead", { file_path: "tests/cli.test.mjs" }),
        toolCall("h2-read-readme", "FileRead", { file_path: "README.md" }),
        toolCall("h2-run-baseline-test", "Bash", { command: "npm test", timeout_ms: 10_000 })
      ]);
    }

    if (turn === 2) {
      assert(transcript.includes("notes cli tests passed"), "H2 baseline test was not visible");
      assert(
        transcript.includes("node src/cli.js add --title <title>"),
        "H2 help text was not visible"
      );
      assert(
        transcript.includes("function addNote(title)"),
        "H2 store implementation was not visible"
      );
      return toolResponse([
        toolCall("h2-patch-store", "FilePatch", {
          file_path: "src/store.js",
          patch: [
            "@@",
            "-function addNote(title) {",
            "+function addNote(title, options = {}) {",
            "   const notes = readNotes();",
            "   const note = { id: notes.length + 1, title };",
            "+  if (options.dryRun) {",
            "+    return note;",
            "+  }",
            "   notes.push(note);",
            "   mkdirSync(path.dirname(DATA_FILE), { recursive: true });",
            '   writeFileSync(DATA_FILE, `${JSON.stringify(notes, null, 2)}\\n`, "utf8");'
          ].join("\n")
        }),
        toolCall("h2-patch-cli", "FilePatch", {
          file_path: "src/cli.js",
          patch: [
            "@@",
            '     if (value === "--title") {',
            "       options.title = rest[index + 1];",
            "       index += 1;",
            "     }",
            '+    if (value === "--dry-run") {',
            "+      options.dryRun = true;",
            "+    }",
            "   }",
            "   return { command, options };",
            " }",
            "@@",
            "   return [",
            '     "Usage:",',
            '-    "  node src/cli.js add --title <title>",',
            '+    "  node src/cli.js add --title <title> [--dry-run]",',
            '     "  node src/cli.js list"',
            '   ].join("\\n");',
            " }",
            "@@",
            "-    const note = addNote(options.title);",
            "+    const note = addNote(options.title, { dryRun: options.dryRun });",
            "+    if (options.dryRun) {",
            "+      console.log(`[dry-run] Would add note: ${note.title}`);",
            "+      return 0;",
            "+    }",
            "     console.log(`Added note #${note.id}: ${note.title}`);",
            "     return 0;",
            "   }"
          ].join("\n")
        }),
        toolCall("h2-patch-tests", "FilePatch", {
          file_path: "tests/cli.test.mjs",
          patch: [
            "@@",
            ' assert.equal(existsSync("data/notes.json"), true);',
            ' assert.match(readFileSync("data/notes.json", "utf8"), /First/);',
            " ",
            '+const beforeDryRun = readFileSync("data/notes.json", "utf8");',
            "+result = spawnSync(process.execPath, [",
            '+  "src/cli.js",',
            '+  "add",',
            '+  "--title",',
            '+  "Preview",',
            '+  "--dry-run"',
            '+], { encoding: "utf8" });',
            "+assert.equal(result.status, 0);",
            "+assert.match(result.stdout, /\\[dry-run\\] Would add note: Preview/);",
            "+assert.equal(",
            '+  readFileSync("data/notes.json", "utf8"),',
            "+  beforeDryRun,",
            '+  "dry-run does not write notes"',
            "+);",
            "+",
            ' console.log("notes cli tests passed");'
          ].join("\n")
        }),
        toolCall("h2-patch-readme", "FilePatch", {
          file_path: "README.md",
          patch: [
            "@@",
            " ```bash",
            ' node src/cli.js add --title "Buy milk"',
            '+node src/cli.js add --title "Preview note" --dry-run',
            " node src/cli.js list",
            " ```",
            " ",
            "-Notes are stored in `data/notes.json`.",
            "+Notes are stored in `data/notes.json`. Use `--dry-run` to preview an add without writing the data file."
          ].join("\n")
        })
      ]);
    }

    if (turn === 3) {
      assert(transcript.includes("Patched src/cli.js"), "H2 CLI patch result was not visible");
      assert(transcript.includes("Patched src/store.js"), "H2 store patch result was not visible");
      assert(
        transcript.includes("Patched tests/cli.test.mjs"),
        "H2 test patch result was not visible"
      );
      assert(transcript.includes("Patched README.md"), "H2 README patch result was not visible");
      return toolResponse([
        toolCall("h2-run-passing-test-and-dry-run", "Bash", {
          command: [
            "npm test",
            "node <<'NODE'",
            "const { mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');",
            "const { spawnSync } = require('node:child_process');",
            "mkdirSync('data', { recursive: true });",
            "writeFileSync('data/notes.json', '[]\\n', 'utf8');",
            "const result = spawnSync(process.execPath, ['src/cli.js', 'add', '--title', 'Preview', '--dry-run'], { encoding: 'utf8' });",
            "if (result.status !== 0) throw new Error(result.stderr || result.stdout);",
            "if (!result.stdout.includes('[dry-run] Would add note: Preview')) throw new Error('missing dry-run output');",
            "console.log(result.stdout.trim());",
            "if (readFileSync('data/notes.json', 'utf8').trim() !== '[]') throw new Error('dry-run wrote data');",
            "rmSync('data', { recursive: true, force: true });",
            "NODE"
          ].join("\n")
        })
      ]);
    }

    if (turn === 4) {
      assert(
        transcript.includes("Command exited 0"),
        "H2 passing verification command was not visible"
      );
      assert(transcript.includes("notes cli tests passed"), "H2 passing tests output was missing");
      assert(
        transcript.includes("[dry-run] Would add note: Preview"),
        "H2 dry-run output was missing"
      );
      return messageText(
        "Added --dry-run support and verified npm test plus dry-run no-write behavior."
      );
    }

    throw new Error(`H2 exceeded expected provider turns: ${turn}`);
  };
}

function createH3Router() {
  let turn = 0;
  return ({ transcript, toolNames }) => {
    if (!transcript.includes("Refactor duplicate parsing logic while keeping behavior unchanged")) {
      return messageText("OK");
    }
    turn += 1;

    if (turn === 1) {
      assert(toolNames.includes("FileRead"), "H3 missing FileRead");
      assert(toolNames.includes("FilePatch"), "H3 missing FilePatch");
      assert(toolNames.includes("Bash"), "H3 missing Bash");
      assert(
        transcript.includes("Preserve the public output"),
        "H3 output constraint was not visible"
      );
      return toolResponse([
        toolCall("h3-read-sales", "FileRead", { file_path: "src/sales.js" }),
        toolCall("h3-read-inventory", "FileRead", { file_path: "src/inventory.js" }),
        toolCall("h3-read-tests", "FileRead", { file_path: "tests/report.test.mjs" }),
        toolCall("h3-run-baseline-test", "Bash", { command: "npm test", timeout_ms: 10_000 })
      ]);
    }

    if (turn === 2) {
      assert(transcript.includes("sales total=60; count=3"), "H3 baseline sales output missing");
      assert(
        transcript.includes("inventory total=20; count=3"),
        "H3 baseline inventory output missing"
      );
      assert(transcript.includes("report tests passed"), "H3 baseline test was not visible");
      assert(transcript.includes('split(",")'), "H3 duplicate parsing evidence was not visible");
      return toolResponse([
        toolCall("h3-create-parse-helper", "FileWrite", {
          file_path: "src/parse.js",
          content: [
            "function parseCsvNumbers(input) {",
            "  return input",
            '    .split(",")',
            "    .map((value) => value.trim())",
            "    .filter(Boolean)",
            "    .map((value) => Number(value));",
            "}",
            "",
            "module.exports = { parseCsvNumbers };",
            ""
          ].join("\n")
        }),
        toolCall("h3-patch-sales", "FilePatch", {
          file_path: "src/sales.js",
          patch: [
            "@@",
            "-function parseSalesAmounts(input) {",
            "-  return input",
            '-    .split(",")',
            "-    .map((value) => value.trim())",
            "-    .filter(Boolean)",
            "-    .map((value) => Number(value));",
            "-}",
            '+const { parseCsvNumbers } = require("./parse");',
            "+",
            "+function parseSalesAmounts(input) {",
            "+  return parseCsvNumbers(input);",
            "+}",
            " ",
            " function salesReport(input) {"
          ].join("\n")
        }),
        toolCall("h3-patch-inventory", "FilePatch", {
          file_path: "src/inventory.js",
          patch: [
            "@@",
            "-function parseInventoryCounts(input) {",
            "-  return input",
            '-    .split(",")',
            "-    .map((value) => value.trim())",
            "-    .filter(Boolean)",
            "-    .map((value) => Number(value));",
            "-}",
            '+const { parseCsvNumbers } = require("./parse");',
            "+",
            "+function parseInventoryCounts(input) {",
            "+  return parseCsvNumbers(input);",
            "+}",
            " ",
            " function inventoryReport(input) {"
          ].join("\n")
        })
      ]);
    }

    if (turn === 3) {
      assert(
        transcript.includes("Wrote src/parse.js"),
        "H3 parse helper write result was not visible"
      );
      assert(transcript.includes("Patched src/sales.js"), "H3 sales patch result was not visible");
      assert(
        transcript.includes("Patched src/inventory.js"),
        "H3 inventory patch result was not visible"
      );
      return toolResponse([
        toolCall("h3-run-refactor-verification", "Bash", {
          command: [
            "npm test",
            "node <<'NODE'",
            "const { readFileSync } = require('node:fs');",
            "const sales = readFileSync('src/sales.js', 'utf8');",
            "const inventory = readFileSync('src/inventory.js', 'utf8');",
            "const parse = readFileSync('src/parse.js', 'utf8');",
            "if (!parse.includes('function parseCsvNumbers')) throw new Error('missing parseCsvNumbers');",
            "if (!sales.includes('parseCsvNumbers(input)')) throw new Error('sales not delegated');",
            "if (!inventory.includes('parseCsvNumbers(input)')) throw new Error('inventory not delegated');",
            "if (sales.includes('split(\",\")') || inventory.includes('split(\",\")')) throw new Error('duplicate parsing remains');",
            "console.log('refactor helper verified');",
            "NODE"
          ].join("\n")
        })
      ]);
    }

    if (turn === 4) {
      assert(
        transcript.includes("Command exited 0"),
        "H3 passing verification command was not visible"
      );
      assert(
        transcript.includes("sales total=60; count=3"),
        "H3 sales output changed or disappeared"
      );
      assert(
        transcript.includes("inventory total=20; count=3"),
        "H3 inventory output changed or disappeared"
      );
      assert(transcript.includes("refactor helper verified"), "H3 helper verification missing");
      return messageText(
        "Refactored duplicate parsing into src/parse.js and verified npm test preserves output."
      );
    }

    throw new Error(`H3 exceeded expected provider turns: ${turn}`);
  };
}

function createH4Router() {
  let turn = 0;
  return ({ transcript, toolNames }) => {
    if (!transcript.includes("Find why the config loader rejects a valid config and fix it")) {
      return messageText("OK");
    }
    turn += 1;

    if (turn === 1) {
      assert(toolNames.includes("Glob"), "H4 missing Glob");
      assert(toolNames.includes("Grep"), "H4 missing Grep");
      assert(toolNames.includes("FileRead"), "H4 missing FileRead");
      assert(toolNames.includes("FilePatch"), "H4 missing FilePatch");
      assert(toolNames.includes("Bash"), "H4 missing Bash");
      assert(
        transcript.includes("discover relevant files") &&
          transcript.includes("search for the validation error"),
        "H4 investigation constraints were not visible"
      );
      return toolResponse([
        toolCall("h4-glob-config-files", "Glob", { pattern: "src/**/*.js", max_matches: 20 }),
        toolCall("h4-grep-port-error", "Grep", {
          pattern: "server.port is required",
          path: ".",
          line_numbers: true
        }),
        toolCall("h4-read-loader", "FileRead", { file_path: "src/config/load.js" }),
        toolCall("h4-read-validator", "FileRead", { file_path: "src/config/validate.js" }),
        toolCall("h4-read-tests", "FileRead", { file_path: "tests/config.test.mjs" }),
        toolCall("h4-read-docs", "FileRead", { file_path: "docs/config.md" }),
        toolCall("h4-run-baseline-test", "Bash", { command: "npm test", timeout_ms: 10_000 })
      ]);
    }

    if (turn === 2) {
      assert(transcript.includes("src/config/load.js"), "H4 file discovery did not find loader");
      assert(
        transcript.includes("src/config/validate.js"),
        "H4 file discovery did not find validator"
      );
      assert(
        transcript.includes("server.port is required"),
        "H4 validation error search result was not visible"
      );
      assert(
        transcript.includes("client.retryLimit is required"),
        "H4 retryLimit check was not read"
      );
      assert(transcript.includes("server.port, 0"), "H4 failing zero-port test was not visible");
      assert(transcript.includes("retryLimit, 0"), "H4 failing zero-retry test was not visible");
      assert(transcript.includes("Command exited 1"), "H4 failing baseline test was not visible");
      return toolResponse([
        toolCall("h4-patch-validator", "FilePatch", {
          file_path: "src/config/validate.js",
          patch: [
            "@@",
            "-    if (!config.server.port) {",
            "+    if (config.server.port === undefined) {",
            '       errors.push("server.port is required");',
            "     }",
            "@@",
            "-    if (!config.client.retryLimit) {",
            "+    if (config.client.retryLimit === undefined) {",
            '       errors.push("client.retryLimit is required");',
            "     }"
          ].join("\n")
        })
      ]);
    }

    if (turn === 3) {
      assert(
        transcript.includes("Patched src/config/validate.js"),
        "H4 validator patch result was not visible"
      );
      return toolResponse([
        toolCall("h4-run-final-test", "Bash", {
          command: [
            "npm test",
            "node <<'NODE'",
            "const { readFileSync } = require('node:fs');",
            "const source = readFileSync('src/config/validate.js', 'utf8');",
            "if (!source.includes('config.server.port === undefined')) throw new Error('port check not fixed');",
            "if (!source.includes('config.client.retryLimit === undefined')) throw new Error('retry check not fixed');",
            "if (source.includes('!config.server.port') || source.includes('!config.client.retryLimit')) throw new Error('falsy check remains');",
            "console.log('config validation investigation fix verified');",
            "NODE"
          ].join("\n")
        })
      ]);
    }

    if (turn === 4) {
      assert(
        transcript.includes("Command exited 0"),
        "H4 passing verification command was not visible"
      );
      assert(
        transcript.includes("config loader tests passed"),
        "H4 passing config loader test output was missing"
      );
      assert(
        transcript.includes("config validation investigation fix verified"),
        "H4 source verification output was missing"
      );
      return messageText(
        "Fixed src/config/validate.js and verified npm test preserves valid zero config handling."
      );
    }

    throw new Error(`H4 exceeded expected provider turns: ${turn}`);
  };
}

function createH5Router() {
  let turn = 0;
  return ({ transcript, toolNames }) => {
    if (!transcript.includes("Update the project config. Do not touch files outside this repo")) {
      return messageText("OK");
    }
    turn += 1;

    if (turn === 1) {
      assert(toolNames.includes("FileRead"), "H5 missing FileRead");
      assert(toolNames.includes("FilePatch"), "H5 missing FilePatch");
      assert(toolNames.includes("FileWrite"), "H5 missing FileWrite");
      assert(toolNames.includes("Bash"), "H5 missing Bash");
      assert(
        transcript.includes(
          "Do not change package.json, tests, generated files, or files outside this repo"
        ),
        "H5 permission boundary constraints were not visible"
      );
      return toolResponse([
        toolCall("h5-read-config", "FileRead", { file_path: "src/project-config.js" }),
        toolCall("h5-read-tests", "FileRead", { file_path: "tests/config.test.mjs" }),
        toolCall("h5-run-baseline-test", "Bash", { command: "npm test", timeout_ms: 10_000 }),
        toolCall("h5-attempt-outside-write", "FileWrite", {
          file_path: "../outside-sentinel.txt",
          content: "outside write should be rejected\n"
        })
      ]);
    }

    if (turn === 2) {
      assert(
        transcript.includes('environment: "staging"'),
        "H5 original environment was not visible"
      );
      assert(transcript.includes("timeoutMs: 2000"), "H5 original timeout was not visible");
      assert(transcript.includes("Command exited 1"), "H5 failing baseline test was not visible");
      assert(
        transcript.includes("outside allowed directories"),
        "H5 outside write denial was not visible"
      );
      return toolResponse([
        toolCall("h5-patch-project-config", "FilePatch", {
          file_path: "src/project-config.js",
          patch: [
            "@@",
            '-  environment: "staging",',
            '+  environment: "production",',
            "   api: {",
            '     baseUrl: "https://api.example.test",',
            "-    timeoutMs: 2000",
            "+    timeoutMs: 5000",
            "   },"
          ].join("\n")
        })
      ]);
    }

    if (turn === 3) {
      assert(
        transcript.includes("Patched src/project-config.js"),
        "H5 project config patch result was not visible"
      );
      return toolResponse([
        toolCall("h5-run-final-test", "Bash", {
          command: [
            "npm test",
            "node <<'NODE'",
            "const { readFileSync } = require('node:fs');",
            "const source = readFileSync('src/project-config.js', 'utf8');",
            "if (!source.includes('environment: \"production\"')) throw new Error('environment not production');",
            "if (!source.includes('timeoutMs: 5000')) throw new Error('timeout not updated');",
            "if (source.includes('environment: \"staging\"') || source.includes('timeoutMs: 2000')) throw new Error('stale config remains');",
            "console.log('permission boundary config verified');",
            "NODE"
          ].join("\n")
        })
      ]);
    }

    if (turn === 4) {
      assert(
        transcript.includes("Command exited 0"),
        "H5 passing verification command was not visible"
      );
      assert(
        transcript.includes("project config tests passed"),
        "H5 passing project config test output was missing"
      );
      assert(
        transcript.includes("permission boundary config verified"),
        "H5 config verification output was missing"
      );
      return messageText(
        "Updated src/project-config.js and verified outside workspace writes were rejected."
      );
    }

    throw new Error(`H5 exceeded expected provider turns: ${turn}`);
  };
}

function createH6Router() {
  let turn = 0;
  return ({ transcript, toolNames }) => {
    if (
      !transcript.includes("Investigate the invoice summary bug") &&
      !transcript.includes("Continue the interrupted invoice summary task")
    ) {
      return messageText("OK");
    }
    turn += 1;

    if (turn === 1) {
      assert(toolNames.includes("FileRead"), "H6 first pass missing FileRead");
      assert(toolNames.includes("FileWrite"), "H6 first pass missing FileWrite");
      assert(toolNames.includes("Bash"), "H6 first pass missing Bash");
      assert(
        transcript.includes("Stop after the investigation report"),
        "H6 first-pass stop constraint was not visible"
      );
      return toolResponse([
        toolCall("h6-read-invoice-source", "FileRead", { file_path: "src/invoice.js" }),
        toolCall("h6-read-invoice-tests", "FileRead", { file_path: "tests/invoice.test.mjs" }),
        toolCall("h6-run-failing-test", "Bash", { command: "npm test", timeout_ms: 10_000 })
      ]);
    }

    if (turn === 2) {
      assert(
        transcript.includes("total + line.unitPrice"),
        "H6 first pass source evidence was not visible"
      );
      assert(transcript.includes("40"), "H6 expected invoice total was not visible");
      assert(transcript.includes("25"), "H6 failing invoice total was not visible");
      assert(transcript.includes("Command exited 1"), "H6 failing baseline test was not visible");
      return toolResponse([
        toolCall("h6-write-investigation", "FileWrite", {
          file_path: "reports/invoice-investigation.md",
          content: [
            "# Invoice Investigation",
            "",
            "- Failing case: expected 40 but received 25.",
            "- Root cause: quantity is ignored in invoiceTotal; only unitPrice is added.",
            "- Intended fix: add line.quantity * line.unitPrice for each line.",
            ""
          ].join("\n")
        })
      ]);
    }

    if (turn === 3) {
      assert(
        transcript.includes("Wrote reports/invoice-investigation.md"),
        "H6 investigation write result was not visible"
      );
      return messageText("Investigation report written; ready to resume for the source fix.");
    }

    if (turn === 4) {
      assert(toolNames.includes("FileRead"), "H6 resume missing FileRead");
      assert(toolNames.includes("FilePatch"), "H6 resume missing FilePatch");
      assert(toolNames.includes("Bash"), "H6 resume missing Bash");
      assert(
        transcript.includes("Investigation report written; ready to resume") ||
          transcript.includes("quantity is ignored in invoiceTotal"),
        "H6 resume context did not include prior investigation"
      );
      assert(
        transcript.includes("Continue the interrupted invoice summary task"),
        "H6 resume prompt was not visible"
      );
      return toolResponse([
        toolCall("h6-reread-investigation", "FileRead", {
          file_path: "reports/invoice-investigation.md"
        }),
        toolCall("h6-reread-invoice-source", "FileRead", { file_path: "src/invoice.js" })
      ]);
    }

    if (turn === 5) {
      assert(
        transcript.includes("quantity is ignored"),
        "H6 resume did not read investigation report"
      );
      assert(
        transcript.includes("total + line.unitPrice"),
        "H6 resume did not re-read invoice source"
      );
      return toolResponse([
        toolCall("h6-patch-invoice-total", "FilePatch", {
          file_path: "src/invoice.js",
          patch: [
            "@@",
            " function invoiceTotal(lines) {",
            "-  return lines.reduce((total, line) => total + line.unitPrice, 0);",
            "+  return lines.reduce((total, line) => total + line.quantity * line.unitPrice, 0);",
            " }"
          ].join("\n")
        })
      ]);
    }

    if (turn === 6) {
      assert(
        transcript.includes("Patched src/invoice.js"),
        "H6 invoice patch result was not visible"
      );
      return toolResponse([
        toolCall("h6-run-final-test", "Bash", { command: "npm test", timeout_ms: 10_000 })
      ]);
    }

    if (turn === 7) {
      assert(
        transcript.includes("Command exited 0"),
        "H6 passing verification command was not visible"
      );
      assert(
        transcript.includes("invoice tests passed"),
        "H6 passing invoice tests output was missing"
      );
      return messageText(
        "Resumed the invoice task, fixed src/invoice.js, and verified npm test passes."
      );
    }

    throw new Error(`H6 exceeded expected provider turns: ${turn}`);
  };
}

function createH7Router() {
  let turn = 0;
  return ({ transcript, toolNames }) => {
    if (!transcript.includes("Create a file and report the path")) {
      return messageText("OK");
    }
    turn += 1;

    if (turn === 1) {
      assert(toolNames.includes("FileWrite"), "H7 missing FileWrite");
      assert(
        transcript.includes("output/automation-result.txt"),
        "H7 output path constraint was not visible"
      );
      return toolResponse([
        toolCall("h7-write-automation-result", "FileWrite", {
          file_path: "output/automation-result.txt",
          content: "stream-json automation ok\n"
        })
      ]);
    }

    if (turn === 2) {
      assert(
        transcript.includes("Wrote output/automation-result.txt"),
        "H7 FileWrite result was not visible"
      );
      return messageText("Created output/automation-result.txt.");
    }

    throw new Error(`H7 exceeded expected provider turns: ${turn}`);
  };
}

function createH8Router() {
  let turn = 0;
  return ({ transcript, toolNames }) => {
    if (!transcript.includes("Exercise the multi-agent write-claim boundary")) {
      return messageText("OK");
    }
    turn += 1;

    if (turn === 1) {
      assert(toolNames.includes("FileRead"), "H8 missing FileRead");
      assert(toolNames.includes("FileWrite"), "H8 missing FileWrite");
      assert(toolNames.includes("Bash"), "H8 missing Bash");
      assert(
        transcript.includes("two workers can claim disjoint files"),
        "H8 disjoint write-claim requirement was not visible"
      );
      assert(
        transcript.includes("same-file conflict") && transcript.includes("rejected"),
        "H8 conflict rejection requirement was not visible"
      );
      return toolResponse([
        toolCall("h8-read-agent-notes", "FileRead", {
          file_path: "docs/agent-boundary.md"
        }),
        toolCall("h8-run-agent-queue-flow", "Bash", {
          timeout_ms: 20_000,
          command: [
            "node <<'NODE'",
            "const { spawnSync } = require('node:child_process');",
            "const cli = process.env.MAGI_CLI_UNDER_TEST;",
            "if (!cli) throw new Error('MAGI_CLI_UNDER_TEST missing');",
            "function run(args, expectCode = 0) {",
            "  const result = spawnSync(process.execPath, [cli, '--no-color', ...args], {",
            "    encoding: 'utf8',",
            "    env: process.env",
            "  });",
            "  if (result.status !== expectCode) {",
            "    throw new Error(`unexpected exit ${result.status} for ${args.join(' ')}\\nSTDOUT:\\n${result.stdout}\\nSTDERR:\\n${result.stderr}`);",
            "  }",
            "  return result;",
            "}",
            "const left = JSON.parse(run(['agents', 'spawn', 'worker', 'update left module', '--write-file', 'src/left.txt']).stdout);",
            "const right = JSON.parse(run(['agents', 'spawn', 'worker', 'update right module', '--write-file', 'src/right.txt']).stdout);",
            "run(['agents', 'start', left.id]);",
            "run(['agents', 'start', right.id]);",
            "run(['agents', 'complete', left.id, 'left done']);",
            "run(['agents', 'complete', right.id, 'right done']);",
            "const conflict = spawnSync(process.execPath, [cli, '--no-color', 'agents', 'spawn', 'worker', 'duplicate left module', '--write-file', 'src/left.txt'], {",
            "  encoding: 'utf8',",
            "  env: process.env",
            "});",
            "if (conflict.status === 0) {",
            "  throw new Error('conflicting worker claim unexpectedly succeeded');",
            "}",
            "if (!conflict.stderr.includes('Write conflict for src/left.txt')) {",
            "  throw new Error(`missing write conflict: ${conflict.stderr}`);",
            "}",
            "const list = run(['agents', 'list']).stdout;",
            "if (!list.includes(left.id) || !list.includes(right.id) || !list.includes('completed')) {",
            "  throw new Error(`agent list missing completed workers: ${list}`);",
            "}",
            "console.log(JSON.stringify({",
            "  left: left.id,",
            "  right: right.id,",
            "  conflict: conflict.stderr.trim().split('\\n').at(-1)",
            "}));",
            "NODE"
          ].join("\n")
        })
      ]);
    }

    if (turn === 2) {
      assert(transcript.includes("Parallel worker claims"), "H8 notes were not read");
      assert(transcript.includes("Command exited 0"), "H8 agent queue command did not pass");
      assert(transcript.includes("Write conflict for src/left.txt"), "H8 conflict was not visible");
      assert(transcript.includes('"left"'), "H8 left worker id was not visible");
      assert(transcript.includes('"right"'), "H8 right worker id was not visible");
      return toolResponse([
        toolCall("h8-write-report", "FileWrite", {
          file_path: "reports/agent-conflict-report.md",
          content: [
            "# Agent Conflict Report",
            "",
            "- Disjoint worker write claims succeeded for `src/left.txt` and `src/right.txt`.",
            "- Both disjoint worker tasks reached `completed` status.",
            "- A second worker claim for `src/left.txt` was rejected with `Write conflict for src/left.txt`.",
            "- The conflict was persisted in the shared SQLite write claim boundary by preserving the original claim only.",
            ""
          ].join("\n")
        })
      ]);
    }

    if (turn === 3) {
      assert(
        transcript.includes("Wrote reports/agent-conflict-report.md"),
        "H8 report write result was not visible"
      );
      return messageText(
        "Verified multi-agent write claims and wrote reports/agent-conflict-report.md."
      );
    }

    throw new Error(`H8 exceeded expected provider turns: ${turn}`);
  };
}

function createH9Router() {
  let outerTurn = 0;
  let controlTurn = 0;
  return ({ transcript, toolNames }) => {
    if (transcript.includes("Run the Bash approval control probe")) {
      controlTurn += 1;

      if (controlTurn === 1) {
        assert(toolNames.includes("Bash"), "H9 control job missing Bash");
        return toolResponse([
          toolCall("h9-readonly-pwd", "Bash", {
            command: "pwd"
          })
        ]);
      }

      if (controlTurn === 2) {
        assert(transcript.includes("Command exited 0"), "H9 read-only Bash did not execute");
        return toolResponse([
          toolCall("h9-run-approved-bash", "Bash", {
            command: "npm test",
            timeout_ms: 7000
          })
        ]);
      }

      if (controlTurn === 3) {
        assert(transcript.includes("bash approval test ok"), "H9 approved Bash output missing");
        assert(transcript.includes("Command exited 0"), "H9 approved Bash did not complete");
        return messageText("CONTROL BASH APPROVAL DONE");
      }

      throw new Error(`H9 control job exceeded expected provider turns: ${controlTurn}`);
    }

    if (!transcript.includes("Validate the Bash approval boundary")) {
      return messageText("OK");
    }
    outerTurn += 1;

    if (outerTurn === 1) {
      assert(toolNames.includes("FileRead"), "H9 missing FileRead");
      assert(toolNames.includes("FileWrite"), "H9 missing FileWrite");
      assert(toolNames.includes("Bash"), "H9 missing Bash");
      assert(transcript.includes("Control API"), "H9 Control API requirement was not visible");
      assert(
        transcript.includes("command, cwd, and timeout"),
        "H9 approval detail requirement was not visible"
      );
      return toolResponse([
        toolCall("h9-read-policy", "FileRead", {
          file_path: "docs/bash-approval-policy.md"
        }),
        toolCall("h9-run-control-approval-flow", "Bash", {
          timeout_ms: 45_000,
          command: [
            "node <<'NODE'",
            "const { spawn } = require('node:child_process');",
            "const cli = process.env.MAGI_CLI_UNDER_TEST;",
            "if (!cli) throw new Error('MAGI_CLI_UNDER_TEST missing');",
            "const port = 18000 + Math.floor(Math.random() * 20000);",
            "const base = `http://127.0.0.1:${port}`;",
            "const serve = spawn(process.execPath, [cli, '--no-color', 'serve'], {",
            "  env: {",
            "    ...process.env,",
            "    MAGI_CONTROL_PORT: String(port),",
            "    MAGI_INTERACTION_TIMEOUT_MS: '20000',",
            "    NO_COLOR: '1'",
            "  },",
            "  stdio: ['ignore', 'pipe', 'pipe']",
            "});",
            "let stdout = '';",
            "let stderr = '';",
            "serve.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });",
            "serve.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });",
            "function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }",
            "async function waitFor(check, label, timeoutMs = 15000) {",
            "  const deadline = Date.now() + timeoutMs;",
            "  let lastError;",
            "  while (Date.now() < deadline) {",
            "    try {",
            "      if (await check()) return;",
            "    } catch (error) {",
            "      lastError = error;",
            "    }",
            "    await sleep(100);",
            "  }",
            "  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}\\nSTDOUT:\\n${stdout}\\nSTDERR:\\n${stderr}`);",
            "}",
            "async function request(method, path, body, headers = {}, expectStatus = 200) {",
            "  const response = await fetch(`${base}${path}`, {",
            "    method,",
            "    headers: { 'content-type': 'application/json', ...headers },",
            "    body: body === undefined ? undefined : JSON.stringify(body)",
            "  });",
            "  const text = await response.text();",
            "  let parsed;",
            "  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { text }; }",
            "  if (response.status !== expectStatus) {",
            "    throw new Error(`${method} ${path} returned ${response.status}: ${text}`);",
            "  }",
            "  return parsed;",
            "}",
            "function authHeaders(pairing) {",
            "  return {",
            "    'x-magi-device-id': pairing.deviceId,",
            "    authorization: `Bearer ${pairing.token}`",
            "  };",
            "}",
            "async function main() {",
            "try {",
            "  await waitFor(() => stdout.includes('Magi Control API listening on'), 'control server start');",
            "  const health = await request('GET', '/health');",
            "  if (health.ok !== true) throw new Error('control health check failed');",
            "  const pairing = await request('POST', '/pairing', { name: 'bash-approval-harness' });",
            "  if (!pairing.deviceId || !pairing.token) throw new Error('pairing did not return credentials');",
            "  const headers = authHeaders(pairing);",
            "  const started = await request('POST', '/jobs', {",
            "    prompt: 'Run the Bash approval control probe.',",
            "    model: 'main',",
            "    background: true,",
            "    permissionMode: 'default'",
            "  }, headers, 202);",
            "  if (!started.jobId || !started.sessionId) throw new Error('background job did not start');",
            "  let pending;",
            "  await waitFor(async () => {",
            "    const response = await request('GET', `/jobs/${encodeURIComponent(started.jobId)}/interactions`, undefined, headers);",
            "    pending = (response.interactions ?? []).find((item) =>",
            "      item.kind === 'approval' &&",
            "      item.status === 'pending' &&",
            "      item.toolName === 'Bash' &&",
            "      item.toolUseId === 'h9-run-approved-bash'",
            "    );",
            "    return Boolean(pending);",
            "  }, 'pending Bash approval');",
            "  if (pending.toolUse.input.command !== 'npm test') throw new Error('pending approval command mismatch');",
            "  if (pending.toolUse.input.timeout_ms !== 7000) throw new Error('pending approval timeout mismatch');",
            "  const pendingEvents = await request('GET', `/jobs/${encodeURIComponent(started.jobId)}/events?limit=50`, undefined, headers);",
            "  const pendingAudit = (pendingEvents.events ?? []).find((event) => event.action === 'agent.approval.pending' && event.target === 'Bash');",
            "  if (!pendingAudit) throw new Error('approval pending audit missing');",
            "  if (pendingAudit.metadata.cwd !== process.cwd()) throw new Error(`pending audit cwd mismatch: ${pendingAudit.metadata.cwd}`);",
            "  if (pendingAudit.metadata.toolUse.input.command !== 'npm test') throw new Error('pending audit command mismatch');",
            "  if (pendingAudit.metadata.toolUse.input.timeout_ms !== 7000) throw new Error('pending audit timeout mismatch');",
            "  const resolved = await request('POST', `/jobs/${encodeURIComponent(started.jobId)}/approvals/h9-run-approved-bash`, {",
            "    decision: 'approve',",
            "    responder: 'bash-approval-harness'",
            "  }, headers);",
            "  if (resolved.ok !== true || resolved.interaction.approved !== true) throw new Error('approval resolution failed');",
            "  await waitFor(async () => {",
            "    const response = await request('GET', `/jobs/${encodeURIComponent(started.jobId)}`, undefined, headers);",
            "    return response.job?.status === 'completed';",
            "  }, 'control job completion', 15000);",
            "  const job = await request('GET', `/jobs/${encodeURIComponent(started.jobId)}`, undefined, headers);",
            "  const events = await request('GET', `/jobs/${encodeURIComponent(started.jobId)}/events?limit=80`, undefined, headers);",
            "  const actions = (events.events ?? []).map((event) => event.action);",
            "  if (!actions.includes('agent.approval.pending')) throw new Error('job events missed approval pending');",
            "  if (!actions.includes('control.approval.resolved')) throw new Error('job events missed control approval resolve');",
            "  const bashCompleted = (events.events ?? []).filter((event) => event.action === 'agent.tool.completed' && event.target === 'Bash');",
            "  if (bashCompleted.length < 2) throw new Error(`expected two completed Bash tools, saw ${bashCompleted.length}`);",
            "  if (job.job?.status !== 'completed') throw new Error('control job did not complete');",
            "  console.log(JSON.stringify({",
            "    readOnly: 'pwd completed without approval',",
            "    approval: {",
            "      toolUseId: pending.toolUseId,",
            "      command: pending.toolUse.input.command,",
            "      cwd: pendingAudit.metadata.cwd,",
            "      timeout_ms: pending.toolUse.input.timeout_ms",
            "    },",
            "    approved: resolved.interaction.approved,",
            "    bashCompleted: bashCompleted.length,",
            "    message: 'CONTROL BASH APPROVAL DONE'",
            "  }));",
            "} finally {",
            "  serve.kill('SIGTERM');",
            "  await sleep(300);",
            "  if (serve.exitCode === null && serve.signalCode === null) serve.kill('SIGKILL');",
            "}",
            "}",
            "main().catch((error) => {",
            "  console.error(error && error.stack ? error.stack : String(error));",
            "  serve.kill('SIGTERM');",
            "  setTimeout(() => serve.kill('SIGKILL'), 300).unref?.();",
            "  process.exit(1);",
            "});",
            "NODE"
          ].join("\n")
        })
      ]);
    }

    if (outerTurn === 2) {
      assert(transcript.includes("Bash Approval Policy"), "H9 policy document was not read");
      assert(transcript.includes("pwd completed without approval"), "H9 read-only Bash proof missing");
      assert(transcript.includes('"command":"npm test"'), "H9 approval command proof missing");
      assert(transcript.includes('"timeout_ms":7000'), "H9 approval timeout proof missing");
      assert(transcript.includes("CONTROL BASH APPROVAL DONE"), "H9 control job final missing");
      return toolResponse([
        toolCall("h9-write-report", "FileWrite", {
          file_path: "reports/bash-approval-report.md",
          content: [
            "# Bash Approval Report",
            "",
            "- Read-only Bash `pwd` ran in default permission mode without approval.",
            "- Non-read-only Bash `npm test` entered an active Control API approval.",
            "- The pending approval exposed command `npm test`, the repo cwd, and `timeout_ms: 7000`.",
            "- Control API approval resolved the pending Bash interaction and the approved test completed.",
            "- The approval and Bash completion events were persisted in the session audit database.",
            ""
          ].join("\n")
        })
      ]);
    }

    if (outerTurn === 3) {
      assert(
        transcript.includes("Wrote reports/bash-approval-report.md"),
        "H9 report write result was not visible"
      );
      return messageText(
        "Verified Bash approval boundary and wrote reports/bash-approval-report.md."
      );
    }

    throw new Error(`H9 exceeded expected provider turns: ${outerTurn}`);
  };
}

function createH10Router() {
  let primaryCalls = 0;
  let backupTurn = 0;
  return ({ body, transcript, toolNames }) => {
    if (!transcript.includes("Verify provider retry and fallback")) {
      return messageText("OK", body.model ?? "mock-main");
    }

    if (body.model === "mock-main") {
      primaryCalls += 1;
      if (primaryCalls <= 3) {
        return fail(500, "primary transient provider failure");
      }
      return fail(500, "primary should have fallen back before another attempt");
    }

    if (body.model === "mock-backup") {
      backupTurn += 1;
      if (backupTurn === 1) {
        assert(primaryCalls === 3, `H10 expected 3 primary retry attempts, saw ${primaryCalls}`);
        assert(toolNames.includes("FileRead"), "H10 backup route missing FileRead");
        assert(toolNames.includes("FileWrite"), "H10 backup route missing FileWrite");
        return toolResponse(
          [
            toolCall("h10-read-policy", "FileRead", {
              file_path: "docs/provider-retry.md"
            }),
            toolCall("h10-write-report", "FileWrite", {
              file_path: "reports/provider-retry-report.md",
              content: [
                "# Provider Retry Report",
                "",
                "- Primary provider produced three retryable server failures.",
                "- Retry diagnostics used provider.retry events instead of session.error.",
                "- Fallback switched to backup/mock-backup and recovered the task.",
                "- TUI live output suppresses provider retry diagnostics by default.",
                ""
              ].join("\n")
            })
          ],
          "mock-backup"
        );
      }

      if (backupTurn === 2) {
        assert(transcript.includes("Provider Retry Policy"), "H10 policy document was not read");
        assert(
          transcript.includes("Wrote reports/provider-retry-report.md"),
          "H10 report write result was not visible"
        );
        return messageText(
          "Verified provider retry fallback and wrote reports/provider-retry-report.md.",
          "mock-backup"
        );
      }

      throw new Error(`H10 backup exceeded expected provider turns: ${backupTurn}`);
    }

    return fail(400, `unexpected H10 model ${body.model}`);
  };
}

function taskDefinitionFor(taskId) {
  if (taskId === "H1") {
    return {
      createRouter: createH1Router,
      finalMessage: "Fixed src/discount.ts and verified npm test passes.",
      assertions: [
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
      ],
      filesVerified: [
        "src/discount.ts",
        "tests/discount.test.mjs",
        "checks.sh",
        "state/sessions.sqlite"
      ],
      validate: ({ toolCounts, session }) => {
        assert((toolCounts.FileRead ?? 0) >= 2, "H1 did not read enough evidence");
        assert((toolCounts.FilePatch ?? 0) >= 2, "H1 should recover with FilePatch retry");
        assert((toolCounts.Bash ?? 0) === 2, "H1 should run failing and passing tests");
        assert((toolCounts.FileWrite ?? 0) === 0, "H1 should not use FileWrite");
        assert((toolCounts.FileEdit ?? 0) === 0, "H1 should not use FileEdit");
        assert(session.auditEventCount > 0, "H1 audit events were not persisted");
        assert(session.messageCount >= 2, "H1 session messages were not persisted");
      }
    };
  }

  if (taskId === "H2") {
    return {
      createRouter: createH2Router,
      finalMessage: "Added --dry-run support and verified npm test plus dry-run no-write behavior.",
      assertions: [
        "H2 fixture copied into isolated workspace",
        "H2 provider saw dry-run constraints",
        "H2 baseline npm test reproduced",
        "H2 CLI, store, tests, and README read before patch",
        "H2 multi-file feature patched with FilePatch",
        "H2 npm test passed after patch",
        "H2 dry-run command reported preview",
        "H2 dry-run left data file unchanged",
        "H2 checks.sh passed",
        "H2 changed exactly expected files",
        "H2 forbidden paths unchanged",
        "H2 session and audit persisted"
      ],
      filesVerified: [
        "src/cli.js",
        "src/store.js",
        "tests/cli.test.mjs",
        "README.md",
        "checks.sh",
        "state/sessions.sqlite"
      ],
      validate: ({ after, toolCounts, session }) => {
        assert((toolCounts.FileRead ?? 0) >= 4, "H2 did not read enough project evidence");
        assert((toolCounts.FilePatch ?? 0) >= 4, "H2 should patch all feature files");
        assert((toolCounts.Bash ?? 0) === 2, "H2 should run baseline and final verification");
        assert((toolCounts.FileWrite ?? 0) === 0, "H2 should not use FileWrite");
        assert((toolCounts.FileEdit ?? 0) === 0, "H2 should not use FileEdit");
        assert(after["src/cli.js"]?.text.includes("--dry-run"), "H2 CLI missing --dry-run");
        assert(after["src/store.js"]?.text.includes("options.dryRun"), "H2 store missing dryRun");
        assert(
          after["tests/cli.test.mjs"]?.text.includes("dry-run does not write notes"),
          "H2 tests missing dry-run no-write assertion"
        );
        assert(after["README.md"]?.text.includes("--dry-run"), "H2 README missing dry-run docs");
        assert(session.auditEventCount > 0, "H2 audit events were not persisted");
        assert(session.messageCount >= 2, "H2 session messages were not persisted");
      }
    };
  }

  if (taskId === "H3") {
    return {
      createRouter: createH3Router,
      finalMessage:
        "Refactored duplicate parsing into src/parse.js and verified npm test preserves output.",
      assertions: [
        "H3 fixture copied into isolated workspace",
        "H3 provider saw behavior preservation constraints",
        "H3 baseline npm test captured public output",
        "H3 duplicate parsing source read before patch",
        "H3 shared parse helper created with FileWrite",
        "H3 sales and inventory modules delegated to helper",
        "H3 npm test passed after refactor",
        "H3 public output preserved after refactor",
        "H3 duplicate parsing removed from source modules",
        "H3 checks.sh passed",
        "H3 changed exactly expected files",
        "H3 forbidden paths unchanged",
        "H3 session and audit persisted"
      ],
      filesVerified: [
        "src/parse.js",
        "src/sales.js",
        "src/inventory.js",
        "tests/report.test.mjs",
        "checks.sh",
        "state/sessions.sqlite"
      ],
      validate: ({ after, toolCounts, session }) => {
        assert((toolCounts.FileRead ?? 0) >= 3, "H3 did not read enough project evidence");
        assert((toolCounts.FilePatch ?? 0) >= 2, "H3 should patch existing source files");
        assert((toolCounts.Bash ?? 0) === 2, "H3 should run baseline and final verification");
        assert((toolCounts.FileWrite ?? 0) === 1, "H3 should use FileWrite only for new helper");
        assert((toolCounts.FileEdit ?? 0) === 0, "H3 should not use FileEdit");
        assert(after["src/parse.js"]?.text.includes("parseCsvNumbers"), "H3 parse helper missing");
        assert(
          after["src/sales.js"]?.text.includes('require("./parse")'),
          "H3 sales missing shared helper import"
        );
        assert(
          after["src/inventory.js"]?.text.includes('require("./parse")'),
          "H3 inventory missing shared helper import"
        );
        assert(
          !after["src/sales.js"]?.text.includes('split(",")'),
          "H3 sales duplicate parsing remains"
        );
        assert(
          !after["src/inventory.js"]?.text.includes('split(",")'),
          "H3 inventory duplicate parsing remains"
        );
        assert(session.auditEventCount > 0, "H3 audit events were not persisted");
        assert(session.messageCount >= 2, "H3 session messages were not persisted");
      }
    };
  }

  if (taskId === "H4") {
    return {
      createRouter: createH4Router,
      finalMessage:
        "Fixed src/config/validate.js and verified npm test preserves valid zero config handling.",
      assertions: [
        "H4 fixture copied into isolated workspace",
        "H4 provider saw investigation constraints",
        "H4 relevant files discovered with Glob",
        "H4 validation error found with Grep",
        "H4 loader, validator, tests, and docs read before edit",
        "H4 baseline npm test reproduced zero-value config failure",
        "H4 validator fixed with a narrow FilePatch",
        "H4 npm test passed after fix",
        "H4 valid port 0 and retryLimit 0 preserved",
        "H4 invalid range checks preserved",
        "H4 changed exactly expected file",
        "H4 forbidden paths unchanged",
        "H4 checks.sh passed",
        "H4 session and audit persisted"
      ],
      filesVerified: [
        "src/config/validate.js",
        "src/config/load.js",
        "tests/config.test.mjs",
        "docs/config.md",
        "checks.sh",
        "state/sessions.sqlite"
      ],
      validate: ({ after, toolCounts, session }) => {
        assert((toolCounts.Glob ?? 0) >= 1, "H4 should discover files with Glob");
        assert((toolCounts.Grep ?? 0) >= 1, "H4 should search for the validation error with Grep");
        assert((toolCounts.FileRead ?? 0) >= 4, "H4 did not read enough investigation evidence");
        assert((toolCounts.FilePatch ?? 0) === 1, "H4 should patch only the validator");
        assert((toolCounts.Bash ?? 0) === 2, "H4 should run baseline and final verification");
        assert((toolCounts.FileWrite ?? 0) === 0, "H4 should not use FileWrite");
        assert((toolCounts.FileEdit ?? 0) === 0, "H4 should not use FileEdit");
        const validator = after["src/config/validate.js"]?.text ?? "";
        assert(
          validator.includes("config.server.port === undefined"),
          "H4 server.port undefined check missing"
        );
        assert(
          validator.includes("config.client.retryLimit === undefined"),
          "H4 retryLimit undefined check missing"
        );
        assert(!validator.includes("!config.server.port"), "H4 falsy port check remains");
        assert(
          !validator.includes("!config.client.retryLimit"),
          "H4 falsy retryLimit check remains"
        );
        assert(session.auditEventCount > 0, "H4 audit events were not persisted");
        assert(session.messageCount >= 2, "H4 session messages were not persisted");
      }
    };
  }

  if (taskId === "H5") {
    return {
      createRouter: createH5Router,
      finalMessage:
        "Updated src/project-config.js and verified outside workspace writes were rejected.",
      assertions: [
        "H5 fixture copied into isolated workspace",
        "H5 provider saw permission boundary constraints",
        "H5 baseline npm test reproduced config failure",
        "H5 outside workspace write attempted by FileWrite",
        "H5 outside workspace write was rejected",
        "H5 outside sentinel remained unchanged",
        "H5 rejection reason was persisted in audit metadata",
        "H5 project config patched with FilePatch",
        "H5 npm test passed after config update",
        "H5 final config values verified",
        "H5 changed exactly expected file",
        "H5 forbidden paths unchanged",
        "H5 checks.sh passed",
        "H5 session and audit persisted"
      ],
      filesVerified: [
        "src/project-config.js",
        "tests/config.test.mjs",
        "../outside-sentinel.txt",
        "checks.sh",
        "state/sessions.sqlite"
      ],
      validate: ({ after, toolCounts, session }) => {
        assert((toolCounts.FileRead ?? 0) >= 2, "H5 did not read enough project evidence");
        assert((toolCounts.FileWrite ?? 0) === 1, "H5 should attempt one outside FileWrite");
        assert((toolCounts.FilePatch ?? 0) === 1, "H5 should patch only the project config");
        assert((toolCounts.Bash ?? 0) === 2, "H5 should run baseline and final verification");
        assert((toolCounts.FileEdit ?? 0) === 0, "H5 should not use FileEdit");
        const config = after["src/project-config.js"]?.text ?? "";
        assert(config.includes('environment: "production"'), "H5 production environment missing");
        assert(config.includes("timeoutMs: 5000"), "H5 timeout update missing");
        assert(!config.includes('environment: "staging"'), "H5 stale staging environment remains");
        assert(!config.includes("timeoutMs: 2000"), "H5 stale timeout remains");
        assert(
          session.failedToolReasons.some(
            (failure) =>
              failure.target === "FileWrite" &&
              failure.reason.includes("outside allowed directories")
          ),
          "H5 outside write failure reason was not audited"
        );
        assert(session.auditEventCount > 0, "H5 audit events were not persisted");
        assert(session.messageCount >= 2, "H5 session messages were not persisted");
      }
    };
  }

  if (taskId === "H6") {
    return {
      createRouter: createH6Router,
      finalMessage: "Resumed the invoice task, fixed src/invoice.js, and verified npm test passes.",
      firstPassFinalMessage: "Investigation report written; ready to resume for the source fix.",
      assertions: [
        "H6 fixture copied into isolated workspace",
        "H6 first pass read source and tests",
        "H6 first pass reproduced failing test",
        "H6 first pass wrote investigation report",
        "H6 first pass stopped before source patch",
        "H6 resume used -c latest cwd session",
        "H6 resume reused the same session id",
        "H6 resume context preserved prior investigation",
        "H6 resume read investigation report",
        "H6 resume patched invoice source",
        "H6 npm test passed after resume",
        "H6 changed exactly expected files",
        "H6 forbidden paths unchanged",
        "H6 checks.sh passed",
        "H6 session and audit persisted"
      ],
      filesVerified: [
        "reports/invoice-investigation.md",
        "src/invoice.js",
        "tests/invoice.test.mjs",
        "checks.sh",
        "state/sessions.sqlite"
      ],
      validate: ({ after, toolCounts, session, resume }) => {
        assert((toolCounts.FileRead ?? 0) >= 4, "H6 did not read enough resume evidence");
        assert((toolCounts.FileWrite ?? 0) === 1, "H6 should write one investigation report");
        assert((toolCounts.FilePatch ?? 0) === 1, "H6 should patch invoice source once");
        assert((toolCounts.Bash ?? 0) === 2, "H6 should run baseline and final verification");
        assert((toolCounts.FileEdit ?? 0) === 0, "H6 should not use FileEdit");
        const report = after["reports/invoice-investigation.md"]?.text ?? "";
        const source = after["src/invoice.js"]?.text ?? "";
        assert(
          report.includes("quantity is ignored"),
          "H6 investigation report missing root cause"
        );
        assert(
          report.includes("expected 40 but received 25"),
          "H6 investigation report missing failure"
        );
        assert(
          source.includes("line.quantity * line.unitPrice"),
          "H6 invoice source was not fixed"
        );
        assert(!source.includes("total + line.unitPrice;"), "H6 stale invoice bug remains");
        assert(resume?.sameSession === true, "H6 resume did not reuse the same session");
        assert(session.auditEventCount > 0, "H6 audit events were not persisted");
        assert(session.messageCount >= 4, "H6 session messages did not include both passes");
      }
    };
  }

  if (taskId === "H7") {
    return {
      createRouter: createH7Router,
      finalMessage: "Created output/automation-result.txt.",
      assertions: [
        "H7 fixture copied into isolated workspace",
        "H7 provider saw output path constraint",
        "H7 stdout emitted only valid NDJSON lines",
        "H7 stream-json started with session.started",
        "H7 stream-json emitted user message event",
        "H7 stream-json emitted FileWrite tool.started",
        "H7 stream-json emitted FileWrite tool.completed",
        "H7 stream-json preserved raw agent tool_use event",
        "H7 stream-json preserved raw agent tool_result event",
        "H7 stream-json ended with session.completed",
        "H7 session.completed carried final message",
        "H7 output file exists with expected content",
        "H7 changed exactly expected file",
        "H7 forbidden paths unchanged",
        "H7 checks.sh passed",
        "H7 session and audit persisted"
      ],
      filesVerified: [
        "output/automation-result.txt",
        "stdout.jsonl",
        "stderr.txt",
        "checks.sh",
        "state/sessions.sqlite"
      ],
      validate: ({ after, toolCounts, session, stream }) => {
        assert((toolCounts.FileWrite ?? 0) === 1, "H7 should use one FileWrite");
        assert((toolCounts.FileRead ?? 0) === 0, "H7 should not need FileRead");
        assert((toolCounts.FilePatch ?? 0) === 0, "H7 should not use FilePatch");
        assert((toolCounts.Bash ?? 0) === 0, "H7 should not run shell commands");
        assert((toolCounts.FileEdit ?? 0) === 0, "H7 should not use FileEdit");
        assert(
          after["output/automation-result.txt"]?.text === "stream-json automation ok\n",
          "H7 output file content mismatch"
        );
        assert(stream?.validNdjson === true, "H7 stream output was not valid NDJSON");
        assert(stream?.stderrEmpty === true, "H7 stderr was not empty");
        assert(stream?.startedFirst === true, "H7 stream did not start with session.started");
        assert(stream?.completedLast === true, "H7 stream did not end with session.completed");
        assert(stream?.userMessageSeen === true, "H7 stream missed user message event");
        assert(stream?.toolStartedSeen === true, "H7 stream missed tool.started");
        assert(stream?.toolCompletedSeen === true, "H7 stream missed tool.completed");
        assert(stream?.rawToolUseSeen === true, "H7 stream missed raw agent tool_use event");
        assert(stream?.rawToolResultSeen === true, "H7 stream missed raw agent tool_result event");
        assert(
          stream?.completedMessage === "Created output/automation-result.txt.",
          "H7 final message missing"
        );
        assert(session.auditEventCount > 0, "H7 audit events were not persisted");
        assert(session.messageCount >= 2, "H7 session messages were not persisted");
      }
    };
  }

  if (taskId === "H8") {
    return {
      createRouter: createH8Router,
      finalMessage: "Verified multi-agent write claims and wrote reports/agent-conflict-report.md.",
      assertions: [
        "H8 fixture copied into isolated workspace",
        "H8 provider saw disjoint write-claim requirement",
        "H8 provider saw same-file conflict requirement",
        "H8 agent notes read before command execution",
        "H8 agents CLI spawned disjoint worker claims",
        "H8 agents CLI started disjoint workers",
        "H8 agents CLI completed disjoint workers",
        "H8 same-file worker claim was rejected",
        "H8 CLI list showed completed workers",
        "H8 conflict report written",
        "H8 changed exactly expected report",
        "H8 forbidden paths unchanged",
        "H8 SQLite agent tasks persisted",
        "H8 SQLite write claims persisted",
        "H8 only disjoint write claims remained",
        "H8 session and audit persisted"
      ],
      filesVerified: [
        "docs/agent-boundary.md",
        "reports/agent-conflict-report.md",
        "stdout.jsonl",
        "stderr.txt",
        "state/sessions.sqlite"
      ],
      validate: ({ after, toolCounts, session, agentQueue }) => {
        assert((toolCounts.FileRead ?? 0) === 1, "H8 should read agent notes once");
        assert((toolCounts.Bash ?? 0) === 1, "H8 should use one Bash CLI flow");
        assert((toolCounts.FileWrite ?? 0) === 1, "H8 should write one report");
        assert((toolCounts.FilePatch ?? 0) === 0, "H8 should not patch source");
        assert((toolCounts.FileEdit ?? 0) === 0, "H8 should not use FileEdit");
        const report = after["reports/agent-conflict-report.md"]?.text ?? "";
        assert(
          report.includes("Disjoint worker write claims succeeded"),
          "H8 report missed disjoint success"
        );
        assert(
          report.includes("Both disjoint worker tasks reached `completed` status"),
          "H8 report missed completion status"
        );
        assert(
          report.includes("Write conflict for src/left.txt"),
          "H8 report missed conflict evidence"
        );
        assert(session.auditEventCount > 0, "H8 audit events were not persisted");
        assert(session.messageCount >= 2, "H8 session messages were not persisted");
        assert(
          agentQueue.taskCount === 2,
          `H8 expected 2 persisted agent tasks, saw ${agentQueue.taskCount}`
        );
        assert(
          agentQueue.completedTaskCount === 2,
          `H8 expected 2 completed agent tasks, saw ${agentQueue.completedTaskCount}`
        );
        assert(
          JSON.stringify(agentQueue.writeClaimFiles) ===
            JSON.stringify(["src/left.txt", "src/right.txt"]),
          `H8 write claims mismatch: ${JSON.stringify(agentQueue.writeClaimFiles)}`
        );
        assert(agentQueue.conflictRejected === true, "H8 conflict rejection evidence missing");
      }
    };
  }

  if (taskId === "H9") {
    return {
      createRouter: createH9Router,
      finalMessage: "Verified Bash approval boundary and wrote reports/bash-approval-report.md.",
      assertions: [
        "H9 fixture copied into isolated workspace",
        "H9 provider saw Control API approval requirement",
        "H9 provider saw command, cwd, and timeout requirement",
        "H9 Bash approval policy read before execution",
        "H9 Control API started from dist CLI",
        "H9 phone-style pairing returned credentials",
        "H9 read-only Bash ran without approval",
        "H9 non-read-only Bash produced pending approval",
        "H9 pending approval exposed command",
        "H9 pending approval exposed cwd",
        "H9 pending approval exposed timeout",
        "H9 Control API resolved approval",
        "H9 approved Bash command completed",
        "H9 approval events persisted",
        "H9 approval report written",
        "H9 changed exactly expected report",
        "H9 session and audit persisted"
      ],
      filesVerified: [
        "docs/bash-approval-policy.md",
        "package.json",
        "tests/bash-approval.test.mjs",
        "reports/bash-approval-report.md",
        "stdout.jsonl",
        "state/sessions.sqlite"
      ],
      validate: ({ after, toolCounts, session, approval }) => {
        assert((toolCounts.FileRead ?? 0) === 1, "H9 should read policy once");
        assert((toolCounts.Bash ?? 0) === 1, "H9 should use one Bash Control API flow");
        assert((toolCounts.FileWrite ?? 0) === 1, "H9 should write one report");
        assert((toolCounts.FilePatch ?? 0) === 0, "H9 should not patch files");
        assert((toolCounts.FileEdit ?? 0) === 0, "H9 should not use FileEdit");
        const report = after["reports/bash-approval-report.md"]?.text ?? "";
        assert(
          report.includes("Read-only Bash `pwd` ran"),
          "H9 report missed read-only Bash evidence"
        );
        assert(
          report.includes("Non-read-only Bash `npm test` entered an active Control API approval"),
          "H9 report missed approval evidence"
        );
        assert(
          report.includes("timeout_ms: 7000"),
          "H9 report missed timeout evidence"
        );
        assert(session.auditEventCount > 0, "H9 outer session audit events were not persisted");
        assert(session.messageCount >= 2, "H9 outer session messages were not persisted");
        assert(approval.pendingCount === 1, `H9 expected one pending approval, saw ${approval.pendingCount}`);
        assert(
          approval.resolvedCount >= 1,
          `H9 expected resolved approval audit, saw ${approval.resolvedCount}`
        );
        assert(
          approval.controlResolvedCount === 1,
          `H9 expected one control approval resolution, saw ${approval.controlResolvedCount}`
        );
        assert(
          approval.completedBashToolCount >= 2,
          `H9 expected two completed Bash tools, saw ${approval.completedBashToolCount}`
        );
        assert(approval.pendingCommand === "npm test", "H9 pending command mismatch");
        assert(approval.pendingTimeoutMs === 7000, "H9 pending timeout mismatch");
        assert(typeof approval.pendingCwd === "string" && approval.pendingCwd.length > 0, "H9 pending cwd missing");
        assert(approval.approved === true, "H9 approval was not approved");
        assert(approval.readOnlyBashCompleted === true, "H9 read-only Bash completion missing");
        assert(approval.approvedBashCompleted === true, "H9 approved Bash completion missing");
      }
    };
  }

  if (taskId === "H10") {
    return {
      createRouter: createH10Router,
      fallbacks: true,
      finalMessage: "Verified provider retry fallback and wrote reports/provider-retry-report.md.",
      assertions: [
        "H10 fixture copied into isolated workspace",
        "H10 fallback config enabled",
        "H10 primary provider failed with retryable server errors",
        "H10 primary attempted exactly three times before fallback",
        "H10 stream emitted provider.retry diagnostics for scheduled retries",
        "H10 stream did not emit session.error for retry diagnostics",
        "H10 stream emitted provider fallback event",
        "H10 backup provider recovered the task",
        "H10 policy document read on backup route",
        "H10 retry report written",
        "H10 changed exactly expected report",
        "H10 forbidden paths unchanged",
        "H10 SQLite retry audit persisted",
        "H10 SQLite fallback audit persisted",
        "H10 retry audit captured provider",
        "H10 retry audit captured attempt count",
        "H10 fallback audit captured backup provider",
        "H10 session and audit persisted"
      ],
      filesVerified: [
        "docs/provider-retry.md",
        "reports/provider-retry-report.md",
        "stdout.jsonl",
        "stderr.txt",
        "state/sessions.sqlite"
      ],
      validate: ({ after, toolCounts, session, stream, providerRouting }) => {
        assert((toolCounts.FileRead ?? 0) === 1, "H10 should read provider retry policy once");
        assert((toolCounts.FileWrite ?? 0) === 1, "H10 should write one report");
        assert((toolCounts.Bash ?? 0) === 0, "H10 should not use Bash");
        assert((toolCounts.FilePatch ?? 0) === 0, "H10 should not patch files");
        assert((toolCounts.FileEdit ?? 0) === 0, "H10 should not use FileEdit");
        const report = after["reports/provider-retry-report.md"]?.text ?? "";
        assert(
          report.includes("three retryable server failures"),
          "H10 report missed retry evidence"
        );
        assert(
          report.includes("provider.retry events instead of session.error"),
          "H10 report missed retry event evidence"
        );
        assert(
          report.includes("backup/mock-backup"),
          "H10 report missed fallback provider evidence"
        );
        assert(
          stream.providerRetryCount === 2,
          `H10 expected 2 provider.retry events, saw ${stream.providerRetryCount}`
        );
        assert(stream.providerFallbackSeen === true, "H10 provider fallback stream event missing");
        assert(
          stream.sessionErrorSeen === false,
          "H10 retry diagnostics should not emit session.error"
        );
        assert(
          providerRouting.retryCount === 2,
          `H10 expected 2 retry audit events, saw ${providerRouting.retryCount}`
        );
        assert(
          providerRouting.fallbackCount === 1,
          `H10 expected one fallback audit event, saw ${providerRouting.fallbackCount}`
        );
        assert(
          providerRouting.retryProviders.includes("openai"),
          "H10 retry audit provider missing"
        );
        assert(providerRouting.fallbackToProvider === "backup", "H10 fallback target mismatch");
        assert(session.auditEventCount > 0, "H10 session audit events were not persisted");
        assert(session.messageCount >= 2, "H10 session messages were not persisted");
      }
    };
  }

  throw new Error(`Unknown complex harness task id: ${taskId}`);
}

async function runCommand({ command, args, cwd, configDir, label, timeoutMs = 30_000 }) {
  console.log(`+ ${label}: ${JSON.stringify(command)} ${args.map(JSON.stringify).join(" ")}`);
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        MAGI_CONFIG_DIR: configDir,
        MAGI_CLI_UNDER_TEST: cliPath,
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
  const taskDefinition = taskDefinitionFor(expected.id);
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
    routeRequest: taskDefinition.createRouter()
  });

  try {
    writeFileSync(
      path.join(configDir, "config.yaml"),
      renderConfig(provider.port, { fallbacks: taskDefinition.fallbacks === true }),
      "utf8"
    );
    const taskPrompt = readFileSync(path.join(taskRoot, "task.md"), "utf8");
    const result = await runCli({
      args: [
        "--permission-mode",
        "acceptEdits",
        "--allowed-tools",
        "AskUserQuestion,Bash,Brief,EnterPlanMode,ExitPlanMode,FileEdit,FilePatch,FileRead,FileWrite,GitDiff,GitLog,GitShow,GitStatus,GitSummary,Glob,Grep,ListMcpResources,Memorize,MemoryCorrect,ReadMcpResource,SendUserMessage,ToolSearch,WorkspaceDiagnostics",
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
    const stream = summarizeStreamProtocol({
      output: result.stdout,
      stderr: result.stderr,
      events,
      finalMessage: taskDefinition.finalMessage
    });
    const completed = events.at(-1);
    assert(completed?.type === "session.completed", "stream-json did not complete");
    assert(completed.status === "completed", "session did not finish completed");
    assert(
      completed.message === taskDefinition.finalMessage,
      `final message did not report ${expected.id} verification`
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
    const sessionDbFile = path.join(configDir, "state", "sessions.sqlite");
    const session = readSessionEvidence(sessionDbFile, completed.sessionId);
    const agentQueue = readAgentQueueEvidence(sessionDbFile);
    const approval = readBashApprovalEvidence(sessionDbFile);
    const providerRouting = readProviderRoutingEvidence(sessionDbFile);
    const diffText = renderChangedFileDiffs(before, after, changedFiles);
    writeFileSync(path.join(archiveDir, "diff.txt"), diffText, "utf8");

    const commandCount = toolCounts.Bash ?? 0;
    const assertions = taskDefinition.assertions;
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
    taskDefinition.validate({
      before,
      after,
      changedFiles,
      toolCounts,
      session,
      stream,
      agentQueue,
      approval,
      providerRouting
    });

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
        filesVerified: taskDefinition.filesVerified,
        changedFiles,
        forbiddenChanges,
        checksPassed: true,
        checksExitCode: checks.code,
        streamJsonLifecycleVerified: true,
        stream,
        session,
        agentQueue:
          agentQueue.taskCount > 0 || agentQueue.writeClaimCount > 0 ? agentQueue : undefined,
        approval:
          approval.pendingCount > 0 || approval.completedBashToolCount > 0 ? approval : undefined,
        providerRouting:
          providerRouting.retryCount > 0 || providerRouting.fallbackCount > 0
            ? providerRouting
            : undefined,
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

async function runResumeTask(taskName) {
  const taskRoot = path.join(fixturesRoot, taskName);
  const repoFixture = path.join(taskRoot, "repo");
  const expected = readJson(path.join(taskRoot, "expected.json"));
  const taskDefinition = taskDefinitionFor(expected.id);
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
    routeRequest: taskDefinition.createRouter()
  });

  try {
    writeFileSync(
      path.join(configDir, "config.yaml"),
      renderConfig(provider.port, { fallbacks: taskDefinition.fallbacks === true }),
      "utf8"
    );
    const firstPrompt = readFileSync(path.join(taskRoot, "task.md"), "utf8");
    const first = await runCli({
      args: [
        "--permission-mode",
        "acceptEdits",
        "--allowed-tools",
        "AskUserQuestion,Bash,Brief,EnterPlanMode,ExitPlanMode,FileEdit,FilePatch,FileRead,FileWrite,GitDiff,GitLog,GitShow,GitStatus,GitSummary,Glob,Grep,ListMcpResources,Memorize,MemoryCorrect,ReadMcpResource,SendUserMessage,ToolSearch,WorkspaceDiagnostics",
        "--model",
        "main",
        "--output-format",
        "stream-json",
        "-p",
        firstPrompt
      ],
      cwd: workDir,
      configDir,
      label: `${taskName} first pass`,
      timeoutMs: limits.maxTimeMs
    });
    writeFileSync(path.join(archiveDir, "first.stdout.jsonl"), first.stdout, "utf8");
    writeFileSync(path.join(archiveDir, "first.stderr.txt"), first.stderr, "utf8");
    const firstEvents = parseStreamEvents(first.stdout);
    const firstCompleted = firstEvents.at(-1);
    assert(firstCompleted?.type === "session.completed", "H6 first pass did not complete");
    assert(firstCompleted.status === "completed", "H6 first pass status was not completed");
    assert(
      firstCompleted.message === taskDefinition.firstPassFinalMessage,
      "H6 first pass final message did not stop at investigation"
    );

    const resumePrompt = readFileSync(path.join(taskRoot, "resume-task.md"), "utf8");
    const resumed = await runCli({
      args: [
        "--permission-mode",
        "acceptEdits",
        "--allowed-tools",
        "AskUserQuestion,Bash,Brief,EnterPlanMode,ExitPlanMode,FileEdit,FilePatch,FileRead,FileWrite,GitDiff,GitLog,GitShow,GitStatus,GitSummary,Glob,Grep,ListMcpResources,Memorize,MemoryCorrect,ReadMcpResource,SendUserMessage,ToolSearch,WorkspaceDiagnostics",
        "--model",
        "main",
        "--output-format",
        "stream-json",
        "-c",
        "-p",
        resumePrompt
      ],
      cwd: workDir,
      configDir,
      label: `${taskName} resume pass`,
      timeoutMs: limits.maxTimeMs
    });
    writeFileSync(path.join(archiveDir, "resume.stdout.jsonl"), resumed.stdout, "utf8");
    writeFileSync(path.join(archiveDir, "resume.stderr.txt"), resumed.stderr, "utf8");
    const resumeEvents = parseStreamEvents(resumed.stdout);
    const completed = resumeEvents.at(-1);
    assert(completed?.type === "session.completed", "H6 resume stream-json did not complete");
    assert(completed.status === "completed", "H6 resume session did not finish completed");
    assert(
      completed.sessionId === firstCompleted.sessionId,
      "H6 resume did not use same session id"
    );
    assert(
      completed.message === taskDefinition.finalMessage,
      `final message did not report ${expected.id} verification`
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
    const firstToolCounts = countStreamTools(firstEvents);
    const resumeToolCounts = countStreamTools(resumeEvents);
    const toolCounts = mergeToolCounts(firstToolCounts, resumeToolCounts);
    const session = readSessionEvidence(
      path.join(configDir, "state", "sessions.sqlite"),
      completed.sessionId
    );
    const diffText = renderChangedFileDiffs(before, after, changedFiles);
    writeFileSync(path.join(archiveDir, "diff.txt"), diffText, "utf8");

    const commandCount = toolCounts.Bash ?? 0;
    const assertions = taskDefinition.assertions;
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
    taskDefinition.validate({
      before,
      after,
      changedFiles,
      toolCounts,
      session,
      resume: {
        firstSessionId: firstCompleted.sessionId,
        resumedSessionId: completed.sessionId,
        sameSession: firstCompleted.sessionId === completed.sessionId
      }
    });

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
        filesVerified: taskDefinition.filesVerified,
        changedFiles,
        forbiddenChanges,
        checksPassed: true,
        checksExitCode: checks.code,
        streamJsonLifecycleVerified: true,
        session,
        resume: {
          firstSessionId: firstCompleted.sessionId,
          resumedSessionId: completed.sessionId,
          sameSession: firstCompleted.sessionId === completed.sessionId,
          firstJobId: firstCompleted.jobId,
          resumedJobId: completed.jobId
        },
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
    const failedToolReasons = db
      .prepare(
        "select target, metadata_json from audit_events where session_id = ? and action = 'agent.tool.failed'"
      )
      .all(sessionId)
      .map((row) => {
        let metadata = {};
        try {
          metadata = JSON.parse(row.metadata_json);
        } catch {
          metadata = {};
        }
        return {
          target: row.target,
          toolCallId: typeof metadata.toolCallId === "string" ? metadata.toolCallId : undefined,
          reason: typeof metadata.reason === "string" ? metadata.reason : ""
        };
      });
    return { sessionId, messageCount, auditEventCount, failedToolReasons };
  } finally {
    db.close();
  }
}

function readAgentQueueEvidence(dbFile) {
  assert(existsSync(dbFile), "sessions.sqlite was not created");
  const db = new Database(dbFile, { readonly: true });
  try {
    const tasks = db
      .prepare(
        "select id, role, prompt, status, metadata_json from agent_tasks order by created_at asc"
      )
      .all()
      .map((row) => {
        let metadata = {};
        try {
          metadata = JSON.parse(row.metadata_json);
        } catch {
          metadata = {};
        }
        return {
          id: row.id,
          role: row.role,
          prompt: row.prompt,
          status: row.status,
          writeFiles: Array.isArray(metadata.writeFiles)
            ? metadata.writeFiles.filter((item) => typeof item === "string")
            : []
        };
      });
    const claims = db
      .prepare("select task_id, file_path, owner_role from write_claims order by id asc")
      .all()
      .map((row) => ({
        taskId: row.task_id,
        filePath: row.file_path,
        ownerRole: row.owner_role
      }));
    const writeClaimFiles = claims.map((claim) => claim.filePath).sort();
    const taskPrompts = tasks.map((task) => task.prompt);
    return {
      taskCount: tasks.length,
      completedTaskCount: tasks.filter((task) => task.status === "completed").length,
      workerTaskCount: tasks.filter((task) => task.role === "worker").length,
      writeClaimCount: claims.length,
      writeClaimFiles,
      taskPrompts,
      tasks,
      claims,
      conflictRejected:
        tasks.length === 2 &&
        claims.length === 2 &&
        writeClaimFiles.includes("src/left.txt") &&
        writeClaimFiles.includes("src/right.txt") &&
        taskPrompts.every((prompt) => prompt !== "duplicate left module")
    };
  } finally {
    db.close();
  }
}

function readBashApprovalEvidence(dbFile) {
  assert(existsSync(dbFile), "sessions.sqlite was not created");
  const db = new Database(dbFile, { readonly: true });
  try {
    const rows = db
      .prepare("select action, target, metadata_json from audit_events order by id asc")
      .all()
      .map((row) => {
        let metadata = {};
        try {
          metadata = JSON.parse(row.metadata_json);
        } catch {
          metadata = {};
        }
        return {
          action: row.action,
          target: row.target,
          metadata
        };
      });
    const pending = rows.filter(
      (row) => row.action === "agent.approval.pending" && row.target === "Bash"
    );
    const resolved = rows.filter(
      (row) => row.action === "agent.approval.resolved" && row.target === "Bash"
    );
    const controlResolved = rows.filter(
      (row) =>
        row.action === "control.approval.resolved" &&
        readNestedString(row.metadata, ["interaction", "toolName"]) === "Bash"
    );
    const completed = rows.filter(
      (row) => row.action === "agent.tool.completed" && row.target === "Bash"
    );
    const pendingMetadata = pending[0]?.metadata ?? {};
    const pendingToolUse = readNestedRecord(pendingMetadata, ["toolUse"]);
    const pendingInput = readNestedRecord(pendingMetadata, ["toolUse", "input"]);
    const completedToolIds = completed
      .map((row) => readNestedString(row.metadata, ["toolCallId"]))
      .filter((value) => typeof value === "string");
    return {
      pendingCount: pending.length,
      resolvedCount: resolved.length,
      controlResolvedCount: controlResolved.length,
      completedBashToolCount: completed.length,
      pendingToolUseId: readNestedString(pendingToolUse, ["id"]),
      pendingCommand: readNestedString(pendingInput, ["command"]),
      pendingTimeoutMs: readNestedNumber(pendingInput, ["timeout_ms"]),
      pendingCwd: readNestedString(pendingMetadata, ["cwd"]),
      approved:
        controlResolved.some(
          (row) => readNestedBoolean(row.metadata, ["interaction", "approved"]) === true
        ) || resolved.some((row) => readNestedBoolean(row.metadata, ["approved"]) === true),
      readOnlyBashCompleted: completedToolIds.includes("h9-readonly-pwd"),
      approvedBashCompleted: completedToolIds.includes("h9-run-approved-bash"),
      completedToolIds
    };
  } finally {
    db.close();
  }
}

function readProviderRoutingEvidence(dbFile) {
  assert(existsSync(dbFile), "sessions.sqlite was not created");
  const db = new Database(dbFile, { readonly: true });
  try {
    const rows = db
      .prepare("select action, target, metadata_json from audit_events order by id asc")
      .all()
      .map((row) => {
        let metadata = {};
        try {
          metadata = JSON.parse(row.metadata_json);
        } catch {
          metadata = {};
        }
        return {
          action: row.action,
          target: row.target,
          metadata
        };
      });
    const retries = rows.filter((row) => row.action === "agent.provider.retry");
    const fallbacks = rows.filter((row) => row.action === "agent.provider.fallback");
    const fallback = fallbacks[0]?.metadata ?? {};
    return {
      retryCount: retries.length,
      fallbackCount: fallbacks.length,
      retryProviders: Array.from(
        new Set(
          retries
            .map((row) => readNestedString(row.metadata, ["providerName"]) ?? row.target)
            .filter((value) => typeof value === "string")
        )
      ).sort(),
      retryErrorKinds: Array.from(
        new Set(
          retries
            .map((row) => readNestedString(row.metadata, ["errorKind"]))
            .filter((value) => typeof value === "string")
        )
      ).sort(),
      retryAttempts: retries
        .map((row) => readNestedNumber(row.metadata, ["attempt"]))
        .filter((value) => typeof value === "number"),
      fallbackFromProvider: readNestedString(fallback, ["fromProvider"]),
      fallbackToProvider: readNestedString(fallback, ["toProvider"]),
      fallbackErrorKind: readNestedString(fallback, ["errorKind"])
    };
  } finally {
    db.close();
  }
}

function readNestedRecord(value, pathSegments) {
  let current = value;
  for (const segment of pathSegments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return {};
    }
    current = current[segment];
  }
  return current && typeof current === "object" && !Array.isArray(current) ? current : {};
}

function readNestedString(value, pathSegments) {
  let current = value;
  for (const segment of pathSegments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return typeof current === "string" ? current : undefined;
}

function readNestedNumber(value, pathSegments) {
  let current = value;
  for (const segment of pathSegments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return typeof current === "number" ? current : undefined;
}

function readNestedBoolean(value, pathSegments) {
  let current = value;
  for (const segment of pathSegments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return typeof current === "boolean" ? current : undefined;
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

function summarizeStreamProtocol({ output, stderr, events, finalMessage }) {
  let validNdjson = true;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
    } catch {
      validNdjson = false;
    }
  }
  const completed = events.at(-1);
  return {
    validNdjson,
    stderrEmpty: stderr.trim() === "",
    startedFirst: events[0]?.type === "session.started",
    completedLast: completed?.type === "session.completed",
    userMessageSeen: events.some(
      (event) => event.type === "message.created" && event.role === "user"
    ),
    assistantMessageSeen: events.some(
      (event) => event.type === "message.created" && event.role === "assistant"
    ),
    toolStartedSeen: events.some((event) => event.type === "tool.started"),
    toolCompletedSeen: events.some((event) => event.type === "tool.completed"),
    rawToolUseSeen: events.some((event) => event.type === "agent.tool_use"),
    rawToolResultSeen: events.some((event) => event.type === "agent.tool_result"),
    providerRetrySeen: events.some(
      (event) => event.type === "provider.retry" || event.type === "agent.provider_retry"
    ),
    providerRetryCount: events.filter((event) => event.type === "provider.retry").length,
    providerFallbackSeen: events.some(
      (event) => event.type === "provider.fallback" || event.type === "agent.fallback_switched"
    ),
    sessionErrorSeen: events.some((event) => event.type === "session.error"),
    completedMessage: typeof completed?.message === "string" ? completed.message : undefined,
    completedStatus: typeof completed?.status === "string" ? completed.status : undefined,
    finalMessageMatched: completed?.message === finalMessage,
    eventCount: events.length
  };
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

function mergeToolCounts(...countsList) {
  const merged = {};
  for (const counts of countsList) {
    for (const [tool, count] of Object.entries(counts)) {
      merged[tool] = (merged[tool] ?? 0) + count;
    }
  }
  return merged;
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
  for (const taskName of [
    "h1-single-file-bug-fix",
    "h2-multi-file-dry-run",
    "h3-refactor-behavior-preservation",
    "h4-repository-investigation",
    "h5-permission-boundary",
    "h6-resume-after-interruption",
    "h7-stream-json-automation",
    "h8-multi-agent-conflict",
    "h9-bash-approval-control",
    "h10-provider-retry-fallback"
  ]) {
    const started = Date.now();
    console.log(`\n=== ${taskName} ===`);
    try {
      const result =
        taskName === "h6-resume-after-interruption"
          ? await runResumeTask(taskName)
          : await runTask(taskName);
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
