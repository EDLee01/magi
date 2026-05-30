#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");
const harnessReportPath = path.join(repoRoot, "dist", "harness-report.js");
const nodeBin = process.execPath;
const startedAt = new Date();
const reportPath =
  process.env.MAGI_BLACKBOX_REPORT || path.join(repoRoot, ".magi-reports", "blackbox-e2e.json");
const INTERACTIVE_TUI_TIMEOUT_MS = 15_000;
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
    ""
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
      writeFileSync(logPath, JSON.stringify(calls, null, 2));

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
        exposedTools: Array.from(exposedTools).sort(),
        toolCounts
      };
    },
    close: () => new Promise((resolve) => server.close(resolve))
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
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
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
    "x-magi-device-id": pairing.deviceId
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
      NO_COLOR: "1"
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
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
    close
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
        NO_COLOR: "1"
      },
      detached,
      stdio: ["pipe", "pipe", "pipe"]
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
            `${label} timed out after ${timeoutMs}ms and was terminated\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`
          )
        );
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

async function runCliAllowFailure(input) {
  return runCommand({
    command: nodeBin,
    args: [cliPath, "--no-color", ...input.args],
    cwd: input.cwd,
    configDir: input.configDir,
    label: input.label,
    timeoutMs: input.timeoutMs ?? 30_000
  });
}

async function runCliWithTtyIo({
  args,
  cwd,
  configDir,
  label,
  inputText,
  waitForText = "resume sessions",
  timeoutMs = INTERACTIVE_TUI_TIMEOUT_MS
}) {
  console.log(`+ ${label}: runCli(${args.map((part) => JSON.stringify(part)).join(" ")})`);
  const { runCli: runCliApi } = await import(pathToFileURL(cliPath).href);
  const harness = createPromptHarness();
  const promise = runCliApi(
    args,
    {
      ...process.env,
      MAGI_CONFIG_DIR: configDir,
      MAGI_OPENAI_API_KEY: "test-key",
      NO_COLOR: "1"
    },
    cwd,
    {
      stdin: harness.input,
      stdout: harness.output
    }
  );
  try {
    await waitFor(
      () => stripTerminalControls(harness.stdout()).includes(waitForText),
      label,
      timeoutMs
    ).catch((error) => {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nSTDOUT:\n${harness.stdout()}`
      );
    });
    harness.input.write(inputText);
    const result = await Promise.race([
      promise,
      sleep(timeoutMs).then(() => {
        throw new Error(`${label} timed out waiting for completion\nSTDOUT:\n${harness.stdout()}`);
      })
    ]);
    return {
      ...result,
      stdout: `${harness.stdout()}${result.stdout}`,
      stderr: result.stderr
    };
  } finally {
    harness.input.destroy();
  }
}

async function runInteractiveCliWithTtySteps({
  cwd,
  configDir,
  label,
  steps,
  timeoutMs = INTERACTIVE_TUI_TIMEOUT_MS
}) {
  console.log(`+ ${label}: runInteractiveCliWithTtySteps`);
  const { runCli: runCliApi } = await import(pathToFileURL(cliPath).href);
  const harness = createPromptHarness();
  const promise = runCliApi(
    ["--no-color"],
    {
      ...process.env,
      MAGI_CONFIG_DIR: configDir,
      MAGI_OPENAI_API_KEY: "test-key",
      NO_COLOR: "1"
    },
    cwd,
    {
      stdin: harness.input,
      stdout: harness.output
    }
  );
  try {
    for (const step of steps) {
      await waitFor(
        () => stripTerminalControls(harness.stdout()).includes(step.waitForText),
        `${label}: ${step.waitForText}`,
        step.timeoutMs ?? timeoutMs
      ).catch((error) => {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\nSTDOUT:\n${harness.stdout()}`
        );
      });
      harness.input.write(step.inputText);
    }
    const result = await Promise.race([
      promise,
      sleep(timeoutMs).then(() => {
        throw new Error(`${label} timed out waiting for completion\nSTDOUT:\n${harness.stdout()}`);
      })
    ]);
    return {
      ...result,
      stdout: `${harness.stdout()}${result.stdout}`,
      stderr: result.stderr
    };
  } finally {
    harness.input.destroy();
  }
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

function parseStreamSessionId(output) {
  const sessionId = parseStreamEvents(output).find(
    (event) => event.type === "session.completed" && typeof event.sessionId === "string"
  )?.sessionId;
  if (!sessionId) {
    throw new Error(`could not parse stream session id from output:\n${output}`);
  }
  return sessionId;
}

function parseTextSessionId(output) {
  const match = output.match(/^sessionId:\s*(.+)$/m);
  assert(match, `could not parse session id from output:\n${output}`);
  return match[1].trim();
}

function parseStreamEvents(output) {
  const events = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      events.push(event);
    } catch {
      throw new Error(`stream-json output contained non-JSON line: ${line}\nFull output:\n${output}`);
    }
  }
  return events;
}

function parseSingleJsonObject(output, label) {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  assert(lines.length === 1, `${label} emitted ${lines.length} JSON lines, expected 1`);
  try {
    return JSON.parse(lines[0]);
  } catch {
    throw new Error(`${label} output was not valid JSON:\n${output}`);
  }
}

function assertStreamProtocol(events, { finalMessage }) {
  assert(events.length > 0, "stream-json emitted no events");
  assert(events[0].type === "session.started", "stream-json did not start with session.started");
  assert(
    events.some((event) => event.type === "message.created" && event.role === "user"),
    "stream-json missed user message event"
  );
  assert(
    events.some((event) => event.type === "message.created" && event.role === "assistant"),
    "stream-json missed assistant message event"
  );
  assert(
    events.some((event) => event.type === "tool.started" && event.tool === "FileWrite"),
    "stream-json missed FileWrite tool.started"
  );
  assert(
    events.some((event) => event.type === "tool.completed" && event.tool === "FileWrite"),
    "stream-json missed FileWrite tool.completed"
  );
  assert(
    events.some((event) => event.type === "tool.started" && event.tool === "FilePatch"),
    "stream-json missed FilePatch tool.started"
  );
  assert(
    events.some((event) => event.type === "tool.completed" && event.tool === "FilePatch"),
    "stream-json missed FilePatch tool.completed"
  );
  assert(
    events.some((event) => event.type === "agent.tool_use"),
    "stream-json missed raw agent tool_use event"
  );
  const completed = events.at(-1);
  assert(completed?.type === "session.completed", "stream-json did not end with session.completed");
  assert(completed.status === "completed", "stream-json session.completed missed completed status");
  assert(
    completed.message === finalMessage,
    "stream-json session.completed did not carry the final message"
  );
  assert(
    typeof completed.sessionId === "string" && completed.sessionId,
    "stream-json session.completed missed sessionId"
  );
  return completed.sessionId;
}

function assertJsonOutputProtocol(body, { finalMessage }) {
  assert(typeof body.sessionId === "string" && body.sessionId, "json output missed sessionId");
  assert(typeof body.jobId === "string" && body.jobId, "json output missed jobId");
  assert(body.status === "completed", "json output missed completed status");
  assert(body.message === finalMessage, "json output missed final message");
  assert(body.provider === "openai", "json output missed provider");
  assert(body.model === "mock-main", "json output missed model");
  assert(body.usage?.inputTokens === 1, "json output missed input token usage");
  assert(body.usage?.outputTokens === 1, "json output missed output token usage");
}

function assertStreamProtocolWithoutTools(events, { finalMessage }) {
  assert(events.length > 0, "stream-json emitted no events");
  assert(events[0].type === "session.started", "stream-json did not start with session.started");
  assert(
    events.some((event) => event.type === "message.created" && event.role === "user"),
    "stream-json missed user message event"
  );
  assert(
    events.some(
      (event) =>
        event.type === "message.created" &&
        event.role === "assistant" &&
        event.content === finalMessage
    ),
    "stream-json missed assistant message event"
  );
  const completed = events.at(-1);
  assert(completed?.type === "session.completed", "stream-json did not end with session.completed");
  assert(completed.status === "completed", "stream-json session.completed missed completed status");
  assert(
    completed.message === finalMessage,
    "stream-json session.completed did not carry the final message"
  );
}

async function seedMemoryAndGoal({ workDir, configDir }) {
  await runCli({ args: ["memory", "init"], cwd: workDir, configDir, label: "memory init" });
  const userDraft = parseDraftId(
    await runCli({
      args: [
        "memory",
        "append",
        "user",
        "User prefers focused CLI black-box verification for complex Magi work."
      ],
      cwd: workDir,
      configDir,
      label: "memory append user"
    })
  );
  await runCli({
    args: ["memory", "draft", "apply", userDraft],
    cwd: workDir,
    configDir,
    label: "memory apply user"
  });

  const projectDraft = parseDraftId(
    await runCli({
      args: [
        "memory",
        "append",
        "project",
        "Run focused CLI E2E before internal unit tests for Magi changes."
      ],
      cwd: workDir,
      configDir,
      label: "memory append project"
    })
  );
  await runCli({
    args: ["memory", "draft", "apply", projectDraft],
    cwd: workDir,
    configDir,
    label: "memory apply project"
  });
  await runCli({
    args: ["goal", "complex black-box E2E"],
    cwd: workDir,
    configDir,
    label: "goal start"
  });
}

function createComplexRouter() {
  let complexTurns = 0;
  return ({ transcript, toolNames }) => {
    if (transcript.includes("Use the mature blackbox verify skill after multiple learning cycles.")) {
      assert(
        transcript.includes("[Relevant Skills]"),
        "mature skill recall request missed skills context"
      );
      assert(
        transcript.includes("## blackbox-verify"),
        "mature skill recall missed learned skill name"
      );
      assert(
        transcript.includes("Run isolated provider validation, then focused CLI E2E, before broad suites."),
        "mature skill recall missed latest multi-cycle guidance"
      );
      assert(
        !transcript.includes("Confirm the patched skill update before broad suites."),
        "mature skill recall still included superseded patch guidance"
      );
      return messageText(
        "Use mature blackbox-verify: isolated provider validation, focused CLI E2E, then broad suites."
      );
    }

    if (transcript.includes("Use the patched blackbox verify skill after a learning update.")) {
      assert(
        transcript.includes("[Relevant Skills]"),
        "patched skill recall request missed skills context"
      );
      assert(
        transcript.includes("## blackbox-verify"),
        "patched skill recall missed learned skill name"
      );
      assert(
        transcript.includes("Confirm the patched skill update before broad suites."),
        "patched skill recall missed skill_patch content"
      );
      return messageText(
        "Use patched blackbox-verify: confirm the patched skill update before broad suites."
      );
    }

    if (transcript.includes("Use the corrected blackbox verify skill after stale guidance was fixed.")) {
      assert(
        transcript.includes("[Relevant Skills]"),
        "corrected skill recall request missed skills context"
      );
      assert(
        transcript.includes("## blackbox-verify"),
        "corrected skill recall missed learned skill name"
      );
      assert(
        transcript.includes("Use isolated provider validation before broad suites."),
        "corrected skill recall missed replacement guidance"
      );
      assert(
        !transcript.includes("Run isolated provider validation before broad checks."),
        "corrected skill recall still included stale guidance"
      );
      return messageText(
        "Use corrected blackbox-verify: isolated provider validation comes before broad suites."
      );
    }

    if (transcript.includes("Use the blackbox verify skill for isolated provider validation.")) {
      assert(transcript.includes("[Relevant Skills]"), "skill recall request missed skills context");
      assert(transcript.includes("## blackbox-verify"), "skill recall missed learned skill name");
      assert(
        transcript.includes("Run isolated provider validation before broad checks."),
        "skill recall missed learned skill body"
      );
      return messageText("Use blackbox-verify: run isolated provider validation before broad checks.");
    }

    if (transcript.includes("What should you remember about my verification preference?")) {
      assert(
        transcript.includes("focused CLI black-box verification"),
        "memory recall request did not receive hot user memory"
      );
      return messageText(
        "You prefer focused CLI black-box verification for complex Magi work, with concise summaries."
      );
    }

    if (!transcript.includes("Run the complex Magi black-box E2E")) {
      return messageText("OK");
    }

    complexTurns += 1;
    if (complexTurns === 1) {
      assert(
        transcript.includes("<active_thread_goal>"),
        "complex task missed active goal context"
      );
      assert(
        transcript.includes("Objective: complex black-box E2E"),
        "complex task missed goal objective"
      );
      assert(transcript.includes("[Relevant Memory]"), "complex task missed relevant memory");
      assert(transcript.includes("[Hot Memory]"), "complex task missed hot memory");
      assert(
        transcript.includes("focused CLI black-box verification"),
        "complex task missed user verification memory"
      );
      assert(
        transcript.includes("Run focused CLI E2E before internal unit tests"),
        "complex task missed project workflow memory"
      );
      assert(
        transcript.includes("use FilePatch for multi-line edits"),
        "complex task missed FilePatch edit-shape guidance"
      );
      assert(
        transcript.includes("use FileEdit only for one exact string replacement"),
        "complex task missed FileEdit boundary guidance"
      );
      assert(
        transcript.includes("If FilePatch fails, use its recovery feedback"),
        "complex task missed FilePatch recovery guidance"
      );
      assert(toolNames.includes("ToolSearch"), "ToolSearch was not available as a core tool");
      assert(toolNames.includes("FilePatch"), "FilePatch was not available as a core tool");
      assert(!toolNames.includes("LearningDraft"), "LearningDraft should start as a deferred tool");
      return toolResponse([
        toolCall("tool-search-patch", "ToolSearch", {
          query: "apply a multi-line patch to a file",
          max_results: 3
        }),
        toolCall("tool-select-learning", "ToolSearch", { query: "select:LearningDraft" }),
        toolCall("workspace-diag", "WorkspaceDiagnostics", {})
      ]);
    }

    if (complexTurns === 2) {
      assert(
        toolNames.includes("LearningDraft"),
        "LearningDraft was not revealed after ToolSearch"
      );
      assert(
        transcript.includes("1. FilePatch"),
        "ToolSearch did not rank FilePatch first for patch intent"
      );
      assert(
        transcript.includes("intent: file-edit"),
        "ToolSearch did not report file-edit intent"
      );
      assert(
        transcript.includes("Workspace Diagnostics"),
        "WorkspaceDiagnostics result was not returned"
      );
      return toolResponse([
        toolCall("write-report", "FileWrite", {
          file_path: "reports/e2e-result.md",
          content:
            "# Magi Black-Box E2E\n\nFocused CLI business flow passed.\n\n- goal context loaded\n- hot memory loaded\n- deferred tool revealed\n"
        }),
        toolCall("todo-update", "TodoWrite", {
          todos: [
            { id: "bb-1", content: "Create black-box report", status: "completed" },
            { id: "bb-2", content: "Persist learned verification workflow", status: "completed" }
          ]
        }),
        toolCall("memorize-workflow", "Memorize", {
          type: "workflow",
          name: "Focused CLI E2E workflow",
          description: "Run focused CLI E2E before internal unit tests for Magi changes.",
          body: "Run focused CLI E2E before internal unit tests for Magi changes, especially when validating harness behavior.",
          weight: 0.92
        })
      ]);
    }

    if (complexTurns === 3) {
      assert(
        transcript.includes("Focused CLI business flow passed"),
        "FileWrite result was not visible"
      );
      assert(transcript.includes("Todo list replaced"), "TodoWrite result was not visible");
      assert(transcript.includes("Wrote Memory node"), "Memorize result was not visible");
      return toolResponse([
        toolCall("memorize-workflow-duplicate", "Memorize", {
          type: "workflow",
          name: "Focused CLI E2E workflow",
          description: "Run focused CLI E2E before internal unit tests for Magi changes.",
          body: "Run focused CLI E2E before internal unit tests for Magi changes, especially when checking harness regressions.",
          weight: 0.43
        }),
        toolCall("patch-report", "FilePatch", {
          file_path: "reports/e2e-result.md",
          patch: [
            "@@",
            " - goal context loaded",
            "-stale patch context",
            "+- FilePatch recovery first attempt"
          ].join("\n")
        })
      ]);
    }

    if (complexTurns === 4) {
      assert(
        transcript.includes("FilePatch failed for reports/e2e-result.md"),
        "FilePatch failure did not name the target"
      );
      assert(
        transcript.includes("Recovery guidance:"),
        "FilePatch failure did not include recovery guidance"
      );
      assert(
        transcript.includes("Current file snippet:"),
        "FilePatch failure did not include current file context"
      );
      return toolResponse([
        toolCall("patch-report-retry", "FilePatch", {
          file_path: "reports/e2e-result.md",
          patch: [
            "@@",
            " - goal context loaded",
            " - hot memory loaded",
            " - deferred tool revealed",
            "+- FilePatch core edit verified"
          ].join("\n")
        })
      ]);
    }

    if (complexTurns === 5) {
      assert(
        transcript.includes("Patched reports/e2e-result.md"),
        "FilePatch result was not visible"
      );
      return toolResponse([
        toolCall("learning-propose", "LearningDraft", {
          action: "propose",
          kind: "memory",
          target: "workflows/focused-cli-e2e.md",
          content:
            "# Focused CLI E2E workflow\n\nRun the real CLI with an isolated MAGI_CONFIG_DIR and a mock provider, then verify files, memory, goals, and learning drafts.\n",
          reason:
            "Use real Magi CLI commands with a temp config and mock provider before relying on unit tests.",
          evidence: ["Validated by scripts/blackbox-e2e.mjs"],
          confidence: 0.91
        }),
        toolCall("notify-user", "SendUserMessage", { message: "Complex black-box E2E finished." })
      ]);
    }

    assert(transcript.includes("Created LearningDraft"), "LearningDraft proposal was not created");
    assert(transcript.includes("User message delivered"), "SendUserMessage result was not visible");
    return messageText(
      "Complex black-box E2E completed with real CLI, memory, goal, tools, and learning draft."
    );
  };
}

async function scenarioComplexWorkflow() {
  return await withTempWorkspace("complex", async ({ root, configDir, workDir }) => {
    const providerLog = path.join(root, "provider-log.json");
    const provider = await startProvider({
      logPath: providerLog,
      routeRequest: createComplexRouter()
    });
    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig({ port: provider.port }));
      await seedMemoryAndGoal({ workDir, configDir });

      const complexOutput = await runCli({
        args: [
          "--permission-mode",
          "acceptEdits",
          "--model",
          "main",
          "--output-format",
          "stream-json",
          "-c",
          "-p",
          "Run the complex Magi black-box E2E using focused CLI E2E workflow. Write a report, track todo state, memorize the workflow, and create a learning draft."
        ],
        cwd: workDir,
        configDir,
        label: "complex prompt",
        timeoutMs: 45_000
      });
      assert(
        complexOutput.includes("session.completed") &&
          complexOutput.includes("Complex black-box E2E completed"),
        "complex headless prompt did not complete"
      );
      const complexEvents = parseStreamEvents(complexOutput);
      const complexSessionId = assertStreamProtocol(complexEvents, {
        finalMessage:
          "Complex black-box E2E completed with real CLI, memory, goal, tools, and learning draft."
      });

      const reportPath = path.join(workDir, "reports", "e2e-result.md");
      assert(existsSync(reportPath), "complex task did not create report file");
      assert(
        readFileSync(reportPath, "utf8").includes("Focused CLI business flow passed"),
        "report file content was not written correctly"
      );
      assert(
        readFileSync(reportPath, "utf8").includes("FilePatch core edit verified"),
        "FilePatch did not update the report file"
      );

      const todosPath = path.join(configDir, "state", "todos.json");
      assert(existsSync(todosPath), "TodoWrite did not persist todo state");
      assert(
        readFileSync(todosPath, "utf8").includes("Persist learned verification workflow"),
        "todo state missing item"
      );

      const recall = await runCli({
        args: [
          "--model",
          "main",
          "-c",
          "-p",
          "What should you remember about my verification preference?"
        ],
        cwd: workDir,
        configDir,
        label: "memory recall"
      });
      assert(
        recall.includes("focused CLI black-box verification"),
        "memory recall answer missed verification preference"
      );

      const learningList = await runCli({
        args: ["learning", "list"],
        cwd: workDir,
        configDir,
        label: "learning list"
      });
      assert(learningList.includes("LearningDrafts:"), "learning draft list was empty");
      assert(
        learningList.includes("workflows/focused-cli-e2e.md"),
        "learning draft target was not listed"
      );
      const learningDraftId = learningList
        .split(/\r?\n/)
        .find((line) => line.includes("workflows/focused-cli-e2e.md"))
        ?.match(/learn_[a-z0-9_]+/i)?.[0];
      assert(learningDraftId, "learning draft id was not listed");
      const learningReview = await runCli({
        args: ["learning", "draft", "show", learningDraftId],
        cwd: workDir,
        configDir,
        label: "learning draft show"
      });
      assert(
        learningReview.includes("Validated by scripts/blackbox-e2e.mjs"),
        "learning draft review missed evidence"
      );
      assert(
        learningReview.includes("Use real Magi CLI commands with a temp config and mock provider"),
        "learning draft review missed reason"
      );
      const learningApply = await runCli({
        args: ["learning", "draft", "apply", learningDraftId],
        cwd: workDir,
        configDir,
        label: "learning draft apply"
      });
      assert(learningApply.includes("Applied LearningDraft:"), "learning draft apply did not run");
      const learningListAfterApply = await runCli({
        args: ["learning", "list"],
        cwd: workDir,
        configDir,
        label: "learning list after apply"
      });
      assert(
        learningListAfterApply.includes(`${learningDraftId}  applied`),
        "learning draft status was not applied"
      );
      const appliedWorkflowPath = path.join(configDir, "memory", "workflows", "focused-cli-e2e.md");
      assert(existsSync(appliedWorkflowPath), "applied learning draft did not write memory file");
      assert(
        readFileSync(appliedWorkflowPath, "utf8").includes(
          "Run the real CLI with an isolated MAGI_CONFIG_DIR"
        ),
        "applied learning memory file missed workflow content"
      );
      const appliedLearningSearch = await runCli({
        args: ["memory", "search", "isolated MAGI_CONFIG_DIR mock provider learning drafts"],
        cwd: workDir,
        configDir,
        label: "applied learning memory search"
      });
      assert(
        appliedLearningSearch.includes("Focused CLI E2E workflow"),
        "applied LearningDraft workflow was not indexed into memory graph"
      );
      assert(
        appliedLearningSearch.includes("isolated MAGI_CONFIG_DIR"),
        "applied LearningDraft workflow content was not recalled"
      );
      const skillDraft = await runCli({
        args: [
          "learning",
          "propose",
          "--kind",
          "skill_create",
          "--target",
          "skills/blackbox-verify/SKILL.md",
          "--reason",
          "Promote a repeated black-box verification workflow into a reusable skill.",
          "--evidence",
          "Validated by scripts/blackbox-e2e.mjs",
          "--confidence",
          "0.9",
          "# Blackbox Verify\n\nRun isolated provider validation before broad checks.\n\n## Steps\n\n1. Start a mock provider.\n2. Run focused black-box CLI flow.\n3. Verify memory, tools, and learning evidence before broad suites.\n"
        ],
        cwd: workDir,
        configDir,
        label: "learning skill draft propose"
      });
      assert(skillDraft.includes("Created LearningDraft:"), "skill LearningDraft was not proposed");
      const skillDraftId = /learn_[a-z0-9_]+/i.exec(skillDraft)?.[0];
      assert(skillDraftId, "skill LearningDraft id was not returned");
      const skillReview = await runCli({
        args: ["learning", "draft", "show", skillDraftId],
        cwd: workDir,
        configDir,
        label: "learning skill draft show"
      });
      assert(
        skillReview.includes("Promote a repeated black-box verification workflow"),
        "skill LearningDraft review missed reason"
      );
      assert(
        skillReview.includes("Validated by scripts/blackbox-e2e.mjs"),
        "skill LearningDraft review missed evidence"
      );
      const skillApply = await runCli({
        args: ["learning", "draft", "apply", skillDraftId],
        cwd: workDir,
        configDir,
        label: "learning skill draft apply"
      });
      assert(skillApply.includes("Applied LearningDraft:"), "skill LearningDraft apply did not run");
      const skillFile = path.join(configDir, "skills", "blackbox-verify", "SKILL.md");
      assert(existsSync(skillFile), "applied skill LearningDraft did not write SKILL.md");
      assert(
        readFileSync(skillFile, "utf8").includes("Run isolated provider validation before broad checks."),
        "applied skill file missed learned workflow"
      );
      const skillRecall = await runCli({
        args: [
          "--model",
          "main",
          "-c",
          "-p",
          "Use the blackbox verify skill for isolated provider validation."
        ],
        cwd: workDir,
        configDir,
        label: "learned skill recall"
      });
      assert(
        skillRecall.includes("blackbox-verify"),
        "learned skill recall answer missed skill name"
      );
      const skillPatchDraft = await runCli({
        args: [
          "learning",
          "propose",
          "--kind",
          "skill_patch",
          "--target",
          "skills/blackbox-verify/SKILL.md",
          "--reason",
          "Refine an existing learned verification skill after repeated black-box use.",
          "--evidence",
          "Validated by skill_patch black-box recall",
          "--confidence",
          "0.88",
          "## Learned patch update\n\nConfirm the patched skill update before broad suites.\n"
        ],
        cwd: workDir,
        configDir,
        label: "learning skill patch draft propose"
      });
      assert(
        skillPatchDraft.includes("Created LearningDraft:"),
        "skill_patch LearningDraft was not proposed"
      );
      const skillPatchDraftId = /learn_[a-z0-9_]+/i.exec(skillPatchDraft)?.[0];
      assert(skillPatchDraftId, "skill_patch LearningDraft id was not returned");
      const skillPatchReview = await runCli({
        args: ["learning", "draft", "show", skillPatchDraftId],
        cwd: workDir,
        configDir,
        label: "learning skill patch draft show"
      });
      assert(
        skillPatchReview.includes("Refine an existing learned verification skill"),
        "skill_patch LearningDraft review missed reason"
      );
      assert(
        skillPatchReview.includes("Validated by skill_patch black-box recall"),
        "skill_patch LearningDraft review missed evidence"
      );
      const skillPatchApply = await runCli({
        args: ["learning", "draft", "apply", skillPatchDraftId],
        cwd: workDir,
        configDir,
        label: "learning skill patch draft apply"
      });
      assert(
        skillPatchApply.includes("Applied LearningDraft:"),
        "skill_patch LearningDraft apply did not run"
      );
      const patchedSkill = readFileSync(skillFile, "utf8");
      assert(
        patchedSkill.includes(`<!-- LearningDraft ${skillPatchDraftId} -->`),
        "applied skill_patch did not mark the source LearningDraft"
      );
      assert(
        patchedSkill.includes("Confirm the patched skill update before broad suites."),
        "applied skill_patch file missed learned update"
      );
      const patchedSkillRecall = await runCli({
        args: [
          "--model",
          "main",
          "-c",
          "-p",
          "Use the patched blackbox verify skill after a learning update."
        ],
        cwd: workDir,
        configDir,
        label: "patched skill recall"
      });
      assert(
        patchedSkillRecall.includes("patched blackbox-verify"),
        "patched skill recall answer missed patched skill name"
      );
      const staleSkillPatchDraft = await runCli({
        args: [
          "learning",
          "propose",
          "--kind",
          "skill_patch",
          "--target",
          "skills/blackbox-verify/SKILL.md",
          "--reason",
          "Correct stale skill guidance that skipped provider validation.",
          "--evidence",
          "User reported the learned skill was wrong",
          "--confidence",
          "0.93",
          [
            "old_string:",
            "```",
            "Run isolated provider validation before broad checks.",
            "```",
            "new_string:",
            "```",
            "Use isolated provider validation before broad suites.",
            "```"
          ].join("\n")
        ],
        cwd: workDir,
        configDir,
        label: "learning stale skill correction draft propose"
      });
      assert(
        staleSkillPatchDraft.includes("Created LearningDraft:"),
        "stale skill correction LearningDraft was not proposed"
      );
      const staleSkillPatchDraftId = /learn_[a-z0-9_]+/i.exec(staleSkillPatchDraft)?.[0];
      assert(staleSkillPatchDraftId, "stale skill correction LearningDraft id was not returned");
      const staleSkillPatchReview = await runCli({
        args: ["learning", "draft", "show", staleSkillPatchDraftId],
        cwd: workDir,
        configDir,
        label: "learning stale skill correction draft show"
      });
      assert(
        staleSkillPatchReview.includes("Correct stale skill guidance"),
        "stale skill correction review missed reason"
      );
      assert(
        staleSkillPatchReview.includes("User reported the learned skill was wrong"),
        "stale skill correction review missed evidence"
      );
      const staleSkillPatchApply = await runCli({
        args: ["learning", "draft", "apply", staleSkillPatchDraftId],
        cwd: workDir,
        configDir,
        label: "learning stale skill correction draft apply"
      });
      assert(
        staleSkillPatchApply.includes("Applied LearningDraft:"),
        "stale skill correction LearningDraft apply did not run"
      );
      const correctedSkill = readFileSync(skillFile, "utf8");
      assert(
        correctedSkill.includes("Use isolated provider validation before broad suites."),
        "corrected skill file missed replacement guidance"
      );
      assert(
        !correctedSkill.includes("Run isolated provider validation before broad checks."),
        "corrected skill file retained stale guidance"
      );
      const correctedSkillRecall = await runCli({
        args: [
          "--session-id",
          "blackbox-corrected-skill-session",
          "--model",
          "main",
          "-p",
          "Use the corrected blackbox verify skill after stale guidance was fixed."
        ],
        cwd: workDir,
        configDir,
        label: "corrected skill recall"
      });
      assert(
        correctedSkillRecall.includes("corrected blackbox-verify"),
        "corrected skill recall answer missed corrected skill name"
      );
      const consolidatedSkill = correctedSkill.replace(
        "\n\n<!-- LearningDraft " +
          skillPatchDraftId +
          " -->\n## Learned patch update\n\nConfirm the patched skill update before broad suites.\n",
        ""
      );
      const iterativeSkillPatchDraft = await runCli({
        args: [
          "learning",
          "propose",
          "--kind",
          "skill_patch",
          "--target",
          "skills/blackbox-verify/SKILL.md",
          "--reason",
          "Fold another cycle of successful black-box verification back into the skill.",
          "--evidence",
          "Validated after create, patch, correction, and recall cycles",
          "--confidence",
          "0.94",
          [
            "old_string:",
            "```",
            correctedSkill,
            "```",
            "new_string:",
            "```",
            consolidatedSkill.replace(
              "Use isolated provider validation before broad suites.",
              "Run isolated provider validation, then focused CLI E2E, before broad suites."
            ),
            "```"
          ].join("\n")
        ],
        cwd: workDir,
        configDir,
        label: "learning iterative skill patch draft propose"
      });
      assert(
        iterativeSkillPatchDraft.includes("Created LearningDraft:"),
        "iterative skill LearningDraft was not proposed"
      );
      const iterativeSkillPatchDraftId = /learn_[a-z0-9_]+/i.exec(iterativeSkillPatchDraft)?.[0];
      assert(iterativeSkillPatchDraftId, "iterative skill LearningDraft id was not returned");
      const iterativeSkillPatchReview = await runCli({
        args: ["learning", "draft", "show", iterativeSkillPatchDraftId],
        cwd: workDir,
        configDir,
        label: "learning iterative skill patch draft show"
      });
      assert(
        iterativeSkillPatchReview.includes("Fold another cycle of successful black-box verification"),
        "iterative skill review missed reason"
      );
      assert(
        iterativeSkillPatchReview.includes("Validated after create, patch, correction, and recall cycles"),
        "iterative skill review missed evidence"
      );
      const iterativeSkillPatchApply = await runCli({
        args: ["learning", "draft", "apply", iterativeSkillPatchDraftId],
        cwd: workDir,
        configDir,
        label: "learning iterative skill patch draft apply"
      });
      assert(
        iterativeSkillPatchApply.includes("Applied LearningDraft:"),
        "iterative skill LearningDraft apply did not run"
      );
      const matureSkill = readFileSync(skillFile, "utf8");
      assert(
        matureSkill.includes("Run isolated provider validation, then focused CLI E2E, before broad suites."),
        "mature skill file missed latest learned guidance"
      );
      assert(
        !matureSkill.includes("Use isolated provider validation before broad suites."),
        "mature skill file retained prior corrected guidance"
      );
      const matureSkillRecall = await runCli({
        args: [
          "--session-id",
          "blackbox-mature-skill-session",
          "--model",
          "main",
          "-p",
          "Use the mature blackbox verify skill after multiple learning cycles."
        ],
        cwd: workDir,
        configDir,
        label: "mature skill recall"
      });
      assert(
        matureSkillRecall.includes("mature blackbox-verify"),
        "mature skill recall answer missed mature skill name"
      );

      const memorySearch = await runCli({
        args: ["memory", "search", "CLI E2E workflow"],
        cwd: workDir,
        configDir,
        label: "memory search"
      });
      assert(
        memorySearch.includes("focused CLI E2E"),
        "memory search did not find memorized workflow"
      );
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
          "0.8"
        ],
        cwd: workDir,
        configDir,
        label: "complex duplicate memory link"
      });
      const dream = await runCli({
        args: ["memory", "dream"],
        cwd: workDir,
        configDir,
        label: "complex memory dream duplicate"
      });
      assert(dream.includes("duplicate"), "memory dream did not detect duplicate graph workflow");
      const dreamId = parseDreamId(dream);
      const appliedDream = await runCli({
        args: ["memory", "dream", "apply", dreamId],
        cwd: workDir,
        configDir,
        label: "complex memory dream apply duplicate"
      });
      assert(
        appliedDream.includes("Archived graph nodes: 1"),
        "memory dream did not archive duplicate graph workflow"
      );
      assert(
        appliedDream.includes("Redirected graph edges: 1"),
        "memory dream did not redirect duplicate graph edges"
      );
      assert(
        appliedDream.includes("Fused graph node weights: 1"),
        "memory dream did not fuse duplicate graph node weight"
      );
      assert(
        appliedDream.includes("Resolved graph edge conflicts: 0"),
        "memory dream reported unexpected graph edge conflicts"
      );
      const mergeAudit = await runCli({
        args: ["memory", "merges", "--limit", "5"],
        cwd: workDir,
        configDir,
        label: "complex memory merges"
      });
      assert(
        mergeAudit.includes("Memory graph merges: 1"),
        "memory merges did not list duplicate workflow merge"
      );
      assert(
        mergeAudit.includes("Focused CLI E2E workflow -> Focused CLI E2E workflow"),
        "memory merges did not show duplicate workflow titles"
      );
      assert(
        mergeAudit.includes("redirected edges: 1"),
        "memory merges did not show redirected edge count"
      );
      assert(mergeAudit.includes("dream:"), "memory merges did not include dream id");
      const evalCaseFile = path.join(workDir, "memory-recall-eval.json");
      const evalReportFile = path.join(workDir, "memory-recall-eval-report.json");
      writeFileSync(
        evalCaseFile,
        JSON.stringify(
          {
            name: "complex memory recall",
            cases: [
              {
                name: "workflow and preference recall",
                query: "CLI E2E workflow verification preference",
                expect: ["Focused CLI E2E workflow", "focused CLI black-box verification"],
                forbid: ["verbose terminal dumps"],
                minResults: 2
              }
            ]
          },
          null,
          2
        )
      );
      const memoryEval = await runCli({
        args: [
          "memory",
          "eval",
          "--case-file",
          evalCaseFile,
          "--max-results",
          "5",
          "--min-score",
          "1",
          "--report",
          evalReportFile
        ],
        cwd: workDir,
        configDir,
        label: "complex memory recall eval"
      });
      assert(
        memoryEval.includes("Memory recall eval: complex memory recall"),
        "memory eval did not run named suite"
      );
      assert(
        memoryEval.includes("1. PASS workflow and preference recall"),
        "memory eval did not pass complex recall case"
      );
      assert(memoryEval.includes("score: 1.00"), "memory eval did not report perfect score");
      assert(memoryEval.includes("threshold: PASS"), "memory eval did not report threshold status");
      assert(
        memoryEval.includes(`Report: ${evalReportFile}`),
        "memory eval did not report JSON output path"
      );
      const evalReport = JSON.parse(readFileSync(evalReportFile, "utf8"));
      assert(evalReport.score === 1, "memory eval JSON report did not preserve score");
      assert(evalReport.minScore === 1, "memory eval JSON report did not preserve score threshold");
      assert(
        evalReport.thresholdPassed === true,
        "memory eval JSON report did not preserve threshold status"
      );
      assert(
        evalReport.results?.[0]?.passed === true,
        "memory eval JSON report did not preserve case status"
      );
      assert(
        evalReport.results?.[0]?.forbiddenFound?.length === 0,
        "memory eval JSON report had forbidden recall"
      );

      await runCli({
        args: ["goal", "done", "verified", "--session-id", complexSessionId],
        cwd: workDir,
        configDir,
        label: "goal done"
      });
      const goalStatus = await runCli({
        args: ["goal", "--session-id", complexSessionId],
        cwd: workDir,
        configDir,
        label: "goal status"
      });
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
          "learning draft listed",
          "learning draft review showed evidence",
          "learning draft applied to memory",
          "applied learning indexed into memory graph",
          "skill learning draft reviewed",
          "skill learning draft applied",
          "learned skill recalled in model context",
          "skill patch learning draft reviewed",
          "skill patch learning draft applied",
          "patched skill recalled in model context",
          "stale skill correction draft reviewed",
          "stale skill correction applied replacement",
          "corrected skill recalled without stale guidance",
          "iterative skill patch reviewed after correction",
          "iterative skill patch applied latest guidance",
          "mature skill recalled after multiple learning cycles",
          "stream-json emitted only JSON lines",
          "stream-json emitted user and assistant message events",
          "stream-json emitted tool started and completed events",
          "stream-json preserved raw agent events",
          "stream-json completed with status and final message"
        ],
        filesVerified: [
          "reports/e2e-result.md",
          "state/todos.json",
          "memory/workflows/focused-cli-e2e.md",
          "skills/blackbox-verify/SKILL.md"
        ],
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
          return toolResponse([
            toolCall("denied-write", "FileWrite", { file_path: "denied.txt", content: "no" })
          ]);
        }
        assert(
          transcript.includes("Permission ask: FileWrite requires approval"),
          "default permission denial was not returned to the model"
        );
        return messageText("Default permission denial observed.");
      }
    });
    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig({ port: provider.port }));
      const output = await runCli({
        args: [
          "--model",
          "main",
          "--output-format",
          "stream-json",
          "-p",
          "Try to write a file without permission mode."
        ],
        cwd: workDir,
        configDir,
        label: "default permission denied"
      });
      assert(
        output.includes("approval_request"),
        "default permission path did not emit approval_request"
      );
      assert(
        output.includes("Default permission denial observed"),
        "model did not observe permission denial"
      );
      assert(
        !existsSync(path.join(workDir, "denied.txt")),
        "denied write unexpectedly created a file"
      );
      assert(turn === 2, "permission denial scenario should complete in two provider turns");
      return {
        score: 1,
        assertions: [
          "approval request emitted",
          "permission denial returned to model",
          "denied write did not mutate workspace"
        ],
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

async function scenarioHelpShape() {
  return await withTempWorkspace("help-shape", async ({ configDir, workDir }) => {
    const output = await runCli({
      args: ["--help"],
      cwd: workDir,
      configDir,
      label: "help shape"
    });
    assert(output.includes("Usage:"), "help missed Usage group");
    assert(output.includes("Options:"), "help missed Options group");
    assert(output.includes("Commands:"), "help missed Commands group");
    assert(output.includes("Compatibility notes:"), "help missed compatibility notes");
    assert(output.includes("--output-format <text|json|stream-json>"), "help missed output formats");
    assert(output.includes("--tools <tool[,tool...]>"), "help missed --tools compatibility option");
    assert(output.includes("--allowed-tools <rule[,rule...]>"), "help missed --allowed-tools");
    assert(output.includes("--disallowed-tools <rule[,rule...]>"), "help missed --disallowed-tools");
    assert(output.includes("workspace diagnose"), "help missed workspace diagnose command");
    assert(
      output.includes("memory view|search|link|correct|feedback"),
      "help missed memory command family"
    );
    assert(output.includes("learning list|propose|draft"), "help missed learning command family");
    assert(
      output.includes("Legacy-only provider/browser bridge paths"),
      "help missed unsupported legacy path note"
    );
    assert(output.includes("magi-agent binary"), "help missed unsupported magi-agent binary note");

    return {
      score: 1,
      assertions: [
        "help output grouped Usage Options Commands",
        "help output documented compatibility-shaped options",
        "help output documented command families",
        "help output documented unsupported legacy paths"
      ]
    };
  });
}

async function scenarioTextOutputProtocol() {
  return await withTempWorkspace("text-output", async ({ root, configDir, workDir }) => {
    const providerLog = path.join(root, "provider-log.json");
    const provider = await startProvider({
      logPath: providerLog,
      routeRequest: ({ transcript }) => {
        if (transcript.includes("Return verbose text protocol status.")) {
          return messageText("Verbose text protocol final.");
        }
        if (transcript.includes("Return plain text protocol status.")) {
          return messageText("Plain text protocol final.");
        }
        return fail(500, `unexpected text-output prompt: ${transcript}`);
      }
    });
    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig({ port: provider.port }));
      const plain = await runCli({
        args: ["--model", "main", "-p", "Return plain text protocol status."],
        cwd: workDir,
        configDir,
        label: "plain text output protocol"
      });
      assert(plain === "Plain text protocol final.\n", "plain text output included extra metadata");
      assert(!plain.includes("sessionId:"), "plain text output leaked sessionId");
      assert(!plain.includes("jobId:"), "plain text output leaked jobId");
      assert(!plain.includes("stateDb:"), "plain text output leaked stateDb");

      const verbose = await runCli({
        args: ["--verbose", "--model", "main", "-p", "Return verbose text protocol status."],
        cwd: workDir,
        configDir,
        label: "verbose text output protocol"
      });
      assert(
        verbose.includes("Verbose text protocol final."),
        "verbose text output missed final message"
      );
      assert(verbose.includes("sessionId:"), "verbose text output missed sessionId");
      assert(verbose.includes("jobId:"), "verbose text output missed jobId");
      assert(verbose.includes("stateDb:"), "verbose text output missed stateDb");

      return {
        score: 1,
        assertions: [
          "text output default emitted final message only",
          "text output default hid session metadata",
          "text output verbose included session metadata"
        ],
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

async function scenarioJsonOutputProtocol() {
  return await withTempWorkspace("json-output", async ({ root, configDir, workDir }) => {
    const providerLog = path.join(root, "provider-log.json");
    const provider = await startProvider({
      logPath: providerLog,
      routeRequest: ({ transcript }) => {
        if (transcript.includes("Return JSON protocol status.")) {
          return messageText("JSON protocol final.");
        }
        return fail(500, `unexpected json-output prompt: ${transcript}`);
      }
    });
    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig({ port: provider.port }));
      const output = await runCli({
        args: [
          "--model",
          "main",
          "--output-format",
          "json",
          "-p",
          "Return JSON protocol status."
        ],
        cwd: workDir,
        configDir,
        label: "json output protocol"
      });
      const body = parseSingleJsonObject(output, "json output protocol");
      assertJsonOutputProtocol(body, { finalMessage: "JSON protocol final." });

      const failed = await runCliAllowFailure({
        args: ["--output-format", "json", "resume"],
        cwd: workDir,
        configDir,
        label: "json output usage error"
      });
      assert(failed.code === 2, "json usage error did not exit with code 2");
      assert(!failed.stderr.trim(), "json usage error wrote stderr");
      const errorBody = parseSingleJsonObject(failed.stdout, "json output usage error");
      assert(errorBody.status === "failed", "json error missed failed status");
      assert(errorBody.exitCode === 2, "json error missed exit code");
      assert(errorBody.error?.kind === "usage", "json error missed usage kind");
      assert(
        errorBody.error?.message === "magi resume requires a session id",
        "json error missed message"
      );

      return {
        score: 1,
        assertions: [
          "json output emitted single object",
          "json output included session job status message",
          "json output included provider model usage",
          "json error output stayed JSON",
          "json error output included failure status and kind"
        ],
        filesVerified: [],
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

async function scenarioToolPolicyAllowDeny() {
  return await withTempWorkspace("tool-policy", async ({ root, configDir, workDir }) => {
    await writeFile(path.join(workDir, "tracked.txt"), "tracked\n", "utf8");
    spawnSync("git", ["init"], { cwd: workDir, stdio: "ignore" });
    spawnSync("git", ["add", "tracked.txt"], { cwd: workDir, stdio: "ignore" });
    const providerLog = path.join(root, "provider-log.json");
    const seenInitialTools = [];
    let turn = 0;
    const provider = await startProvider({
      logPath: providerLog,
      routeRequest: ({ body, transcript, toolNames }) => {
        turn += 1;
        if (turn === 1) {
          seenInitialTools.push(...toolNames);
          assert(toolNames.includes("FileRead"), "--tools Read did not expose FileRead");
          assert(toolNames.includes("Grep"), "--tools Search did not expose Grep");
          assert(!toolNames.includes("FileWrite"), "--tools Read,Search exposed FileWrite");
          return toolResponse([
            toolCall("policy-write", "FileWrite", {
              file_path: "policy-denied.txt",
              content: "no"
            })
          ]);
        }
        if (turn === 2) {
          assert(
            transcript.includes("Permission deny: FileWrite is not in allowed tools"),
            "allow-list denial was not returned to the model"
          );
          return messageText("Tool allow-list denial observed.");
        }
        if (turn === 3) {
          assert(!toolNames.includes("Bash"), "--disallowed-tools Bash exposed Bash");
          return toolResponse([
            toolCall("policy-bash-denied", "Bash", {
              command: "pwd"
            })
          ]);
        }
        if (turn === 4) {
          assert(
            transcript.includes("Permission deny: matched rule Bash(*)"),
            "disallowed Bash denial was not returned to the model"
          );
          return messageText("Tool deny-list denial observed.");
        }
        if (turn === 5) {
          assert(toolNames.includes("Bash"), "allowed Bash(git:*) did not expose Bash schema");
          return toolResponse([
            toolCall("policy-bash-git", "Bash", {
              command: "git status --short"
            })
          ]);
        }
        if (turn === 6) {
          assert(
            transcript.includes("Command exited 0"),
            "allowed Bash(git:*) did not run successfully"
          );
          return messageText("Tool scoped allow observed.");
        }
        if (turn === 7) {
          assert(toolNames.includes("Bash"), "allowed Bash(git:*) did not expose Bash schema");
          return toolResponse([
            toolCall("policy-bash-rm", "Bash", {
              command: "pwd"
            })
          ]);
        }
        assert(
          transcript.includes("Permission deny: Bash is not in allowed tools"),
          "scoped Bash allow did not deny unmatched command"
        );
        return messageText("Tool scoped deny observed.");
      }
    });
    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig({ port: provider.port }));
      const allowOutput = await runCli({
        args: [
          "--tools",
          "Read,Search",
          "--model",
          "main",
          "--output-format",
          "stream-json",
          "-p",
          "Try to write with read-only tools."
        ],
        cwd: workDir,
        configDir,
        label: "tool policy allow-list"
      });
      assert(
        allowOutput.includes("Tool allow-list denial observed"),
        "allow-list scenario did not complete"
      );
      assert(
        !existsSync(path.join(workDir, "policy-denied.txt")),
        "allow-list denied write unexpectedly created a file"
      );
      const denyOutput = await runCli({
        args: [
          "--disallowed-tools",
          "Bash",
          "--model",
          "main",
          "--output-format",
          "stream-json",
          "-p",
          "Try to run pwd with Bash denied."
        ],
        cwd: workDir,
        configDir,
        label: "tool policy deny-list"
      });
      assert(
        denyOutput.includes("Tool deny-list denial observed"),
        "deny-list scenario did not complete"
      );
      const scopedAllowOutput = await runCli({
        args: [
          "--allowed-tools",
          "Bash(git:*)",
          "--model",
          "main",
          "--output-format",
          "stream-json",
          "-p",
          "Run git status through scoped Bash."
        ],
        cwd: workDir,
        configDir,
        label: "tool policy scoped allow"
      });
      assert(
        scopedAllowOutput.includes("Tool scoped allow observed"),
        "scoped allow scenario did not complete"
      );
      const scopedDenyOutput = await runCli({
        args: [
          "--allowed-tools",
          "Bash(git:*)",
          "--model",
          "main",
          "--output-format",
          "stream-json",
          "-p",
          "Run pwd through scoped Bash."
        ],
        cwd: workDir,
        configDir,
        label: "tool policy scoped deny"
      });
      assert(
        scopedDenyOutput.includes("Tool scoped deny observed"),
        "scoped deny scenario did not complete"
      );
      assert(seenInitialTools.length > 0, "tool policy scenario did not capture exposed tools");
      return {
        score: 1,
        assertions: [
          "--tools allow-list filtered exposed schemas",
          "--tools allow-list denied hidden write execution",
          "--disallowed-tools filtered exposed schemas",
          "--disallowed-tools denied requested tool execution",
          "--allowed-tools scoped selector allowed matching Bash command",
          "--allowed-tools scoped selector denied non-matching Bash command"
        ],
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

async function scenarioBarePromptHeadless() {
  return await withTempWorkspace("bare-prompt", async ({ root, configDir, workDir }) => {
    const providerLog = path.join(root, "provider-log.json");
    const provider = await startProvider({
      logPath: providerLog,
      routeRequest: ({ transcript }) => {
        assert(
          transcript.includes("Create a terse bare prompt status"),
          "bare prompt argument was not sent to the provider"
        );
        return messageText("Bare prompt headless status ready.");
      }
    });
    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig({ port: provider.port }));
      const output = await runCli({
        args: [
          "--model",
          "main",
          "--output-format",
          "stream-json",
          "Create",
          "a",
          "terse",
          "bare",
          "prompt",
          "status"
        ],
        cwd: workDir,
        configDir,
        label: "bare prompt headless"
      });
      const events = parseStreamEvents(output);
      assertStreamProtocolWithoutTools(events, {
        finalMessage: "Bare prompt headless status ready."
      });
      const completed = events.at(-1);
      assert(
        typeof completed.sessionId === "string" && completed.sessionId,
        "bare prompt headless session did not complete with a session id"
      );
      assert(
        provider.calls.length === 1,
        `bare prompt should call provider once, got ${provider.calls.length}`
      );
      return {
        score: 1,
        assertions: [
          "bare prompt argument entered headless provider path",
          "bare prompt stream-json emitted valid lifecycle events",
          "bare prompt headless session completed"
        ],
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

async function scenarioResumePickerTty() {
  return await withTempWorkspace("resume-picker", async ({ root, configDir, workDir }) => {
    const providerLog = path.join(root, "provider-log.json");
    const provider = await startProvider({
      logPath: providerLog,
      routeRequest: () => messageText("Resume picker seed response.")
    });
    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig({ port: provider.port }));
      await runCli({
        args: ["--verbose", "--model", "main", "--name", "fix parser", "-p", "seed parser session"],
        cwd: workDir,
        configDir,
        label: "resume picker seed parser"
      });
      const targetOutput = await runCli({
        args: [
          "--verbose",
          "--model",
          "main",
          "--name",
          "review auth target",
          "-p",
          "seed auth session"
        ],
        cwd: workDir,
        configDir,
        label: "resume picker seed auth"
      });
      await runCli({
        args: ["--verbose", "--model", "main", "--name", "write docs", "-p", "seed docs session"],
        cwd: workDir,
        configDir,
        label: "resume picker seed docs"
      });
      const targetSessionId = parseTextSessionId(targetOutput);
      const nonTtyList = await runCli({
        args: ["-r"],
        cwd: workDir,
        configDir,
        label: "resume picker non-TTY list"
      });
      assert(nonTtyList.includes("Resume sessions:"), "non-TTY -r did not list sessions");
      assert(
        nonTtyList.includes("review auth target"),
        "non-TTY -r did not include the target session"
      );
      const result = await runCliWithTtyIo({
        args: ["--no-color", "-r"],
        cwd: workDir,
        configDir,
        label: "resume picker TTY",
        inputText: "auth\r"
      });
      assert(
        result.exitCode === 0,
        `resume picker exited ${result.exitCode}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
      );
      const combined = stripTerminalControls(`${result.stdout}\n${result.stderr}`);
      assert(combined.includes("resume sessions"), "resume picker title did not render");
      assert(combined.includes("matching auth"), "resume picker did not filter by typed query");
      assert(combined.includes("review auth target"), "resume picker did not show target title");
      assert(
        combined.includes(`sessionId: ${targetSessionId}`),
        "resume picker did not resume the selected session"
      );
      return {
        score: 1,
        assertions: [
          "TTY -r rendered searchable session picker",
          "TTY -r filtered sessions by typed query",
          "TTY -r resumed selected session",
          "non-TTY -r session list remains available"
        ],
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

async function scenarioSlashResumeSearchTty() {
  return await withTempWorkspace("slash-resume-search", async ({ root, configDir, workDir }) => {
    const providerLog = path.join(root, "provider-log.json");
    const provider = await startProvider({
      logPath: providerLog,
      routeRequest: () => messageText("Slash resume seed response.")
    });
    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig({ port: provider.port }));
      await runCli({
        args: [
          "--verbose",
          "--model",
          "main",
          "--name",
          "repair parser session",
          "-p",
          "seed parser session"
        ],
        cwd: workDir,
        configDir,
        label: "slash resume seed parser"
      });
      const targetOutput = await runCli({
        args: [
          "--verbose",
          "--model",
          "main",
          "--name",
          "audit billing export",
          "-p",
          "seed billing session"
        ],
        cwd: workDir,
        configDir,
        label: "slash resume seed billing"
      });
      const targetSessionId = parseTextSessionId(targetOutput);
      const resumeResult = await runInteractiveCliWithTtySteps({
        cwd: workDir,
        configDir,
        label: "slash resume search TTY",
        steps: [
          { waitForText: "/help for commands", inputText: "/resume billing\r" },
          { waitForText: "matching billing", inputText: "\r" },
          { waitForText: `sessionId: ${targetSessionId}`, inputText: "/exit\r" }
        ],
        timeoutMs: INTERACTIVE_TUI_TIMEOUT_MS
      });
      assert(
        resumeResult.exitCode === 0,
        `slash resume search exited ${resumeResult.exitCode}\nSTDOUT:\n${resumeResult.stdout}\nSTDERR:\n${resumeResult.stderr}`
      );
      const resumeVisible = stripTerminalControls(`${resumeResult.stdout}\n${resumeResult.stderr}`);
      assert(resumeVisible.includes("resume sessions"), "slash /resume picker title did not render");
      assert(
        resumeVisible.includes("matching billing"),
        "slash /resume picker did not start with query filter"
      );
      assert(
        resumeVisible.includes("audit billing export"),
        "slash /resume picker did not show target title"
      );
      assert(
        resumeVisible.includes(`sessionId: ${targetSessionId}`),
        "slash /resume did not resume the selected session"
      );

      const noMatchResult = await runInteractiveCliWithTtySteps({
        cwd: workDir,
        configDir,
        label: "slash resume no match cancel TTY",
        steps: [
          { waitForText: "/help for commands", inputText: "/resume no-such-session-token\r" },
          { waitForText: "No matching sessions", inputText: "\x1b" },
          { waitForText: "> ", inputText: "/exit\r" }
        ],
        timeoutMs: INTERACTIVE_TUI_TIMEOUT_MS
      });
      assert(
        noMatchResult.exitCode === 0,
        `slash resume no-match exited ${noMatchResult.exitCode}\nSTDOUT:\n${noMatchResult.stdout}\nSTDERR:\n${noMatchResult.stderr}`
      );
      const noMatchVisible = stripTerminalControls(
        `${noMatchResult.stdout}\n${noMatchResult.stderr}`
      );
      assert(
        noMatchVisible.includes("No matching sessions"),
        "slash /resume picker did not show no-results state"
      );
      assert(
        !noMatchVisible.includes("sessionId:"),
        "slash /resume Escape path unexpectedly resumed a session"
      );
      return {
        score: 1,
        assertions: [
          "slash /resume opened searchable session picker",
          "slash /resume initial query filtered sessions",
          "slash /resume Enter resumed selected session",
          "slash /resume no-results state rendered",
          "slash /resume Escape returned without resuming"
        ],
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
      }
    });
    try {
      writeFileSync(
        path.join(configDir, "config.yaml"),
        renderConfig({ port: provider.port, fallbacks: true })
      );
      const output = await runCli({
        args: [
          "--model",
          "main",
          "--output-format",
          "stream-json",
          "-p",
          "Exercise retry and fallback."
        ],
        cwd: workDir,
        configDir,
        label: "retry fallback",
        timeoutMs: 45_000
      });
      assert(
        output.includes("fallback_switched"),
        "fallback event was not present in stream-json output"
      );
      assert(
        output.includes("fallback recovered"),
        "fallback route did not provide the final answer"
      );
      assert(
        primaryCalls === 3,
        `expected three fast attempts before fallback, got ${primaryCalls} primary calls`
      );
      assert(backupCalls === 1, `expected one backup call, got ${backupCalls}`);
      return {
        score: 1,
        assertions: [
          "retry attempts exhausted on primary",
          "fallback event emitted",
          "backup model recovered"
        ],
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
    const draftId = parseDraftId(
      await runCli({
        args: [
          "memory",
          "append",
          "project",
          [
            "## Graph CLI anchor",
            "Magi CLI exposes durable graph memory linking.",
            "",
            "## Linked workflow neighbor",
            "Run business-level verification after graph memory changes."
          ].join("\n")
        ],
        cwd: workDir,
        configDir,
        label: "memory graph append"
      })
    );
    await runCli({
      args: ["memory", "draft", "apply", draftId],
      cwd: workDir,
      configDir,
      label: "memory graph apply"
    });
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
        "0.9"
      ],
      cwd: workDir,
      configDir,
      label: "memory graph link"
    });
    assert(linked.includes("Linked Memory nodes:"), "memory link did not create an edge");
    assert(
      linked.includes("relates_to -> Linked workflow neighbor"),
      "memory link did not show the target node"
    );

    const search = await runCli({
      args: ["memory", "search", "durable graph memory linking"],
      cwd: workDir,
      configDir,
      label: "memory graph search"
    });
    assert(search.includes("Graph CLI anchor"), "memory graph search missed direct anchor");
    assert(
      search.includes("Linked workflow neighbor"),
      "memory graph search missed linked neighbor"
    );
    return {
      score: 1,
      assertions: [
        "memory draft applied",
        "graph edge created",
        "linked neighbor retrieved through graph search"
      ]
    };
  });
}

async function scenarioMemoryCorrection() {
  return await withTempWorkspace("memory-correction", async ({ configDir, workDir }) => {
    writeFileSync(path.join(configDir, "config.yaml"), renderConfig({ port: 9 }));
    await runCli({
      args: ["memory", "init"],
      cwd: workDir,
      configDir,
      label: "memory correction init"
    });
    const draftId = parseDraftId(
      await runCli({
        args: [
          "memory",
          "append",
          "user",
          "The user prefers verbose terminal dumps after verification."
        ],
        cwd: workDir,
        configDir,
        label: "memory correction append"
      })
    );
    await runCli({
      args: ["memory", "draft", "apply", draftId],
      cwd: workDir,
      configDir,
      label: "memory correction apply"
    });
    const before = await runCli({
      args: ["memory", "search", "verbose terminal dumps verification"],
      cwd: workDir,
      configDir,
      label: "memory correction search before"
    });
    assert(
      before.includes("verbose terminal dumps"),
      "correction precondition did not retrieve stale memory"
    );

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
      label: "memory correction correct"
    });
    assert(
      corrected.includes("Corrected Memory node:"),
      "memory correction did not dispute a node"
    );
    assert(corrected.includes("replacement:"), "memory correction did not create a replacement");
    const correctedNodeId = parseCorrectedNodeId(corrected);

    const after = await runCli({
      args: ["memory", "search", "verbose terminal dumps verification"],
      cwd: workDir,
      configDir,
      label: "memory correction search after"
    });
    assert(after.includes("concise verification summaries"), "replacement memory was not recalled");
    assert(
      !after.includes("prefers verbose terminal dumps"),
      "disputed stale memory was still recalled"
    );
    const conflicts = await runCli({
      args: ["memory", "conflicts"],
      cwd: workDir,
      configDir,
      label: "memory conflicts"
    });
    assert(
      conflicts.includes("Memory graph conflicts:"),
      "memory conflicts did not list graph conflicts"
    );
    assert(
      conflicts.includes("recommendation: prefer_from"),
      "memory conflicts did not recommend active replacement"
    );
    assert(
      conflicts.includes("edge reason:"),
      "memory conflicts did not include correction edge reason"
    );
    const dream = await runCli({
      args: ["memory", "dream"],
      cwd: workDir,
      configDir,
      label: "memory dream graph cleanup"
    });
    assert(
      dream.includes("archive_candidate"),
      "memory dream did not include graph archive candidate"
    );
    assert(dream.includes("Drafts:"), "memory dream did not create reviewable drafts");
    const dreamId = parseDreamId(dream);
    const appliedDream = await runCli({
      args: ["memory", "dream", "apply", dreamId],
      cwd: workDir,
      configDir,
      label: "memory dream apply graph cleanup"
    });
    assert(
      appliedDream.includes("Archived graph nodes: 1"),
      "memory dream apply did not archive graph node"
    );
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
      label: "memory maintenance config"
    });
    assert(
      maintenanceConfig.includes("Memory maintenance policy"),
      "memory maintenance config did not run"
    );
    assert(
      maintenanceConfig.includes("decay: 0.100"),
      "memory maintenance config did not persist decay"
    );
    const maintenancePreview = await runCli({
      args: ["memory", "maintain"],
      cwd: workDir,
      configDir,
      label: "memory maintenance preview"
    });
    assert(
      maintenancePreview.includes("Memory maintenance preview"),
      "memory maintenance preview did not run"
    );
    assert(
      maintenancePreview.includes("changed:"),
      "memory maintenance preview did not report changed count"
    );
    assert(
      maintenancePreview.includes("decay: 0.100"),
      "memory maintenance preview did not use configured policy"
    );
    const maintenanceApply = await runCli({
      args: ["memory", "maintain", "--apply"],
      cwd: workDir,
      configDir,
      label: "memory maintenance apply"
    });
    assert(
      maintenanceApply.includes("Memory maintenance applied"),
      "memory maintenance apply did not run"
    );
    assert(maintenanceApply.includes("->"), "memory maintenance did not report weight decay");
    const auditPath = path.join(configDir, "memory", "logs", "audit.jsonl");
    assert(existsSync(auditPath), "memory correction audit log was not written");
    const audit = readFileSync(auditPath, "utf8");
    assert(audit.includes("memory.corrected"), "memory correction audit event missing");
    assert(audit.includes("memory.dream.applied"), "memory dream apply audit event missing");
    assert(
      audit.includes("memory.maintenance.configured"),
      "memory maintenance config audit event missing"
    );
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
    "if (row.status !== expectedStatus) throw new Error(`expected ${expectedStatus}, got ${row.status}`);"
  ].join("\n");
  const result = spawnSync(
    nodeBin,
    [
      "--input-type=module",
      "-e",
      script,
      path.join(configDir, "state", "sessions.sqlite"),
      nodeId,
      expectedStatus
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        MAGI_CONFIG_DIR: configDir,
        MAGI_OPENAI_API_KEY: "test-key",
        NO_COLOR: "1"
      },
      encoding: "utf8"
    }
  );
  if (result.status !== 0) {
    throw new Error(
      `graph node status check failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
    );
  }
}

function outputLikeTranscriptHasToolSearchFeedback(transcript) {
  return transcript.includes("1. Glob") && transcript.includes("failure:path");
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
            toolCall("glob-ok-4", "Glob", { pattern: "**/*.md" })
          ]);
        }
        if (turn === 2) {
          assert(
            transcript.includes("Search path is outside allowed directories"),
            "Grep failure was not visible to the model"
          );
          assert(transcript.includes("No matches"), "Glob success was not visible to the model");
          return toolResponse([
            toolCall("tool-search-after-feedback", "ToolSearch", {
              query: "search workspace files",
              max_results: 5
            })
          ]);
        }
        assert(
          transcript.includes("Search path is outside allowed directories"),
          "Grep failure was not visible to the model"
        );
        assert(transcript.includes("No matches"), "Glob success was not visible to the model");
        assert(
          outputLikeTranscriptHasToolSearchFeedback(transcript),
          "ToolSearch feedback was not visible to the model"
        );
        return messageText("Tool feedback ranking completed.");
      }
    });
    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig({ port: provider.port }));
      const output = await runCli({
        args: [
          "--permission-mode",
          "acceptEdits",
          "--model",
          "main",
          "--output-format",
          "stream-json",
          "-p",
          "Exercise tool feedback ranking by trying search tools, then ask ToolSearch for workspace file search."
        ],
        cwd: workDir,
        configDir,
        label: "tool feedback ranking"
      });
      assert(
        output.includes("1. Glob"),
        "ToolSearch did not rank successful Glob ahead after feedback"
      );
      assert(output.includes("usage:+"), "ToolSearch did not report positive usage feedback");
      assert(output.includes("usage:-"), "ToolSearch did not report negative usage feedback");
      assert(output.includes("failure:path"), "ToolSearch did not report failure kind feedback");
      assert(
        output.includes(
          "recovery:path=use Glob for broad search or pass a workspace-relative path"
        ),
        "ToolSearch did not report recovery guidance"
      );
      const statsPath = path.join(configDir, "state", "tool-usage-stats.json");
      assert(existsSync(statsPath), "tool feedback stats were not persisted");
      const stats = JSON.parse(readFileSync(statsPath, "utf8"));
      assert(stats.tools?.Grep?.failures === 4, "Grep failures were not recorded");
      assert(stats.tools?.Glob?.successes === 4, "Glob successes were not recorded");
      return {
        score: 1,
        assertions: [
          "tool failures persisted",
          "tool successes persisted",
          "ToolSearch ranking used feedback",
          "ToolSearch recovery guidance visible"
        ],
        provider: provider.summary(),
        toolFeedback: {
          grepFailures: stats.tools.Grep.failures,
          globSuccesses: stats.tools.Glob.successes,
          recoveryGuidanceSeen: true
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
    const plan =
      "1. Inspect the requested files\n2. Show this plan before implementation\n3. Wait for approval";
    const provider = await startProvider({
      logPath: providerLog,
      routeRequest: ({ transcript }) => {
        turn += 1;
        if (turn === 1) {
          return toolResponse([
            toolCall("plan-write-denied", "FileWrite", {
              file_path: "should-not-edit.txt",
              content: "plan mode should block this"
            })
          ]);
        }
        if (turn === 2) {
          assert(
            transcript.includes("FileWrite is not allowed in plan mode"),
            "plan mode did not deny a write tool"
          );
          return toolResponse([toolCall("submit-plan", "ExitPlanMode", { plan })]);
        }
        assert(
          transcript.includes("Plan submitted for user approval"),
          "headless plan mode did not return a plan review result"
        );
        assert(
          transcript.includes("Show this plan before implementation"),
          "plan content was not visible after ExitPlanMode"
        );
        return messageText("Plan mode surfaced the plan and stopped before implementation.");
      }
    });
    try {
      writeFileSync(path.join(configDir, "config.yaml"), renderConfig({ port: provider.port }));
      const output = await runCli({
        args: [
          "--permission-mode",
          "plan",
          "--model",
          "main",
          "--output-format",
          "stream-json",
          "-p",
          "Plan a risky implementation before editing."
        ],
        cwd: workDir,
        configDir,
        label: "plan mode"
      });
      assert(output.includes("Plan mode surfaced the plan"), "plan mode final answer missing");
      assert(
        !existsSync(path.join(workDir, "should-not-edit.txt")),
        "plan mode should not mutate workspace"
      );
      const planStatus = await runCli({
        args: ["plan"],
        cwd: workDir,
        configDir,
        label: "plan status"
      });
      assert(planStatus.includes("Status: submitted"), "submitted plan was not persisted");
      assert(
        planStatus.includes("Show this plan before implementation"),
        "persisted plan did not include plan content"
      );
      return {
        score: 1,
        assertions: [
          "write denied in plan mode",
          "ExitPlanMode surfaced plan",
          "plan review persisted"
        ],
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
              content: "approved by mobile control"
            })
          ]);
        }
        assert(
          transcript.includes("Permission approved") ||
            transcript.includes("Wrote mobile-control.txt"),
          "control approval result was not returned to the model"
        );
        return messageText("CONTROL APPROVAL DONE");
      }
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
          background: true
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
          text.includes("agent.approval.pending") && text.includes("control.approval.resolved"),
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
      await waitFor(
        async () => {
          const response = await getJson(
            `${serve.url}/jobs/${encodeURIComponent(started.jobId)}`,
            headers
          );
          return response.job?.status === "completed";
        },
        "control job completion",
        10_000
      );
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
          "control job completed and persisted audit events"
        ],
        control: {
          port: controlPort,
          jobId: started.jobId,
          eventCount: events.events?.length ?? 0
        },
        provider: provider.summary(),
        filesVerified: ["mobile-control.txt"]
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
    const result = await runInteractiveTuiCommand({
      inputFile,
      cwd: workDir,
      configDir,
      timeoutMs: INTERACTIVE_TUI_TIMEOUT_MS
    });

    assert(
      result.code === 0,
      `interactive TUI exited ${result.code ?? result.signal}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
    );
    const combined = `${result.stdout}\n${result.stderr}`;
    assert(combined.includes("Magi v"), "TUI banner did not render");
    assert(combined.includes("/help for commands"), "TUI help hint did not render");
    assert(
      !combined.includes("Interactive terminal requires a TTY"),
      "TUI did not receive a pseudo-TTY"
    );
    return {
      score: 1,
      assertions: ["TUI banner rendered", "help hint rendered", "pseudo-TTY accepted"]
    };
  });
}

function runInteractiveTuiCommand({ inputFile, cwd, configDir, timeoutMs }) {
  return runPseudoTtyCliCommand({
    inputFile,
    cwd,
    configDir,
    args: [],
    label: "interactive TUI",
    timeoutMs
  });
}

function runPseudoTtyCliCommand({ inputFile, cwd, configDir, args, label, timeoutMs }) {
  const quotedCommand = `${shellQuote(nodeBin)} ${shellQuote(cliPath)} --no-color ${args
    .map(shellQuote)
    .join(" ")}`.trim();
  return process.platform === "darwin"
    ? runCommand({
        command: "/bin/sh",
        args: ["-c", `script -q /dev/null ${quotedCommand} < ${shellQuote(inputFile)}`],
        cwd,
        configDir,
        label,
        timeoutMs
      })
    : runCommand({
        command: "/bin/sh",
        args: [
          "-c",
          `script -q -e -c ${shellQuote(quotedCommand)} /dev/null < ${shellQuote(inputFile)}`
        ],
        cwd,
        configDir,
        label,
        timeoutMs
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
      timeoutMs: 15_000
    });

    assert(
      result.code === 2,
      `non-TTY TUI exited ${result.code ?? result.signal}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
    );
    assert(
      result.stdout.includes("Interactive terminal requires a TTY"),
      "non-TTY TUI did not explain the TTY requirement"
    );
    return {
      score: 1,
      assertions: ["non-TTY TUI exits clearly", "TTY requirement message emitted"]
    };
  });
}

async function scenarioSlashSuggestionPrompt() {
  return await withTempWorkspace("slash-suggestion", async () => {
    const { registry } = await import(pathToFileURL(path.join(repoRoot, "dist", "slash.js")).href);
    const { readTuiPrompt } = await import(
      pathToFileURL(path.join(repoRoot, "dist", "tui", "prompt-reader.js")).href
    );
    const slashCommands = [
      { name: "model", usage: "/model [alias]", description: "Switch model alias" },
      { name: "resume", usage: "/resume [query]", description: "Search and resume a session" },
      { name: "status", usage: "/status", description: "Show session status" }
    ];
    const registrySlashCommands = registry.getAll().map((command) => ({
      name: command.name,
      aliases: command.aliases,
      usage: command.usage,
      description: command.description
    }));

    const filtered = createPromptHarness();
    const filteredPrompt = readTuiPrompt({
      input: filtered.input,
      output: filtered.output,
      prompt: "> ",
      slashCommands
    });
    filtered.input.write("/resu");
    await sleep(10);
    const filteredVisible = stripTerminalControls(filtered.stdout());
    assert(
      filteredVisible.includes("commands matching /resu"),
      "slash suggestion did not render filtered header"
    );
    assert(filteredVisible.includes("/resume"), "slash suggestion missed matching /resume command");
    assert(!filteredVisible.includes("/model"), "slash suggestion did not filter nonmatching /model");
    filtered.input.write("\r");
    assert(
      (await filteredPrompt) === "/resume",
      "filtered slash suggestion did not submit /resume"
    );

    const selected = createPromptHarness();
    const selectedPrompt = readTuiPrompt({
      input: selected.input,
      output: selected.output,
      prompt: "> ",
      slashCommands
    });
    selected.input.write("/");
    await sleep(10);
    const menuVisible = stripTerminalControls(selected.stdout());
    assert(menuVisible.includes("commands"), "slash suggestion menu did not render for slash input");
    assert(menuVisible.includes("Tab complete"), "slash suggestion menu missed keyboard footer");
    selected.input.write("\x1b[B");
    await sleep(10);
    assert(
      stripTerminalControls(selected.stdout()).includes("❯ /resume"),
      "slash suggestion arrow selection did not move to /resume"
    );
    selected.input.write("\r");
    assert(
      (await selectedPrompt) === "/resume",
      "slash suggestion arrow selection did not submit /resume"
    );

    const coverage = createPromptHarness();
    const coveragePrompt = readTuiPrompt({
      input: coverage.input,
      output: coverage.output,
      prompt: "> ",
      slashCommands: registrySlashCommands,
      maxSlashSuggestions: 30
    });
    coverage.input.write("/plug");
    await sleep(10);
    const coverageVisible = stripTerminalControls(coverage.stdout());
    assert(
      coverageVisible.includes("/plugins"),
      "slash suggestion missed /plugins extension command"
    );
    assert(
      registrySlashCommands.some((command) => command.name === "context"),
      "slash registry missed /context command"
    );
    assert(
      registrySlashCommands.some((command) => command.name === "rules"),
      "slash registry missed /rules command"
    );
    assert(
      registrySlashCommands.some((command) => command.name === "run"),
      "slash registry missed /run"
    );
    assert(
      registrySlashCommands.some((command) => command.name === "agents"),
      "slash registry missed /agents command"
    );
    coverage.input.write("\r");
    assert((await coveragePrompt) === "/plugins", "slash suggestion did not submit /plugins");

    const skillAlias = createPromptHarness();
    const skillPrompt = readTuiPrompt({
      input: skillAlias.input,
      output: skillAlias.output,
      prompt: "> ",
      slashCommands: registrySlashCommands,
      maxSlashSuggestions: 30
    });
    skillAlias.input.write("/ski");
    await sleep(10);
    assert(
      stripTerminalControls(skillAlias.stdout()).includes("/skills"),
      "slash suggestion did not render /skills alias"
    );
    skillAlias.input.write("\r");
    assert((await skillPrompt) === "/skills", "slash suggestion did not submit /skills alias");

    return {
      score: 1,
      assertions: [
        "slash suggestion menu rendered for slash input",
        "slash suggestion filtered command descriptions",
        "slash suggestion arrow selection submitted command",
        "slash suggestion enter submitted filtered command",
        "slash command coverage included context rules run extensions agents",
        "slash suggestion submitted extension command",
        "slash suggestion submitted command alias"
      ]
    };
  });
}

async function scenarioHarnessCiTuiGuard() {
  return await withTempWorkspace("ci-tui-guard", async ({ configDir, workDir }) => {
    const ciDefault = shouldRunInteractiveTui({ MAGI_BLACKBOX_TUI: "1", CI: "true" });
    const ciForced = shouldRunInteractiveTui({
      MAGI_BLACKBOX_TUI: "1",
      MAGI_BLACKBOX_TUI_FORCE: "1",
      CI: "true"
    });
    const localEnabled = shouldRunInteractiveTui({ MAGI_BLACKBOX_TUI: "1" });
    assert(ciDefault === false, "CI should skip interactive TUI unless forced");
    assert(ciForced === true, "forced CI should run interactive TUI");
    assert(localEnabled === true, "local opt-in should run interactive TUI");

    const timeout = await runCommand({
      command: nodeBin,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: workDir,
      configDir,
      label: "hanging child timeout guard",
      timeoutMs: 200
    }).then(
      () => ({ timedOut: false, message: "" }),
      (error) => ({ timedOut: true, message: error instanceof Error ? error.message : String(error) })
    );
    assert(timeout.timedOut, "hanging child command did not time out");
    assert(timeout.message.includes("was terminated"), "timeout did not report termination");

    return {
      score: 1,
      assertions: [
        "CI skips interactive TUI unless forced",
        "forced CI can opt into interactive TUI",
        "local opt-in can run interactive TUI",
        "hanging child commands time out and terminate"
      ]
    };
  });
}

function shouldRunInteractiveTui(env = process.env) {
  return (
    env.MAGI_BLACKBOX_TUI === "1" &&
    (env.MAGI_BLACKBOX_TUI_FORCE === "1" || env.CI !== "true")
  );
}

function createPromptHarness() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (mode) => {
    input.isRaw = mode;
    return input;
  };
  let text = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString("utf8");
      callback();
    }
  });
  output.isTTY = true;
  output.columns = 80;
  return {
    input,
    output,
    stdout: () => text
  };
}

function stripTerminalControls(text) {
  return text
    .replace(/\x1b\[[0-9;?]*(?:[ -/]*[@-~])/g, "")
    .replace(/\x1b[>=]/g, "")
    .replace(/\r/g, "");
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
  assert(
    existsSync(harnessReportPath),
    "dist/harness-report.js not found; run npm run build first"
  );
  harnessReport = await import("../dist/harness-report.js");
  const scenarios = [
    ["complex workflow", scenarioComplexWorkflow],
    ["default permission denied", scenarioDefaultPermissionDenied],
    ["help shape", scenarioHelpShape],
    ["text output protocol", scenarioTextOutputProtocol],
    ["json output protocol", scenarioJsonOutputProtocol],
    ["tool policy allow deny", scenarioToolPolicyAllowDeny],
    ["bare prompt headless", scenarioBarePromptHeadless],
    ["resume picker TTY", scenarioResumePickerTty],
    ["slash resume search TTY", scenarioSlashResumeSearchTty],
    ["retry fallback", scenarioRetryAndFallback],
    ["memory graph link", scenarioMemoryGraphLink],
    ["memory correction", scenarioMemoryCorrection],
    ["tool feedback ranking", scenarioToolFeedbackRanking],
    ["plan mode", scenarioPlanMode],
    ["control approval flow", scenarioControlApprovalFlow],
    ["slash suggestion prompt", scenarioSlashSuggestionPrompt],
    ["TUI requires TTY", scenarioTuiRequiresTty],
    ["harness CI TUI guard", scenarioHarnessCiTuiGuard]
  ];
  if (process.env.MAGI_BLACKBOX_TUI === "1" && !shouldRunInteractiveTui()) {
    console.log(
      "\nSkipping interactive TUI scenario in CI; set MAGI_BLACKBOX_TUI_FORCE=1 to force it."
    );
  } else if (shouldRunInteractiveTui()) {
    scenarios.push(["interactive TUI", scenarioInteractiveTui]);
  }
  const results = [];
  for (const [name, fn] of scenarios) {
    results.push(await runScenario(name, fn));
  }
  const report = harnessReport.buildHarnessReport({
    name: "blackbox-e2e",
    startedAt,
    scenarios: results
  });
  writeReport(report);
  if (report.status !== "passed") {
    console.error(
      `\nBlack-box E2E matrix failed (${report.summary.failed}/${report.summary.total} scenarios).`
    );
    process.exit(1);
  }
  console.log(
    `\nBlack-box E2E matrix passed (${report.summary.passed} scenarios, score=${report.summary.score.toFixed(2)}).`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
