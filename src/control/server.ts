import http, { IncomingMessage, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

import { MagiConfig } from "../config.js";
import { runHeadlessPrompt } from "../headless.js";
import { readHeadlessInteractionMode } from "../headless-interactions.js";
import { buildRemoteSafeToolRules } from "../tool-policy.js";
import { ToolPermissionRules } from "../tools/registry.js";
import { MagiPaths, RuntimeSettings } from "../paths.js";
import { SessionStore } from "../session-store.js";
import { createPairingToken, validateDeviceToken } from "./auth.js";
import { advertiseMdns, getLocalHostname, MdnsAdvertiseHandle } from "./mdns.js";
import {
  ActiveInteractionCancelledError,
  ActiveInteractionNotFoundError,
  ActiveInteractionRegistry,
  ActiveInteractionStateError
} from "../interactions.js";
import {
  cancelAgentTask,
  completeAgentTask,
  spawnAgentTask,
  startAgentTask,
  waitAgentTask
} from "../agents/task-queue.js";
import { listLocalPlugins } from "../plugins/manifest.js";
import { discoverLocalMarketplaceSources, loadMarketplace } from "../plugins/marketplace.js";
import { listSkills } from "../skills/loader.js";
import { openApiDocument, renderPanelClient, renderWebPanel } from "../web/panel.js";
import { triggerHooks } from "../hooks/events.js";
import { cronStorePathFromRoot, takeDueCronJobs } from "../tools/cron.js";
import { listDreams, runDream } from "../memory-dream.js";
import { MagiEventView, toEventView } from "../events.js";
import { StoredAuditRecord } from "../session-store.js";
import { parsePermissionMode } from "../commands/permissions.js";
import { ToolPermissionMode } from "../agent/tools.js";
import { VERSION } from "../version.js";
import {
  AskUserQuestionAnswer,
  AskUserQuestionRequest,
  normalizeAskUserQuestionAnswer
} from "../tools/user-question.js";

export interface ControlServerHandle {
  server: http.Server;
  url: string;
  close: () => Promise<void>;
  interactions: ActiveInteractionRegistry;
}

class ControlRequestError extends Error {}

interface RunningControlJob {
  jobId: string;
  sessionId: string;
  controller: AbortController;
  promise: Promise<unknown>;
}

export async function startControlServer(input: {
  paths: MagiPaths;
  runtime: RuntimeSettings;
  config: MagiConfig;
  store: SessionStore;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ControlServerHandle> {
  const interactions = new ActiveInteractionRegistry({
    timeoutMs: parseInteractionTimeoutMs(input.env?.MAGI_INTERACTION_TIMEOUT_MS)
  });
  const runningJobs = new Map<string, RunningControlJob>();
  const server = http.createServer((request, response) => {
    void handleRequest({ ...input, interactions, runningJobs, request, response });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            [
              `Cannot start control server: port ${input.runtime.controlPort} is already in use on ${input.runtime.controlBind}.`,
              ``,
              `Common fixes:`,
              `  - 'magi daemon status' — see if Magi is already running`,
              `  - 'lsof -i :${input.runtime.controlPort}' — find what's using the port`,
              `  - 'MAGI_CONTROL_PORT=8780 magi serve' — pick a different port`
            ].join("\n")
          )
        );
        return;
      }
      if (err.code === "EACCES") {
        reject(
          new Error(
            `Cannot bind to ${input.runtime.controlBind}:${input.runtime.controlPort} — permission denied. Pick a port above 1024 or run with elevated privileges.`
          )
        );
        return;
      }
      reject(err);
    });
    server.listen(input.runtime.controlPort, input.runtime.controlBind, () => resolve());
  });
  const address = server.address() as AddressInfo;
  const cronRunner = startCronRunner(input);
  const dreamRunner = startDreamRunner({
    ...input,
    isIdle: () =>
      runningJobs.size === 0 && interactions.listInteractions({ status: "pending" }).length === 0
  });

  // Advertise this daemon via mDNS so phones and other Magi instances can discover it.
  let mdnsHandle: MdnsAdvertiseHandle | undefined;
  if (input.env?.MAGI_DISABLE_MDNS !== "1") {
    try {
      const hostname = getLocalHostname();
      const instanceName = `magi-${address.port}-${process.pid}`;
      mdnsHandle = advertiseMdns({
        hostname,
        instanceName,
        port: address.port,
        txt: {
          version: VERSION,
          cwd: input.cwd,
          bind: input.runtime.controlBind
        }
      });
      if (input.env?.MAGI_DEBUG_MDNS === "1") {
        process.stdout.write(
          `[mdns] Advertising ${instanceName} on _magi._tcp.local. (port ${address.port})\n`
        );
      }
    } catch (error) {
      if (input.env?.MAGI_DEBUG_MDNS === "1") {
        process.stdout.write(
          `[mdns] Failed to advertise: ${error instanceof Error ? error.message : String(error)}\n`
        );
      }
    }
  }

  return {
    server,
    url: `http://${input.runtime.controlBind}:${address.port}`,
    interactions,
    close: async () => {
      mdnsHandle?.stop();
      cronRunner.close();
      dreamRunner.close();
      for (const running of runningJobs.values()) {
        running.controller.abort("control server closing");
      }
      await Promise.allSettled([...runningJobs.values()].map((running) => running.promise));
      interactions.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  };
}

export function runDueCronJobs(input: {
  paths: MagiPaths;
  config: MagiConfig;
  store: SessionStore;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}) {
  const due = takeDueCronJobs(
    cronStorePathFromRoot(input.paths.stateRoot),
    input.now ?? new Date()
  );
  return Promise.all(
    due.map(async ({ job, prompt }) => {
      const result = await runHeadlessPrompt({
        prompt,
        cwd: input.cwd,
        store: input.store,
        config: input.config,
        env: input.env,
        paths: input.paths,
        stateRoot: input.paths.stateRoot,
        modelAlias: "main",
        sessionName: `cron ${job.id}`
      });
      input.store.recordAudit({
        sessionId: result.sessionId,
        jobId: result.jobId,
        action: "cron.job.executed",
        target: job.id,
        metadata: {
          cron: job.cron,
          prompt,
          recurring: job.recurring,
          nextRunAt: job.nextRunAt
        }
      });
      return { cronJob: job, result };
    })
  );
}

function startCronRunner(input: {
  paths: MagiPaths;
  config: MagiConfig;
  store: SessionStore;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): { close: () => void } {
  const intervalMs = parseCronIntervalMs(input.env?.MAGI_CRON_POLL_MS);
  let running = false;
  const tick = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      await runDueCronJobs(input);
    } catch (error) {
      const sessionId = input.store.createSession({
        title: "cron runner error",
        cwd: input.cwd,
        metadata: { source: "cron-runner" }
      });
      input.store.recordAudit({
        sessionId,
        action: "cron.runner.failed",
        metadata: { error: error instanceof Error ? error.message : String(error) }
      });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();
  void tick();
  return {
    close: () => clearInterval(timer)
  };
}

function parseCronIntervalMs(raw: string | undefined): number {
  return parsePositiveIntervalMs(raw, "MAGI_CRON_POLL_MS", 60_000);
}

function startDreamRunner(input: {
  paths: MagiPaths;
  config: MagiConfig;
  store: SessionStore;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  isIdle: () => boolean;
}): { close: () => void } {
  // Precedence: env overrides config; config provides the persistent default.
  // Disabled unless either the config flag or MAGI_DREAM_ENABLED=1 opts in.
  const envEnabled = input.env?.MAGI_DREAM_ENABLED;
  const enabled =
    envEnabled === "1" ? true : envEnabled === "0" ? false : input.config.memory.dream.enabled;
  if (!enabled) {
    return { close: () => {} };
  }
  const intervalMs = parsePositiveIntervalMs(
    input.env?.MAGI_DREAM_INTERVAL_MS,
    "MAGI_DREAM_INTERVAL_MS",
    input.config.memory.dream.intervalMs
  );
  const rootInput = { appRoot: input.paths.root, root: input.config.memory.root };
  let running = false;
  const lastDreamAt = (): number => {
    try {
      const dreams = listDreams(rootInput);
      let latest = 0;
      for (const dream of dreams) {
        const at = Date.parse(dream.createdAt);
        if (Number.isFinite(at) && at > latest) latest = at;
      }
      return latest;
    } catch {
      return 0;
    }
  };
  const tick = async () => {
    if (running) return;
    // Only dream while idle — no running jobs and no pending interactions.
    if (!input.isIdle()) return;
    // Skip if a dream already ran within the interval window.
    if (Date.now() - lastDreamAt() < intervalMs) return;
    running = true;
    try {
      const dream = runDream({ ...rootInput, paths: input.paths });
      input.store.recordAudit({
        sessionId: input.store.createSession({
          title: "memory dream",
          cwd: input.cwd,
          metadata: { source: "dream-runner" }
        }),
        action: "memory.dream.scheduled",
        target: dream.id,
        metadata: {
          operationCount: dream.operations.length,
          draftCount: dream.draftIds.length
        }
      });
    } catch (error) {
      input.store.recordAudit({
        sessionId: input.store.createSession({
          title: "dream runner error",
          cwd: input.cwd,
          metadata: { source: "dream-runner" }
        }),
        action: "memory.dream.failed",
        metadata: { error: error instanceof Error ? error.message : String(error) }
      });
    } finally {
      running = false;
    }
  };
  // Poll on a short cadence so we can catch idle windows; the interval gate
  // above ensures dreams themselves stay at most once per intervalMs.
  const pollMs = Math.min(intervalMs, 5 * 60 * 1000);
  const timer = setInterval(() => {
    void tick();
  }, pollMs);
  timer.unref?.();
  return {
    close: () => clearInterval(timer)
  };
}

function parsePositiveIntervalMs(raw: string | undefined, name: string, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer >= 1000, got ${JSON.stringify(raw)}`);
  }
  const interval = Number(raw);
  if (!Number.isInteger(interval) || interval < 1000) {
    throw new Error(`${name} must be an integer >= 1000, got ${JSON.stringify(raw)}`);
  }
  return interval;
}

function parseInteractionTimeoutMs(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `MAGI_INTERACTION_TIMEOUT_MS must be an integer >= 1, got ${JSON.stringify(raw)}`
    );
  }
  const timeout = Number(raw);
  if (!Number.isInteger(timeout) || timeout < 1) {
    throw new Error(
      `MAGI_INTERACTION_TIMEOUT_MS must be an integer >= 1, got ${JSON.stringify(raw)}`
    );
  }
  return timeout;
}

async function handleRequest(input: {
  paths: MagiPaths;
  runtime: RuntimeSettings;
  config: MagiConfig;
  store: SessionStore;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  interactions: ActiveInteractionRegistry;
  runningJobs: Map<string, RunningControlJob>;
  request: IncomingMessage;
  response: ServerResponse;
}): Promise<void> {
  try {
    const url = new URL(
      input.request.url ?? "/",
      `http://${input.request.headers.host ?? "127.0.0.1"}`
    );

    if (input.request.method === "GET" && url.pathname === "/health") {
      return sendJson(input.response, 200, {
        ok: true,
        root: input.paths.root,
        control: { bind: input.runtime.controlBind, port: input.runtime.controlPort }
      });
    }

    if (input.request.method === "GET" && url.pathname === "/panel") {
      return sendText(input.response, 200, "text/html; charset=utf-8", renderWebPanel());
    }

    if (input.request.method === "GET" && url.pathname === "/panel-client.js") {
      return sendText(input.response, 200, "text/javascript; charset=utf-8", renderPanelClient());
    }

    if (input.request.method === "GET" && url.pathname === "/openapi.json") {
      return sendJson(input.response, 200, openApiDocument());
    }

    if (input.request.method === "POST" && url.pathname === "/pairing") {
      // Pairing endpoint: only allow from loopback OR with an existing valid device token.
      // This prevents an attacker on the network from minting tokens for themselves.
      if (!isLoopbackRequest(input.request) && !isAuthorized(input.request, input.store)) {
        return sendJson(input.response, 403, {
          error: "forbidden",
          message:
            "Pairing must be initiated from the local machine. Run 'magi pair' on the daemon host."
        });
      }
      const body = await readJson(input.request);
      const token = createPairingToken({
        store: input.store,
        deviceName: typeof body.name === "string" ? body.name : "unnamed device"
      });
      input.store.recordAudit({
        sessionId: input.store.createSession({
          title: "control pairing",
          cwd: input.cwd,
          metadata: { command: "pairing" }
        }),
        action: "control.pairing.created",
        target: token.deviceId,
        metadata: { expiresAt: token.expiresAt }
      });
      return sendJson(input.response, 200, token);
    }

    if (!isAuthorized(input.request, input.store)) {
      return sendJson(input.response, 401, { error: "unauthorized" });
    }

    if (input.request.method === "GET" && url.pathname === "/sessions") {
      return sendJson(input.response, 200, { sessions: input.store.listSessions(50) });
    }

    if (input.request.method === "POST" && url.pathname === "/sessions") {
      const body = await readJson(input.request);
      const sessionId = input.store.createSession({
        id: readOptionalString(body.id),
        title: readOptionalString(body.title),
        cwd: resolveControlCwd(readOptionalString(body.cwd), input.cwd, input),
        metadata: readOptionalRecord(body.metadata)
      });
      return sendJson(input.response, 200, { session: input.store.getSession(sessionId) });
    }

    const sessionEventsRoute = /^\/sessions\/([^/]+)\/events$/.exec(url.pathname);
    if (sessionEventsRoute && input.request.method === "GET") {
      const sessionId = decodeURIComponent(sessionEventsRoute[1]);
      const session = input.store.getSession(sessionId);
      if (!session) {
        return sendJson(input.response, 404, { error: "session not found" });
      }
      const limit = readLimit(url.searchParams.get("limit"), 100);
      return sendJson(input.response, 200, {
        events: input.store.listSessionAuditEvents(sessionId, limit).map(toEventView)
      });
    }

    const sessionRoute = /^\/sessions\/([^/]+)(?:\/messages)?$/.exec(url.pathname);
    if (sessionRoute) {
      const sessionId = decodeURIComponent(sessionRoute[1]);
      const isMessagesRoute = url.pathname.endsWith("/messages");
      const session = input.store.getSession(sessionId);
      if (!session) {
        return sendJson(input.response, 404, { error: "session not found" });
      }
      if (input.request.method === "GET" && !isMessagesRoute) {
        return sendJson(input.response, 200, { session });
      }
      if (input.request.method === "POST" && isMessagesRoute) {
        const body = await readJson(input.request);
        const jobInput = normalizeControlJobInput(body);
        if (!jobInput) {
          return sendJson(input.response, 400, { error: "prompt is required" });
        }
        const result = await runControlJob(input, jobInput, { sessionId, cwd: session.cwd });
        return sendJson(input.response, 200, result);
      }
    }

    if (input.request.method === "GET" && url.pathname === "/jobs") {
      return sendJson(input.response, 200, { jobs: input.store.listJobs(50) });
    }

    const jobEventsRoute = /^\/jobs\/([^/]+)\/events$/.exec(url.pathname);
    if (jobEventsRoute && input.request.method === "GET") {
      const jobId = decodeURIComponent(jobEventsRoute[1]);
      const job = input.store.getJob(jobId);
      if (!job) {
        return sendJson(input.response, 404, { error: "job not found" });
      }
      const limit = readLimit(url.searchParams.get("limit"), 100);
      return sendJson(input.response, 200, {
        events: input.store.listJobAuditEvents(jobId, limit).map(toEventView)
      });
    }

    const jobApprovalRoute = /^\/jobs\/([^/]+)\/approvals\/([^/]+)$/.exec(url.pathname);
    if (jobApprovalRoute && input.request.method === "POST") {
      const jobId = decodeURIComponent(jobApprovalRoute[1]);
      const toolUseId = decodeURIComponent(jobApprovalRoute[2]);
      const body = await readJson(input.request);
      const job = input.store.getJob(jobId);
      if (!job) {
        return sendJson(input.response, 404, { error: "job not found" });
      }
      const decision = readApprovalDecision(body);
      if (decision === undefined) {
        return sendJson(input.response, 400, {
          error: "decision must be approve, deny, approved, denied, true, or false"
        });
      }
      try {
        const interaction = input.interactions.resolveApproval({
          jobId,
          toolUseId,
          approved: decision
        });
        input.store.recordAudit({
          sessionId: job.sessionId,
          jobId,
          action: "control.approval.resolved",
          target: toolUseId,
          metadata: {
            status: "resolved",
            interactionKind: "approval",
            toolUseId,
            approved: decision,
            responder: readOptionalString(body.responder),
            interaction
          }
        });
        return sendJson(input.response, 200, { ok: true, interaction });
      } catch (error) {
        return sendInteractionError(input.response, error);
      }
    }

    const jobQuestionRoute = /^\/jobs\/([^/]+)\/questions\/([^/]+)$/.exec(url.pathname);
    if (jobQuestionRoute && input.request.method === "POST") {
      const jobId = decodeURIComponent(jobQuestionRoute[1]);
      const toolUseId = decodeURIComponent(jobQuestionRoute[2]);
      const body = await readJson(input.request);
      const job = input.store.getJob(jobId);
      if (!job) {
        return sendJson(input.response, 404, { error: "job not found" });
      }
      try {
        const pending = input.interactions.getPendingQuestion({ jobId, toolUseId });
        const answer = normalizeControlQuestionAnswer(body, pending.question);
        const interaction = input.interactions.resolveQuestion({ jobId, toolUseId, answer });
        input.store.recordAudit({
          sessionId: job.sessionId,
          jobId,
          action: "control.user_question.resolved",
          target: toolUseId,
          metadata: {
            status: "resolved",
            interactionKind: "question",
            toolUseId,
            answer,
            responder: readOptionalString(body.responder),
            interaction
          }
        });
        return sendJson(input.response, 200, { ok: true, interaction });
      } catch (error) {
        return sendInteractionError(input.response, error);
      }
    }

    const jobInteractionCancelRoute =
      /^\/jobs\/([^/]+)\/(approvals|questions)\/([^/]+)\/cancel$/.exec(url.pathname);
    if (jobInteractionCancelRoute && input.request.method === "POST") {
      const jobId = decodeURIComponent(jobInteractionCancelRoute[1]);
      const interactionType =
        jobInteractionCancelRoute[2] === "approvals" ? "approval" : "question";
      const toolUseId = decodeURIComponent(jobInteractionCancelRoute[3]);
      const body = await readJson(input.request);
      const job = input.store.getJob(jobId);
      if (!job) {
        return sendJson(input.response, 404, { error: "job not found" });
      }
      try {
        const interaction = input.interactions.cancelInteraction({
          jobId,
          toolUseId,
          reason: readOptionalString(body.reason) ?? "cancelled by control API"
        });
        input.store.recordAudit({
          sessionId: job.sessionId,
          jobId,
          action:
            interactionType === "approval"
              ? "control.approval.cancelled"
              : "control.user_question.cancelled",
          target: toolUseId,
          metadata: {
            status: "cancelled",
            interactionKind: interactionType,
            toolUseId,
            reason: interaction.cancelReason,
            interaction
          }
        });
        return sendJson(input.response, 200, { ok: true, interaction });
      } catch (error) {
        return sendInteractionError(input.response, error);
      }
    }

    const jobRoute = /^\/jobs\/([^/]+)$/.exec(url.pathname);
    if (jobRoute && input.request.method === "GET") {
      const job = input.store.getJob(decodeURIComponent(jobRoute[1]));
      return job
        ? sendJson(input.response, 200, { job })
        : sendJson(input.response, 404, { error: "job not found" });
    }

    const jobCancelRoute = /^\/jobs\/([^/]+)\/cancel$/.exec(url.pathname);
    if (jobCancelRoute && input.request.method === "POST") {
      const jobId = decodeURIComponent(jobCancelRoute[1]);
      const body = await readJson(input.request);
      const running = input.runningJobs.get(jobId);
      const reason = readOptionalString(body.reason) ?? "cancelled by control API";
      if (running) {
        running.controller.abort(reason);
        input.store.recordAudit({
          sessionId: running.sessionId,
          jobId,
          action: "control.job.cancel_requested",
          target: jobId,
          metadata: { reason }
        });
        return sendJson(input.response, 200, { ok: true, status: "cancelling", jobId, reason });
      }
      const job = input.store.getJob(jobId);
      if (!job) {
        return sendJson(input.response, 404, { error: "job not found" });
      }
      if (job.status === "running") {
        input.store.updateJobStatus({
          id: jobId,
          status: "cancelled",
          metadata: { reason, cancelledWithoutActiveRunner: true }
        });
        input.store.recordAudit({
          sessionId: job.sessionId,
          jobId,
          action: "control.job.cancelled",
          target: jobId,
          metadata: { reason, cancelledWithoutActiveRunner: true }
        });
        return sendJson(input.response, 200, { ok: true, status: "cancelled", jobId, reason });
      }
      return sendJson(input.response, 409, { error: `job is ${job.status}` });
    }

    if (input.request.method === "GET" && url.pathname === "/agents") {
      return sendJson(input.response, 200, { tasks: input.store.listAgentTasks(50) });
    }

    if (input.request.method === "GET" && url.pathname === "/providers") {
      return sendJson(input.response, 200, {
        providers: Object.entries(input.config.providers).map(([name, provider]) => ({
          name,
          type: provider.type,
          defaultModel: provider.defaultModel,
          configured: Boolean(provider.apiKeyEnv ? input.env?.[provider.apiKeyEnv] : true)
        })),
        aliases: input.config.models.aliases
      });
    }

    if (input.request.method === "GET" && url.pathname === "/plugins") {
      return sendJson(input.response, 200, {
        plugins: listLocalPlugins(input.paths),
        marketplaces: discoverLocalMarketplaceSources(input.paths).map(loadMarketplace)
      });
    }

    if (input.request.method === "GET" && url.pathname === "/skills") {
      return sendJson(input.response, 200, { skills: listSkills(input.paths) });
    }

    if (input.request.method === "POST" && url.pathname === "/agents") {
      const body = await readJson(input.request);
      if (body.role !== "explorer" && body.role !== "worker") {
        return sendJson(input.response, 400, { error: "role must be explorer or worker" });
      }
      if (typeof body.prompt !== "string" || !body.prompt.trim()) {
        return sendJson(input.response, 400, { error: "prompt is required" });
      }
      const writeFiles = Array.isArray(body.writeFiles)
        ? body.writeFiles.filter((item): item is string => typeof item === "string")
        : [];
      const cwd = resolveControlCwd(readOptionalString(body.cwd), input.cwd, input);
      const sessionId = input.store.createSession({
        title: `control agent task ${body.role}`,
        cwd
      });
      const task = spawnAgentTask(input.store, {
        role: body.role,
        prompt: body.prompt,
        cwd,
        sessionId,
        writeFiles
      });
      const hooks = await triggerHooks({
        event: "task_created",
        hooks: input.config.hooks,
        store: input.store,
        sessionId,
        cwd,
        env: input.env,
        context: {
          taskId: task.id,
          taskSubject: task.prompt,
          taskDescription: task.prompt,
          agentId: task.id,
          agentType: task.role
        }
      });
      return sendJson(input.response, 200, {
        task,
        hooks
      });
    }

    const agentAction = /^\/agents\/([^/]+)\/(start|wait|cancel|complete)$/.exec(url.pathname);
    if (agentAction && input.request.method === "POST") {
      const [, taskId, action] = agentAction;
      const body = await readJson(input.request);
      if (action === "start") {
        const task = waitAgentTask(input.store, startAgentTask(input.store, taskId).id);
        const sessionId =
          task.sessionId ??
          input.store.createSession({ title: "control agent start", cwd: task.cwd });
        const hooks = await triggerHooks({
          event: "subagent_start",
          hooks: input.config.hooks,
          store: input.store,
          sessionId,
          cwd: task.cwd,
          env: input.env,
          context: {
            agentId: task.id,
            agentType: task.role,
            taskId: task.id,
            taskSubject: task.prompt
          }
        });
        return sendJson(input.response, 200, { task, hooks });
      }
      if (action === "wait") {
        return sendJson(input.response, 200, { task: waitAgentTask(input.store, taskId) });
      }
      if (action === "cancel") {
        const task = cancelAgentTask(input.store, taskId);
        const sessionId =
          task.sessionId ??
          input.store.createSession({ title: "control agent stop", cwd: task.cwd });
        const hooks = await triggerHooks({
          event: "stop",
          hooks: input.config.hooks,
          store: input.store,
          sessionId,
          cwd: task.cwd,
          env: input.env,
          context: {
            message: `Agent task ${task.id} cancelled`,
            notificationType: "agent_task_cancelled",
            lastAssistantMessage: task.result ?? undefined
          }
        });
        const subagentHooks = await triggerHooks({
          event: "subagent_stop",
          hooks: input.config.hooks,
          store: input.store,
          sessionId,
          cwd: task.cwd,
          env: input.env,
          context: {
            agentId: task.id,
            agentType: task.role,
            taskId: task.id,
            taskSubject: task.prompt,
            message: `Agent task ${task.id} cancelled`,
            notificationType: "agent_task_cancelled",
            lastAssistantMessage: task.result ?? undefined
          }
        });
        return sendJson(input.response, 200, { task, hooks: [...hooks, ...subagentHooks] });
      }
      const task = completeAgentTask(
        input.store,
        taskId,
        typeof body.result === "string" ? body.result : ""
      );
      const sessionId =
        task.sessionId ??
        input.store.createSession({ title: "control agent notification", cwd: task.cwd });
      const hooks = await triggerHooks({
        event: "notification",
        hooks: input.config.hooks,
        store: input.store,
        sessionId,
        cwd: task.cwd,
        env: input.env,
        context: {
          message: `Agent task ${task.id} completed`,
          title: "Agent task completed",
          notificationType: "agent_task_completed",
          lastAssistantMessage: task.result ?? undefined
        }
      });
      const taskHooks = await triggerHooks({
        event: "task_completed",
        hooks: input.config.hooks,
        store: input.store,
        sessionId,
        cwd: task.cwd,
        env: input.env,
        context: {
          taskId: task.id,
          taskSubject: task.prompt,
          taskDescription: task.prompt,
          agentId: task.id,
          agentType: task.role,
          lastAssistantMessage: task.result ?? undefined
        }
      });
      const subagentHooks = await triggerHooks({
        event: "subagent_stop",
        hooks: input.config.hooks,
        store: input.store,
        sessionId,
        cwd: task.cwd,
        env: input.env,
        context: {
          agentId: task.id,
          agentType: task.role,
          taskId: task.id,
          taskSubject: task.prompt,
          lastAssistantMessage: task.result ?? undefined
        }
      });
      return sendJson(input.response, 200, {
        task,
        hooks: [...hooks, ...taskHooks, ...subagentHooks]
      });
    }

    if (input.request.method === "GET" && url.pathname === "/audit") {
      return sendJson(input.response, 200, { audit: input.store.listAuditEvents(100) });
    }

    if (input.request.method === "GET" && url.pathname === "/events.json") {
      const limit = readLimit(url.searchParams.get("limit"), 100);
      const sessionId = readOptionalString(url.searchParams.get("sessionId") ?? undefined);
      const jobId = readOptionalString(url.searchParams.get("jobId") ?? undefined);
      return sendJson(input.response, 200, {
        events: input.store.listRecentAuditEvents({ sessionId, jobId, limit }).map(toEventView)
      });
    }

    if (input.request.method === "POST" && url.pathname === "/jobs") {
      const body = await readJson(input.request);
      const jobInput = normalizeControlJobInput(body);
      if (!jobInput) {
        return sendJson(input.response, 400, { error: "prompt is required" });
      }
      const sessionId = readOptionalString(jobInput.sessionId);
      const existingSession = sessionId ? input.store.getSession(sessionId) : undefined;
      if (sessionId && !existingSession) {
        return sendJson(input.response, 404, { error: "session not found" });
      }
      if (jobInput.background === true || jobInput.async === true) {
        const result = startBackgroundControlJob(input, jobInput, {
          sessionId,
          cwd: existingSession?.cwd
        });
        return sendJson(input.response, 202, result);
      }
      const result = await runControlJob(input, jobInput, {
        sessionId,
        cwd: existingSession?.cwd
      });
      return sendJson(input.response, 200, result);
    }

    const activeInteractionsRoute = /^\/jobs\/([^/]+)\/interactions$/.exec(url.pathname);
    if (activeInteractionsRoute && input.request.method === "GET") {
      const jobId = decodeURIComponent(activeInteractionsRoute[1]);
      const job = input.store.getJob(jobId);
      if (!job) {
        return sendJson(input.response, 404, { error: "job not found" });
      }
      return sendJson(input.response, 200, {
        interactions: input.interactions.listInteractions({ jobId })
      });
    }

    if (input.request.method === "POST" && url.pathname === "/approvals") {
      const body = await readJson(input.request);
      const sessionId =
        typeof body.sessionId === "string"
          ? body.sessionId
          : input.store.createSession({ title: "control approval", cwd: input.cwd });
      input.store.recordAudit({
        sessionId,
        jobId: typeof body.jobId === "string" ? body.jobId : undefined,
        action: "control.approval.recorded",
        target: typeof body.decision === "string" ? body.decision : "unknown",
        metadata: body
      });
      return sendJson(input.response, 200, { ok: true, approvalId: randomUUID() });
    }

    if (input.request.method === "GET" && url.pathname === "/events") {
      streamEvents({
        request: input.request,
        response: input.response,
        store: input.store,
        limit: readLimit(url.searchParams.get("limit"), 50),
        afterId: readOptionalId(url.searchParams.get("after")),
        sessionId: readOptionalString(url.searchParams.get("sessionId") ?? undefined),
        jobId: readOptionalString(url.searchParams.get("jobId") ?? undefined)
      });
      return;
    }

    return sendJson(input.response, 404, { error: "not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!input.response.headersSent) {
      if (error instanceof ControlRequestError) {
        return sendJson(input.response, 400, { error: message });
      }
      return sendJson(input.response, 500, { error: message });
    }
    input.response.end();
    return;
  }
}

function streamEvents(input: {
  request: IncomingMessage;
  response: ServerResponse;
  store: SessionStore;
  limit: number;
  afterId?: number;
  sessionId?: string;
  jobId?: string;
}): void {
  input.response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  input.response.write(
    `event: ready\ndata: ${JSON.stringify({
      ok: true,
      sessionId: input.sessionId,
      jobId: input.jobId
    })}\n\n`
  );

  const historical = input.store
    .listRecentAuditEvents({
      sessionId: input.sessionId,
      jobId: input.jobId,
      afterId: input.afterId,
      limit: input.limit,
      order: "asc"
    })
    .map(toEventView);
  for (const event of historical) {
    writeSseEvent(input.response, "audit", event);
  }

  const unsubscribe = input.store.subscribeAuditEvents((event) => {
    if (!matchesEventStreamFilter(event, input)) {
      return;
    }
    writeSseEvent(input.response, "audit", toEventView(event));
  });
  const heartbeat = setInterval(() => {
    input.response.write(`: heartbeat ${new Date().toISOString()}\n\n`);
  }, 15_000);
  heartbeat.unref?.();
  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
    input.response.end();
  };
  input.request.once("close", close);
}

function writeSseEvent(response: ServerResponse, eventName: string, event: MagiEventView): void {
  response.write(`id: ${event.id}\n`);
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function matchesEventStreamFilter(
  event: StoredAuditRecord,
  filter: { sessionId?: string; jobId?: string; afterId?: number }
): boolean {
  if (filter.afterId !== undefined && event.id <= filter.afterId) {
    return false;
  }
  if (filter.sessionId && event.sessionId !== filter.sessionId) {
    return false;
  }
  if (filter.jobId && event.jobId !== filter.jobId) {
    return false;
  }
  return true;
}

async function runControlJob(
  input: {
    paths: MagiPaths;
    config: MagiConfig;
    store: SessionStore;
    cwd: string;
    env?: NodeJS.ProcessEnv;
    interactions: ActiveInteractionRegistry;
    runningJobs: Map<string, RunningControlJob>;
  },
  body: Record<string, unknown>,
  options: { sessionId?: string; cwd?: string } = {}
) {
  try {
    const cwd = resolveControlCwd(options.cwd ?? readOptionalString(body.cwd), input.cwd, input);
    return await runHeadlessPrompt({
      prompt: String(body.prompt),
      cwd,
      store: input.store,
      config: input.config,
      env: input.env,
      paths: input.paths,
      stateRoot: input.paths.stateRoot,
      modelAlias: readOptionalString(body.model),
      sessionId: options.sessionId,
      sessionName: readOptionalString(body.sessionName),
      persistSession: typeof body.persistSession === "boolean" ? body.persistSession : undefined,
      collectEvents: body.collectEvents === true,
      permissionMode: readPermissionMode(body.permissionMode) ?? "default",
      interactionMode: readHeadlessInteractionMode(body.interactionMode),
      toolRules: resolveControlToolRules(body, input.config),
      activeInteractions: input.interactions
    });
  } catch (error) {
    if (error instanceof ActiveInteractionCancelledError) {
      const jobId =
        findLatestCancelledInteractionJobId(input.interactions) ?? findLatestJobId(input.store);
      return {
        sessionId: options.sessionId ?? findJobSessionId(input.store, jobId) ?? "",
        jobId: jobId ?? "",
        message: "CONTROL CANCEL DONE"
      };
    }
    throw error;
  }
}

function resolveControlToolRules(
  body: Record<string, unknown>,
  config: MagiConfig
): ToolPermissionRules | undefined {
  const denyDestructive =
    body.allowDestructive === true
      ? false
      : body.denyDestructive !== false && config.control.denyDestructive === true;
  if (!denyDestructive) {
    return undefined;
  }
  return buildRemoteSafeToolRules();
}

function startBackgroundControlJob(
  input: {
    paths: MagiPaths;
    config: MagiConfig;
    store: SessionStore;
    cwd: string;
    env?: NodeJS.ProcessEnv;
    interactions: ActiveInteractionRegistry;
    runningJobs: Map<string, RunningControlJob>;
  },
  body: Record<string, unknown>,
  options: { sessionId?: string; cwd?: string } = {}
) {
  const cwd = resolveControlCwd(options.cwd ?? readOptionalString(body.cwd), input.cwd, input);
  const prompt = String(body.prompt);
  const sessionId =
    options.sessionId ??
    input.store.createSession({
      title: readOptionalString(body.sessionName) ?? prompt.slice(0, 80),
      cwd,
      metadata: { mode: "control-background" }
    });
  const jobId = randomUUID();
  const controller = new AbortController();
  const promise = runHeadlessPrompt({
    prompt,
    cwd,
    store: input.store,
    config: input.config,
    env: input.env,
    paths: input.paths,
    stateRoot: input.paths.stateRoot,
    modelAlias: readOptionalString(body.model),
    jobId,
    sessionId,
    sessionName: readOptionalString(body.sessionName),
    persistSession: true,
    collectEvents: body.collectEvents === true,
    permissionMode: readPermissionMode(body.permissionMode) ?? "default",
    interactionMode: readHeadlessInteractionMode(body.interactionMode),
    toolRules: resolveControlToolRules(body, input.config),
    activeInteractions: input.interactions,
    signal: controller.signal,
    stream: body.stream !== false
  }).finally(() => {
    input.runningJobs.delete(jobId);
  });
  input.runningJobs.set(jobId, { jobId, sessionId, controller, promise });
  promise.catch(() => undefined);
  return { sessionId, jobId, status: "running" };
}

function isAuthorized(request: IncomingMessage, store: SessionStore): boolean {
  const deviceId = headerValue(request.headers["x-magi-device-id"]);
  const token = headerValue(request.headers.authorization)?.replace(/^Bearer\s+/i, "");
  return validateDeviceToken({ store, deviceId, token });
}

function isLoopbackRequest(request: IncomingMessage): boolean {
  const addr = request.socket.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    return {};
  }
  const parsed = JSON.parse(text) as unknown;
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function normalizeControlJobInput(
  body: Record<string, unknown>
): Record<string, unknown> | undefined {
  const prompt = readOptionalString(body.prompt) ?? readOptionalString(body.content);
  if (!prompt) {
    return undefined;
  }
  return {
    ...body,
    prompt,
    model: readOptionalString(body.model) ?? readOptionalString(body.modelAlias)
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body)}\n`);
}

function sendText(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string
): void {
  response.writeHead(status, { "content-type": contentType });
  response.end(body);
}

function sendInteractionError(response: ServerResponse, error: unknown): void {
  if (error instanceof ActiveInteractionNotFoundError) {
    return sendJson(response, 404, { error: error.message });
  }
  if (error instanceof ActiveInteractionStateError) {
    return sendJson(response, 409, { error: error.message });
  }
  if (error instanceof ActiveInteractionCancelledError) {
    return sendJson(response, 200, { ok: true, status: "cancelled", error: error.message });
  }
  return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
}

function findLatestCancelledInteractionJobId(
  interactions: ActiveInteractionRegistry
): string | undefined {
  return interactions
    .listInteractions({ status: "cancelled" })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.jobId;
}

function findLatestJobId(store: SessionStore): string | undefined {
  return store.listJobs(1)[0]?.id;
}

function findJobSessionId(store: SessionStore, jobId: string | undefined): string | undefined {
  return jobId ? store.getJob(jobId)?.sessionId : undefined;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function controlAllowsAnyCwd(input: { config: MagiConfig; env?: NodeJS.ProcessEnv }): boolean {
  return input.config.control.allowAnyCwd === true || input.env?.MAGI_CONTROL_ALLOW_ANY_CWD === "1";
}

function resolveConfiguredControlRoot(input: {
  workspaceRoot: string;
  config?: MagiConfig;
}): string {
  const configured = input.config?.control.defaultCwd?.trim();
  if (configured) {
    return realpathSync(path.resolve(configured));
  }
  return realpathSync(input.workspaceRoot);
}

function resolveControlCwd(
  requestedCwd: string | undefined,
  workspaceRoot: string,
  input?: { config: MagiConfig; env?: NodeJS.ProcessEnv }
): string {
  let baseRoot: string;
  try {
    baseRoot = resolveConfiguredControlRoot({ workspaceRoot, config: input?.config });
    if (!statSync(baseRoot).isDirectory()) {
      throw new ControlRequestError("control.defaultCwd must be an existing directory");
    }
  } catch (error) {
    if (error instanceof ControlRequestError) {
      throw error;
    }
    throw new ControlRequestError(
      "control.defaultCwd must be an existing directory inside the authorized workspace"
    );
  }

  if (!requestedCwd) {
    return baseRoot;
  }

  if (input && controlAllowsAnyCwd(input)) {
    const absolute = path.isAbsolute(requestedCwd)
      ? requestedCwd
      : path.resolve(baseRoot, requestedCwd);
    try {
      const candidate = realpathSync(absolute);
      if (statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      throw new ControlRequestError("cwd must be an existing directory");
    }
    throw new ControlRequestError("cwd must be an existing directory");
  }

  let candidate: string;
  try {
    candidate = realpathSync(
      path.isAbsolute(requestedCwd) ? requestedCwd : path.resolve(baseRoot, requestedCwd)
    );
    if (!statSync(candidate).isDirectory()) {
      throw new ControlRequestError(
        "cwd must be an existing directory inside the authorized workspace"
      );
    }
  } catch (error) {
    if (error instanceof ControlRequestError) {
      throw error;
    }
    throw new ControlRequestError(
      "cwd must be an existing directory inside the authorized workspace"
    );
  }

  const relative = path.relative(baseRoot, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ControlRequestError(`cwd is outside the authorized workspace: ${baseRoot}`);
  }
  return candidate;
}

function readApprovalDecision(body: Record<string, unknown>): boolean | undefined {
  const raw = body.approved ?? body.decision;
  if (
    raw === true ||
    raw === "approve" ||
    raw === "approved" ||
    raw === "allow" ||
    raw === "allowed"
  ) {
    return true;
  }
  if (
    raw === false ||
    raw === "deny" ||
    raw === "denied" ||
    raw === "reject" ||
    raw === "rejected"
  ) {
    return false;
  }
  return undefined;
}

function readPermissionMode(value: unknown): ToolPermissionMode | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return parsePermissionMode(value);
}

function normalizeControlQuestionAnswer(
  body: Record<string, unknown>,
  question: AskUserQuestionRequest
): AskUserQuestionAnswer {
  const rawAnswer = readOptionalRecord(body.answer) ?? body;
  const candidate =
    rawAnswer.answers === undefined &&
    (Array.isArray(rawAnswer.selectedLabels) || Array.isArray(body.selectedLabels))
      ? {
          answers: [
            {
              question: question.questions[0]?.question ?? "",
              selectedLabels: Array.isArray(rawAnswer.selectedLabels)
                ? rawAnswer.selectedLabels
                : body.selectedLabels
            }
          ]
        }
      : rawAnswer;
  return normalizeAskUserQuestionAnswer(question, candidate as unknown as AskUserQuestionAnswer);
}

function readLimit(raw: string | null, fallback: number): number {
  if (raw === null || raw === "") {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 500 ? value : fallback;
}

function readOptionalId(raw: string | null): number | undefined {
  if (raw === null || raw === "") {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
