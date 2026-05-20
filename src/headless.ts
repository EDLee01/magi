import { randomUUID } from "node:crypto";

import { runLocalHeadlessAgent } from "./agent/headless-agent.js";
import { AgentQueryEvent } from "./agent/query.js";
import { QueryEngine } from "./agent/query-engine.js";
import { ToolPermissionMode } from "./agent/tools.js";
import { MagiConfig } from "./config.js";
import { MagiPaths } from "./paths.js";
import { buildProviderRegistry } from "./providers/registry.js";
import { textMessage } from "./providers/ir.js";
import { ActiveInteractionRegistry } from "./interactions.js";
import { hasProviderRoute, routeProviderRequest } from "./routing/router.js";
import { resolveFallbackChain, resolveModelAlias } from "./routing/model-alias.js";
import { routeAuto, routeAutoDetailed, RouteContext } from "./routing/model-router.js";
import { SessionStore } from "./session-store.js";
import { UserQuestionResolver } from "./tools/user-question.js";
import { UserMessageSink } from "./tools/user-message.js";
import { SubAgentRequest, SubAgentResult } from "./tools/registry.js";
import { executeHooks } from "./hooks/runner.js";

export interface HeadlessResult {
  sessionId: string;
  jobId: string;
  message: string;
  provider?: string;
  model?: string;
  events?: AgentQueryEvent[];
}

export function runHeadlessPrompt(input: {
  prompt: string;
  cwd: string;
  store: SessionStore;
  config: MagiConfig;
  env?: NodeJS.ProcessEnv;
  paths?: MagiPaths;
  stateRoot?: string;
  modelAlias?: string;
  jobId?: string;
  sessionId?: string;
  sessionName?: string;
  persistSession?: boolean;
  collectEvents?: boolean;
  permissionMode?: ToolPermissionMode;
  userQuestionResolver?: UserQuestionResolver;
  userMessageSink?: UserMessageSink;
  activeInteractions?: ActiveInteractionRegistry;
  interactionTimeoutMs?: number;
  signal?: AbortSignal;
  onStreamEvent?: (event: AgentQueryEvent) => void;
}): Promise<HeadlessResult> {
  return runHeadlessPromptAsync(input);
}

async function runHeadlessPromptAsync(input: {
  prompt: string;
  cwd: string;
  store: SessionStore;
  config: MagiConfig;
  env?: NodeJS.ProcessEnv;
  paths?: MagiPaths;
  stateRoot?: string;
  modelAlias?: string;
  jobId?: string;
  sessionId?: string;
  sessionName?: string;
  persistSession?: boolean;
  collectEvents?: boolean;
  permissionMode?: ToolPermissionMode;
  userQuestionResolver?: UserQuestionResolver;
  userMessageSink?: UserMessageSink;
  activeInteractions?: ActiveInteractionRegistry;
  interactionTimeoutMs?: number;
  signal?: AbortSignal;
  onStreamEvent?: (event: AgentQueryEvent) => void;
}): Promise<HeadlessResult> {
  const shouldPersist = input.persistSession ?? true;
  const sessionId = shouldPersist
    ? input.sessionId ?? input.store.createSession({
      title: input.sessionName ?? input.prompt.slice(0, 80),
      cwd: input.cwd,
      metadata: { mode: "headless" }
    })
    : randomUUID();

  if (!shouldPersist) {
    return runEphemeralHeadless(input, sessionId, randomUUID());
  }

  const jobId = input.jobId ?? randomUUID();

  return runPersistedHeadless(input, sessionId, jobId);
}

async function runEphemeralHeadless(input: {
  prompt: string;
  cwd: string;
  store: SessionStore;
  config: MagiConfig;
  env?: NodeJS.ProcessEnv;
  paths?: MagiPaths;
  stateRoot?: string;
  modelAlias?: string;
  jobId?: string;
  collectEvents?: boolean;
  permissionMode?: ToolPermissionMode;
  userQuestionResolver?: UserQuestionResolver;
  userMessageSink?: UserMessageSink;
  activeInteractions?: ActiveInteractionRegistry;
  interactionTimeoutMs?: number;
  signal?: AbortSignal;
  onStreamEvent?: (event: AgentQueryEvent) => void;
}, sessionId: string, jobId: string): Promise<HeadlessResult> {
  const routeCtx = buildRouteContext(input);
  const resolvedAlias = resolveAutoAlias(input.modelAlias, input.config, input.prompt, routeCtx);
  if (resolvedAlias && hasProviderRoute(input.config, resolvedAlias)) {
    const registry = buildProviderRegistry({ config: input.config, env: input.env });
    const routed = await routeProviderRequest({
      config: input.config,
      registry,
      alias: resolvedAlias,
      messages: [textMessage("user", input.prompt)]
      ,
      signal: input.signal
    });
    return {
      sessionId,
      jobId,
      message: routed.response.text,
      provider: routed.providerName,
      model: routed.model
    };
  }
  return {
    sessionId,
    jobId,
    message: "No provider is configured. Run 'magi init' to set up a provider + API key, then try again."
  };
}

async function runPersistedHeadless(input: {
  prompt: string;
  cwd: string;
  store: SessionStore;
  config: MagiConfig;
  env?: NodeJS.ProcessEnv;
  paths?: MagiPaths;
  stateRoot?: string;
  modelAlias?: string;
  jobId?: string;
  collectEvents?: boolean;
  permissionMode?: ToolPermissionMode;
  userQuestionResolver?: UserQuestionResolver;
  userMessageSink?: UserMessageSink;
  activeInteractions?: ActiveInteractionRegistry;
  interactionTimeoutMs?: number;
  signal?: AbortSignal;
  onStreamEvent?: (event: AgentQueryEvent) => void;
}, sessionId: string, jobId: string): Promise<HeadlessResult> {
  const local = await runLocalHeadlessAgent({
    prompt: input.prompt,
    cwd: input.cwd,
    sessionId,
    jobId,
    store: input.store,
    env: input.env
  });
  if (local.handled) {
    appendHeadlessUserMessage(input.store, sessionId, input.prompt);
    input.store.appendMessage({
      sessionId,
      role: "assistant",
      content: local.output ?? "",
      metadata: { mode: "local-headless", actions: local.actions }
    });
    input.store.recordJob({
      id: jobId,
      sessionId,
      kind: "headless.prompt",
      status: "completed",
      metadata: { mode: "local-headless", actions: local.actions }
    });
    input.store.recordUsage({
      sessionId,
      provider: "local",
      model: "local-headless-tools",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0
    });
    return {
      sessionId,
      jobId,
      message: local.output ?? ""
    };
  }

  const persistedRouteCtx = buildRouteContext(input, sessionId);
  const modelAlias = resolveAutoAlias(input.modelAlias, input.config, input.prompt, persistedRouteCtx, input.store, sessionId, jobId);
  if (modelAlias && hasProviderRoute(input.config, modelAlias)) {
    const registry = buildProviderRegistry({ config: input.config, env: input.env });
    const routes = resolveFallbackChain(input.config, modelAlias).map((candidate) => {
      const adapter = registry.get(candidate.providerName);
      if (!adapter) {
        throw new Error(`Provider ${candidate.providerName} is not configured`);
      }
      return {
        providerName: candidate.providerName,
        model: candidate.model,
        adapter
      };
    });
    const compactionRoute = input.config.context.compactionModel
      ? resolveCompactionRoute({
        config: input.config,
        registry,
        modelRef: input.config.context.compactionModel
      })
      : undefined;
    const queryEngine = new QueryEngine({
      store: input.store,
      sessionId,
      jobId,
      routes,
      cwd: input.cwd,
      env: input.env,
      stateRoot: input.stateRoot,
      webSearchConfig: input.config.webSearch,
      permissionMode: input.permissionMode,
      hooks: input.config.hooks,
      userQuestionResolver: input.userQuestionResolver,
      userMessageSink: input.userMessageSink,
      activeInteractions: input.activeInteractions,
      interactionTimeoutMs: input.interactionTimeoutMs,
      signal: input.signal,
      onStreamEvent: input.onStreamEvent,
      mcp: input.config.mcp,
      spawnSubAgent: buildSpawnSubAgent({
        store: input.store,
        config: input.config,
        env: input.env,
        paths: input.paths,
        stateRoot: input.stateRoot,
        cwd: input.cwd,
        modelAlias
      }),
      contextOptions: {
        recentMessages: input.config.context.recentMessages,
        autoCompactTokenThreshold: input.config.context.autoCompactTokenThreshold,
        autoCompactMessageThreshold: input.config.context.autoCompactMessageThreshold,
        compactionRoute
      },
      memoryOptions: {
        paths: input.paths,
        enabled: input.config.memory.enabled,
        autoWrite: input.config.memory.autoWrite,
        maxResults: input.config.memory.maxResults,
        scopes: input.config.memory.scopes,
        selectionRoute: input.config.memory.selectionModel
          ? resolveSelectionRoute({ config: input.config, registry, modelRef: input.config.memory.selectionModel })
          : undefined
      }
    });
    const agentResult = await queryEngine.submitMessage(input.prompt);

    return {
      sessionId,
      jobId,
      message: agentResult.text,
      provider: agentResult.providerName,
      model: agentResult.model,
      events: input.collectEvents ? agentResult.events : undefined
    };
  }

  appendHeadlessUserMessage(input.store, sessionId, input.prompt);
  input.store.recordJob({
    id: jobId,
    sessionId,
    kind: "headless.prompt",
    status: "recorded",
    metadata: { providerLoop: "not-configured" }
  });
  input.store.recordAudit({
    sessionId,
    jobId,
    action: "headless.prompt.recorded",
    target: "session-store"
  });
  input.store.recordUsage({
    sessionId,
    provider: "none",
    model: "none",
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    metadata: { reason: "no-provider-route-configured" }
  });

  return {
    sessionId,
    jobId,
    message: "No provider is configured for this prompt.\n\nQuick start:\n  1. Set ANTHROPIC_AUTH_TOKEN (or your provider's API key) in your environment\n  2. Run 'magi init' to set up a default provider + model alias\n  3. Or run 'magi config' to see current config\n\nYour prompt is saved — re-run after configuring."
  };
}

function appendHeadlessUserMessage(store: SessionStore, sessionId: string, prompt: string): void {
  store.appendMessage({
    sessionId,
    role: "user",
    content: prompt,
    metadata: { source: "cli" }
  });
}

function resolveCompactionRoute(input: {
  config: MagiConfig;
  registry: ReturnType<typeof buildProviderRegistry>;
  modelRef: string;
}) {
  const resolved = resolveModelAlias(input.config, input.modelRef);
  const adapter = input.registry.get(resolved.providerName);
  if (!adapter) {
    throw new Error(`Provider ${resolved.providerName} is not configured for context.compactionModel`);
  }
  return {
    providerName: resolved.providerName,
    model: resolved.model,
    adapter
  };
}

function resolveAutoAlias(
  alias: string | undefined,
  config: MagiConfig,
  prompt: string,
  context?: RouteContext,
  store?: SessionStore,
  sessionId?: string,
  jobId?: string
): string | undefined {
  if (!alias) {
    return undefined;
  }
  if (alias === "auto") {
    const decision = routeAutoDetailed(config, prompt, context ?? {});
    if (!decision) return undefined;
    // Emit telemetry to audit log so users can inspect routing decisions
    if (store && sessionId) {
      try {
        store.recordAudit({
          sessionId,
          jobId,
          action: "agent.route.auto",
          target: decision.chosenAlias,
          metadata: {
            routeKind: decision.routeKind,
            chosenAlias: decision.chosenAlias,
            chosenScore: decision.chosenScore,
            providerName: decision.resolved.providerName,
            model: decision.resolved.model,
            isPlanMode: context?.isPlanMode ?? false,
            estimatedContextTokens: context?.estimatedContextTokens,
            hasImage: context?.hasImage ?? false,
            candidates: decision.candidates.slice(0, 6)
          }
        });
      } catch {
        // Telemetry should not break execution
      }
    }
    return decision.resolved.source ?? undefined;
  }
  return alias;
}

function resolveSelectionRoute(input: {
  config: MagiConfig;
  registry: ReturnType<typeof buildProviderRegistry>;
  modelRef: string;
}) {
  const resolved = resolveModelAlias(input.config, input.modelRef);
  const adapter = input.registry.get(resolved.providerName);
  if (!adapter) {
    return undefined;
  }
  return {
    providerName: resolved.providerName,
    model: resolved.model,
    adapter
  };
}

function buildSpawnSubAgent(input: {
  store: SessionStore;
  config: MagiConfig;
  env?: NodeJS.ProcessEnv;
  paths?: MagiPaths;
  stateRoot?: string;
  cwd: string;
  modelAlias?: string;
}): (request: SubAgentRequest) => Promise<SubAgentResult> {
  return async (request: SubAgentRequest): Promise<SubAgentResult> => {
    const agentId = randomUUID();
    const subModelAlias = pickSubAgentAlias(request.subagentType, input.modelAlias);
    const subAgentPrompt = wrapSubAgentPrompt(request.subagentType, request.prompt);
    try {
      // If a target peer is specified, dispatch the sub-agent to a remote daemon.
      if (request.target) {
        try {
          const { dispatchToPeer, resolvePeerByName } = await import("./control/peer-client.js");
          const baseUrl = await resolvePeerByName(request.target, { timeoutMs: 2500, store: input.store });
          if (!baseUrl) {
            return {
              agentId,
              status: "failed",
              error: `Could not resolve peer "${request.target}". Use 'magi peers' to see available targets, or pass an http URL.`
            };
          }
          // Look up an OAuth-style token for the peer (stored when user paired with it)
          const peerToken = input.store.getMcpOAuthToken(`peer:${request.target}`);
          await fireSubAgentHook({
            event: "subagent_start",
            config: input.config,
            env: input.env,
            cwd: input.cwd,
            agentId,
            agentType: request.subagentType,
            description: `${request.description} (remote: ${request.target})`
          });
          const result = await dispatchToPeer({
            peer: {
              baseUrl,
              deviceId: peerToken?.metadata && typeof (peerToken.metadata as Record<string, unknown>).deviceId === "string"
                ? (peerToken.metadata as Record<string, unknown>).deviceId as string
                : undefined,
              token: peerToken?.accessToken
            },
            prompt: subAgentPrompt,
            cwd: input.cwd,
            modelAlias: subModelAlias
          });
          await fireSubAgentHook({
            event: "subagent_stop",
            config: input.config,
            env: input.env,
            cwd: input.cwd,
            agentId,
            agentType: request.subagentType,
            description: `${request.description} (remote: ${request.target})`,
            agentResult: result.text
          });
          if (result.errorText) {
            return { agentId, status: "failed", error: result.errorText };
          }
          return { agentId, status: "completed", result: result.text };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { agentId, status: "failed", error: `Remote dispatch failed: ${msg}` };
        }
      }
      if (request.runInBackground) {
        const subSessionId = input.store.createSession({
          title: request.description,
          cwd: input.cwd,
          metadata: { mode: "sub-agent", parentAgentId: agentId, subagentType: request.subagentType }
        });
        input.store.recordJob({
          id: agentId,
          sessionId: subSessionId,
          kind: "sub-agent",
          status: "running",
          metadata: { subagentType: request.subagentType, description: request.description }
        });
        await fireSubAgentHook({
          event: "subagent_start",
          config: input.config,
          env: input.env,
          cwd: input.cwd,
          agentId,
          agentType: request.subagentType,
          description: request.description
        });
        runHeadlessPrompt({
          prompt: subAgentPrompt,
          cwd: input.cwd,
          store: input.store,
          config: input.config,
          env: input.env,
          paths: input.paths,
          stateRoot: input.stateRoot,
          sessionId: subSessionId,
          jobId: agentId,
          modelAlias: subModelAlias,
          persistSession: true
        }).then(async (result) => {
          input.store.updateJobStatus({
            id: agentId,
            status: "completed",
            metadata: { subagentType: request.subagentType, description: request.description, result: result.message }
          });
          await fireSubAgentHook({
            event: "subagent_stop",
            config: input.config,
            env: input.env,
            cwd: input.cwd,
            agentId,
            agentType: request.subagentType,
            description: request.description,
            agentResult: result.message
          });
        }).catch(async (error) => {
          const errorMsg = error instanceof Error ? error.message : String(error);
          input.store.updateJobStatus({
            id: agentId,
            status: "failed",
            metadata: { subagentType: request.subagentType, description: request.description, error: errorMsg }
          });
          await fireSubAgentHook({
            event: "subagent_stop",
            config: input.config,
            env: input.env,
            cwd: input.cwd,
            agentId,
            agentType: request.subagentType,
            description: request.description,
            error: errorMsg
          });
        });
        return { agentId, status: "running" };
      }

      // Fire subagent_start hook before launching
      await fireSubAgentHook({
        event: "subagent_start",
        config: input.config,
        env: input.env,
        cwd: input.cwd,
        agentId,
        agentType: request.subagentType,
        description: request.description
      });

      const result = await runHeadlessPrompt({
        prompt: subAgentPrompt,
        cwd: input.cwd,
        store: input.store,
        config: input.config,
        env: input.env,
        paths: input.paths,
        stateRoot: input.stateRoot,
        sessionName: request.description,
        modelAlias: subModelAlias,
        persistSession: true
      });

      // Fire subagent_stop hook after completion
      await fireSubAgentHook({
        event: "subagent_stop",
        config: input.config,
        env: input.env,
        cwd: input.cwd,
        agentId,
        agentType: request.subagentType,
        description: request.description,
        agentResult: result.message
      });

      return { agentId: result.sessionId, status: "completed", result: result.message };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await fireSubAgentHook({
        event: "subagent_stop",
        config: input.config,
        env: input.env,
        cwd: input.cwd,
        agentId,
        agentType: request.subagentType,
        description: request.description,
        error: errorMsg
      });
      return {
        agentId,
        status: "failed",
        error: errorMsg
      };
    }
  };
}

function wrapSubAgentPrompt(subagentType: string, prompt: string): string {
  const roleInstructions: Record<string, string> = {
    "verification": [
      "You are a VERIFICATION sub-agent. Your job is to verify implementation work and return a verdict.",
      "",
      "Process:",
      "1. Read the original task description and the changed files.",
      "2. Run the project's build, test, and lint commands as appropriate (npm run build, npm test, etc.).",
      "3. Check that the implementation actually addresses the task.",
      "4. Return a structured verdict: PASS, FAIL, or PARTIAL with concrete evidence.",
      "",
      "Format your final response as:",
      "VERDICT: <PASS|FAIL|PARTIAL>",
      "EVIDENCE:",
      "- <command run>: <result summary>",
      "- ...",
      "ISSUES (if any):",
      "- <issue with file:line reference>",
      ""
    ].join("\n"),
    "explore": [
      "You are an EXPLORE sub-agent. Quickly find and report relevant code without making changes.",
      "Use Glob, Grep, and Read. Do not modify files. Return a concise summary with file:line references.",
      ""
    ].join("\n"),
    "plan": [
      "You are a PLAN sub-agent. Design an implementation strategy.",
      "Read relevant code with Read, Grep, Glob. Do not modify files. Return a step-by-step plan with critical files identified and trade-offs considered.",
      ""
    ].join("\n")
  };
  const prefix = roleInstructions[subagentType];
  if (!prefix) return prompt;
  return `${prefix}\n---\n${prompt}`;
}

function buildRouteContext(input: {
  config: MagiConfig;
  store: SessionStore;
  permissionMode?: ToolPermissionMode;
  prompt: string;
}, sessionId?: string): RouteContext {
  const ctx: RouteContext = {
    isPlanMode: input.permissionMode === "plan"
  };
  // If we have a persistent session, estimate total context size from history + prompt
  if (sessionId) {
    try {
      const session = input.store.getSession(sessionId);
      if (session) {
        let totalChars = input.prompt.length;
        for (const msg of session.messages) {
          totalChars += msg.content.length;
        }
        // Rough estimate: 4 chars/token for English mix, halved for CJK is fine averaged out
        ctx.estimatedContextTokens = Math.ceil(totalChars / 4);
      }
    } catch {
      // Best effort
    }
  }
  return ctx;
}

function pickSubAgentAlias(subagentType: string, parentAlias?: string): string {
  // Map known subagent types to aliases. Falls back to parent alias or "main".
  const aliasMap: Record<string, string> = {
    "Explore": "fast",
    "general-purpose": parentAlias ?? "main",
    "verification": "review",
    "Plan": "deep",
    "magi-guide": "fast",
    "statusline-setup": "fast"
  };
  return aliasMap[subagentType] ?? parentAlias ?? "main";
}

async function fireSubAgentHook(input: {
  event: "subagent_start" | "subagent_stop";
  config: MagiConfig;
  env?: NodeJS.ProcessEnv;
  cwd: string;
  agentId: string;
  agentType: string;
  description: string;
  agentResult?: string;
  error?: string;
}): Promise<void> {
  const hooks = input.config.hooks ?? [];
  if (hooks.length === 0) return;
  try {
    await executeHooks({
      event: input.event,
      hooks,
      env: input.env,
      context: {
        sessionId: "",
        cwd: input.cwd,
        agentId: input.agentId,
        agentType: input.agentType,
        message: input.description,
        lastAssistantMessage: input.agentResult,
        error: input.error
      }
    });
  } catch {
    // Hooks should not break sub-agent execution
  }
}
