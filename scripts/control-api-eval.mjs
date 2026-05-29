#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");
const reportPath =
  process.env.MAGI_CONTROL_API_EVAL_REPORT ??
  path.join(repoRoot, ".magi-reports", "control-api-eval.json");
const startedAt = new Date();
const nodeBin = process.execPath;

const root = process.env.MAGI_KEEP_CONTROL_API_EVAL_TMP
  ? mkdtempSync(path.join(os.tmpdir(), "magi-control-api-eval-keep-"))
  : mkdtempSync(path.join(os.tmpdir(), "magi-control-api-eval-"));
const configDir = path.join(root, "config");
const workDir = path.join(root, "work");

let harnessReport;

try {
  assert(existsSync(cliPath), "dist/cli.js does not exist. Run npm run build first.");
  harnessReport = await import("../dist/harness-report.js");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  const state = {
    controlServeStarted: false,
    pairingSucceeded: false,
    pairingUrlGenerated: false,
    pairingUrlTokenHandoffSeen: false,
    mdnsPeerDiscovered: false,
    approvalSseSeen: false,
    approvalResolved: false,
    approvalFileWritten: false,
    backgroundJobCompleted: false,
    approvalAuditPersisted: false,
    streamDeltaSeen: false,
    jobCancelRequested: false,
    jobCancelled: false,
    queryCancelledAuditPersisted: false,
    approvalCancelResolved: false,
    cancelledApprovalDidNotWrite: false,
    approvalCancelledAuditPersisted: false,
    sessionCreatedForResume: false,
    panelPayloadAccepted: false,
    resumedSessionContextSeen: false,
    resumedSessionMessagesPersisted: false,
    panelHtmlServed: false,
    panelClientContractValid: false,
    panelUiApprovalControlsSeen: false,
    panelUiCancelControlSeen: false,
    panelClientCreateSessionUnwrapped: false,
    panelClientStartJobAccepted: false,
    panelSseJobStreamSeen: false,
    mobileBrowserViewportSeen: false,
    mobileBrowserTokenStored: false,
    mobileBrowserTokenUrlCleaned: false,
    mobileBrowserMessageSent: false,
    mobileBrowserStreamRendered: false,
    mobileBrowserCancelRequested: false,
    mobileBrowserCancelRendered: false
  };
  const controlPort = randomControlPort();
  const providerLog = path.join(root, "provider-log.json");
  const provider = await startProvider({ logPath: providerLog, routeRequest: createRouter(state) });
  let serve;

  try {
    writeFileSync(
      path.join(configDir, "config.yaml"),
      renderConfig({ port: provider.port }),
      "utf8"
    );
    serve = await startServe({ configDir, workDir, controlPort });
    state.controlServeStarted = true;

    const health = await getJson(`${serve.url}/health`);
    assert(health.ok === true, "control health check failed");

    const pairing = await postJson(`${serve.url}/pairing`, { name: "phone-eval" });
    assert(pairing.deviceId && pairing.token, "control pairing did not return credentials");
    state.pairingSucceeded = true;
    const pairingUrl = buildPairingUrl(serve.url, pairing);
    assert(
      pairingUrl.includes("/panel?") &&
        pairingUrl.includes(`device=${encodeURIComponent(pairing.deviceId)}`) &&
        pairingUrl.includes(`token=${encodeURIComponent(pairing.token)}`),
      "pairing URL did not include panel credentials"
    );
    state.pairingUrlGenerated = true;
    const headers = authHeaders(pairing);

    await exerciseMdnsDiscovery({ controlPort, state });
    await exerciseBackgroundApprovalFlow({ serve, headers, workDir, state });
    await exerciseBackgroundCancelFlow({ serve, headers, state });
    await exerciseApprovalCancelFlow({ serve, headers, workDir, state });
    await exercisePanelResumeFlow({ serve, headers, state });
    await exerciseWebPanelContract({ serve, headers, state });
    await exerciseMobilePanelBrowserFlow({ pairingUrl, pairing, state });

    assertAllState(state);
    const report = harnessReport.buildHarnessReport({
      name: "control-api-eval",
      startedAt,
      scenarios: [
        {
          name: "mobile control approval, stream, and cancel workflow",
          status: "passed",
          durationMs: Date.now() - startedAt.getTime(),
          score: 1,
          failureKind: null,
          details: {
            ...state,
            control: { port: controlPort },
            provider: provider.summary()
          }
        }
      ]
    });
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(
      "Control API eval passed (pairing URL, mDNS discovery, approval, SSE, job cancel, approval cancel, session resume, mobile browser panel)."
    );
    console.log(`Control API report: ${reportPath}`);
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
} finally {
  if (!process.env.MAGI_KEEP_CONTROL_API_EVAL_TMP) {
    rmSync(root, { recursive: true, force: true });
  }
}

async function exerciseBackgroundApprovalFlow({ serve, headers, workDir, state }) {
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
  assert(started.jobId && started.sessionId, "background approval job did not start");

  let sseReady = false;
  const ssePromise = readSseUntil(
    `${serve.url}/events?jobId=${encodeURIComponent(started.jobId)}&limit=20`,
    headers,
    (text) => text.includes("agent.approval.pending") && text.includes("control.approval.resolved"),
    (text) => {
      if (text.includes("event: ready")) {
        sseReady = true;
      }
    }
  );
  await waitFor(() => sseReady, "control SSE ready");

  await waitFor(async () => {
    const response = await getJson(
      `${serve.url}/jobs/${encodeURIComponent(started.jobId)}/interactions`,
      headers
    );
    return (response.interactions ?? []).some(
      (interaction) =>
        interaction.kind === "approval" &&
        interaction.status === "pending" &&
        interaction.toolUseId === "approve-mobile"
    );
  }, "pending mobile approval");

  const resolved = await postJson(
    `${serve.url}/jobs/${encodeURIComponent(started.jobId)}/approvals/approve-mobile`,
    { decision: "approve", responder: "phone-eval" },
    headers
  );
  assert(resolved.ok === true, "control approval resolution failed");
  assert(resolved.interaction?.approved === true, "control approval was not approved");
  state.approvalResolved = true;

  const sse = await ssePromise;
  state.approvalSseSeen =
    sse.includes("agent.approval.pending") && sse.includes("control.approval.resolved");

  await waitFor(
    async () => {
      const response = await getJson(
        `${serve.url}/jobs/${encodeURIComponent(started.jobId)}`,
        headers
      );
      return response.job?.status === "completed";
    },
    "background approval job completion",
    10_000
  );
  state.backgroundJobCompleted = true;

  const filePath = path.join(workDir, "mobile-control.txt");
  state.approvalFileWritten =
    existsSync(filePath) && readFileSync(filePath, "utf8") === "approved by mobile control";

  const events = await getJson(
    `${serve.url}/jobs/${encodeURIComponent(started.jobId)}/events?limit=50`,
    headers
  );
  const actions = (events.events ?? []).map((event) => event.action);
  state.approvalAuditPersisted =
    actions.includes("agent.approval.pending") && actions.includes("control.approval.resolved");
}

async function exerciseBackgroundCancelFlow({ serve, headers, state }) {
  const started = await postJson(
    `${serve.url}/jobs`,
    {
      prompt: "Stream and cancel via mobile control.",
      model: "main",
      background: true
    },
    headers,
    202
  );
  assert(started.jobId, "background cancel job did not start");

  const streamText = await readSseUntil(
    `${serve.url}/events?jobId=${encodeURIComponent(started.jobId)}&limit=0`,
    headers,
    (text) => text.includes("agent.text.delta") && text.includes("live ")
  );
  state.streamDeltaSeen = streamText.includes("agent.text.delta") && streamText.includes("live ");

  const cancelled = await postJson(
    `${serve.url}/jobs/${encodeURIComponent(started.jobId)}/cancel`,
    { reason: "operator stop" },
    headers
  );
  state.jobCancelRequested =
    cancelled.ok === true &&
    (cancelled.status === "cancelling" || cancelled.status === "cancelled");

  await waitFor(
    async () => {
      const response = await getJson(
        `${serve.url}/jobs/${encodeURIComponent(started.jobId)}`,
        headers
      );
      return response.job?.status === "cancelled";
    },
    "background stream job cancellation",
    10_000
  );
  state.jobCancelled = true;

  const events = await getJson(
    `${serve.url}/jobs/${encodeURIComponent(started.jobId)}/events?limit=50`,
    headers
  );
  const actions = (events.events ?? []).map((event) => event.action);
  state.queryCancelledAuditPersisted =
    actions.includes("control.job.cancel_requested") && actions.includes("agent.query.cancelled");
}

async function exerciseApprovalCancelFlow({ serve, headers, workDir, state }) {
  const jobPromise = postJson(
    `${serve.url}/jobs`,
    { prompt: "Write then cancel approval through mobile control.", model: "main" },
    headers
  );

  let jobId = "";
  await waitFor(async () => {
    const events = await getJson(`${serve.url}/events.json?limit=100`, headers);
    const pending = (events.events ?? []).find(
      (event) =>
        event.action === "agent.approval.pending" && event.metadata?.toolUseId === "approve-cancel"
    );
    jobId = pending?.jobId ?? "";
    return Boolean(jobId);
  }, "pending approval cancellation");

  const cancel = await postJson(
    `${serve.url}/jobs/${encodeURIComponent(jobId)}/approvals/approve-cancel/cancel`,
    { reason: "operator cancelled" },
    headers
  );
  state.approvalCancelResolved = cancel.ok === true && cancel.interaction?.status === "cancelled";

  const job = await jobPromise;
  assert(job.jobId === jobId, "approval cancel job id mismatch");
  assert(
    job.message === "CONTROL CANCEL DONE",
    "approval cancel did not return cancellation result"
  );

  const filePath = path.join(workDir, "cancelled.txt");
  state.cancelledApprovalDidNotWrite = !existsSync(filePath);

  const events = await getJson(
    `${serve.url}/jobs/${encodeURIComponent(jobId)}/events?limit=50`,
    headers
  );
  const actions = (events.events ?? []).map((event) => event.action);
  state.approvalCancelledAuditPersisted =
    actions.includes("control.approval.cancelled") && actions.includes("agent.approval.cancelled");
}

async function exercisePanelResumeFlow({ serve, headers, state }) {
  const created = await postJson(
    `${serve.url}/sessions`,
    {
      title: "panel resume eval",
      cwd: "/",
      metadata: { source: "panel-eval" }
    },
    headers
  );
  const sessionId = created.session?.id;
  assert(sessionId, "control session creation did not return an id");
  state.sessionCreatedForResume = true;

  const first = await postJson(
    `${serve.url}/sessions/${encodeURIComponent(sessionId)}/messages`,
    { content: "Panel resume seed: keep token orchid-17.", modelAlias: "main" },
    headers
  );
  assert(first.sessionId === sessionId, "first panel message did not stay in session");
  assert(first.message === "CONTROL RESUME SEED", "first panel message returned wrong content");
  state.panelPayloadAccepted = true;

  const second = await postJson(
    `${serve.url}/sessions/${encodeURIComponent(sessionId)}/messages`,
    { content: "Panel resume follow-up: what token should remain visible?", modelAlias: "main" },
    headers
  );
  assert(second.sessionId === sessionId, "resumed panel message did not stay in session");
  assert(second.message === "CONTROL RESUME DONE", "resumed panel message returned wrong content");

  const session = await getJson(`${serve.url}/sessions/${encodeURIComponent(sessionId)}`, headers);
  const messages = session.session?.messages ?? [];
  state.resumedSessionMessagesPersisted =
    messages.filter((message) => message.role === "user").length === 2 &&
    messages.some(
      (message) => message.role === "assistant" && message.content === "CONTROL RESUME DONE"
    );

  const events = await getJson(
    `${serve.url}/sessions/${encodeURIComponent(sessionId)}/events?limit=50`,
    headers
  );
  const actions = (events.events ?? []).map((event) => event.action);
  assert(actions.includes("agent.query.completed"), "resume session events missed completion");
}

async function exerciseWebPanelContract({ serve, headers, state }) {
  const panelResponse = await fetch(`${serve.url}/panel`);
  assert(panelResponse.status === 200, "web panel was not served");
  const panelHtml = await panelResponse.text();
  assert(panelHtml.includes("Magi Next"), "web panel missed app title");
  assert(
    panelHtml.includes('import { createMagiPanelClient } from "/panel-client.js"'),
    "web panel did not load the panel client"
  );
  assert(
    panelHtml.includes("client.createSession") &&
      panelHtml.includes("client.startJob") &&
      panelHtml.includes("/events?jobId="),
    "web panel did not use the session, job, and SSE control flow"
  );
  assert(
    panelHtml.includes("addApprovalCard") &&
      panelHtml.includes("resolveApprovalCard") &&
      panelHtml.includes("client.resolveApproval"),
    "web panel did not expose approval controls"
  );
  assert(
    panelHtml.includes("cancelActiveJob") && panelHtml.includes("client.cancelJob"),
    "web panel did not expose job cancellation"
  );
  state.panelHtmlServed = true;
  state.panelUiApprovalControlsSeen = true;
  state.panelUiCancelControlSeen = true;

  const clientResponse = await fetch(`${serve.url}/panel-client.js`);
  assert(clientResponse.status === 200, "panel client script was not served");
  const clientSource = await clientResponse.text();
  assert(clientSource.includes("createMagiPanelClient"), "panel client export is missing");
  assert(clientSource.includes("resolveApproval"), "panel client lacks approval resolution");
  assert(clientSource.includes("answerQuestion"), "panel client lacks question resolution");
  assert(clientSource.includes("cancelJob"), "panel client lacks job cancellation");
  state.panelClientContractValid = true;

  const client = await importPanelClient(clientSource);
  const api = client(serve.url, headers);
  const created = await api.createSession({
    title: "panel contract eval",
    cwd: "/",
    metadata: { source: "panel-contract-eval" }
  });
  assert(created.id, "panel client did not unwrap createSession response");
  state.panelClientCreateSessionUnwrapped = true;

  const started = await api.startJob({
    content: "Panel browser contract: keep token basil-42.",
    modelAlias: "main",
    sessionId: created.id,
    background: true
  });
  assert(started.jobId && started.sessionId === created.id, "panel client startJob failed");
  state.panelClientStartJobAccepted = true;

  const sse = await readSseUntil(
    `${serve.url}/events?jobId=${encodeURIComponent(started.jobId)}&limit=20`,
    headers,
    (text) =>
      text.includes("agent.query.completed") &&
      text.includes("CONTROL ") &&
      text.includes("PANEL ") &&
      text.includes("CONTRACT")
  );
  state.panelSseJobStreamSeen =
    sse.includes("event: ready") &&
    sse.includes("agent.text.delta") &&
    sse.includes("agent.query.completed");
}

async function exerciseMdnsDiscovery({ controlPort, state }) {
  const mdns = await import("../dist/control/mdns.js");
  const instanceName = `magi-control-eval-${process.pid}`;
  const advertised = mdns.advertiseMdns({
    hostname: "magi-control-eval.local.",
    instanceName,
    port: controlPort,
    txt: {
      version: "eval",
      capability: "panel-pairing"
    }
  });
  const browser = mdns.browseMdns({});
  try {
    await waitFor(
      () =>
        browser
          .peers()
          .some(
            (peer) =>
              peer.instanceName === instanceName &&
              peer.port === controlPort &&
              peer.txt?.capability === "panel-pairing"
          ),
      "mDNS peer discovery",
      5_000
    );
    state.mdnsPeerDiscovered = true;
  } finally {
    browser.stop();
    advertised.stop();
  }
}

async function exerciseMobilePanelBrowserFlow({ pairingUrl, pairing, state }) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3
    });
    const page = await context.newPage();
    await page.goto(pairingUrl, { waitUntil: "domcontentloaded" });
    state.mobileBrowserViewportSeen = await page.evaluate(
      () => window.innerWidth <= 430 && window.innerHeight >= 700
    );
    state.mobileBrowserTokenStored =
      (await page.evaluate(() => window.localStorage.getItem("MAGI_DEVICE_TOKEN"))) ===
      pairing.token;
    state.pairingUrlTokenHandoffSeen = state.mobileBrowserTokenStored;
    state.mobileBrowserTokenUrlCleaned = !page.url().includes("token=");

    const input = page.locator("#input");
    await input.fill("Panel mobile browser flow: keep token tulip-39.");
    await page.locator("#send-btn").tap();
    await page.locator(".msg.user", { hasText: "Panel mobile browser flow" }).waitFor({
      timeout: 10_000
    });
    state.mobileBrowserMessageSent = true;
    await page.locator(".msg.assistant", { hasText: "MOBILE PANEL OK" }).waitFor({
      timeout: 10_000
    });
    state.mobileBrowserStreamRendered = true;

    await input.fill("Panel mobile browser cancel flow");
    await page.locator("#send-btn").tap();
    await page.waitForFunction(
      () => document.querySelector("#send-btn")?.textContent === "Stop",
      undefined,
      { timeout: 10_000 }
    );
    await page.locator("#send-btn").tap();
    state.mobileBrowserCancelRequested = true;
    await page.locator(".msg.system", { hasText: "Cancelled" }).waitFor({ timeout: 10_000 });
    state.mobileBrowserCancelRendered = true;
  } finally {
    await browser.close();
  }
}

function createRouter(state) {
  return ({ body, transcript }) => {
    const latestUser = latestUserFromBody(body);
    if (latestUser.includes("Panel mobile browser cancel flow")) {
      return streamTextResponse(["mobile ", "cancel "]);
    }
    if (latestUser.includes("Panel mobile browser flow")) {
      return completedStreamTextResponse(["MOBILE ", "PANEL ", "OK"]);
    }
    if (latestUser.includes("Stream and cancel via mobile control")) {
      return streamTextResponse(["live ", "delta "]);
    }

    const hasToolMessage = (body.messages ?? []).some((message) => message.role === "tool");
    if (hasToolMessage) {
      if (transcript.includes("mobile-control.txt") || transcript.includes("approve-mobile")) {
        return messageText("CONTROL APPROVAL DONE");
      }
      return messageText("CONTROL CANCEL DONE");
    }

    if (latestUser.includes("Panel resume follow-up")) {
      assert(
        transcript.includes("Panel resume seed: keep token orchid-17."),
        "resumed session context did not include the first panel message"
      );
      state.resumedSessionContextSeen = true;
      return messageText("CONTROL RESUME DONE");
    }

    if (latestUser.includes("Panel resume seed")) {
      return messageText("CONTROL RESUME SEED");
    }

    if (latestUser.includes("Panel browser contract")) {
      return completedStreamTextResponse(["CONTROL ", "PANEL ", "CONTRACT"]);
    }

    if (latestUser.includes("Write then cancel approval through mobile control")) {
      return toolResponse([
        toolCall("approve-cancel", "FileWrite", {
          file_path: "cancelled.txt",
          content: "this should not be written"
        })
      ]);
    }

    if (latestUser.includes("Write a file through mobile Control API approval")) {
      return toolResponse([
        toolCall("approve-mobile", "FileWrite", {
          file_path: "mobile-control.txt",
          content: "approved by mobile control"
        })
      ]);
    }

    return messageText("CONTROL API EVAL READY");
  };
}

async function startProvider({ logPath, routeRequest }) {
  const calls = [];
  const openStreams = new Set();
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

      const call = {
        path: request.url,
        model: body.model ?? "unknown",
        transcript: transcriptFromBody(body),
        stream: body.stream === true,
        toolNames: (body.tools ?? []).map((tool) => tool.function?.name).filter(Boolean)
      };
      calls.push(call);
      writeFileSync(logPath, JSON.stringify(calls, null, 2), "utf8");

      let result;
      try {
        result = routeRequest({ body, transcript: call.transcript, toolNames: call.toolNames });
      } catch (error) {
        result = fail(500, error instanceof Error ? error.message : String(error));
      }

      if (result.stream) {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache"
        });
        openStreams.add(response);
        const keepAlive = setInterval(() => {
          response.write(": keepalive\n\n");
        }, 1_000);
        keepAlive.unref?.();
        response.once("close", () => {
          clearInterval(keepAlive);
          openStreams.delete(response);
        });
        for (const text of result.chunks) {
          response.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
          );
        }
        if (result.end === true) {
          response.write(`data: [DONE]\n\n`);
          response.end();
        }
        return;
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
        if (call.model) {
          models.add(call.model);
        }
        for (const toolName of call.toolNames ?? []) {
          exposedTools.add(toolName);
        }
      }
      return {
        callCount: calls.length,
        models: Array.from(models).sort(),
        exposedToolCount: exposedTools.size,
        exposedTools: Array.from(exposedTools).sort()
      };
    },
    close: () =>
      new Promise((resolve) => {
        for (const stream of openStreams) {
          stream.destroy();
        }
        server.close(resolve);
      })
  };
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
    "  fallbacks:",
    "    {}",
    "mcp:",
    "  servers: {}",
    "context:",
    "  recentMessages: 6",
    ""
  ].join("\n");
}

async function startServe({ configDir, workDir, controlPort }) {
  const child = spawn(nodeBin, [cliPath, "--no-color", "serve"], {
    cwd: workDir,
    env: {
      ...process.env,
      MAGI_CONFIG_DIR: configDir,
      MAGI_CONTROL_PORT: String(controlPort),
      MAGI_DISABLE_MDNS: "1",
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
      `magi serve did not start\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}\n${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  return {
    url: `http://127.0.0.1:${controlPort}`,
    stdout: () => stdout,
    stderr: () => stderr,
    close
  };
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

function buildPairingUrl(baseUrl, pairing) {
  const url = new URL("/panel", baseUrl);
  url.searchParams.set("device", pairing.deviceId);
  url.searchParams.set("token", pairing.token);
  return url.toString();
}

function authHeaders(pairing) {
  return {
    authorization: `Bearer ${pairing.token}`,
    "x-magi-device-id": pairing.deviceId
  };
}

async function importPanelClient(source) {
  const moduleDir = mkdtempSync(path.join(os.tmpdir(), "magi-panel-client-eval-"));
  const modulePath = path.join(moduleDir, "panel-client.mjs");
  const patchedSource = source.replaceAll("window.localStorage", "__magiLocalStorage");
  writeFileSync(
    modulePath,
    [
      "let __magiDeviceId = null;",
      "let __magiDeviceToken = null;",
      "const __magiLocalStorage = {",
      "  getItem(key) {",
      "    if (key === 'MAGI_DEVICE_ID') return __magiDeviceId;",
      "    if (key === 'MAGI_DEVICE_TOKEN') return __magiDeviceToken;",
      "    return null;",
      "  }",
      "};",
      patchedSource,
      "export function createAuthenticatedMagiPanelClient(baseUrl, headers) {",
      "  __magiDeviceId = headers['x-magi-device-id'];",
      "  __magiDeviceToken = String(headers.authorization || '').replace(/^Bearer\\s+/i, '');",
      "  return createMagiPanelClient(baseUrl);",
      "}"
    ].join("\n"),
    "utf8"
  );
  const imported = await import(`${pathToFileUrl(modulePath)}?t=${Date.now()}`);
  return (baseUrl, headers) => imported.createAuthenticatedMagiPanelClient(baseUrl, headers);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomControlPort() {
  return 30_000 + Math.floor(Math.random() * 20_000);
}

function pathToFileUrl(file) {
  let resolved = path.resolve(file).replace(/\\/g, "/");
  if (!resolved.startsWith("/")) {
    resolved = `/${resolved}`;
  }
  return `file://${resolved.split("/").map(encodeURIComponent).join("/")}`;
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

function streamTextResponse(chunks) {
  return { stream: true, chunks };
}

function completedStreamTextResponse(chunks) {
  return { stream: true, chunks, end: true };
}

function fail(status, message) {
  return {
    status,
    body: {
      error: { message, type: "mock_assertion_failed" }
    }
  };
}

function latestUserFromBody(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      return textFromMessage(messages[index]);
    }
  }
  return "";
}

function transcriptFromBody(body) {
  return (body.messages ?? []).map(textFromMessage).join("\n");
}

function textFromMessage(message) {
  const content = message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("\n");
  }
  return "";
}

function assertAllState(state) {
  for (const [key, value] of Object.entries(state)) {
    assert(value === true, `${key}=false`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function printProviderLog(providerLog) {
  if (existsSync(providerLog)) {
    console.error("\nProvider log:");
    console.error(readFileSync(providerLog, "utf8"));
  }
}
