import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import http, { IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "../src/config.js";
import { runDueCronJobs, startControlServer } from "../src/control/server.js";
import { ensureMagiHome, getMagiPaths, getRuntimeSettings } from "../src/paths.js";
import { SessionStore } from "../src/session-store.js";
import { cronStorePathFromRoot, saveCronStore } from "../src/tools/cron.js";
import { makeTempRoot, TempRoot } from "./helpers.js";

let temp: TempRoot | undefined;
let handle: Awaited<ReturnType<typeof startControlServer>> | undefined;
let store: SessionStore | undefined;
let modelServer: http.Server | undefined;

interface PanelClient {
  createSession(body: Record<string, unknown>): Promise<unknown>;
  startJob(body: Record<string, unknown>): Promise<unknown>;
}

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = undefined;
  }
  if (modelServer) {
    await closeServer(modelServer);
    modelServer = undefined;
  }
  store?.close();
  store = undefined;
  temp?.cleanup();
  temp = undefined;
});

describe("Control API", () => {
  it("serves health on the configured bind and port", async () => {
    await startTestServer();
    const response = await fetch(`${handle!.url}/health`);
    const body = (await response.json()) as { ok: boolean; control: { port: number } };
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.control.port).toBe(Number(temp!.env.MAGI_CONTROL_PORT));
  });

  it("creates pairing tokens and rejects expired or missing auth", async () => {
    await startTestServer();
    const pairing = (await postJson(`${handle!.url}/pairing`, { name: "phone" })) as {
      deviceId: string;
      token: string;
    };
    expect(pairing.deviceId).toBeTruthy();
    expect(pairing.token).toMatch(/^magi_/);

    const denied = await fetch(`${handle!.url}/sessions`);
    expect(denied.status).toBe(401);
  });

  it("lists sessions and creates jobs with device auth", async () => {
    await startTestServer();
    const pairing = (await postJson(`${handle!.url}/pairing`, { name: "phone" })) as {
      deviceId: string;
      token: string;
    };
    const headers = authHeaders(pairing);
    const job = (await postJson(
      `${handle!.url}/jobs`,
      { prompt: "write a short status" },
      headers
    )) as {
      sessionId: string;
      jobId: string;
    };
    expect(job.sessionId).toBeTruthy();
    expect(job.jobId).toBeTruthy();

    const sessions = (await getJson(`${handle!.url}/sessions`, headers)) as {
      sessions: Array<{ id: string }>;
    };
    expect(sessions.sessions.some((session) => session.id === job.sessionId)).toBe(true);
  });

  it("creates sessions, reads transcripts, submits messages, and fetches job detail", async () => {
    await startTestServer();
    const pairing = (await postJson(`${handle!.url}/pairing`, { name: "phone" })) as {
      deviceId: string;
      token: string;
    };
    const headers = authHeaders(pairing);

    const created = (await postJson(
      `${handle!.url}/sessions`,
      {
        title: "api session",
        cwd: temp!.path,
        metadata: { source: "control-test" }
      },
      headers
    )) as { session: { id: string; title: string; cwd: string; messages: unknown[] } };
    expect(created.session).toMatchObject({
      title: "api session",
      cwd: temp!.path,
      messages: []
    });

    const message = (await postJson(
      `${handle!.url}/sessions/${encodeURIComponent(created.session.id)}/messages`,
      { prompt: "write a short status" },
      headers
    )) as { sessionId: string; jobId: string; message: string };
    expect(message.sessionId).toBe(created.session.id);
    expect(message.message).toContain("No provider is configured");

    const fetched = (await getJson(
      `${handle!.url}/sessions/${encodeURIComponent(created.session.id)}`,
      headers
    )) as {
      session: { id: string; cwd: string; messages: Array<{ role: string; content: string }> };
    };
    expect(fetched.session.id).toBe(created.session.id);
    expect(fetched.session.cwd).toBe(temp!.path);
    expect(fetched.session.messages.map((entry) => entry.role)).toEqual(["user"]);
    expect(fetched.session.messages[0].content).toBe("write a short status");

    const job = (await getJson(
      `${handle!.url}/jobs/${encodeURIComponent(message.jobId)}`,
      headers
    )) as {
      job: { id: string; sessionId: string; status: string };
    };
    expect(job.job).toMatchObject({
      id: message.jobId,
      sessionId: created.session.id,
      status: "recorded"
    });
  });

  it("inherits the daemon workspace and rejects cwd paths outside its real boundary", async () => {
    await startTestServer();
    const pairing = (await postJson(`${handle!.url}/pairing`, { name: "phone" })) as {
      deviceId: string;
      token: string;
    };
    const headers = authHeaders(pairing);

    const inherited = (await postJson(
      `${handle!.url}/sessions`,
      { title: "inherited workspace" },
      headers
    )) as { session: { cwd: string } };
    expect(inherited.session.cwd).toBe(temp!.path);

    const nested = path.join(temp!.path, "nested");
    mkdirSync(nested);
    const nestedSession = (await postJson(
      `${handle!.url}/sessions`,
      { title: "nested workspace", cwd: nested },
      headers
    )) as { session: { cwd: string } };
    expect(nestedSession.session.cwd).toBe(nested);

    const dotted = path.join(temp!.path, "..cache");
    mkdirSync(dotted);
    const dottedSession = (await postJson(
      `${handle!.url}/sessions`,
      { title: "dotted workspace", cwd: dotted },
      headers
    )) as { session: { cwd: string } };
    expect(dottedSession.session.cwd).toBe(dotted);

    const outside = await fetch(`${handle!.url}/sessions`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ title: "outside workspace", cwd: "/" })
    });
    expect(outside.status).toBe(400);
    expect(await outside.text()).toContain("outside the authorized workspace");

    if (process.platform !== "win32") {
      const escape = path.join(temp!.path, "escape");
      symlinkSync("/", escape);
      const symlinkEscape = await fetch(`${handle!.url}/sessions`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ title: "symlink escape", cwd: escape })
      });
      expect(symlinkEscape.status).toBe(400);
    }
  });

  it("accepts mobile panel content/modelAlias payloads when resuming sessions", async () => {
    const calls: Array<{ model: string; body: Record<string, unknown> }> = [];
    modelServer = http.createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) {
        raw += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : Buffer.from(chunk).toString("utf8");
      }
      const body = JSON.parse(raw) as { model: string };
      calls.push({ model: body.model, body: body as Record<string, unknown> });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { content: `PANEL ${calls.length}` } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        })
      );
    });
    const baseUrl = await listen(modelServer);
    await startTestServer({
      env: { MAGI_OPENAI_API_KEY: "test-key" },
      configLines: providerControlConfig(baseUrl)
    });
    const pairing = (await postJson(`${handle!.url}/pairing`, { name: "phone" })) as {
      deviceId: string;
      token: string;
    };
    const headers = authHeaders(pairing);
    const created = (await postJson(
      `${handle!.url}/sessions`,
      { title: "panel resume", cwd: temp!.path, metadata: { source: "panel" } },
      headers
    )) as { session: { id: string } };

    const first = (await postJson(
      `${handle!.url}/sessions/${encodeURIComponent(created.session.id)}/messages`,
      { content: "panel seed", modelAlias: "main" },
      headers
    )) as { sessionId: string; message: string };
    const second = (await postJson(
      `${handle!.url}/sessions/${encodeURIComponent(created.session.id)}/messages`,
      { content: "panel follow-up", modelAlias: "main" },
      headers
    )) as { sessionId: string; message: string };

    expect(first).toMatchObject({ sessionId: created.session.id, message: "PANEL 1" });
    expect(second).toMatchObject({ sessionId: created.session.id, message: "PANEL 2" });
    expect(calls.map((call) => call.model)).toEqual(["gpt-main", "gpt-main"]);
    expect(JSON.stringify(calls[1].body)).toContain("panel seed");

    const fetched = (await getJson(
      `${handle!.url}/sessions/${encodeURIComponent(created.session.id)}`,
      headers
    )) as {
      session: { messages: Array<{ role: string; content: string }> };
    };
    expect(fetched.session.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "panel seed" }),
        expect.objectContaining({ role: "user", content: "panel follow-up" }),
        expect.objectContaining({ role: "assistant", content: "PANEL 2" })
      ])
    );
  });

  it("routes mobile panel auto model payloads through the provider loop", async () => {
    const calls: Array<{ model: string; body: Record<string, unknown> }> = [];
    modelServer = http.createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) {
        raw += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : Buffer.from(chunk).toString("utf8");
      }
      const body = JSON.parse(raw) as { model: string };
      calls.push({ model: body.model, body: body as Record<string, unknown> });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { content: "PANEL AUTO" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        })
      );
    });
    const baseUrl = await listen(modelServer);
    await startTestServer({
      env: { MAGI_OPENAI_API_KEY: "test-key" },
      configLines: providerControlConfig(baseUrl)
    });
    const pairing = (await postJson(`${handle!.url}/pairing`, { name: "phone" })) as {
      deviceId: string;
      token: string;
    };
    const headers = authHeaders(pairing);

    const result = (await postJson(
      `${handle!.url}/jobs`,
      {
        content: "panel default auto route",
        modelAlias: "auto"
      },
      headers
    )) as { message: string; provider: string; model: string };

    expect(result).toMatchObject({
      message: "PANEL AUTO",
      provider: "main",
      model: "gpt-main"
    });
    expect(calls.map((call) => call.model)).toEqual(["gpt-main"]);
    expect(JSON.stringify(calls[0].body)).toContain("panel default auto route");
  });

  it("passes job model and session options through the Control API provider loop", async () => {
    const calls: Array<{ model: string; body: Record<string, unknown> }> = [];
    modelServer = http.createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) {
        raw += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : Buffer.from(chunk).toString("utf8");
      }
      const body = JSON.parse(raw) as { model: string };
      calls.push({ model: body.model, body: body as Record<string, unknown> });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: body.model === "gpt-compact" ? "CONTROL SUMMARY" : "CONTROL FINAL"
              }
            }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        })
      );
    });
    const baseUrl = await listen(modelServer);
    await startTestServer({
      env: { MAGI_OPENAI_API_KEY: "test-key" },
      configLines: [
        "version: 0.1",
        "control:",
        "  bind: 127.0.0.1",
        "  port: 8765",
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
        "mcp:",
        "  servers: {}",
        "context:",
        "  recentMessages: 2",
        "  autoCompactTokenThreshold: 1",
        "  compactionModel: compact"
      ]
    });
    const pairing = (await postJson(`${handle!.url}/pairing`, { name: "phone" })) as {
      deviceId: string;
      token: string;
    };
    const headers = authHeaders(pairing);

    const first = (await postJson(
      `${handle!.url}/jobs`,
      {
        prompt: "x".repeat(200),
        sessionName: "control compact seed"
      },
      headers
    )) as { sessionId: string; jobId: string };
    expect(first.sessionId).toBeTruthy();
    expect(first.jobId).toBeTruthy();
    expect(calls).toHaveLength(0);

    const second = (await postJson(
      `${handle!.url}/jobs`,
      {
        prompt: "continue",
        sessionId: first.sessionId,
        model: "main"
      },
      headers
    )) as { sessionId: string; message: string; provider: string; model: string };
    expect(second).toMatchObject({
      sessionId: first.sessionId,
      message: "CONTROL FINAL",
      provider: "main",
      model: "gpt-main"
    });
    expect(calls.map((call) => call.model)).toEqual(["gpt-compact", "gpt-main"]);
    expect(JSON.stringify(calls[1].body)).toContain("CONTROL SUMMARY");

    const session = (await getJson(
      `${handle!.url}/sessions/${encodeURIComponent(first.sessionId)}`,
      headers
    )) as {
      session: { messages: Array<{ role: string; content: string }> };
    };
    expect(
      session.session.messages.filter(
        (message) => message.role === "user" && message.content === "continue"
      )
    ).toHaveLength(1);
  });

  it("records approvals and emits a minimal SSE ready event", async () => {
    await startTestServer();
    const pairing = (await postJson(`${handle!.url}/pairing`, { name: "phone" })) as {
      deviceId: string;
      token: string;
    };
    const headers = authHeaders(pairing);
    const approval = (await postJson(
      `${handle!.url}/approvals`,
      { decision: "approve" },
      headers
    )) as { ok: boolean };
    expect(approval.ok).toBe(true);

    const events = await readSseUntil(`${handle!.url}/events?limit=1`, headers, (text) =>
      text.includes("event: ready")
    );
    expect(events).toContain("event: ready");
  });

  it("serves durable session and job events through JSON and SSE endpoints", async () => {
    await startTestServer();
    const pairing = (await postJson(`${handle!.url}/pairing`, { name: "phone" })) as {
      deviceId: string;
      token: string;
    };
    const headers = authHeaders(pairing);
    const job = (await postJson(
      `${handle!.url}/jobs`,
      { prompt: "write a short status" },
      headers
    )) as {
      sessionId: string;
      jobId: string;
    };
    store!.recordAudit({
      sessionId: job.sessionId,
      jobId: job.jobId,
      action: "agent.tool.completed",
      target: "GitDiff",
      metadata: { toolCallId: "git-diff-control" }
    });

    const sessionEvents = (await getJson(
      `${handle!.url}/sessions/${encodeURIComponent(job.sessionId)}/events?limit=10`,
      headers
    )) as { events: Array<{ action: string; message: string; sessionId: string; jobId?: string }> };
    expect(sessionEvents.events).toContainEqual(
      expect.objectContaining({
        action: "agent.tool.completed",
        message: "tool completed git-diff-control",
        sessionId: job.sessionId,
        jobId: job.jobId
      })
    );

    const jobEvents = (await getJson(
      `${handle!.url}/jobs/${encodeURIComponent(job.jobId)}/events`,
      headers
    )) as { events: Array<{ action: string; target?: string }> };
    expect(jobEvents.events.map((event) => event.action)).toContain("agent.tool.completed");

    const allEvents = (await getJson(`${handle!.url}/events.json?limit=10`, headers)) as {
      events: Array<{ action: string; target?: string }>;
    };
    expect(allEvents.events).toContainEqual(
      expect.objectContaining({ action: "agent.tool.completed", target: "GitDiff" })
    );

    const text = await readSseUntil(`${handle!.url}/events?limit=10`, headers, (streamText) =>
      streamText.includes("agent.tool.completed")
    );
    expect(text).toContain("event: ready");
    expect(text).toContain("event: audit");
    expect(text).toContain("agent.tool.completed");
  });

  it("keeps the SSE event stream open and publishes new durable events", async () => {
    await startTestServer();
    const pairing = (await postJson(`${handle!.url}/pairing`, { name: "phone" })) as {
      deviceId: string;
      token: string;
    };
    const headers = authHeaders(pairing);
    const session = (await postJson(
      `${handle!.url}/sessions`,
      { title: "stream session" },
      headers
    )) as {
      session: { id: string };
    };

    let ready = false;
    const streamPromise = readSseUntil(
      `${handle!.url}/events?sessionId=${encodeURIComponent(session.session.id)}&limit=0`,
      headers,
      (text) => text.includes("control.approval.recorded"),
      (text) => {
        if (text.includes("event: ready")) {
          ready = true;
        }
      }
    );
    await waitFor(() => ready);
    await postJson(
      `${handle!.url}/approvals`,
      {
        sessionId: session.session.id,
        jobId: "stream-job",
        decision: "approve"
      },
      headers
    );
    const text = await streamPromise;

    expect(text).toContain("event: ready");
    expect(text).toContain("id:");
    expect(text).toContain("control.approval.recorded");
    expect(text).toContain('"category":"control"');
  });

  it("starts background jobs, streams provider deltas, and cancels running work", async () => {
    let firstRequest: IncomingMessage | undefined;
    modelServer = http.createServer(async (request, response) => {
      firstRequest ??= request;
      let raw = "";
      for await (const chunk of request) {
        raw += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : Buffer.from(chunk).toString("utf8");
      }
      expect(JSON.parse(raw)).toMatchObject({ stream: true });
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache"
      });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "live " } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "delta" } }] })}\n\n`);
      request.once("close", () => response.end());
    });
    const baseUrl = await listen(modelServer);
    await startTestServer({
      env: { MAGI_OPENAI_API_KEY: "test-key" },
      configLines: providerControlConfig(baseUrl)
    });
    const pairing = (await postJson(`${handle!.url}/pairing`, { name: "phone" })) as {
      deviceId: string;
      token: string;
    };
    const headers = authHeaders(pairing);

    const started = (await postJsonStatus(
      `${handle!.url}/jobs`,
      {
        prompt: "stream in background",
        model: "main",
        background: true
      },
      202,
      headers
    )) as { sessionId: string; jobId: string; status: string };
    expect(started.status).toBe("running");

    const streamText = await readSseUntil(
      `${handle!.url}/events?jobId=${encodeURIComponent(started.jobId)}&limit=0`,
      headers,
      (text) => text.includes("agent.text.delta") && text.includes("live ")
    );
    expect(streamText).toContain("agent.text.delta");
    await waitFor(() => store!.getJob(started.jobId)?.status === "running");

    const cancelled = (await postJson(
      `${handle!.url}/jobs/${encodeURIComponent(started.jobId)}/cancel`,
      { reason: "operator stop" },
      headers
    )) as { ok: boolean; status: string };
    expect(cancelled).toMatchObject({ ok: true, status: "cancelling" });
    await waitFor(() => store!.getJob(started.jobId)?.status === "cancelled");
    expect(firstRequest?.destroyed).toBe(true);
    expect(store!.listJobAuditEvents(started.jobId, 50)).toContainEqual(
      expect.objectContaining({
        action: "agent.query.cancelled",
        metadata: expect.objectContaining({ reason: "operator stop" })
      })
    );
  });

  it("unblocks active approval jobs through the Control API and streams pending/resolved events", async () => {
    const calls: Array<Record<string, unknown>> = [];
    modelServer = http.createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) {
        raw += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : Buffer.from(chunk).toString("utf8");
      }
      const body = JSON.parse(raw) as { messages: Array<{ role: string }> };
      calls.push(body as Record<string, unknown>);
      response.writeHead(200, { "content-type": "application/json" });
      if (body.messages.some((message) => message.role === "tool")) {
        response.end(
          JSON.stringify({
            choices: [{ message: { content: "CONTROL APPROVAL DONE" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 }
          })
        );
        return;
      }
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "approve-control",
                    type: "function",
                    function: {
                      name: "FileWrite",
                      arguments: JSON.stringify({
                        file_path: "control-approval.txt",
                        content: "approved by control"
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
    const baseUrl = await listen(modelServer);
    await startTestServer({
      env: { MAGI_OPENAI_API_KEY: "test-key", MAGI_INTERACTION_TIMEOUT_MS: "5000" },
      configLines: providerControlConfig(baseUrl)
    });
    const pairing = (await postJson(`${handle!.url}/pairing`, { name: "phone" })) as {
      deviceId: string;
      token: string;
    };
    const headers = authHeaders(pairing);

    const jobPromise = postJson(
      `${handle!.url}/jobs`,
      { prompt: "write a file", model: "main" },
      headers
    ) as Promise<{
      sessionId: string;
      jobId: string;
      message: string;
    }>;
    await waitFor(() =>
      store!.listAuditEvents(50).some((event) => event.action === "agent.approval.pending")
    );
    const pending = store!
      .listAuditEvents(50)
      .find((event) => event.action === "agent.approval.pending")!;
    const jobId = pending.jobId!;

    let sseReady = false;
    const ssePromise = readSseUntil(
      `${handle!.url}/events?jobId=${encodeURIComponent(jobId)}&limit=20`,
      headers,
      (text) =>
        text.includes("agent.approval.pending") && text.includes("control.approval.resolved"),
      (text) => {
        if (text.includes("event: ready")) {
          sseReady = true;
        }
      }
    );
    await waitFor(() => sseReady);
    const interactions = (await getJson(
      `${handle!.url}/jobs/${encodeURIComponent(jobId)}/interactions`,
      headers
    )) as {
      interactions: Array<{ toolUseId: string; status: string; kind: string }>;
    };
    expect(interactions.interactions).toContainEqual(
      expect.objectContaining({
        kind: "approval",
        status: "pending",
        toolUseId: "approve-control"
      })
    );

    const resolved = (await postJson(
      `${handle!.url}/jobs/${encodeURIComponent(jobId)}/approvals/approve-control`,
      { decision: "approve", responder: "phone" },
      headers
    )) as { ok: boolean; interaction: { status: string; approved: boolean } };
    expect(resolved).toMatchObject({
      ok: true,
      interaction: { status: "resolved", approved: true }
    });
    const job = await jobPromise;
    const sse = await ssePromise;

    expect(job).toMatchObject({ jobId, message: "CONTROL APPROVAL DONE" });
    expect(calls).toHaveLength(2);
    await expect(readFile(path.join(temp!.path, "control-approval.txt"), "utf8")).resolves.toBe(
      "approved by control"
    );
    expect(sse).toContain("agent.approval.pending");
    expect(sse).toContain("control.approval.resolved");
  });

  it("unblocks active AskUserQuestion jobs through the Control API", async () => {
    modelServer = http.createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) {
        raw += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : Buffer.from(chunk).toString("utf8");
      }
      const body = JSON.parse(raw) as { messages: Array<{ role: string; content?: string }> };
      response.writeHead(200, { "content-type": "application/json" });
      if (body.messages.some((message) => message.role === "tool")) {
        response.end(
          JSON.stringify({
            choices: [{ message: { content: "CONTROL QUESTION DONE" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 }
          })
        );
        return;
      }
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "ask-control",
                    type: "function",
                    function: {
                      name: "AskUserQuestion",
                      arguments: JSON.stringify({
                        questions: [
                          {
                            question: "Which route should continue?",
                            options: [
                              { label: "fast", description: "Use the fast route" },
                              { label: "safe", description: "Use the safe route" }
                            ]
                          }
                        ]
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
    const baseUrl = await listen(modelServer);
    await startTestServer({
      env: { MAGI_OPENAI_API_KEY: "test-key", MAGI_INTERACTION_TIMEOUT_MS: "5000" },
      configLines: providerControlConfig(baseUrl)
    });
    const pairing = (await postJson(`${handle!.url}/pairing`, { name: "phone" })) as {
      deviceId: string;
      token: string;
    };
    const headers = authHeaders(pairing);

    const jobPromise = postJson(
      `${handle!.url}/jobs`,
      { prompt: "ask user", model: "main" },
      headers
    ) as Promise<{
      sessionId: string;
      jobId: string;
      message: string;
    }>;
    await waitFor(() =>
      store!.listAuditEvents(50).some((event) => event.action === "agent.user_question.pending")
    );
    const pending = store!
      .listAuditEvents(50)
      .find((event) => event.action === "agent.user_question.pending")!;
    const jobId = pending.jobId!;

    await postJson(
      `${handle!.url}/jobs/${encodeURIComponent(jobId)}/questions/ask-control`,
      { selectedLabels: ["safe"], responder: "phone" },
      headers
    );
    const job = await jobPromise;

    expect(job.message).toBe("CONTROL QUESTION DONE");
    expect(store!.listJobAuditEvents(jobId, 50)).toContainEqual(
      expect.objectContaining({
        action: "control.user_question.resolved",
        metadata: expect.objectContaining({ status: "resolved", toolUseId: "ask-control" })
      })
    );
    expect(store!.getSession(job.sessionId)?.messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        content: expect.stringContaining("- safe: Use the safe route")
      })
    );
  });

  it("cancels active approval jobs through the Control API", async () => {
    modelServer = http.createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) {
        raw += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : Buffer.from(chunk).toString("utf8");
      }
      const body = JSON.parse(raw) as { messages: Array<{ role: string }> };
      response.writeHead(200, { "content-type": "application/json" });
      if (body.messages.some((message) => message.role === "tool")) {
        response.end(
          JSON.stringify({
            choices: [{ message: { content: "CONTROL CANCEL DONE" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 }
          })
        );
        return;
      }
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "approve-cancel",
                    type: "function",
                    function: {
                      name: "FileWrite",
                      arguments: JSON.stringify({ file_path: "cancelled.txt", content: "no" })
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
    const baseUrl = await listen(modelServer);
    await startTestServer({
      env: { MAGI_OPENAI_API_KEY: "test-key", MAGI_INTERACTION_TIMEOUT_MS: "5000" },
      configLines: providerControlConfig(baseUrl)
    });
    const pairing = (await postJson(`${handle!.url}/pairing`, { name: "phone" })) as {
      deviceId: string;
      token: string;
    };
    const headers = authHeaders(pairing);
    const jobPromise = postJson(
      `${handle!.url}/jobs`,
      { prompt: "write then cancel", model: "main" },
      headers
    ) as Promise<{
      jobId: string;
      message: string;
    }>;
    await waitFor(() =>
      store!.listAuditEvents(50).some((event) => event.action === "agent.approval.pending")
    );
    const jobId = store!
      .listAuditEvents(50)
      .find((event) => event.action === "agent.approval.pending")!.jobId!;

    await postJson(
      `${handle!.url}/jobs/${encodeURIComponent(jobId)}/approvals/approve-cancel/cancel`,
      { reason: "operator cancelled" },
      headers
    );
    const job = await jobPromise;

    expect(job.message).toBe("CONTROL CANCEL DONE");
    await expect(readFile(path.join(temp!.path, "cancelled.txt"), "utf8")).rejects.toThrow();
    expect(store!.listJobAuditEvents(jobId, 50)).toContainEqual(
      expect.objectContaining({
        action: "agent.approval.cancelled",
        metadata: expect.objectContaining({ status: "cancelled", toolUseId: "approve-cancel" })
      })
    );
  });

  it("manages agent tasks through the Control API", async () => {
    await startTestServer();
    const pairing = (await postJson(`${handle!.url}/pairing`, { name: "phone" })) as {
      deviceId: string;
      token: string;
    };
    const headers = authHeaders(pairing);
    const created = (await postJson(
      `${handle!.url}/agents`,
      {
        role: "worker",
        prompt: "edit file",
        writeFiles: ["a.txt"]
      },
      headers
    )) as { task: { id: string; status: string } };
    expect(created.task.status).toBe("queued");

    const started = (await postJson(
      `${handle!.url}/agents/${created.task.id}/start`,
      {},
      headers
    )) as {
      task: { status: string };
    };
    expect(started.task.status).toBe("running");

    const completed = (await postJson(
      `${handle!.url}/agents/${created.task.id}/complete`,
      { result: "done" },
      headers
    )) as {
      task: { status: string; result: string };
    };
    expect(completed.task).toMatchObject({ status: "completed", result: "done" });

    const listed = (await getJson(`${handle!.url}/agents`, headers)) as {
      tasks: Array<{ id: string }>;
    };
    expect(listed.tasks.some((task) => task.id === created.task.id)).toBe(true);
  });

  it("triggers notification and stop hooks for agent task completion and cancellation", async () => {
    await startTestServer([
      "hooks:",
      "  - event: notification",
      "    type: command",
      '    command: "node -e \'require(\\"fs\\").writeFileSync(\\"notify.json\\", process.env.ARGUMENTS)\'"',
      "  - event: stop",
      "    type: command",
      '    command: "node -e \'require(\\"fs\\").writeFileSync(\\"stop.json\\", process.env.ARGUMENTS)\'"'
    ]);
    const pairing = (await postJson(`${handle!.url}/pairing`, { name: "phone" })) as {
      deviceId: string;
      token: string;
    };
    const headers = authHeaders(pairing);
    const created = (await postJson(
      `${handle!.url}/agents`,
      {
        role: "worker",
        prompt: "edit file"
      },
      headers
    )) as { task: { id: string } };
    const completed = (await postJson(
      `${handle!.url}/agents/${created.task.id}/complete`,
      { result: "done" },
      headers
    )) as {
      task: { status: string };
      hooks: Array<{ output: string }>;
    };
    expect(completed.task.status).toBe("completed");
    expect(completed.hooks).toHaveLength(1);
    await expect(readFile(path.join(temp!.path, "notify.json"), "utf8")).resolves.toContain(
      "agent_task_completed"
    );

    const cancelTask = (await postJson(
      `${handle!.url}/agents`,
      {
        role: "worker",
        prompt: "cancel file"
      },
      headers
    )) as { task: { id: string } };
    const cancelled = (await postJson(
      `${handle!.url}/agents/${cancelTask.task.id}/cancel`,
      {},
      headers
    )) as {
      task: { status: string };
      hooks: Array<{ output: string }>;
    };
    expect(cancelled.task.status).toBe("cancelled");
    expect(cancelled.hooks).toHaveLength(1);
    await expect(readFile(path.join(temp!.path, "stop.json"), "utf8")).resolves.toContain(
      "agent_task_cancelled"
    );

    const audit = store!
      .listAuditEvents(20)
      .filter((event) => event.action === "agent.hook.completed");
    expect(audit.map((event) => event.target)).toEqual(
      expect.arrayContaining(["notification:command", "stop:command"])
    );
  });

  it("serves web panel, OpenAPI, providers, plugins, and skills", async () => {
    await startTestServer();
    const paths = getMagiPaths(temp!.env);
    const pluginRoot = path.join(paths.pluginsRoot, "panel.plugin");
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(
      path.join(pluginRoot, "plugin.json"),
      JSON.stringify({
        schemaVersion: "0.1",
        name: "panel.plugin",
        version: "0.1.0",
        permissions: []
      }),
      "utf8"
    );
    const skillRoot = path.join(paths.skillsRoot, "panel-skill");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(path.join(skillRoot, "SKILL.md"), "# Panel Skill\n", "utf8");

    const panel = await fetch(`${handle!.url}/panel`);
    expect(panel.status).toBe(200);
    expect(await panel.text()).toContain("Magi Next");

    const openapi = await fetch(`${handle!.url}/openapi.json`);
    expect(await openapi.json()).toMatchObject({ openapi: "3.1.0" });

    const pairing = (await postJson(`${handle!.url}/pairing`, { name: "phone" })) as {
      deviceId: string;
      token: string;
    };
    const headers = authHeaders(pairing);
    const providers = (await getJson(`${handle!.url}/providers`, headers)) as {
      providers: unknown[];
    };
    expect(providers.providers).toBeInstanceOf(Array);
    const plugins = (await getJson(`${handle!.url}/plugins`, headers)) as {
      plugins: Array<{ manifest: { name: string } }>;
    };
    expect(plugins.plugins[0].manifest.name).toBe("panel.plugin");
    const skills = (await getJson(`${handle!.url}/skills`, headers)) as {
      skills: Array<{ name: string }>;
    };
    expect(skills.skills[0].name).toBe("panel-skill");
  });

  it("serves a panel client that matches the Control API session and job contract", async () => {
    const calls: Array<Record<string, unknown>> = [];
    modelServer = http.createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) {
        raw += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : Buffer.from(chunk).toString("utf8");
      }
      const body = JSON.parse(raw) as Record<string, unknown>;
      calls.push(body);
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "PANEL " } }] })}\n\n`
      );
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "STREAM" } }] })}\n\n`
      );
      response.write("data: [DONE]\n\n");
      response.end();
    });
    const baseUrl = await listen(modelServer);
    await startTestServer({
      env: { MAGI_OPENAI_API_KEY: "test-key" },
      configLines: providerControlConfig(baseUrl)
    });

    const panel = await fetch(`${handle!.url}/panel`);
    const panelHtml = await panel.text();
    expect(panelHtml).toContain('import { createMagiPanelClient } from "/panel-client.js"');
    expect(panelHtml).toContain("client.startJob");
    expect(panelHtml).toContain("/events?jobId=");
    expect(panelHtml).toContain("addApprovalCard");
    expect(panelHtml).toContain("client.resolveApproval");
    expect(panelHtml).toContain("cancelActiveJob");
    expect(panelHtml).toContain("client.cancelJob");
    expect(panelHtml).not.toContain('cwd: "/"');

    const pairing = (await postJson(`${handle!.url}/pairing`, { name: "phone" })) as {
      deviceId: string;
      token: string;
    };
    const headers = authHeaders(pairing);
    const client = await loadPanelClient(`${handle!.url}/panel-client.js`, headers);
    const created = (await client.createSession({
      title: "panel contract",
      cwd: temp!.path,
      metadata: { source: "panel" }
    })) as { id: string; title: string };
    expect(created).toMatchObject({ title: "panel contract" });
    expect(created.id).toBeTruthy();

    const started = (await client.startJob({
      content: "panel streaming contract",
      modelAlias: "main",
      sessionId: created.id,
      background: true
    })) as { sessionId: string; jobId: string; status: string };
    expect(started).toMatchObject({ sessionId: created.id, status: "running" });

    const streamText = await readSseUntil(
      `${handle!.url}/events?jobId=${encodeURIComponent(started.jobId)}&limit=20`,
      headers,
      (text) =>
        text.includes("agent.query.completed") && text.includes("PANEL ") && text.includes("STREAM")
    );
    expect(streamText).toContain("agent.text.delta");
    expect(streamText).toContain("agent.query.completed");
    expect(calls).toHaveLength(1);
  }, 10_000);

  it("runs due cron jobs through the headless control path", async () => {
    const calls: Array<Record<string, unknown>> = [];
    modelServer = http.createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) {
        raw += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : Buffer.from(chunk).toString("utf8");
      }
      calls.push(JSON.parse(raw) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { content: "CRON DONE" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        })
      );
    });
    const baseUrl = await listen(modelServer);
    await startTestServer({
      env: { MAGI_OPENAI_API_KEY: "test-key", MAGI_CRON_POLL_MS: "60000" },
      configLines: [
        "version: 0.1",
        "control:",
        "  bind: 127.0.0.1",
        "  port: 8765",
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
        "  servers: {}",
        "context:",
        "  recentMessages: 6"
      ]
    });
    const paths = getMagiPaths(temp!.env);
    saveCronStore(cronStorePathFromRoot(paths.stateRoot), {
      version: 1,
      jobs: [
        {
          id: "cron-test",
          cron: "* * * * *",
          prompt: "run scheduled status",
          recurring: false,
          durable: true,
          enabled: true,
          createdAt: "2026-05-16T00:00:00.000Z",
          updatedAt: "2026-05-16T00:00:00.000Z",
          nextRunAt: "2026-05-16T00:00:00.000Z"
        }
      ]
    });

    const ran = await runDueCronJobs({
      paths,
      config: loadConfig(paths, temp!.env),
      store: store!,
      cwd: temp!.path,
      env: temp!.env,
      now: new Date("2026-05-16T00:01:00.000Z")
    });

    expect(ran).toHaveLength(1);
    expect(ran[0].result.message).toBe("CRON DONE");
    expect(JSON.stringify(calls[0])).toContain("run scheduled status");
    const saved = JSON.parse(await readFile(cronStorePathFromRoot(paths.stateRoot), "utf8")) as {
      jobs: Array<{ enabled: boolean; lastRunAt?: string }>;
    };
    expect(saved.jobs[0].enabled).toBe(false);
    expect(saved.jobs[0].lastRunAt).toBe("2026-05-16T00:01:00.000Z");
    expect(
      store!
        .listAuditEvents(20)
        .some((event) => event.action === "cron.job.executed" && event.target === "cron-test")
    ).toBe(true);
  });
});

async function startTestServer(
  input:
    | string[]
    | {
        configLines?: string[];
        extraConfig?: string[];
        env?: NodeJS.ProcessEnv;
      } = []
): Promise<void> {
  temp = makeTempRoot();
  const env = {
    ...temp.env,
    ...(Array.isArray(input) ? {} : input.env),
    MAGI_CONTROL_PORT: String(20_000 + Math.floor(Math.random() * 20_000))
  };
  temp.env = env;
  const paths = getMagiPaths(env);
  ensureMagiHome(paths);
  const configLines = Array.isArray(input)
    ? defaultControlConfig(input)
    : (input.configLines ?? defaultControlConfig(input.extraConfig ?? []));
  writeFileSync(paths.configFile, [...configLines, ""].join("\n"), "utf8");
  const config = loadConfig(paths, env);
  store = SessionStore.open(paths);
  handle = await startControlServer({
    paths,
    runtime: getRuntimeSettings(env),
    config,
    store,
    cwd: temp.path,
    env
  });
}

function defaultControlConfig(extraConfig: string[] = []): string[] {
  return [
    "version: 0.1",
    "control:",
    "  bind: 127.0.0.1",
    "  port: 8765",
    "providers: {}",
    "models:",
    "  aliases: {}",
    "  fallbacks: {}",
    "mcp:",
    "  servers: {}",
    ...extraConfig
  ];
}

function providerControlConfig(baseUrl: string): string[] {
  return [
    "version: 0.1",
    "control:",
    "  bind: 127.0.0.1",
    "  port: 8765",
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
    "  servers: {}",
    "context:",
    "  recentMessages: 6"
  ];
}

async function postJson(
  url: string,
  body: unknown,
  headers?: Record<string, string>
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function postJsonStatus(
  url: string,
  body: unknown,
  status: number,
  headers?: Record<string, string>
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  expect(response.status).toBe(status);
  return response.json();
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers });
  expect(response.status).toBe(200);
  return response.json();
}

async function readSseUntil(
  url: string,
  headers: Record<string, string>,
  predicate: (text: string) => boolean,
  onChunk?: (text: string) => void
): Promise<string> {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  expect(response.status).toBe(200);
  expect(response.body).toBeTruthy();
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (let index = 0; index < 100; index += 1) {
      const result = await Promise.race([
        reader.read(),
        new Promise<Awaited<ReturnType<typeof reader.read>>>((_, reject) => {
          setTimeout(() => reject(new Error(`Timed out waiting for SSE event from ${url}`)), 5_000);
        })
      ]);
      if (result.done) {
        break;
      }
      text += decoder.decode(result.value, { stream: true });
      onChunk?.(text);
      if (predicate(text)) {
        return text;
      }
    }
    throw new Error(`SSE predicate was not satisfied. Received:\n${text}`);
  } finally {
    controller.abort();
    reader.releaseLock();
  }
}

async function loadPanelClient(
  clientUrl: string,
  auth: Record<string, string>
): Promise<PanelClient> {
  const response = await fetch(clientUrl);
  expect(response.status).toBe(200);
  const source = await response.text();
  const moduleDir = mkdtempSync(path.join(os.tmpdir(), "magi-panel-client-"));
  const modulePath = path.join(moduleDir, "panel-client.mjs");
  const patchedSource = source.replaceAll("window.localStorage", "__magiLocalStorage");
  writeFileSync(
    modulePath,
    [
      "const __magiLocalStorage = {",
      "  getItem(key) {",
      `    if (key === "MAGI_DEVICE_ID") return ${JSON.stringify(auth["x-magi-device-id"])};`,
      `    if (key === "MAGI_DEVICE_TOKEN") return ${JSON.stringify(auth.authorization.replace(/^Bearer\s+/i, ""))};`,
      "    return null;",
      "  }",
      "};",
      patchedSource
    ].join("\n"),
    "utf8"
  );
  const imported = (await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`)) as {
    createMagiPanelClient: (baseUrl: string) => PanelClient;
  };
  return imported.createMagiPanelClient(handle!.url);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

function authHeaders(pairing: { deviceId: string; token: string }): Record<string, string> {
  return {
    authorization: `Bearer ${pairing.token}`,
    "x-magi-device-id": pairing.deviceId
  };
}

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
