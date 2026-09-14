import http from "node:http";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { getMagiPaths } from "../src/paths.js";
import { MemoryNodeStore } from "../src/memory-node-store.js";
import { SessionStore } from "../src/session-store.js";
import {
  daemonControlCredentialsFile,
  readDaemonControlCredentials,
  writeDaemonPidFile
} from "../src/control/daemon.js";
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
    expect(result.stdout).toBe("magi 0.1.14\n");
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

  it("prints a scannable pairing URL and QR code for mobile panels", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    server = http.createServer(async (request, response) => {
      expect(request.url).toBe("/pairing");
      let raw = "";
      for await (const chunk of request) {
        raw += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : Buffer.from(chunk).toString("utf8");
      }
      expect(JSON.parse(raw)).toMatchObject({ name: "phone" });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          deviceId: "device_cli_pair",
          token: "magi_cli_pair_token",
          expiresAt: "2026-05-30T00:00:00.000Z"
        })
      );
    });
    const baseUrl = await listen(server);
    const port = Number(new URL(baseUrl).port);
    writeDaemonPidFile(paths, { pid: process.pid, port, bind: "0.0.0.0" });

    const result = await runCli(["pair", "phone"], temp.env, process.cwd());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Pairing URL:");
    expect(result.stdout).toContain("/panel?device=device_cli_pair&token=magi_cli_pair_token");
    expect(result.stdout).toContain("Scan this QR code");
    expect(result.stdout).toMatch(/[▄▀█]/);
    expect(result.stdout).not.toContain("token NOT in URL");
  });

  it("authenticates magi kill with a loopback-paired daemon token stored as 0600", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    const requests: string[] = [];
    server = http.createServer(async (request, response) => {
      requests.push(request.url ?? "");
      if (request.url === "/pairing") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            deviceId: "local-cli-device",
            token: "magi_local_cli_token",
            expiresAt: "2099-01-01T00:00:00.000Z"
          })
        );
        return;
      }
      expect(request.url).toBe("/jobs/job-1/cancel");
      expect(request.headers["x-magi-device-id"]).toBe("local-cli-device");
      expect(request.headers.authorization).toBe("Bearer magi_local_cli_token");
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}\n');
    });
    const baseUrl = await listen(server);
    const port = Number(new URL(baseUrl).port);
    writeDaemonPidFile(paths, { pid: process.pid, port, bind: "127.0.0.1" });

    const result = await runCli(["kill", "job-1"], temp.env, process.cwd());

    expect(result).toMatchObject({ exitCode: 0, stdout: "Cancelled job job-1\n", stderr: "" });
    expect(requests).toEqual(["/pairing", "/jobs/job-1/cancel"]);
    expect(readDaemonControlCredentials(paths)).toMatchObject({
      deviceId: "local-cli-device",
      token: "magi_local_cli_token"
    });
    expect(statSync(daemonControlCredentialsFile(paths)).mode & 0o777).toBe(0o600);
  });

  it("runs magi -p through the headless path", async () => {
    temp = makeTempRoot();
    const result = await runCli(["-p", "write a short status"], temp.env, process.cwd());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No provider is configured");
    expect(result.stdout).not.toContain("sessionId:");
    expect(result.stdout).not.toContain("jobId:");
    expect(result.stdout).not.toContain("stateDb:");
    expect(existsSync(getMagiPaths(temp.env).sessionDbFile)).toBe(true);
  });

  it("prints text metadata only when verbose is requested", async () => {
    temp = makeTempRoot();
    const result = await runCli(
      ["--verbose", "-p", "write a short status"],
      temp.env,
      process.cwd()
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No provider is configured");
    expect(result.stdout).toContain("sessionId:");
    expect(result.stdout).toContain("jobId:");
    expect(result.stdout).toContain("stateDb:");
    expect(existsSync(getMagiPaths(temp.env).sessionDbFile)).toBe(true);
  });

  it("treats a bare prompt argument as a headless prompt", async () => {
    temp = makeTempRoot();
    const result = await runCli(["write", "a", "short", "status"], temp.env, process.cwd());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No provider is configured");
    expect(result.stdout).not.toContain("sessionId:");
  });

  it("supports --print as an alias for -p", async () => {
    temp = makeTempRoot();
    const result = await runCli(
      ["--verbose", "--print", "write a short status"],
      temp.env,
      process.cwd()
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("sessionId:");
  });

  it("supports json output for headless prompts", async () => {
    temp = makeTempRoot();
    const result = await runCli(
      ["--output-format", "json", "-p", "write a short status"],
      temp.env,
      process.cwd()
    );
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout) as {
      sessionId: string;
      jobId: string;
      status: string;
      message: string;
      provider: string;
      model: string;
      usage: { inputTokens: number; outputTokens: number };
    };
    expect(body.sessionId).toBeTruthy();
    expect(body.jobId).toBeTruthy();
    expect(body.status).toBe("recorded");
    expect(body.message).toContain("No provider is configured");
    expect(body.provider).toBe("none");
    expect(body.model).toBe("none");
    expect(body.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("includes provider model and usage in json output", async () => {
    temp = makeTempRoot();
    server = http.createServer(async (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { content: "JSON STATUS OK" } }],
          usage: { prompt_tokens: 7, completion_tokens: 3 }
        })
      );
    });
    const baseUrl = await listen(server);
    const paths = getMagiPaths(temp.env);
    writeFileSync(
      paths.configFile,
      [
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
      ].join("\n"),
      "utf8"
    );

    const result = await runCli(
      ["--model", "main", "--output-format", "json", "-p", "write json status"],
      { ...temp.env, MAGI_OPENAI_API_KEY: "test-key" },
      process.cwd()
    );

    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout) as {
      status: string;
      message: string;
      provider: string;
      model: string;
      usage: { inputTokens: number; outputTokens: number };
    };
    expect(body).toMatchObject({
      status: "completed",
      message: "JSON STATUS OK",
      provider: "main",
      model: "gpt-main",
      usage: { inputTokens: 7, outputTokens: 3 }
    });
  });

  it("returns json errors when json output is requested", async () => {
    const result = await runCli(["--output-format", "json", "resume"], {}, process.cwd());

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("");
    const body = JSON.parse(result.stdout) as {
      status: string;
      exitCode: number;
      error: { kind: string; message: string };
    };
    expect(body).toEqual({
      status: "failed",
      exitCode: 2,
      error: { kind: "usage", message: "magi resume requires a session id" }
    });
  });

  it("uses memory.writeDecisionModel instead of selectionModel for memory write decisions", async () => {
    temp = makeTempRoot();
    const calls: Array<{ model: string; text: string }> = [];
    server = http.createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) {
        raw += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : Buffer.from(chunk).toString("utf8");
      }
      const body = JSON.parse(raw) as { model: string; messages: Array<{ content: string }> };
      const text = body.messages.map((message) => String(message.content ?? "")).join("\n");
      calls.push({ model: body.model, text });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  body.model === "gpt-memory-write"
                    ? JSON.stringify({
                        action: "write",
                        scope: "user",
                        type: "preference",
                        content: "User prefers concise memory write checks.",
                        confidence: 0.91
                      })
                    : "WRITE DECISION MODEL OK"
              }
            }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        })
      );
    });
    const baseUrl = await listen(server);
    const paths = getMagiPaths(temp.env);
    writeFileSync(
      paths.configFile,
      [
        "version: 0.1",
        "providers:",
        "  main:",
        "    type: openai",
        "    apiKeyEnv: MAGI_OPENAI_API_KEY",
        `    baseUrl: ${baseUrl}/v1`,
        "models:",
        "  aliases:",
        "    main: main:gpt-main",
        "    select: main:gpt-memory-select",
        "    decide: main:gpt-memory-write",
        "  fallbacks: {}",
        "memory:",
        "  enabled: true",
        "  autoWrite: explicit",
        "  maxResults: 4",
        "  selectionModel: select",
        "  writeDecisionModel: decide",
        "  scopes:",
        "    - user",
        "    - project",
        "    - session",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await runCli(
      ["--model", "main", "-p", "remember that I prefer concise memory write checks"],
      { ...temp.env, MAGI_OPENAI_API_KEY: "test-key" },
      process.cwd()
    );

    expect(result.exitCode).toBe(0);
    expect(calls.map((call) => call.model)).toEqual(["gpt-memory-write", "gpt-main"]);
    expect(calls.map((call) => call.model)).not.toContain("gpt-memory-select");
    const nodeStore = MemoryNodeStore.open(paths);
    try {
      expect(
        nodeStore
          .listHotNodes({ limit: 10, minWeight: 0 })
          .some((node) => node.body === "User prefers concise memory write checks.")
      ).toBe(true);
    } finally {
      nodeStore.close();
    }
  });

  it("loads MAGI_* secrets from the runtime .env before provider requests", async () => {
    temp = makeTempRoot();
    const requests: Array<{ authorization: string | undefined }> = [];
    server = http.createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) {
        raw += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : Buffer.from(chunk).toString("utf8");
      }
      requests.push({ authorization: request.headers.authorization });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { content: "ENV OK" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        })
      );
    });
    const baseUrl = await listen(server);
    const paths = getMagiPaths(temp.env);
    writeFileSync(
      paths.configFile,
      [
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
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(temp.path, ".env"),
      ["ANTHROPIC_AUTH_TOKEN=ignored", "export MAGI_OPENAI_API_KEY=runtime-env-key", ""].join("\n"),
      "utf8"
    );

    const result = await runCli(
      ["--model", "main", "-p", "use configured env"],
      temp.env,
      process.cwd()
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ENV OK");
    expect(requests).toEqual([{ authorization: "Bearer runtime-env-key" }]);
  });

  it("continues the most recent cwd session with -c", async () => {
    temp = makeTempRoot();
    const first = await runCli(
      ["--verbose", "-p", "write a short status"],
      temp.env,
      process.cwd()
    );
    const firstId = /sessionId: ([^\n]+)/.exec(first.stdout)?.[1];
    const second = await runCli(
      ["--verbose", "-c", "-p", "write another short status"],
      temp.env,
      process.cwd()
    );
    const secondId = /sessionId: ([^\n]+)/.exec(second.stdout)?.[1];
    expect(secondId).toBe(firstId);
  });

  it("resumes a specific session with -r and supports session names", async () => {
    temp = makeTempRoot();
    const first = await runCli(
      ["--verbose", "--name", "named run", "-p", "write a short status"],
      temp.env,
      process.cwd()
    );
    const id = /sessionId: ([^\n]+)/.exec(first.stdout)?.[1];
    expect(id).toBeTruthy();

    const second = await runCli(
      ["--verbose", "-r", id!, "-p", "write again"],
      temp.env,
      process.cwd()
    );
    expect(second.stdout).toContain(`sessionId: ${id}`);

    const resume = await runCli(["resume", id!], temp.env, process.cwd());
    expect(resume.stdout).toContain("title: named run");
  });

  it("supports explicit session ids and no session persistence", async () => {
    temp = makeTempRoot();
    const explicitId = "11111111-1111-4111-8111-111111111111";
    const explicit = await runCli(
      ["--verbose", "--session-id", explicitId, "-p", "write a short status"],
      temp.env,
      process.cwd()
    );
    expect(explicit.stdout).toContain(`sessionId: ${explicitId}`);

    const ephemeral = await runCli(
      ["--no-session-persistence", "--output-format", "json", "-p", "write a short status"],
      temp.env,
      process.cwd()
    );
    const body = JSON.parse(ephemeral.stdout) as {
      sessionId: string;
      status: string;
      message: string;
      provider: string;
      model: string;
    };
    expect(body.sessionId).toBeTruthy();
    // --no-session-persistence now runs the full agent path against an
    // in-memory store (so tools work in ephemeral mode); with no provider
    // configured it reports the shared "recorded" no-provider result rather
    // than the old bare-provider-call "completed" stub.
    expect(body.status).toBe("recorded");
    expect(body.message).toContain("No provider is configured");
    expect(body.provider).toBe("none");
    expect(body.model).toBe("none");
  });

  it("shows empty goal status before any session exists", async () => {
    temp = makeTempRoot();
    const status = await runCli(["goal"], temp.env, process.cwd());
    const list = await runCli(["goal", "list"], temp.env, process.cwd());

    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("No active goal.");
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toBe("No goals for this session.\n");
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

    const list = await runCli(["goal", "list"], temp.env, process.cwd());
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain("Goals for this session:");
    expect(list.stdout).toContain("active");
    expect(list.stdout).toContain("ship replacement");
    expect(list.stdout).toContain("cancelled");
    expect(list.stdout).toContain("ship goal support");

    const blocked = await runCli(
      ["goal", "blocked", "waiting", "on", "review"],
      temp.env,
      process.cwd()
    );
    expect(blocked.exitCode).toBe(0);
    expect(blocked.stdout).toContain("Goal blocked: ship replacement");

    const afterBlocked = await runCli(["goal"], temp.env, process.cwd());
    expect(afterBlocked.exitCode).toBe(0);
    expect(afterBlocked.stdout).toContain("No active goal.");

    const next = await runCli(
      ["goal", "close", "the", "remaining", "work"],
      temp.env,
      process.cwd()
    );
    expect(next.exitCode).toBe(0);
    expect(next.stdout).toContain("Goal started: close the remaining work");

    const completed = await runCli(["goal", "done", "verified"], temp.env, process.cwd());
    expect(completed.exitCode).toBe(0);
    expect(completed.stdout).toContain("Goal completed: close the remaining work");

    const afterDone = await runCli(["goal"], temp.env, process.cwd());
    expect(afterDone.exitCode).toBe(0);
    expect(afterDone.stdout).toContain("No active goal.");
  });

  it("shows submitted plans from the CLI", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    const sessionId = "33333333-3333-4333-8333-333333333333";
    await runCli(
      ["--session-id", sessionId, "-p", "prepare plan session"],
      temp.env,
      process.cwd()
    );
    const { recordPlanReview, updatePlanReviewStatus } = await import("../src/plan-state.js");
    const plan = recordPlanReview({
      stateRoot: paths.stateRoot,
      sessionId,
      jobId: "job-plan-cli",
      toolUseId: "exit-plan-cli",
      plan: "1. Inspect\n2. Implement\n3. Verify"
    });
    updatePlanReviewStatus(paths.stateRoot, plan.id, {
      status: "approved",
      response: "Yes, proceed"
    });

    const show = await runCli(["plan", "--session-id", sessionId], temp.env, process.cwd());
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain(`Plan: ${plan.id}`);
    expect(show.stdout).toContain("Status: approved");
    expect(show.stdout).toContain("1. Inspect");

    const list = await runCli(["plan", "list", "--session-id", sessionId], temp.env, process.cwd());
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain("Submitted plans:");
    expect(list.stdout).toContain(plan.id);
  });

  it("shows plan revision links from the CLI", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    const sessionId = "33333333-3333-4333-8333-333333333336";
    await runCli(
      ["--session-id", sessionId, "-p", "prepare plan chain session"],
      temp.env,
      process.cwd()
    );
    const { recordPlanReview } = await import("../src/plan-state.js");
    const original = recordPlanReview({
      stateRoot: paths.stateRoot,
      sessionId,
      plan: "1. Edit immediately",
      status: "needs_revision",
      response: "No, revise"
    });
    const revised = recordPlanReview({
      stateRoot: paths.stateRoot,
      sessionId,
      plan: "1. Inspect first\n2. Verify before editing",
      status: "approved",
      response: "Yes, proceed",
      revisesPlanId: original.id
    });

    const show = await runCli(["plan", "--session-id", sessionId], temp.env, process.cwd());
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain(`Plan: ${revised.id}`);
    expect(show.stdout).toContain(`Revises plan: ${original.id}`);
    expect(show.stdout).toContain(`Root plan: ${original.id}`);

    const list = await runCli(["plan", "list", "--session-id", sessionId], temp.env);
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain(`revises:${original.id}`);
    expect(list.stdout).toContain(`revised-by:${revised.id}`);

    const originalShow = await runCli(["plan", "show", original.id], temp.env);
    expect(originalShow.exitCode).toBe(0);
    expect(originalShow.stdout).toContain(`Plan: ${original.id}`);
    expect(originalShow.stdout).toContain(`Revised by plan: ${revised.id}`);

    const chain = await runCli(["plan", "chain", revised.id], temp.env);
    expect(chain.exitCode).toBe(0);
    expect(chain.stdout).toContain(`Plan chain: ${original.id}`);
    expect(chain.stdout).toContain(`1. needs_revision ${original.id}`);
    expect(chain.stdout).toContain(`2. approved ${revised.id}`);
  });

  it("lists submitted plans across sessions from the CLI", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    const firstSessionId = "33333333-3333-4333-8333-333333333334";
    const secondSessionId = "33333333-3333-4333-8333-333333333335";
    await runCli(["--session-id", firstSessionId, "-p", "prepare first plan session"], temp.env);
    await runCli(["--session-id", secondSessionId, "-p", "prepare second plan session"], temp.env);
    const { recordPlanReview } = await import("../src/plan-state.js");
    const firstPlan = recordPlanReview({
      stateRoot: paths.stateRoot,
      sessionId: firstSessionId,
      plan: "1. Inspect first session"
    });
    const secondPlan = recordPlanReview({
      stateRoot: paths.stateRoot,
      sessionId: secondSessionId,
      plan: "1. Inspect second session"
    });

    const scoped = await runCli(
      ["plan", "list", "--session-id", secondSessionId],
      temp.env,
      process.cwd()
    );
    expect(scoped.exitCode).toBe(0);
    expect(scoped.stdout).toContain(secondPlan.id);
    expect(scoped.stdout).not.toContain(firstPlan.id);

    const all = await runCli(["plan", "all"], temp.env, process.cwd());
    expect(all.exitCode).toBe(0);
    expect(all.stdout).toContain("Submitted plans:");
    expect(all.stdout).toContain(firstPlan.id);
    expect(all.stdout).toContain(secondPlan.id);
  });

  it("adopts an approved plan into another session from the CLI", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    const sourceSessionId = "33333333-3333-4333-8333-333333333338";
    const targetSessionId = "33333333-3333-4333-8333-333333333339";
    await runCli(["--session-id", sourceSessionId, "-p", "prepare source plan session"], temp.env);
    await runCli(["--session-id", targetSessionId, "-p", "prepare target plan session"], temp.env);
    const { recordPlanReview } = await import("../src/plan-state.js");
    const source = recordPlanReview({
      stateRoot: paths.stateRoot,
      sessionId: sourceSessionId,
      plan: "1. Inspect source plan\n2. Carry plan into target",
      status: "approved",
      response: "Yes, proceed"
    });

    const adopted = await runCli(
      ["plan", "adopt", source.id, "--session-id", targetSessionId],
      temp.env
    );
    expect(adopted.exitCode).toBe(0);
    expect(adopted.stdout).toContain("Plan adopted:");
    expect(adopted.stdout).toContain(`Adopted from plan: ${source.id}`);

    const show = await runCli(["plan", "--session-id", targetSessionId], temp.env);
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain(`Adopted from plan: ${source.id}`);
    expect(show.stdout).toContain(`Adopted from session: ${sourceSessionId}`);
    expect(show.stdout).toContain("Carry plan into target");
  });

  it("rejects conflicting plan adoption from the CLI unless forced", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    const sourceSessionId = "33333333-3333-4333-8333-333333333340";
    const targetSessionId = "33333333-3333-4333-8333-333333333341";
    await runCli(["--session-id", sourceSessionId, "-p", "prepare source plan session"], temp.env);
    await runCli(["--session-id", targetSessionId, "-p", "prepare target plan session"], temp.env);
    const { recordPlanReview } = await import("../src/plan-state.js");
    const source = recordPlanReview({
      stateRoot: paths.stateRoot,
      sessionId: sourceSessionId,
      plan: "1. Adoptable source plan",
      status: "approved",
      response: "Yes, proceed"
    });
    const target = recordPlanReview({
      stateRoot: paths.stateRoot,
      sessionId: targetSessionId,
      plan: "1. Existing target plan",
      status: "submitted"
    });

    const rejected = await runCli(
      ["plan", "adopt", source.id, "--session-id", targetSessionId],
      temp.env
    );
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toContain("already has an approved or submitted plan");

    const unchanged = await runCli(["plan", "--session-id", targetSessionId], temp.env);
    expect(unchanged.exitCode).toBe(0);
    expect(unchanged.stdout).toContain(`Plan: ${target.id}`);
    expect(unchanged.stdout).toContain("Existing target plan");

    const forced = await runCli(
      ["plan", "adopt", source.id, "--session-id", targetSessionId, "--force"],
      temp.env
    );
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain("Plan adopted:");
    expect(forced.stdout).toContain(`Adopted from plan: ${source.id}`);

    const adopted = await runCli(["plan", "--session-id", targetSessionId], temp.env);
    expect(adopted.exitCode).toBe(0);
    expect(adopted.stdout).toContain(`Adopted from plan: ${source.id}`);
    expect(adopted.stdout).toContain("Adoptable source plan");
  });

  it("merges approved plans into another session from the CLI", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    const alphaSessionId = "33333333-3333-4333-8333-333333333342";
    const betaSessionId = "33333333-3333-4333-8333-333333333343";
    const targetSessionId = "33333333-3333-4333-8333-333333333344";
    await runCli(["--session-id", alphaSessionId, "-p", "prepare alpha plan session"], temp.env);
    await runCli(["--session-id", betaSessionId, "-p", "prepare beta plan session"], temp.env);
    await runCli(["--session-id", targetSessionId, "-p", "prepare merged plan session"], temp.env);
    const { recordPlanReview } = await import("../src/plan-state.js");
    const alpha = recordPlanReview({
      stateRoot: paths.stateRoot,
      sessionId: alphaSessionId,
      plan: "1. Read alpha input\n2. Patch alpha output",
      status: "approved",
      response: "Yes, proceed"
    });
    const beta = recordPlanReview({
      stateRoot: paths.stateRoot,
      sessionId: betaSessionId,
      plan: "1. Read beta input\n2. Patch beta output",
      status: "approved",
      response: "Yes, proceed"
    });

    const merged = await runCli(
      ["plan", "merge", alpha.id, beta.id, "--session-id", targetSessionId],
      temp.env
    );
    expect(merged.exitCode).toBe(0);
    expect(merged.stdout).toContain("Plan merged:");
    expect(merged.stdout).toContain(`Merged from plans: ${alpha.id}, ${beta.id}`);

    const show = await runCli(["plan", "--session-id", targetSessionId], temp.env);
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain(`Merged from plans: ${alpha.id}, ${beta.id}`);
    expect(show.stdout).toContain(`Merged from sessions: ${alphaSessionId}, ${betaSessionId}`);
    expect(show.stdout).toContain("Read alpha input");
    expect(show.stdout).toContain("Read beta input");
  });

  it("shows merge conflicts from the CLI", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    const alphaSessionId = "33333333-3333-4333-8333-333333333345";
    const betaSessionId = "33333333-3333-4333-8333-333333333346";
    const targetSessionId = "33333333-3333-4333-8333-333333333347";
    await runCli(
      ["--session-id", alphaSessionId, "-p", "prepare alpha conflict session"],
      temp.env
    );
    await runCli(["--session-id", betaSessionId, "-p", "prepare beta conflict session"], temp.env);
    await runCli(["--session-id", targetSessionId, "-p", "prepare conflict target"], temp.env);
    const { recordPlanReview } = await import("../src/plan-state.js");
    const alpha = recordPlanReview({
      stateRoot: paths.stateRoot,
      sessionId: alphaSessionId,
      plan: "1. Read src/config.ts\n2. Patch src/config.ts to use alpha endpoint",
      status: "approved",
      response: "Yes, proceed"
    });
    const beta = recordPlanReview({
      stateRoot: paths.stateRoot,
      sessionId: betaSessionId,
      plan: "1. Read src/config.ts\n2. Patch src/config.ts to use beta endpoint",
      status: "approved",
      response: "Yes, proceed"
    });

    const merged = await runCli(
      ["plan", "merge", alpha.id, beta.id, "--session-id", targetSessionId],
      temp.env
    );
    expect(merged.exitCode).toBe(0);
    expect(merged.stdout).toContain("Plan merged:");

    const show = await runCli(["plan", "--session-id", targetSessionId], temp.env);
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain("Status: needs_revision");
    expect(show.stdout).toContain("Merge conflicts: 1");
    expect(show.stdout).toContain("Conflict target: src/config.ts");
    expect(show.stdout).toContain("Patch src/config.ts to use alpha endpoint");
    expect(show.stdout).toContain("Patch src/config.ts to use beta endpoint");
  });

  it("resolves merge conflicts from the CLI", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    const alphaSessionId = "33333333-3333-4333-8333-333333333348";
    const betaSessionId = "33333333-3333-4333-8333-333333333349";
    const targetSessionId = "33333333-3333-4333-8333-333333333350";
    await runCli(["--session-id", alphaSessionId, "-p", "prepare alpha resolve session"], temp.env);
    await runCli(["--session-id", betaSessionId, "-p", "prepare beta resolve session"], temp.env);
    await runCli(["--session-id", targetSessionId, "-p", "prepare resolve target"], temp.env);
    const { mergePlanReviews, recordPlanReview } = await import("../src/plan-state.js");
    const alpha = recordPlanReview({
      stateRoot: paths.stateRoot,
      sessionId: alphaSessionId,
      plan: "1. Read src/config.ts\n2. Patch src/config.ts to use alpha endpoint",
      status: "approved",
      response: "Yes, proceed"
    });
    const beta = recordPlanReview({
      stateRoot: paths.stateRoot,
      sessionId: betaSessionId,
      plan: "1. Read src/config.ts\n2. Patch src/config.ts to use beta endpoint",
      status: "approved",
      response: "Yes, proceed"
    });
    const conflicted = mergePlanReviews({
      stateRoot: paths.stateRoot,
      sourcePlanIds: [alpha.id, beta.id],
      targetSessionId
    });

    const resolved = await runCli(
      ["plan", "resolve", conflicted.id, "--choose", beta.id, "--session-id", targetSessionId],
      temp.env
    );
    expect(resolved.exitCode).toBe(0);
    expect(resolved.stdout).toContain("Plan resolved:");
    expect(resolved.stdout).toContain("Status: approved");
    expect(resolved.stdout).toContain(`Resolved from plan: ${conflicted.id}`);
    expect(resolved.stdout).toContain(`Resolved with choice plan: ${beta.id}`);

    const show = await runCli(["plan", "--session-id", targetSessionId], temp.env);
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain("Status: approved");
    expect(show.stdout).toContain(`Resolved from plan: ${conflicted.id}`);
    expect(show.stdout).toContain(`Resolved with choice plan: ${beta.id}`);
    expect(show.stdout).toContain("Patch src/config.ts to use beta endpoint");
    expect(show.stdout).not.toContain("Patch src/config.ts to use alpha endpoint");

    const chain = await runCli(
      ["plan", "chain", show.stdout.match(/Plan: ([^\n]+)/)?.[1] ?? ""],
      temp.env
    );
    expect(chain.exitCode).toBe(0);
    expect(chain.stdout).toContain(`1. needs_revision ${conflicted.id}`);
    expect(chain.stdout).toContain("2. approved");
  });

  it("keeps CLI goals isolated by explicit session id", async () => {
    temp = makeTempRoot();
    const firstId = "11111111-1111-4111-8111-111111111111";
    const secondId = "22222222-2222-4222-8222-222222222222";
    await runCli(["--session-id", firstId, "-p", "prepare alpha session"], temp.env, process.cwd());
    await runCli(["--session-id", secondId, "-p", "prepare beta session"], temp.env, process.cwd());

    const firstGoal = await runCli(
      ["goal", "finish", "alpha", "--session-id", firstId],
      temp.env,
      process.cwd()
    );
    const secondGoal = await runCli(
      ["goal", "finish", "beta", "--session-id", secondId],
      temp.env,
      process.cwd()
    );
    expect(firstGoal.exitCode).toBe(0);
    expect(secondGoal.exitCode).toBe(0);

    const firstStatus = await runCli(["goal", "--session-id", firstId], temp.env, process.cwd());
    const secondStatus = await runCli(["goal", "--session-id", secondId], temp.env, process.cwd());
    expect(firstStatus.stdout).toContain("Goal: finish alpha");
    expect(firstStatus.stdout).not.toContain("finish beta");
    expect(secondStatus.stdout).toContain("Goal: finish beta");
    expect(secondStatus.stdout).not.toContain("finish alpha");

    const doneFirst = await runCli(
      ["goal", "done", "verified", "--session-id", firstId],
      temp.env,
      process.cwd()
    );
    expect(doneFirst.exitCode).toBe(0);

    const firstAfterDone = await runCli(["goal", "--session-id", firstId], temp.env, process.cwd());
    const secondAfterDone = await runCli(
      ["goal", "--session-id", secondId],
      temp.env,
      process.cwd()
    );
    expect(firstAfterDone.stdout).toContain("No active goal.");
    expect(secondAfterDone.stdout).toContain("Goal: finish beta");
  });

  it("exposes LearningDraft review commands from the CLI", async () => {
    temp = makeTempRoot();
    const result = await runCli(["learning", "list"], temp.env, process.cwd());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No LearningDrafts.");
  });

  it("injects active goals into resumed model context", async () => {
    temp = makeTempRoot();
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    server = http.createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) {
        raw += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : Buffer.from(chunk).toString("utf8");
      }
      requests.push(JSON.parse(raw) as { messages: Array<{ role: string; content: string }> });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { content: "GOAL OK" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        })
      );
    });
    const baseUrl = await listen(server);
    const paths = getMagiPaths(temp.env);
    writeFileSync(
      paths.configFile,
      [
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
      ].join("\n"),
      "utf8"
    );

    await runCli(["goal", "finish", "the", "migration"], temp.env, process.cwd());
    const result = await runCli(
      ["-c", "-p", "continue"],
      { ...temp.env, MAGI_OPENAI_API_KEY: "test-key" },
      process.cwd()
    );

    expect(result.exitCode).toBe(0);
    expect(requests[0].messages[0].role).toBe("system");
    expect(requests[0].messages[0].content).toContain("<active_thread_goal>");
    expect(requests[0].messages[0].content).toContain("Objective: finish the migration");
  });

  it("injects latest session plan context into resumed model context", async () => {
    temp = makeTempRoot();
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    server = http.createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) {
        raw += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : Buffer.from(chunk).toString("utf8");
      }
      requests.push(JSON.parse(raw) as { messages: Array<{ role: string; content: string }> });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { content: "PLAN CONTEXT OK" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        })
      );
    });
    const baseUrl = await listen(server);
    const paths = getMagiPaths(temp.env);
    writeFileSync(
      paths.configFile,
      [
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
      ].join("\n"),
      "utf8"
    );
    const sessionId = "33333333-3333-4333-8333-333333333337";
    await runCli(["--session-id", sessionId, "-p", "seed plan context session"], temp.env);
    const { recordPlanReview } = await import("../src/plan-state.js");
    const original = recordPlanReview({
      stateRoot: paths.stateRoot,
      sessionId,
      plan: "1. Edit without inspecting",
      status: "needs_revision",
      response: "No, revise"
    });
    const revised = recordPlanReview({
      stateRoot: paths.stateRoot,
      sessionId,
      plan: "1. Inspect first\n2. Verify focused change",
      status: "approved",
      response: "Yes, proceed",
      revisesPlanId: original.id
    });

    const result = await runCli(
      ["--session-id", sessionId, "--model", "main", "-p", "continue with inherited plan"],
      { ...temp.env, MAGI_OPENAI_API_KEY: "test-key" },
      process.cwd()
    );

    expect(result.exitCode).toBe(0);
    expect(requests.at(-1)?.messages[0].role).toBe("system");
    expect(requests.at(-1)?.messages[0].content).toContain("<session_plan_context>");
    expect(requests.at(-1)?.messages[0].content).toContain(`Plan id: ${revised.id}`);
    expect(requests.at(-1)?.messages[0].content).toContain(`Revises plan: ${original.id}`);
    expect(requests.at(-1)?.messages[0].content).toContain("1. Inspect first");
    expect(requests.at(-1)?.messages[0].content).not.toContain("Edit without inspecting");
  });

  it("honors headless permission mode for mutating tools", async () => {
    temp = makeTempRoot();
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    server = http.createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) {
        raw += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : Buffer.from(chunk).toString("utf8");
      }
      const body = JSON.parse(raw) as {
        messages: Array<{ role: string; content: string }>;
        tools?: Array<{ function: { name: string } }>;
      };
      requests.push(body);
      const hasToolResult = body.messages.some((message) => message.role === "tool");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: hasToolResult
                ? { content: "WRITE DONE" }
                : {
                    content: "",
                    tool_calls: [
                      {
                        id: "write-cli-permission",
                        type: "function",
                        function: {
                          name: "FileWrite",
                          arguments: JSON.stringify({
                            file_path: "permission-mode.txt",
                            content: "allowed"
                          })
                        }
                      }
                    ]
                  }
            }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        })
      );
    });
    const baseUrl = await listen(server);
    const paths = getMagiPaths(temp.env);
    writeFileSync(
      paths.configFile,
      [
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
      ].join("\n"),
      "utf8"
    );

    const result = await runCli(
      ["--permission-mode", "acceptEdits", "--model", "main", "-p", "write a file"],
      { ...temp.env, MAGI_OPENAI_API_KEY: "test-key" },
      temp.path
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("WRITE DONE");
    expect(readFileSync(path.join(temp.path, "permission-mode.txt"), "utf8")).toBe("allowed");
    expect(JSON.stringify(requests.at(-1))).toContain("Wrote permission-mode.txt");
  });

  it("denies non-read-only tools in dontAsk mode without writing files", async () => {
    temp = makeTempRoot();
    const requests: Array<{ messages: Array<{ role: string; content?: unknown }> }> = [];
    server = http.createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) {
        raw += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : Buffer.from(chunk).toString("utf8");
      }
      const body = JSON.parse(raw) as {
        messages: Array<{ role: string; content?: unknown }>;
      };
      requests.push(body);
      const hasToolResult = body.messages.some((message) => message.role === "tool");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: hasToolResult
                ? { content: "DONTASK DENIAL OBSERVED" }
                : {
                    content: "",
                    tool_calls: [
                      {
                        id: "write-cli-dontask",
                        type: "function",
                        function: {
                          name: "FileWrite",
                          arguments: JSON.stringify({
                            file_path: "dontask-denied.txt",
                            content: "blocked"
                          })
                        }
                      }
                    ]
                  }
            }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        })
      );
    });
    const baseUrl = await listen(server);
    const paths = getMagiPaths(temp.env);
    writeFileSync(
      paths.configFile,
      [
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
      ].join("\n"),
      "utf8"
    );

    const result = await runCli(
      ["--permission-mode", "dontAsk", "--model", "main", "-p", "write a file"],
      { ...temp.env, MAGI_OPENAI_API_KEY: "test-key" },
      temp.path
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("DONTASK DENIAL OBSERVED");
    expect(JSON.stringify(requests.at(-1))).toContain(
      "Permission deny: FileWrite is not allowed in dontAsk mode"
    );
    expect(existsSync(path.join(temp.path, "dontask-denied.txt"))).toBe(false);
  });

  it("applies CLI tool allow and deny rules to exposed schemas and execution", async () => {
    temp = makeTempRoot();
    const requests: Array<{
      messages: Array<{ role: string; content?: unknown }>;
      tools?: Array<{ function: { name: string } }>;
    }> = [];
    server = http.createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) {
        raw += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : Buffer.from(chunk).toString("utf8");
      }
      const body = JSON.parse(raw) as {
        messages: Array<{ role: string; content?: unknown }>;
        tools?: Array<{ function: { name: string } }>;
      };
      requests.push(body);
      const hasToolResult = body.messages.some((message) => message.role === "tool");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: hasToolResult
                ? body.messages.filter((message) => message.role === "tool").length >= 2
                  ? { content: "POLICY OBSERVED" }
                  : {
                      content: "",
                      tool_calls: [
                        {
                          id: "policy-tool-search",
                          type: "function",
                          function: {
                            name: "ToolSearch",
                            arguments: JSON.stringify({ query: "select:FileWrite" })
                          }
                        }
                      ]
                    }
                : {
                    content: "",
                    tool_calls: [
                      {
                        id: "policy-write",
                        type: "function",
                        function: {
                          name: "FileWrite",
                          arguments: JSON.stringify({
                            file_path: "policy-cli-denied.txt",
                            content: "no"
                          })
                        }
                      }
                    ]
                  }
            }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        })
      );
    });
    const baseUrl = await listen(server);
    const paths = getMagiPaths(temp.env);
    writeFileSync(
      paths.configFile,
      [
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
      ].join("\n"),
      "utf8"
    );

    const result = await runCli(
      ["--tools", "Read,Search", "--model", "main", "-p", "try a write"],
      { ...temp.env, MAGI_OPENAI_API_KEY: "test-key" },
      temp.path
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("POLICY OBSERVED");
    expect(requests[0].tools?.map((tool) => tool.function.name)).toContain("FileRead");
    expect(requests[0].tools?.map((tool) => tool.function.name)).toContain("Grep");
    expect(requests[0].tools?.map((tool) => tool.function.name)).not.toContain("FileWrite");
    expect(JSON.stringify(requests.at(-1))).toContain("Permission deny");
    expect(JSON.stringify(requests.at(-1))).toContain("Tool not found: FileWrite");
    expect(existsSync(path.join(temp.path, "policy-cli-denied.txt"))).toBe(false);
  });

  it("does not inject completed or blocked goals into resumed model context", async () => {
    temp = makeTempRoot();
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    server = http.createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) {
        raw += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : Buffer.from(chunk).toString("utf8");
      }
      requests.push(JSON.parse(raw) as { messages: Array<{ role: string; content: string }> });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { content: "GOAL CONTEXT OK" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        })
      );
    });
    const baseUrl = await listen(server);
    const paths = getMagiPaths(temp.env);
    writeFileSync(
      paths.configFile,
      [
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
      ].join("\n"),
      "utf8"
    );

    await runCli(["goal", "finish", "inactive", "migration"], temp.env, process.cwd());
    await runCli(["goal", "blocked", "waiting", "on", "review"], temp.env, process.cwd());
    const blockedResume = await runCli(
      ["-c", "-p", "continue"],
      { ...temp.env, MAGI_OPENAI_API_KEY: "test-key" },
      process.cwd()
    );
    expect(blockedResume.exitCode).toBe(0);
    expect(requests[0].messages[0].role).toBe("system");
    expect(requests[0].messages[0].content).not.toContain("<active_thread_goal>");
    expect(requests[0].messages[0].content).not.toContain("finish inactive migration");

    await runCli(["goal", "finish", "replacement", "migration"], temp.env, process.cwd());
    await runCli(["goal", "done", "verified"], temp.env, process.cwd());
    const completedResume = await runCli(
      ["-c", "-p", "continue again"],
      { ...temp.env, MAGI_OPENAI_API_KEY: "test-key" },
      process.cwd()
    );
    expect(completedResume.exitCode).toBe(0);
    expect(requests[1].messages[0].role).toBe("system");
    expect(requests[1].messages[0].content).not.toContain("<active_thread_goal>");
    expect(requests[1].messages[0].content).not.toContain("finish replacement migration");

    await runCli(["goal", "finish", "active", "migration"], temp.env, process.cwd());
    const activeResume = await runCli(
      ["-c", "-p", "continue active"],
      { ...temp.env, MAGI_OPENAI_API_KEY: "test-key" },
      process.cwd()
    );
    expect(activeResume.exitCode).toBe(0);
    expect(requests[2].messages[0].role).toBe("system");
    expect(requests[2].messages[0].content).toContain("<active_thread_goal>");
    expect(requests[2].messages[0].content).toContain("Objective: finish active migration");
  });

  it("injects relevant prior sessions into model context before a task", async () => {
    temp = makeTempRoot();
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    server = http.createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) {
        raw += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : Buffer.from(chunk).toString("utf8");
      }
      requests.push(JSON.parse(raw) as { messages: Array<{ role: string; content: string }> });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { content: "RECALL OK" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        })
      );
    });
    const baseUrl = await listen(server);
    const paths = getMagiPaths(temp.env);
    writeFileSync(
      paths.configFile,
      [
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
      ].join("\n"),
      "utf8"
    );
    const store = SessionStore.open(paths);
    try {
      const prior = store.createSession({ title: "pixel snake fix", cwd: process.cwd() });
      store.appendMessage({
        sessionId: prior,
        role: "user",
        content: "Pixel snake food spawned inside the snake body."
      });
      store.appendMessage({
        sessionId: prior,
        role: "assistant",
        content: "Keep food generation limited to empty grid cells."
      });
    } finally {
      store.close();
    }

    const result = await runCli(
      ["--model", "main", "-p", "continue the pixel snake food work"],
      { ...temp.env, MAGI_OPENAI_API_KEY: "test-key" },
      process.cwd()
    );

    expect(result.exitCode).toBe(0);
    expect(requests[0].messages[0].role).toBe("system");
    expect(requests[0].messages[0].content).toContain("[Relevant Prior Sessions]");
    expect(requests[0].messages[0].content).toContain("pixel snake fix");
    expect(requests[0].messages[0].content).toContain("empty grid cells");
  });

  it("creates a reviewable LearningDraft after an explicit learning task", async () => {
    temp = makeTempRoot();
    server = http.createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Drain request body.
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            { message: { content: "Workflow: run focused tests before broad test suites." } }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        })
      );
    });
    const baseUrl = await listen(server);
    const paths = getMagiPaths(temp.env);
    writeFileSync(
      paths.configFile,
      [
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
      ].join("\n"),
      "utf8"
    );

    const result = await runCli(
      ["--model", "main", "-p", "请记住这个工作流：先跑 focused tests，再跑完整测试"],
      { ...temp.env, MAGI_OPENAI_API_KEY: "test-key" },
      process.cwd()
    );
    const drafts = await runCli(["learning", "list"], temp.env, process.cwd());

    expect(result.exitCode).toBe(0);
    expect(drafts.exitCode).toBe(0);
    expect(drafts.stdout).toContain("learn_");
    expect(drafts.stdout).toContain("memory");
    expect(drafts.stdout).toContain("workflows/README.md");
  });

  it("lists resume choices when -r has no value", async () => {
    temp = makeTempRoot();
    await runCli(
      ["--name", "resume search target", "-p", "write a short status"],
      temp.env,
      process.cwd()
    );
    const result = await runCli(["-r"], temp.env, process.cwd());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Resume sessions:");
    expect(result.stdout).toContain("resume search target");
  });

  it("supports stream-json output as newline-delimited JSON", async () => {
    temp = makeTempRoot();
    const result = await runCli(
      ["--output-format", "stream-json", "-p", "write a short status"],
      temp.env,
      process.cwd()
    );
    expect(result.exitCode).toBe(0);
    const lines = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; jobId?: string });
    expect(lines[0]).toMatchObject({ type: "session.started" });
    expect(lines[1]).toMatchObject({ type: "message.created", role: "user" });
    expect(lines.at(-2)).toMatchObject({ type: "message.created", role: "assistant" });
    expect(lines.at(-1)).toMatchObject({ type: "session.completed", status: "completed" });
    expect(lines.at(-1)?.jobId).toBeTruthy();
  });

  it("emits stable stream-json tool lifecycle events", async () => {
    temp = makeTempRoot();
    server = http.createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) {
        raw += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : Buffer.from(chunk).toString("utf8");
      }
      const body = JSON.parse(raw) as { messages: Array<{ content: unknown }> };
      const transcript = body.messages.map((message) => JSON.stringify(message.content)).join("\n");
      response.writeHead(200, { "content-type": "application/json" });
      if (!transcript.includes("Wrote stream-lifecycle.txt")) {
        response.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      id: "write-stream-lifecycle",
                      type: "function",
                      function: {
                        name: "FileWrite",
                        arguments: JSON.stringify({
                          file_path: "stream-lifecycle.txt",
                          content: "ok"
                        })
                      }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 }
          })
        );
        return;
      }
      response.end(
        JSON.stringify({
          choices: [{ message: { content: "Tool wrote stream lifecycle." } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        })
      );
    });
    const baseUrl = await listen(server);
    const paths = getMagiPaths(temp.env);
    writeFileSync(
      paths.configFile,
      [
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
      ].join("\n")
    );

    const result = await runCli(
      [
        "--permission-mode",
        "acceptEdits",
        "--model",
        "main",
        "--output-format",
        "stream-json",
        "-p",
        "Write stream lifecycle file."
      ],
      { ...temp.env, MAGI_OPENAI_API_KEY: "test-key" },
      temp.path
    );

    expect(result.exitCode).toBe(0);
    const events = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "session.started",
        "message.created",
        "tool.started",
        "tool.completed",
        "agent.tool_use",
        "agent.tool_result",
        "session.completed"
      ])
    );
    expect(events.find((event) => event.type === "tool.started")).toMatchObject({
      tool: "FileWrite",
      toolUseId: "write-stream-lifecycle",
      input: { file_path: "stream-lifecycle.txt", content: "ok" }
    });
    expect(events.find((event) => event.type === "tool.completed")).toMatchObject({
      tool: "FileWrite",
      toolUseId: "write-stream-lifecycle"
    });
    expect(events.at(-1)).toMatchObject({
      type: "session.completed",
      status: "completed",
      message: "Tool wrote stream lifecycle."
    });
    expect(readFileSync(path.join(temp.path, "stream-lifecycle.txt"), "utf8")).toBe("ok");
  });

  it("recalls workflow graph neighbors across sessions from the CLI", async () => {
    temp = makeTempRoot();
    const store = MemoryNodeStore.open(getMagiPaths(temp.env));
    const seeded = (() => {
      try {
        const project = store.upsertNode({
          type: "project",
          title: "Release rollout project",
          summary: "Release rollout project.",
          body: "Release rollout project uses staged deployment gates.",
          source: "explicit",
          weight: 0.8
        });
        const workflow = store.upsertNode({
          type: "workflow",
          title: "Deployment gate workflow",
          summary: "Deployment gate workflow.",
          body: "Run smoke verification before deployment expansion.",
          source: "explicit",
          weight: 0.7
        });
        const habit = store.upsertNode({
          type: "work_habit",
          title: "Concise deployment reporting",
          summary: "Concise deployment reporting.",
          body: "Summarize expansion risks and verification outcome.",
          source: "explicit",
          weight: 0.65
        });
        return { project, workflow, habit };
      } finally {
        store.close();
      }
    })();
    await runCli(
      [
        "memory",
        "link",
        "--from",
        seeded.project.id,
        "--to",
        seeded.workflow.id,
        "--relation",
        "depends_on",
        "--weight",
        "0.95"
      ],
      temp.env,
      process.cwd()
    );
    await runCli(
      [
        "memory",
        "link",
        "--from",
        seeded.workflow.id,
        "--to",
        seeded.habit.id,
        "--relation",
        "relates_to",
        "--weight",
        "0.95"
      ],
      temp.env,
      process.cwd()
    );

    const search = await runCli(
      ["memory", "search", "release rollout project"],
      temp.env,
      process.cwd()
    );

    expect(search.exitCode).toBe(0);
    expect(search.stdout).toContain("Release rollout project");
    expect(search.stdout).toContain("Deployment gate workflow");
    expect(search.stdout).toContain("Concise deployment reporting");
    expect(search.stdout).toContain("graph-distance: 2");
  });

  it("shows grouped memory conflicts from the CLI", async () => {
    temp = makeTempRoot();
    const firstDraft = await runCli(
      [
        "memory",
        "append",
        "user",
        "## Stale verification preference\nThe user prefers verbose terminal dumps after verification."
      ],
      temp.env,
      process.cwd()
    );
    const firstDraftId = /Created Memory Draft:\s+([a-z0-9_]+)/i.exec(firstDraft.stdout)?.[1];
    expect(firstDraftId).toBeTruthy();
    await runCli(["memory", "draft", "apply", firstDraftId!], temp.env, process.cwd());
    await runCli(
      [
        "memory",
        "correct",
        "--target",
        "verbose terminal dumps",
        "--reason",
        "User corrected stale verification output preference.",
        "--replacement",
        "The user prefers concise verification summaries with only key outcomes.",
        "--replacement-title",
        "Correct verification output preference",
        "--replacement-summary",
        "Correct verification output preference.",
        "--type",
        "preference"
      ],
      temp.env,
      process.cwd()
    );
    const secondDraft = await runCli(
      [
        "memory",
        "append",
        "user",
        "## Raw terminal log preference\nThe user prefers raw terminal logs after verification."
      ],
      temp.env,
      process.cwd()
    );
    const secondDraftId = /Created Memory Draft:\s+([a-z0-9_]+)/i.exec(secondDraft.stdout)?.[1];
    expect(secondDraftId).toBeTruthy();
    await runCli(["memory", "draft", "apply", secondDraftId!], temp.env, process.cwd());
    await runCli(
      [
        "memory",
        "link",
        "--from",
        "Stale verification preference",
        "--to",
        "Raw terminal log preference",
        "--relation",
        "conflicts_with",
        "--weight",
        "0.8"
      ],
      temp.env,
      process.cwd()
    );

    const groups = await runCli(["memory", "conflicts", "--groups"], temp.env, process.cwd());

    expect(groups.exitCode).toBe(0);
    expect(groups.stdout).toContain("Memory graph conflict groups:");
    expect(groups.stdout).toContain("nodes: 3");
    expect(groups.stdout).toContain("recommendation: prefer_node");
    expect(groups.stdout).toContain("Correct verification output preference");
    expect(groups.stdout).toContain("Raw terminal log preference");
  });

  it("uses config context settings for headless auto compaction with explicit compaction model", async () => {
    temp = makeTempRoot();
    const calls: Array<{ model: string; body: Record<string, unknown> }> = [];
    server = http.createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) {
        raw += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : Buffer.from(chunk).toString("utf8");
      }
      const body = JSON.parse(raw) as { model: string; messages: Array<{ content: string }> };
      calls.push({ model: body.model, body: body as Record<string, unknown> });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: body.model === "gpt-compact" ? "COMPACT SUMMARY" : "FINAL ANSWER"
              }
            }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        })
      );
    });
    const baseUrl = await listen(server);
    const paths = getMagiPaths(temp.env);
    writeFileSync(
      paths.configFile,
      [
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
      ].join("\n"),
      "utf8"
    );

    const first = await runCli(
      ["--verbose", "-p", `${"x".repeat(200)}`],
      { ...temp.env, MAGI_OPENAI_API_KEY: "test-key" },
      process.cwd()
    );
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
        raw += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : Buffer.from(chunk).toString("utf8");
      }
      const body = JSON.parse(raw) as {
        model: string;
        messages: Array<{ role: string }>;
        tools?: Array<{ function: { name: string } }>;
      };
      calls.push({ model: body.model, body: body as Record<string, unknown> });
      const hasToolResult = body.messages.some((message) => message.role === "tool");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: hasToolResult
                ? { content: "MCP FINAL" }
                : {
                    content: "",
                    tool_calls: [
                      {
                        id: "mcp-cli-1",
                        type: "function",
                        function: {
                          name: "mcp__notes__read_note",
                          arguments: JSON.stringify({ key: "alpha" })
                        }
                      }
                    ]
                  }
            }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        })
      );
    });
    const baseUrl = await listen(server);
    const paths = getMagiPaths(temp.env);
    writeFileSync(
      paths.configFile,
      [
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
      ].join("\n"),
      "utf8"
    );

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
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("Options:");
    expect(result.stdout).toContain("Commands:");
    expect(result.stdout).toContain("Compatibility notes:");
    expect(result.stdout).toContain("--model");
    expect(result.stdout).toContain("-c -p");
    expect(result.stdout).toContain("--output-format <text|json|stream-json>");
    expect(result.stdout).toContain("--verbose");
    expect(result.stdout).toContain("--output-format json");
    expect(result.stdout).toContain("--tools");
    expect(result.stdout).toContain("--allowed-tools");
    expect(result.stdout).toContain("--disallowed-tools");
    expect(result.stdout).toContain("workspace diagnose");
    expect(result.stdout).toContain("memory view|search|link|correct|feedback");
    expect(result.stdout).toContain("memory conflicts|merges|eval|maintain");
    expect(result.stdout).toContain("learning list|propose|draft");
    expect(result.stdout).toContain("Legacy-only provider/browser bridge paths");
    expect(result.stdout).toContain("magi-agent binary");
  });

  it("runs workspace diagnostics from the CLI", async () => {
    temp = makeTempRoot();
    writeFileSync(
      path.join(temp.path, "package.json"),
      JSON.stringify({
        name: "cli-diagnostics",
        scripts: { test: "vitest run" },
        devDependencies: { vitest: "^3.0.0" }
      }),
      "utf8"
    );
    writeFileSync(path.join(temp.path, "package-lock.json"), "{}", "utf8");
    writeFileSync(path.join(temp.path, "index.ts"), "export const ok = true;\n", "utf8");

    const text = await runCli(["workspace", "diagnose"], temp.env, temp.path);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("Workspace Diagnostics");
    expect(text.stdout).toContain("package manager: npm");
    expect(text.stdout).toContain("- npm run test");

    const json = await runCli(
      ["--output-format", "json", "workspace", "diagnose"],
      temp.env,
      temp.path
    );
    expect(json.exitCode).toBe(0);
    const parsed = JSON.parse(json.stdout) as {
      packageManager: string;
      languages: Array<{ name: string }>;
    };
    expect(parsed.packageManager).toBe("npm");
    expect(parsed.languages).toContainEqual(expect.objectContaining({ name: "TypeScript" }));
  });

  it("does not expose a magi-agent binary or package bin", () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8")
    ) as {
      bin?: Record<string, string>;
    };
    expect(packageJson.bin).toEqual({ magi: "dist/cli.js" });
    expect(packageJson.bin).not.toHaveProperty("magi-agent");
  });
});

async function listen(server: http.Server, port = 0): Promise<string> {
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
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
