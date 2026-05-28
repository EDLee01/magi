import http from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { getMagiPaths } from "../src/paths.js";
import { makeTempRoot, TempRoot } from "./helpers.js";

let temp: TempRoot | undefined;
let server: http.Server | undefined;

afterEach(async () => {
  if (server) {
    await closeServer(server);
    server = undefined;
  }
  temp?.cleanup();
  temp = undefined;
});

describe("CLI entrypoint", () => {
  it("runs magi --version", async () => {
    const result = await runCli(["--version"], {}, process.cwd());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^magi 0\.1\.0-alpha\.0/);
  });

  it("runs magi doctor and displays the isolation root", async () => {
    temp = makeTempRoot();
    const result = await runCli(["doctor"], temp.env, process.cwd());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`configRoot: ${temp.path}`);
    expect(result.stdout).toContain("legacyAccessDetected: no");
  });

  it("runs magi config and reads generated config", async () => {
    temp = makeTempRoot();
    const result = await runCli(["config"], temp.env, process.cwd());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`configFile: ${path.join(temp.path, "config.yaml")}`);
    expect(result.stdout).toContain("providers: {}");
    expect(result.stdout).toContain("fallbacks: {}");
  });

  it("runs magi -p through the headless path", async () => {
    temp = makeTempRoot();
    const result = await runCli(["-p", "write a short status"], temp.env, process.cwd());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No provider is configured");
    expect(result.stdout).toContain("sessionId:");
    expect(existsSync(getMagiPaths(temp.env).sessionDbFile)).toBe(true);
  });

  it("treats a bare prompt argument as a headless prompt", async () => {
    temp = makeTempRoot();
    const result = await runCli(["write", "a", "short", "status"], temp.env, process.cwd());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No provider is configured");
    expect(result.stdout).toContain("sessionId:");
  });

  it("supports --print as an alias for -p", async () => {
    temp = makeTempRoot();
    const result = await runCli(["--print", "write a short status"], temp.env, process.cwd());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("sessionId:");
  });

  it("supports json output for headless prompts", async () => {
    temp = makeTempRoot();
    const result = await runCli(["--output-format", "json", "-p", "write a short status"], temp.env, process.cwd());
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout) as { sessionId: string; jobId: string; message: string };
    expect(body.sessionId).toBeTruthy();
    expect(body.jobId).toBeTruthy();
    expect(body.message).toContain("No provider is configured");
  });

  it("loads MAGI_* secrets from the runtime .env before provider requests", async () => {
    temp = makeTempRoot();
    const requests: Array<{ authorization: string | undefined }> = [];
    server = http.createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) {
        raw += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : Buffer.from(chunk).toString("utf8");
      }
      requests.push({ authorization: request.headers.authorization });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { content: "ENV OK" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      }));
    });
    const baseUrl = await listen(server);
    const paths = getMagiPaths(temp.env);
    writeFileSync(paths.configFile, [
      "version: 0.1",
      "providers:",
      "  main:",
      "    type: openai",
      "    apiKeyEnv: MAGI_OPENAI_API_KEY",
      `    baseUrl: ${baseUrl}/v1`,
      "models:",
      "  aliases:",
      "    main: main:gpt-main",
      "  fallbacks: {}",
      ""
    ].join("\n"), "utf8");
    writeFileSync(path.join(temp.path, ".env"), [
      "ANTHROPIC_AUTH_TOKEN=ignored",
      "export MAGI_OPENAI_API_KEY=runtime-env-key",
      ""
    ].join("\n"), "utf8");

    const result = await runCli(["--model", "main", "-p", "use configured env"], temp.env, process.cwd());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ENV OK");
    expect(requests).toEqual([{ authorization: "Bearer runtime-env-key" }]);
  });

  it("continues the most recent cwd session with -c", async () => {
    temp = makeTempRoot();
    const first = await runCli(["-p", "write a short status"], temp.env, process.cwd());
    const firstId = /sessionId: ([^\n]+)/.exec(first.stdout)?.[1];
    const second = await runCli(["-c", "-p", "write another short status"], temp.env, process.cwd());
    const secondId = /sessionId: ([^\n]+)/.exec(second.stdout)?.[1];
    expect(secondId).toBe(firstId);
  });

  it("resumes a specific session with -r and supports session names", async () => {
    temp = makeTempRoot();
    const first = await runCli(["--name", "named run", "-p", "write a short status"], temp.env, process.cwd());
    const id = /sessionId: ([^\n]+)/.exec(first.stdout)?.[1];
    expect(id).toBeTruthy();

    const second = await runCli(["-r", id!, "-p", "write again"], temp.env, process.cwd());
    expect(second.stdout).toContain(`sessionId: ${id}`);

    const resume = await runCli(["resume", id!], temp.env, process.cwd());
    expect(resume.stdout).toContain("title: named run");
  });

  it("supports explicit session ids and no session persistence", async () => {
    temp = makeTempRoot();
    const explicitId = "11111111-1111-4111-8111-111111111111";
    const explicit = await runCli(["--session-id", explicitId, "-p", "write a short status"], temp.env, process.cwd());
    expect(explicit.stdout).toContain(`sessionId: ${explicitId}`);

    const ephemeral = await runCli(
      ["--no-session-persistence", "--output-format", "json", "-p", "write a short status"],
      temp.env,
      process.cwd()
    );
    const body = JSON.parse(ephemeral.stdout) as { sessionId: string; message: string };
    expect(body.sessionId).toBeTruthy();
    expect(body.message).toContain("No provider is configured");
  });

  it("manages active goals from the CLI", async () => {
    temp = makeTempRoot();
    const create = await runCli(["goal", "ship", "goal", "support"], temp.env, process.cwd());
    expect(create.exitCode).toBe(0);
    expect(create.stdout).toContain("Goal started: ship goal support");

    const status = await runCli(["goal"], temp.env, process.cwd());
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("Goal: ship goal support");
    expect(status.stdout).toContain("Status: active");

    const replacement = await runCli(["goal", "ship", "replacement"], temp.env, process.cwd());
    expect(replacement.exitCode).toBe(0);
    expect(replacement.stdout).toContain("Goal started: ship replacement");

    const afterReplacement = await runCli(["goal"], temp.env, process.cwd());
    expect(afterReplacement.exitCode).toBe(0);
    expect(afterReplacement.stdout).toContain("Goal: ship replacement");
  });

  it("injects active goals into resumed model context", async () => {
    temp = makeTempRoot();
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    server = http.createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) {
        raw += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : Buffer.from(chunk).toString("utf8");
      }
      requests.push(JSON.parse(raw) as { messages: Array<{ role: string; content: string }> });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { content: "GOAL OK" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      }));
    });
    const baseUrl = await listen(server);
    const paths = getMagiPaths(temp.env);
    writeFileSync(paths.configFile, [
      "version: 0.1",
      "providers:",
      "  main:",
      "    type: openai",
      "    apiKeyEnv: MAGI_OPENAI_API_KEY",
      `    baseUrl: ${baseUrl}/v1`,
      "models:",
      "  aliases:",
      "    main: main:gpt-main",
      "  fallbacks: {}",
      ""
    ].join("\n"), "utf8");

    await runCli(["goal", "finish", "the", "migration"], temp.env, process.cwd());
    const result = await runCli(["-c", "-p", "continue"], { ...temp.env, MAGI_OPENAI_API_KEY: "test-key" }, process.cwd());

    expect(result.exitCode).toBe(0);
    expect(requests[0].messages[0].role).toBe("system");
    expect(requests[0].messages[0].content).toContain("<active_thread_goal>");
    expect(requests[0].messages[0].content).toContain("Objective: finish the migration");
  });

  it("lists resume choices when -r has no value", async () => {
    temp = makeTempRoot();
    await runCli(["--name", "resume search target", "-p", "write a short status"], temp.env, process.cwd());
    const result = await runCli(["-r"], temp.env, process.cwd());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Resume sessions:");
    expect(result.stdout).toContain("resume search target");
  });

  it("supports stream-json output as newline-delimited JSON", async () => {
    temp = makeTempRoot();
    const result = await runCli(["--output-format", "stream-json", "-p", "write a short status"], temp.env, process.cwd());
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as { type: string; jobId?: string });
    expect(lines[0]).toMatchObject({ type: "session.started" });
    expect(lines.at(-1)).toMatchObject({ type: "session.completed" });
    expect(lines.at(-1)?.jobId).toBeTruthy();
  });

  it("uses config context settings for headless auto compaction with explicit compaction model", async () => {
    temp = makeTempRoot();
    const calls: Array<{ model: string; body: Record<string, unknown> }> = [];
    server = http.createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) {
        raw += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : Buffer.from(chunk).toString("utf8");
      }
      const body = JSON.parse(raw) as { model: string; messages: Array<{ content: string }> };
      calls.push({ model: body.model, body: body as Record<string, unknown> });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { content: body.model === "gpt-compact" ? "COMPACT SUMMARY" : "FINAL ANSWER" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      }));
    });
    const baseUrl = await listen(server);
    const paths = getMagiPaths(temp.env);
    writeFileSync(paths.configFile, [
      "version: 0.1",
      "providers:",
      "  main:",
      "    type: openai",
      "    apiKeyEnv: MAGI_OPENAI_API_KEY",
      `    baseUrl: ${baseUrl}/v1`,
      "models:",
      "  aliases:",
      "    main: main:gpt-main",
      "    compact: main:gpt-compact",
      "  fallbacks: {}",
      "context:",
      "  recentMessages: 2",
      "  autoCompactTokenThreshold: 1",
      "  compactionModel: compact",
      ""
    ].join("\n"), "utf8");

    const first = await runCli(["-p", `${"x".repeat(200)}`], { ...temp.env, MAGI_OPENAI_API_KEY: "test-key" }, process.cwd());
    expect(first.exitCode).toBe(0);
    const sessionId = /sessionId: ([^\n]+)/.exec(first.stdout)?.[1];
    expect(sessionId).toBeTruthy();

    // Clear call records from the compaction run
    calls.length = 0;

    const second = await runCli(
      ["--model", "main", "--session-id", sessionId!, "-p", "continue"],
      { ...temp.env, MAGI_OPENAI_API_KEY: "test-key" },
      process.cwd()
    );

    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("FINAL ANSWER");
    expect(calls.map((call) => call.model)).toEqual(["gpt-compact", "gpt-main"]);
    expect(JSON.stringify(calls[1].body)).toContain("COMPACT SUMMARY");
  });

  it("exposes configured MCP tools to the headless provider loop", async () => {
    temp = makeTempRoot();
    const calls: Array<{ model: string; body: Record<string, unknown> }> = [];
    server = http.createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) {
        raw += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : Buffer.from(chunk).toString("utf8");
      }
      const body = JSON.parse(raw) as { model: string; messages: Array<{ role: string }>; tools?: Array<{ function: { name: string } }> };
      calls.push({ model: body.model, body: body as Record<string, unknown> });
      const hasToolResult = body.messages.some((message) => message.role === "tool");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{
          message: hasToolResult
            ? { content: "MCP FINAL" }
            : {
              content: "",
              tool_calls: [{
                id: "mcp-cli-1",
                type: "function",
                function: {
                  name: "mcp__notes__read_note",
                  arguments: JSON.stringify({ key: "alpha" })
                }
              }]
            }
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      }));
    });
    const baseUrl = await listen(server);
    const paths = getMagiPaths(temp.env);
    writeFileSync(paths.configFile, [
      "version: 0.1",
      "providers:",
      "  main:",
      "    type: openai",
      "    apiKeyEnv: MAGI_OPENAI_API_KEY",
      `    baseUrl: ${baseUrl}/v1`,
      "models:",
      "  aliases:",
      "    main: main:gpt-main",
      "  fallbacks: {}",
      "mcp:",
      "  servers:",
      "    notes:",
      "      command: node",
      `      args: ["${path.join(process.cwd(), "tests/fixtures/mock-mcp-server.mjs")}"]`,
      "      approval: dangerous",
      ""
    ].join("\n"), "utf8");

    const result = await runCli(
      ["--model", "main", "-p", "use mcp"],
      { ...temp.env, MAGI_OPENAI_API_KEY: "test-key" },
      process.cwd()
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("MCP FINAL");
    const tools = calls[0].body.tools as Array<{ function: { name: string } }>;
    expect(tools.map((tool) => tool.function.name)).toContain("mcp__notes__read_note");
    expect(JSON.stringify(calls[1].body)).toContain("called read_note");
  });

  it("includes compatibility-shaped options in help", async () => {
    const result = await runCli(["--help"], {}, process.cwd());
    expect(result.stdout).toContain("--model");
    expect(result.stdout).toContain("-c -p");
    expect(result.stdout).toContain("--output-format json");
    expect(result.stdout).toContain("workspace diagnose");
  });

  it("runs workspace diagnostics from the CLI", async () => {
    temp = makeTempRoot();
    writeFileSync(path.join(temp.path, "package.json"), JSON.stringify({
      name: "cli-diagnostics",
      scripts: { test: "vitest run" },
      devDependencies: { vitest: "^3.0.0" }
    }), "utf8");
    writeFileSync(path.join(temp.path, "package-lock.json"), "{}", "utf8");
    writeFileSync(path.join(temp.path, "index.ts"), "export const ok = true;\n", "utf8");

    const text = await runCli(["workspace", "diagnose"], temp.env, temp.path);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("Workspace Diagnostics");
    expect(text.stdout).toContain("package manager: npm");
    expect(text.stdout).toContain("- npm run test");

    const json = await runCli(["--output-format", "json", "workspace", "diagnose"], temp.env, temp.path);
    expect(json.exitCode).toBe(0);
    const parsed = JSON.parse(json.stdout) as { packageManager: string; languages: Array<{ name: string }> };
    expect(parsed.packageManager).toBe("npm");
    expect(parsed.languages).toContainEqual(expect.objectContaining({ name: "TypeScript" }));
  });

  it("does not expose a magi-agent binary or package bin", () => {
    const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      bin?: Record<string, string>;
    };
    expect(packageJson.bin).toEqual({ magi: "./dist/cli.js" });
    expect(packageJson.bin).not.toHaveProperty("magi-agent");
  });
});

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP test server did not bind");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
