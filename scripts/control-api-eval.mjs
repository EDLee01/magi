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
    sseDisconnectSimulated: false,
    sseReconnectUsedAfterId: false,
    sseReconnectCompletionSeen: false,
    sseReconnectNoDuplicateReplay: false,
    sseReconnectAuditPersisted: false,
    sseJitterMultipleDisconnectsSimulated: false,
    sseJitterRepeatedAfterCursorUsed: false,
    sseJitterCompletionSeen: false,
    sseJitterNoDuplicateReplay: false,
    sseJitterAuditPersisted: false,
    restartServeStarted: false,
    restartDeviceAuthPersisted: false,
    restartSessionPersisted: false,
    restartSessionContextSeen: false,
    restartJobPersisted: false,
    restartJobAuditPersisted: false,
    mobileBrowserViewportSeen: false,
    mobileBrowserTokenStored: false,
    mobileBrowserTokenUrlCleaned: false,
    mobileBrowserMessageSent: false,
    mobileBrowserStreamRendered: false,
    mobileBrowserCancelRequested: false,
    mobileBrowserCancelRendered: false,
    lanSmokeBoundAllInterfaces: false,
    lanSmokeHealthSeen: false,
    lanSmokePanelLoaded: false,
    lanSmokeAuthenticatedApiSeen: false,
    peerCredentialsSaved: false,
    peerSavedListed: false,
    peerDispatchBoundAllInterfaces: false,
    peerDispatchExternalUrlReachable: false,
    peerAgentToolSearched: false,
    peerAgentSchemaRevealed: false,
    peerAgentDispatched: false,
    peerDispatchSingleAgentCall: false,
    peerDispatchCompleted: false,
    peerDispatchResultReturned: false,
    peerRemoteSessionCreated: false,
    peerRemoteJobCompleted: false,
    peerRemotePermissionModeInherited: false,
    peerRemoteFileWritten: false,
    peerLocalFileNotWritten: false,
    peerDispatchAuditPersisted: false,
    peerLongAgentDispatched: false,
    peerLongDispatchRunningObserved: false,
    peerLongDispatchCompleted: false,
    peerLongDispatchResultReturned: false,
    peerLongDispatchSecondAgentCall: false,
    peerLongRemoteFileWritten: false,
    peerLongRemoteFileIsolated: false,
    peerLongRemoteJobCompleted: false,
    peerLongRemoteAuditPersisted: false
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
    serve = await startServe({ configDir, workDir, controlPort, controlBind: "0.0.0.0" });
    state.controlServeStarted = true;
    state.lanSmokeBoundAllInterfaces = serve.bind === "0.0.0.0";

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
    const approvalFlow = await exerciseBackgroundApprovalFlow({ serve, headers, workDir, state });
    await exerciseBackgroundCancelFlow({ serve, headers, state });
    await exerciseApprovalCancelFlow({ serve, headers, workDir, state });
    const resumeFlow = await exercisePanelResumeFlow({ serve, headers, state });
    await exerciseWebPanelContract({ serve, headers, state });
    await exerciseSseReconnectFlow({ serve, headers, state });
    await exerciseSseJitterRecoveryFlow({ serve, headers, state });
    const restartFlow = await exerciseControlRestartPersistenceFlow({
      serve,
      headers,
      state,
      controlPort,
      approvalJobId: approvalFlow.jobId,
      resumeSessionId: resumeFlow.sessionId
    });
    serve = restartFlow.serve;
    await exerciseMobilePanelBrowserFlow({ pairingUrl, pairing, state });
    const lanSmoke = await exerciseLanDeviceSmoke({ controlPort, pairing, state });
    const peerDispatch = await exercisePeerDispatchFlow({ provider, state });

    assertAllState(state);
    const assertions = [
      "control server health endpoint passed",
      "pairing credentials returned",
      "pairing URL carried panel credentials",
      "mDNS peer discovery found advertised control server",
      "background approval job started",
      "approval SSE pending and resolved events streamed",
      "approval resolution accepted mobile responder",
      "approved FileWrite created workspace file",
      "approval audit events persisted",
      "streaming job emitted text delta",
      "job cancel request accepted",
      "streaming job reached cancelled status",
      "query cancellation audit events persisted",
      "active approval cancellation accepted",
      "cancelled approval avoided file write",
      "approval cancellation audit events persisted",
      "panel session created for resume",
      "panel follow-up saw prior session context",
      "resumed session messages persisted",
      "panel HTML served app shell",
      "panel client contract exported control methods",
      "panel client createSession unwrapped response",
      "panel client startJob accepted background job",
      "panel SSE stream reached completion",
      "SSE disconnect simulated after ready event",
      "SSE reconnect used after id cursor",
      "SSE reconnect observed job completion",
      "SSE reconnect avoided duplicate replay",
      "SSE reconnect completion persisted in audit",
      "SSE jitter simulated repeated disconnects",
      "SSE jitter reused after cursor on repeated reconnect",
      "SSE jitter observed long job completion",
      "SSE jitter avoided duplicate replay",
      "SSE jitter completion persisted in audit",
      "control server restarted on persisted state",
      "paired device authenticated after restart",
      "panel session messages survived control restart",
      "restarted session follow-up saw prior context",
      "completed approval job survived control restart",
      "completed approval job audit survived control restart",
      "mobile viewport rendered panel",
      "mobile pairing token stored and URL cleaned",
      "mobile browser sent message",
      "mobile browser rendered assistant stream",
      "mobile browser requested cancellation",
      "mobile browser rendered cancellation",
      "control server bound all interfaces for LAN smoke",
      "LAN device smoke reached health endpoint",
      "LAN device smoke loaded tokenized panel",
      "LAN device smoke authenticated API request",
      "peer credentials saved locally",
      "saved peer listed by CLI",
      "peer daemon bound all interfaces for LAN dispatch",
      "peer dispatch external URL reached health endpoint",
      "Agent deferred tool revealed through ToolSearch",
      "peer Agent dispatch called once",
      "peer dispatch returned remote result",
      "remote peer session created",
      "remote peer job completed",
      "remote peer inherited acceptEdits permission mode",
      "remote peer wrote requested file",
      "local workspace did not receive remote file",
      "remote peer audit persisted completion",
      "long peer Agent dispatch issued",
      "long peer running job observed remotely",
      "long peer dispatch completed",
      "long peer dispatch returned remote benchmark result",
      "long peer dispatch used second Agent call",
      "long peer wrote requested file remotely",
      "long peer file stayed out of local workspace",
      "long peer remote job completed",
      "long peer remote audit persisted completion"
    ];
    const filesVerified = [
      "mobile-control.txt",
      "state/control-sessions.json",
      "state/control-jobs.json",
      "state/control-devices.json",
      "state/peers.json",
      "peer-work/peer-output.txt",
      "peer-config/state/control-sessions.json",
      "peer-config/state/control-jobs.json"
    ];
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
            assertions,
            filesVerified,
            control: { port: controlPort },
            lanSmoke,
            peerDispatch,
            provider: provider.summary()
          }
        }
      ]
    });
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(
      "Control API eval passed (pairing URL, mDNS discovery, approval, SSE reconnect, job cancel, approval cancel, session resume, mobile browser panel, peer dispatch)."
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
  return { jobId: started.jobId };
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
  return { sessionId };
}

async function exerciseControlRestartPersistenceFlow({
  serve,
  headers,
  state,
  controlPort,
  approvalJobId,
  resumeSessionId
}) {
  await serve.close();
  let restarted;
  try {
    restarted = await startServe({ configDir, workDir, controlPort, controlBind: "0.0.0.0" });
    state.restartServeStarted = true;

    const health = await getJson(`${restarted.url}/health`);
    assert(health.ok === true, "restarted control health check failed");

    const sessions = await getJson(`${restarted.url}/sessions`, headers);
    state.restartDeviceAuthPersisted = Array.isArray(sessions.sessions);

    const session = await getJson(
      `${restarted.url}/sessions/${encodeURIComponent(resumeSessionId)}`,
      headers
    );
    const messages = session.session?.messages ?? [];
    state.restartSessionPersisted =
      messages.some(
        (message) =>
          message.role === "user" &&
          textFromMessage(message).includes("Panel resume seed: keep token orchid-17.")
      ) &&
      messages.some(
        (message) => message.role === "assistant" && textFromMessage(message) === "CONTROL RESUME DONE"
      );

    const followUp = await postJson(
      `${restarted.url}/sessions/${encodeURIComponent(resumeSessionId)}/messages`,
      { content: "Panel restart follow-up: what token remains visible?", modelAlias: "main" },
      headers
    );
    assert(
      followUp.message === "CONTROL RESTART RESUME DONE",
      "restarted panel session follow-up returned wrong content"
    );

    const job = await getJson(
      `${restarted.url}/jobs/${encodeURIComponent(approvalJobId)}`,
      headers
    );
    state.restartJobPersisted = job.job?.status === "completed";

    const events = await getJson(
      `${restarted.url}/jobs/${encodeURIComponent(approvalJobId)}/events?limit=100`,
      headers
    );
    const actions = (events.events ?? []).map((event) => event.action);
    state.restartJobAuditPersisted =
      actions.includes("agent.approval.pending") &&
      actions.includes("control.approval.resolved") &&
      actions.includes("agent.query.completed");

    return { serve: restarted };
  } catch (error) {
    if (restarted) {
      await restarted.close();
    }
    throw error;
  }
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

async function exerciseSseReconnectFlow({ serve, headers, state }) {
  const started = await postJson(
    `${serve.url}/jobs`,
    {
      prompt: "Panel reconnect stream: keep token cedar-58.",
      model: "main",
      background: true
    },
    headers,
    202
  );
  assert(started.jobId, "SSE reconnect job did not start");

  const firstConnect = await readSseUntilAndCancel(
    `${serve.url}/events?jobId=${encodeURIComponent(started.jobId)}&limit=50`,
    headers,
    (text) => text.includes("event: ready") && text.includes("agent.query.started")
  );
  assert(firstConnect.lastEventId, "SSE disconnect did not capture an audit cursor");
  state.sseDisconnectSimulated =
    firstConnect.cancelled === true &&
    firstConnect.text.includes("event: ready") &&
    firstConnect.text.includes("agent.query.started");

  await waitFor(
    async () => {
      const response = await getJson(
        `${serve.url}/jobs/${encodeURIComponent(started.jobId)}`,
        headers
      );
      return response.job?.status === "completed";
    },
    "SSE reconnect job completion",
    10_000
  );

  const reconnectUrl =
    `${serve.url}/events?jobId=${encodeURIComponent(started.jobId)}` +
    `&limit=50&after=${encodeURIComponent(String(firstConnect.lastEventId ?? 0))}`;
  const reconnected = await readSseUntil(
    reconnectUrl,
    headers,
    (text) =>
      text.includes("agent.query.completed") &&
      text.includes("CONTROL ") &&
      text.includes("RECONNECT ") &&
      text.includes("DONE")
  );
  state.sseReconnectUsedAfterId = reconnectUrl.includes("after=");
  state.sseReconnectCompletionSeen =
    reconnected.includes("agent.query.completed") &&
    reconnected.includes("CONTROL ") &&
    reconnected.includes("RECONNECT ") &&
    reconnected.includes("DONE");
  state.sseReconnectNoDuplicateReplay = !reconnected.includes("agent.query.started");

  const events = await getJson(
    `${serve.url}/jobs/${encodeURIComponent(started.jobId)}/events?limit=50`,
    headers
  );
  state.sseReconnectAuditPersisted = (events.events ?? []).some(
    (event) =>
      event.action === "agent.query.completed" &&
      Number(event.id) > Number(firstConnect.lastEventId)
  );
}

async function exerciseSseJitterRecoveryFlow({ serve, headers, state }) {
  const started = await postJson(
    `${serve.url}/jobs`,
    {
      prompt: "Panel jitter reconnect stream: keep token maple-92.",
      model: "main",
      background: true
    },
    headers,
    202
  );
  assert(started.jobId, "SSE jitter reconnect job did not start");

  const firstConnect = await readSseUntilAndCancel(
    `${serve.url}/events?jobId=${encodeURIComponent(started.jobId)}&limit=50`,
    headers,
    (text) => text.includes("event: ready") && text.includes("agent.query.started")
  );
  assert(firstConnect.lastEventId, "first SSE jitter disconnect did not capture a cursor");

  const secondConnectUrl =
    `${serve.url}/events?jobId=${encodeURIComponent(started.jobId)}` +
    `&limit=50&after=${encodeURIComponent(String(firstConnect.lastEventId))}`;
  const secondConnect = await readSseUntilAndCancel(
    secondConnectUrl,
    headers,
    (text) => text.includes("agent.text.delta")
  );
  assert(secondConnect.lastEventId, "second SSE jitter disconnect did not capture a cursor");
  assert(
    Number(secondConnect.lastEventId) >= Number(firstConnect.lastEventId),
    "second SSE jitter cursor moved backwards"
  );

  await waitFor(
    async () => {
      const response = await getJson(
        `${serve.url}/jobs/${encodeURIComponent(started.jobId)}`,
        headers
      );
      return response.job?.status === "completed";
    },
    "SSE jitter reconnect job completion",
    10_000
  );

  const finalReconnectUrl =
    `${serve.url}/events?jobId=${encodeURIComponent(started.jobId)}` +
    `&limit=50&after=${encodeURIComponent(String(secondConnect.lastEventId))}`;
  const finalConnect = await readSseUntil(
    finalReconnectUrl,
    headers,
    (text) =>
      text.includes("agent.query.completed") &&
      text.includes("JITTER ") &&
      text.includes("DONE")
  );
  const combinedReconnectText = `${secondConnect.text}\n${finalConnect}`;

  state.sseJitterMultipleDisconnectsSimulated =
    firstConnect.cancelled === true &&
    secondConnect.cancelled === true &&
    firstConnect.text.includes("agent.query.started") &&
    secondConnect.text.includes("agent.text.delta");
  state.sseJitterRepeatedAfterCursorUsed =
    secondConnectUrl.includes("after=") && finalReconnectUrl.includes("after=");
  state.sseJitterCompletionSeen =
    finalConnect.includes("agent.query.completed") &&
    combinedReconnectText.includes("CONTROL ") &&
    combinedReconnectText.includes("JITTER ") &&
    combinedReconnectText.includes("DONE");
  state.sseJitterNoDuplicateReplay =
    !secondConnect.text.includes("agent.query.started") &&
    !finalConnect.includes("agent.query.started");

  const events = await getJson(
    `${serve.url}/jobs/${encodeURIComponent(started.jobId)}/events?limit=100`,
    headers
  );
  state.sseJitterAuditPersisted = (events.events ?? []).some(
    (event) =>
      event.action === "agent.query.completed" &&
      Number(event.id) > Number(secondConnect.lastEventId)
  );
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

async function exerciseLanDeviceSmoke({ controlPort, pairing, state }) {
  const candidates = controlUrlCandidates({ controlPort });
  let lastError;
  for (const candidate of candidates) {
    const pairingUrl = buildPairingUrl(candidate.baseUrl, pairing);
    try {
      const result = await runLanDeviceSmoke({
        baseUrl: candidate.baseUrl,
        pairingUrl,
        deviceId: pairing.deviceId,
        token: pairing.token
      });
      state.lanSmokeHealthSeen = result.healthOk === true;
      state.lanSmokePanelLoaded = result.panelOk === true;
      state.lanSmokeAuthenticatedApiSeen = result.authOk === true;
      assert(state.lanSmokeHealthSeen, `LAN smoke health failed through ${candidate.host}`);
      assert(state.lanSmokePanelLoaded, `LAN smoke panel failed through ${candidate.host}`);
      assert(
        state.lanSmokeAuthenticatedApiSeen,
        `LAN smoke auth failed through ${candidate.host}`
      );
      return {
        host: candidate.host,
        usedLoopbackFallback: candidate.usedLoopbackFallback,
        healthOk: result.healthOk,
        panelOk: result.panelOk,
        authOk: result.authOk
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `LAN device smoke failed for ${candidates.map((candidate) => candidate.host).join(", ")}\n${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

async function exercisePeerDispatchFlow({ provider, state }) {
  const peerConfigDir = path.join(root, "peer-config");
  const peerWorkDir = path.join(root, "peer-work");
  const peerControlPort = randomControlPort();
  mkdirSync(peerConfigDir, { recursive: true });
  mkdirSync(peerWorkDir, { recursive: true });
  writeFileSync(
    path.join(peerConfigDir, "config.yaml"),
    renderConfig({ port: provider.port }),
    "utf8"
  );

  let peerServe;
  try {
    peerServe = await startServe({
      configDir: peerConfigDir,
      workDir: peerWorkDir,
      controlPort: peerControlPort,
      controlBind: "0.0.0.0"
    });
    state.peerDispatchBoundAllInterfaces = peerServe.bind === "0.0.0.0";
    const peerHealth = await getJson(`${peerServe.url}/health`);
    assert(peerHealth.ok === true, "peer control health check failed");
    const externalPeer = await resolveReachableControlUrl({
      controlPort: peerControlPort,
      path: "/health"
    });
    const externalPeerHealth = await getJson(new URL("/health", externalPeer.baseUrl).toString());
    state.peerDispatchExternalUrlReachable = externalPeerHealth.ok === true;

    const peerPairing = await postJson(`${peerServe.url}/pairing`, {
      name: "peer-dispatch-eval"
    });
    assert(peerPairing.deviceId && peerPairing.token, "peer pairing did not return credentials");
    const peerHeaders = authHeaders(peerPairing);

    await runCli([
      "peers",
      "add",
      "peer-eval",
      externalPeer.baseUrl,
      peerPairing.deviceId,
      peerPairing.token
    ]);
    state.peerCredentialsSaved = true;

    const saved = await runCli(["peers", "saved"]);
    state.peerSavedListed = saved.includes("peer-eval") && saved.includes(externalPeer.baseUrl);

    const output = await runCli([
      "--permission-mode",
      "acceptEdits",
      "--model",
      "main",
      "--output-format",
      "stream-json",
      "-p",
      "Dispatch a sub-agent to peer-eval using Agent target and report its result."
    ]);
    state.peerDispatchCompleted = output.includes("CONTROL PEER DISPATCH DONE");
    assert(state.peerDispatchCompleted, "peer dispatch final answer missing");

    state.peerDispatchResultReturned =
      output.includes("PEER DISPATCH OK") && output.includes("peer-output.txt");
    state.peerDispatchSingleAgentCall = provider.summary().toolCounts.Agent === 1;
    assert(state.peerDispatchSingleAgentCall, "peer dispatch should call Agent exactly once");

    const remoteFile = path.join(peerWorkDir, "peer-output.txt");
    const localFile = path.join(workDir, "peer-output.txt");
    state.peerRemoteFileWritten =
      existsSync(remoteFile) && readFileSync(remoteFile, "utf8") === "remote peer write ok";
    state.peerLocalFileNotWritten = !existsSync(localFile);

    const peerSessions = await getJson(`${peerServe.url}/sessions`, peerHeaders);
    const remoteSession = (peerSessions.sessions ?? []).find(
      (session) =>
        session.title?.includes("Write peer-output.txt") || session.messageCount >= 2
    );
    state.peerRemoteSessionCreated = Boolean(remoteSession);

    const peerJobs = await getJson(`${peerServe.url}/jobs`, peerHeaders);
    state.peerRemoteJobCompleted = (peerJobs.jobs ?? []).some((job) => job.status === "completed");

    const audit = await getJson(`${peerServe.url}/events.json?limit=100`, peerHeaders);
    const auditEvents = audit.events ?? [];
    const remoteFileWriteRequested = auditEvents.some(
      (event) =>
        event.action === "agent.tool.use" &&
        event.target === "FileWrite" &&
        event.metadata?.input?.file_path === "peer-output.txt"
    );
    const remoteFileWriteCompleted = auditEvents.some(
      (event) => event.action === "agent.tool.completed" && event.target === "FileWrite"
    );
    state.peerRemotePermissionModeInherited =
      remoteFileWriteRequested && remoteFileWriteCompleted && state.peerRemoteFileWritten;
    state.peerDispatchAuditPersisted = auditEvents.some(
      (event) => event.action === "agent.query.completed"
    );

    const longOutputPromise = runCli(
      [
        "--permission-mode",
        "acceptEdits",
        "--model",
        "main",
        "--output-format",
        "stream-json",
        "-p",
        "Dispatch a long-running benchmark sub-agent to peer-eval using Agent target and report its result."
      ],
      60_000
    );

    let observedLongJobId;
    await waitFor(
      async () => {
        const peerJobsDuringRun = await getJson(`${peerServe.url}/jobs`, peerHeaders);
        const peerSessionsDuringRun = await getJson(`${peerServe.url}/sessions`, peerHeaders);
        const longSessionIds = new Set(
          (peerSessionsDuringRun.sessions ?? [])
            .filter((session) =>
              String(session.title ?? "").includes("Write peer-long-output.txt")
            )
            .map((session) => session.id)
        );
        const job = (peerJobsDuringRun.jobs ?? []).find(
          (candidate) =>
            candidate.status === "running" &&
            longSessionIds.has(candidate.sessionId)
        );
        observedLongJobId = job?.id;
        return Boolean(observedLongJobId);
      },
      "long-running peer dispatch job",
      15_000
    );
    state.peerLongDispatchRunningObserved = true;

    const longOutput = await longOutputPromise;
    state.peerLongDispatchCompleted = longOutput.includes("CONTROL PEER LONG DISPATCH DONE");
    assert(state.peerLongDispatchCompleted, "long peer dispatch final answer missing");
    state.peerLongDispatchResultReturned =
      longOutput.includes("PEER LONG DISPATCH OK") && longOutput.includes("peer-long-output.txt");
    state.peerLongDispatchSecondAgentCall = provider.summary().toolCounts.Agent === 2;
    assert(state.peerLongDispatchSecondAgentCall, "long peer dispatch should call Agent twice total");

    const longRemoteFile = path.join(peerWorkDir, "peer-long-output.txt");
    const longLocalFile = path.join(workDir, "peer-long-output.txt");
    state.peerLongRemoteFileWritten =
      existsSync(longRemoteFile) &&
      readFileSync(longRemoteFile, "utf8") === "long remote peer benchmark ok";
    state.peerLongRemoteFileIsolated = !existsSync(longLocalFile);

    const longPeerJobs = await getJson(`${peerServe.url}/jobs`, peerHeaders);
    state.peerLongRemoteJobCompleted = (longPeerJobs.jobs ?? []).some(
      (job) => job.id === observedLongJobId && job.status === "completed"
    );
    const longAudit = await getJson(
      `${peerServe.url}/jobs/${encodeURIComponent(observedLongJobId)}/events?limit=100`,
      peerHeaders
    );
    const longAuditEvents = longAudit.events ?? [];
    state.peerLongRemoteAuditPersisted =
      longAuditEvents.some((event) => event.action === "agent.query.started") &&
      longAuditEvents.some(
        (event) => event.action === "agent.tool.completed" && event.target === "FileWrite"
      ) &&
      longAuditEvents.some((event) => event.action === "agent.query.completed");

    return {
      baseUrl: externalPeer.baseUrl,
      usedLoopbackFallback: externalPeer.usedLoopbackFallback,
      longJobId: observedLongJobId
    };
  } finally {
    if (peerServe) {
      await peerServe.close();
    }
  }
}

function createRouter(state) {
  return ({ body, transcript }) => {
    const latestUser = latestUserFromBody(body);
    if (latestUser.includes("Write peer-long-output.txt")) {
      const hasToolMessage = (body.messages ?? []).some((message) => message.role === "tool");
      if (!hasToolMessage) {
        return toolResponse([
          toolCall("remote-peer-long-write", "FileWrite", {
            file_path: "peer-long-output.txt",
            content: "long remote peer benchmark ok"
          })
        ]);
      }
      assert(
        transcript.includes("Wrote peer-long-output.txt"),
        "long remote FileWrite result missing"
      );
      return delayedMessageText(
        "PEER LONG DISPATCH OK: peer-long-output.txt written.",
        1_500
      );
    }
    if (latestUser.includes("Write peer-output.txt")) {
      const hasToolMessage = (body.messages ?? []).some((message) => message.role === "tool");
      if (!hasToolMessage) {
        return toolResponse([
          toolCall("remote-peer-write", "FileWrite", {
            file_path: "peer-output.txt",
            content: "remote peer write ok"
          })
        ]);
      }
      assert(transcript.includes("Wrote peer-output.txt"), "remote FileWrite result missing");
      return messageText("PEER DISPATCH OK: peer-output.txt written on remote peer.");
    }
    if (transcript.includes("PEER DISPATCH OK") && transcript.includes("Agent")) {
      state.peerDispatchResultReturned = true;
      return messageText("CONTROL PEER DISPATCH DONE");
    }
    if (transcript.includes("PEER LONG DISPATCH OK") && transcript.includes("Agent")) {
      state.peerLongDispatchResultReturned = true;
      return messageText("CONTROL PEER LONG DISPATCH DONE");
    }
    if (
      latestUser.includes("Dispatch a long-running benchmark sub-agent to peer-eval") &&
      transcript.includes("Tool: Agent") &&
      transcript.includes("peer-eval")
    ) {
      state.peerLongAgentDispatched = true;
      return toolResponse([
        toolCall("dispatch-peer-long-agent", "Agent", {
          description: "peer long benchmark",
          prompt:
            "Write peer-long-output.txt with exactly: long remote peer benchmark ok. Then stream PEER LONG DISPATCH OK.",
          subagent_type: "general",
          target: "peer-eval"
        })
      ]);
    }
    if (latestUser.includes("Dispatch a long-running benchmark sub-agent to peer-eval")) {
      assert(
        !body.tools?.some((tool) => tool.function?.name === "Agent"),
        "Agent should start deferred"
      );
      state.peerAgentToolSearched = true;
      return toolResponse([
        toolCall("select-agent-tool-for-long-dispatch", "ToolSearch", {
          query: "select:Agent"
        })
      ]);
    }
    if (
      latestUser.includes("Dispatch a sub-agent to peer-eval") &&
      transcript.includes("Tool: Agent") &&
      transcript.includes("peer-eval")
    ) {
      state.peerAgentSchemaRevealed = true;
      state.peerAgentDispatched = true;
      return toolResponse([
        toolCall("dispatch-peer-agent", "Agent", {
          description: "peer remote write check",
          prompt: "Write peer-output.txt with exactly: remote peer write ok. Then report PEER DISPATCH OK.",
          subagent_type: "general",
          target: "peer-eval"
        })
      ]);
    }
    if (latestUser.includes("Dispatch a sub-agent to peer-eval")) {
      assert(
        !body.tools?.some((tool) => tool.function?.name === "Agent"),
        "Agent should start deferred"
      );
      state.peerAgentToolSearched = true;
      return toolResponse([
        toolCall("select-agent-tool", "ToolSearch", {
          query: "select:Agent"
        })
      ]);
    }
    if (latestUser.includes("Panel mobile browser cancel flow")) {
      return streamTextResponse(["mobile ", "cancel "]);
    }
    if (latestUser.includes("Panel reconnect stream")) {
      return completedStreamTextResponse(["CONTROL ", "RECONNECT ", "DONE"]);
    }
    if (latestUser.includes("Panel jitter reconnect stream")) {
      return completedStreamTextResponse(["CONTROL ", "JITTER ", "DONE"], 150);
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

    if (latestUser.includes("Panel restart follow-up")) {
      assert(
        transcript.includes("Panel resume seed: keep token orchid-17."),
        "restarted session context did not include the first panel message"
      );
      assert(
        transcript.includes("CONTROL RESUME DONE"),
        "restarted session context did not include the pre-restart assistant message"
      );
      state.restartSessionContextSeen = true;
      return messageText("CONTROL RESTART RESUME DONE");
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
  const toolCounts = {};
  const openStreams = new Set();
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
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
      for (const toolCall of (result.body ?? result).choices?.[0]?.message?.tool_calls ?? []) {
        const toolName = toolCall.function?.name;
        if (toolName) {
          toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1;
        }
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
          if (result.delayMs > 0) {
            await sleep(result.delayMs);
          }
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

      if (result.delayMs > 0) {
        await sleep(result.delayMs);
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
        exposedTools: Array.from(exposedTools).sort(),
        toolCounts
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

async function startServe({ configDir, workDir, controlPort, controlBind = "127.0.0.1" }) {
  const child = spawn(nodeBin, [cliPath, "--no-color", "serve"], {
    cwd: workDir,
    env: {
      ...process.env,
      MAGI_CONTROL_BIND: controlBind,
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
    bind: controlBind,
    stdout: () => stdout,
    stderr: () => stderr,
    close
  };
}

function runLanDeviceSmoke({ baseUrl, pairingUrl, deviceId, token }) {
  const script = `
const input = JSON.parse(process.argv[1]);
const headers = {
  authorization: \`Bearer \${input.token}\`,
  "x-magi-device-id": input.deviceId
};
const timeoutSignal = AbortSignal.timeout(5000);
const health = await fetch(new URL("/health", input.baseUrl), { signal: timeoutSignal });
const panel = await fetch(input.pairingUrl, { signal: timeoutSignal });
const panelHtml = await panel.text();
const sessions = await fetch(new URL("/sessions", input.baseUrl), {
  headers,
  signal: timeoutSignal
});
process.stdout.write(JSON.stringify({
  healthOk: health.ok && (await health.json()).ok === true,
  panelOk: panel.ok && panelHtml.includes("panel-client.js") && panelHtml.includes("Magi"),
  authOk: sessions.ok && Array.isArray((await sessions.json()).sessions)
}));
`;
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBin, ["--input-type=module", "-e", script, JSON.stringify({
      baseUrl,
      pairingUrl,
      deviceId,
      token
    })], {
      cwd: workDir,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, 8_000);
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
      if (code !== 0) {
        reject(
          new Error(
            `LAN smoke process failed with exit ${code ?? signal}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`
          )
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(
          new Error(
            `LAN smoke process returned invalid JSON\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}\n${
              error instanceof Error ? error.message : String(error)
            }`
          )
        );
      }
    });
  });
}

function runCli(args, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBin, [cliPath, "--no-color", ...args], {
      cwd: workDir,
      env: {
        ...process.env,
        MAGI_CONFIG_DIR: configDir,
        MAGI_INTERACTION_TIMEOUT_MS: "10000",
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
            `control api eval command timed out after ${timeoutMs}ms\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`
          )
        );
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `control api eval command failed with exit ${code ?? signal}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`
          )
        );
        return;
      }
      resolve(stdout);
    });
  });
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

async function readSseUntilAndCancel(url, headers, predicate, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let text = "";
  let lastEventId;
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
        lastEventId = latestSseId(text) ?? lastEventId;
        if (predicate(text)) {
          await reader.cancel();
          return { text, lastEventId, cancelled: true };
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

function latestSseId(text) {
  const matches = [...text.matchAll(/^id:\s*(\d+)$/gm)];
  const last = matches.at(-1)?.[1];
  return last === undefined ? undefined : Number(last);
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

function lanAddressCandidates() {
  const hosts = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const entry of interfaces ?? []) {
      if (entry.family === "IPv4" && !entry.internal && entry.address) {
        hosts.push(entry.address);
      }
    }
  }
  hosts.push("127.0.0.1");
  return [...new Set(hosts)];
}

function controlUrlCandidates({ controlPort }) {
  return lanAddressCandidates().map((host) => ({
    host,
    baseUrl: `http://${host}:${controlPort}`,
    usedLoopbackFallback: host === "127.0.0.1"
  }));
}

async function resolveReachableControlUrl({ controlPort, path: requestPath }) {
  const candidates = controlUrlCandidates({ controlPort });
  let lastError;
  for (const candidate of candidates) {
    try {
      await getJson(new URL(requestPath, candidate.baseUrl).toString());
      return candidate;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `No reachable control URL for ${requestPath} on ${candidates
      .map((candidate) => candidate.host)
      .join(", ")}\n${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
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

function delayedMessageText(text, delayMs, model = "mock-main") {
  return { ...messageText(text, model), delayMs };
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

function streamTextResponse(chunks, delayMs = 0) {
  return { stream: true, chunks, delayMs };
}

function completedStreamTextResponse(chunks, delayMs = 0) {
  return { stream: true, chunks, delayMs, end: true };
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
