import {
  MagiMessage,
  MagiToolUsePart,
  MagiToolDefinition,
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  ProviderUsage,
  messageText,
  textMessage
} from "../providers/ir.js";
import {
  ProviderError,
  providerErrorFromException,
  isFastFailNetworkError
} from "../providers/errors.js";
import { HookDefinition, McpServerConfig, WebSearchConfig } from "../config.js";
import { executeHooks, HookResult } from "../hooks/runner.js";
import { AgentToolResult, executeBuiltinAgentTools, ToolPermissionMode } from "./tools.js";
import {
  getBuiltinToolDefinitionByName,
  getBuiltinToolDefinitions,
  ToolPermissionRules,
  SubAgentRequest,
  SubAgentResult
} from "../tools/registry.js";
import {
  parseToolSearchReveal,
  resolveInitialExposedToolNames,
  resolveToolLoadProfile,
  type ToolLoadProfile
} from "../tool-loading.js";
import {
  checkToolPolicy,
  filterNamedToolRecordsByRules,
  filterToolDefinitionsByRules
} from "../tool-policy.js";
import { McpToolRegistry } from "../mcp/tool-registry.js";
import {
  AskUserQuestionRequest,
  AskUserQuestionAnswer,
  UserQuestionResolver
} from "../tools/user-question.js";
import {
  SendUserMessageRequest,
  SendUserMessageResult,
  UserMessageSink
} from "../tools/user-message.js";

export interface ToolExecutionGuardRequest {
  toolUse: MagiToolUsePart;
  toolUses: MagiToolUsePart[];
}

export type AgentQueryEvent =
  | { type: "request_start" }
  | {
      type: "tool_context";
      toolCount: number;
      deferredToolCount: number;
      schemaChars: number;
      estimatedSchemaTokens: number;
      toolNames: string[];
      toolLoadProfile?: ToolLoadProfile;
    }
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; toolUse: MagiToolUsePart }
  | { type: "assistant_message"; message: MagiMessage }
  | {
      type: "tool_result";
      toolCallId: string;
      toolName: string;
      content: string;
      isError?: boolean;
      retryable?: boolean;
    }
  | {
      type: "hook_result";
      event: string;
      toolCallId?: string;
      toolName?: string;
      result: HookResult;
    }
  | {
      type: "compact_boundary";
      summaryId: string;
      sourceMessageCount: number;
      estimatedTokensBefore: number;
    }
  | { type: "approval_request"; toolUse: MagiToolUsePart; reason: string }
  | {
      type: "user_question";
      toolUse: MagiToolUsePart;
      question: AskUserQuestionRequest;
      answer: AskUserQuestionAnswer;
    }
  | {
      type: "user_message";
      toolUse: MagiToolUsePart;
      message: SendUserMessageRequest;
      result: SendUserMessageResult;
    }
  | { type: "usage"; usage: ProviderUsage }
  | {
      type: "fallback_switched";
      fromProvider: string;
      fromModel: string;
      toProvider: string;
      toModel: string;
      errorKind?: string;
    }
  | {
      type: "provider_retry";
      error: string;
      retryable: true;
      providerName: string;
      model: string;
      errorKind?: string;
      attempt: number;
      maxAttempts: number;
      nextRetryDelayMs: number;
    }
  | { type: "cancelled"; reason?: string }
  | {
      type: "error";
      error: string;
      retryable: boolean;
      providerName?: string;
      model?: string;
      errorKind?: string;
      attempt?: number;
      maxAttempts?: number;
      nextRetryDelayMs?: number;
    }
  | { type: "max_turns_reached" }
  | { type: "done"; text: string; messages: MagiMessage[] };

export interface AgentQueryResult {
  text: string;
  messages: MagiMessage[];
  usage: ProviderUsage;
  turns: number;
  providerName: string;
  model: string;
  attempts: AgentRouteAttempt[];
}

export interface AgentRoute {
  providerName: string;
  model: string;
  adapter: ProviderAdapter;
}

export interface AgentRouteAttempt {
  providerName: string;
  model: string;
  ok: boolean;
  errorKind?: string;
}

export interface AgentQueryInput {
  adapter?: ProviderAdapter;
  model?: string;
  providerName?: string;
  routes?: AgentRoute[];
  messages: MagiMessage[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stateRoot?: string;
  memoryRoot?: string;
  webSearchConfig?: WebSearchConfig;
  maxTurns?: number;
  temperature?: number;
  maxOutputTokens?: number;
  permissionMode?: ToolPermissionMode;
  toolRules?: ToolPermissionRules;
  approvalResolver?: (request: {
    toolUse: MagiToolUsePart;
    reason: string;
    diff?: string;
  }) => Promise<boolean> | boolean;
  userQuestionResolver?: UserQuestionResolver;
  userMessageSink?: UserMessageSink;
  spawnSubAgent?: (request: SubAgentRequest) => Promise<SubAgentResult>;
  hooks?: HookDefinition[];
  sessionId?: string;
  signal?: AbortSignal;
  mcp?: {
    servers: Record<string, McpServerConfig>;
    tokenLookup?: (serverName: string) => string | undefined;
    tokenRefresh?: (serverName: string) => Promise<string | undefined>;
  };
  onStreamEvent?: (event: AgentQueryEvent) => void;
  toolExecutionGuard?: (request: ToolExecutionGuardRequest) => AgentToolResult | undefined;
  stream?: boolean;
}

export async function* runAgentQuery(
  input: AgentQueryInput
): AsyncGenerator<AgentQueryEvent, AgentQueryResult> {
  const inner = runAgentQueryInner(input);
  let result: IteratorResult<AgentQueryEvent, AgentQueryResult>;
  while (true) {
    result = await inner.next();
    if (result.done) return result.value;
    input.onStreamEvent?.(result.value);
    yield result.value;
  }
}

async function* runAgentQueryInner(
  input: AgentQueryInput
): AsyncGenerator<AgentQueryEvent, AgentQueryResult> {
  const messages = [...input.messages];
  const usage: ProviderUsage = { inputTokens: 0, outputTokens: 0 };
  const maxTurns = input.maxTurns ?? 100;
  const routes = normalizeRoutes(input);
  const attempts: AgentRouteAttempt[] = [];
  let routeIndex = 0;
  let activeRoute = routes[routeIndex];
  let finalText = "";
  const mcpTools = input.mcp
    ? new McpToolRegistry({
        servers: input.mcp.servers,
        env: input.env,
        tokenLookup: input.mcp.tokenLookup,
        tokenRefresh: input.mcp.tokenRefresh
      })
    : undefined;

  try {
    const toolCatalog = await createAgentToolCatalog(mcpTools, input.toolRules, input.env);
    yield { type: "request_start" };

    for (let turn = 0; turn < maxTurns; turn++) {
      throwIfCancelled(input.signal);
      const toolDefinitions = toolCatalog.definitions();
      if (input.env?.MAGI_DEBUG_TOOLS === "1") {
        yield formatToolContextEvent(
          toolDefinitions,
          toolCatalog.deferredCount(),
          toolCatalog.profile
        );
      }
      let response: ProviderResponse;
      let streamedTextThisTurn = "";
      while (true) {
        try {
          const completed = yield* completeRoute(activeRoute, {
            model: activeRoute.model,
            messages,
            tools: toolDefinitions,
            temperature: input.temperature,
            maxOutputTokens: input.maxOutputTokens,
            signal: input.signal,
            stream: input.stream === true
          });
          response = completed.response;
          streamedTextThisTurn = completed.streamedText;
          attempts.push({
            providerName: activeRoute.providerName,
            model: activeRoute.model,
            ok: true
          });
          if (completed.streamedText) {
            finalText += completed.streamedText;
          }
          break;
        } catch (error) {
          const providerError = providerErrorFromException(activeRoute.providerName, error);
          const retryable = providerError instanceof ProviderError && providerError.retryable;
          attempts.push({
            providerName: activeRoute.providerName,
            model: activeRoute.model,
            ok: false,
            errorKind: providerError instanceof ProviderError ? providerError.kind : "unknown"
          });

          // Retry same route for transient errors (502, 503, timeout, rate-limit)
          const sameRouteRetries = attempts.filter(
            (a) =>
              !a.ok && a.providerName === activeRoute.providerName && a.model === activeRoute.model
          ).length;

          const nextRoute = routes[routeIndex + 1];
          const hasFallback = retryable && nextRoute !== undefined;
          const retryPolicy = retryPolicyFor(providerError, hasFallback);

          // Fast retries use bounded backoff. Network failures keep shorter
          // waits so a bad baseUrl or closed port fails quickly.
          if (retryable && sameRouteRetries < retryPolicy.fastRetries) {
            const delayMs = retryDelayMs(providerError, sameRouteRetries, "fast");
            yield formatProviderRetryEvent({
              route: activeRoute,
              error: providerError,
              attempt: sameRouteRetries,
              maxAttempts: retryPolicy.fastRetries,
              delayMs
            });
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          }

          // No fallback available: keep a short retry tail for network errors,
          // and a longer one for HTTP retryable failures from an overloaded proxy.
          if (retryable && !hasFallback && sameRouteRetries < retryPolicy.totalRetries) {
            const delayMs = retryDelayMs(
              providerError,
              sameRouteRetries,
              "slow",
              retryPolicy.fastRetries
            );
            yield formatProviderRetryEvent({
              route: activeRoute,
              error: providerError,
              attempt: sameRouteRetries,
              maxAttempts: retryPolicy.totalRetries,
              delayMs,
              messageSuffix: "proxy still down"
            });
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          }

          if (retryable && hasFallback) {
            const previous = activeRoute;
            routeIndex += 1;
            activeRoute = nextRoute;
            yield {
              type: "fallback_switched",
              fromProvider: previous.providerName,
              fromModel: previous.model,
              toProvider: activeRoute.providerName,
              toModel: activeRoute.model,
              errorKind: providerError instanceof ProviderError ? providerError.kind : "unknown"
            };
            continue;
          }
          yield {
            type: "error",
            error: errorMessage(providerError),
            retryable
          };
          throw providerError;
        }
      }

      if (response.usage) {
        usage.inputTokens += response.usage.inputTokens;
        usage.outputTokens += response.usage.outputTokens;
        yield { type: "usage", usage: response.usage };
      }

      throwIfCancelled(input.signal);
      let normalized = normalizeProviderResponse(response, toolDefinitions);
      response = normalized.response;
      let toolUses = normalized.toolUses;
      const fallbackResponseText = longerText(response.text, streamedTextThisTurn);
      if (toolUses.length === 0) {
        const fallbackToolUse = inferFallbackToolUse(
          fallbackResponseText,
          messages,
          toolDefinitions,
          input.cwd,
          input.toolRules
        );
        if (fallbackToolUse) {
          response = { ...response, text: "", toolUses: [fallbackToolUse] };
          toolUses = [fallbackToolUse];
        }
      }

      if (
        toolUses.length === 0 &&
        !response.text.trim() &&
        response.usage &&
        response.usage.outputTokens > 0
      ) {
        response = await recoverEmptyFinalAnswer(activeRoute, messages, input.signal);
        if (response.usage) {
          usage.inputTokens += response.usage.inputTokens;
          usage.outputTokens += response.usage.outputTokens;
          yield { type: "usage", usage: response.usage };
        }
        if (response.text.trim()) {
          yield { type: "text_delta", text: response.text };
        }
        normalized = normalizeProviderResponse(response, toolDefinitions);
        response = normalized.response;
        toolUses = normalized.toolUses;
      }

      const visibleResponseText = toolUses.length > 0 ? "" : response.text;
      if (toolUses.length > 0 && streamedTextThisTurn) {
        finalText = removeTrailingText(finalText, streamedTextThisTurn);
      }
      if (visibleResponseText && !streamedTextThisTurn) {
        finalText += visibleResponseText;
        yield { type: "text_delta", text: visibleResponseText };
      }
      for (const toolUse of toolUses) {
        yield { type: "tool_use", toolUse };
      }
      const assistantMessage: MagiMessage = {
        role: "assistant",
        content: [
          ...(visibleResponseText ? [{ type: "text" as const, text: visibleResponseText }] : []),
          ...toolUses
        ]
      };
      messages.push(assistantMessage);
      yield { type: "assistant_message", message: assistantMessage };

      if (toolUses.length === 0) {
        yield { type: "done", text: finalText, messages };
        return {
          text: finalText,
          messages,
          usage,
          turns: turn + 1,
          providerName: activeRoute.providerName,
          model: activeRoute.model,
          attempts
        };
      }

      const promptModel = async ({
        model,
        messages
      }: {
        model: string;
        messages: MagiMessage[];
      }) => {
        throwIfCancelled(input.signal);
        const response = await activeRoute.adapter.complete({
          model,
          messages,
          signal: input.signal
        });
        return { text: response.text };
      };
      const prepared = await prepareToolUsesWithPreHooks(input, toolUses, promptModel);
      applyToolPolicyGuard(input, prepared);
      applyToolExecutionGuard(input, prepared, toolUses);
      for (const hookResult of prepared.hookResults) {
        yield hookResult;
      }
      const executed = await executePreparedToolUses(
        input,
        prepared,
        mcpTools,
        async ({ messages }) => {
          throwIfCancelled(input.signal);
          const response = await activeRoute.adapter.complete({
            model: activeRoute.model,
            messages,
            signal: input.signal
          });
          return { text: response.text };
        }
      );
      for (const event of executed.events) {
        yield event;
      }
      const toolResults = executed.results;
      toolCatalog.revealFromResults(toolResults);
      const toolResultMessages: MagiMessage[] = [];
      const hookMessages: MagiMessage[] = [];
      let suppressedFailedFallbackResults = 0;
      for (const result of toolResults) {
        if (result.permission?.decision === "ask") {
          yield {
            type: "approval_request",
            toolUse: toolUses.find((toolUse) => toolUse.id === result.toolCallId) ?? {
              type: "tool-use",
              id: result.toolCallId,
              name: result.toolName,
              input: {}
            },
            reason: result.permission.reason
          };
        }
        yield {
          type: "tool_result",
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          content: result.content,
          isError: result.isError,
          retryable: result.retryable
        };
        if (shouldSuppressFailedFallbackResultForModel(result, fallbackResponseText)) {
          suppressedFailedFallbackResults++;
          continue;
        }
        toolResultMessages.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: result.toolCallId,
              content: result.content,
              isError: result.isError,
              retryable: result.retryable
            }
          ]
        });
        const postHooks = await executeHooks({
          event: result.isError ? "post_tool_use_failure" : "post_tool_use",
          hooks: input.hooks ?? [],
          env: input.env,
          context: {
            sessionId: input.sessionId ?? "",
            cwd: input.cwd,
            permissionMode: input.permissionMode,
            toolName: result.toolName,
            toolUseId: result.toolCallId,
            toolResponse: result.content,
            error: result.isError ? result.content : undefined
          },
          promptModel
        });
        for (const hook of postHooks) {
          yield {
            type: "hook_result",
            event: result.isError ? "post_tool_use_failure" : "post_tool_use",
            toolCallId: result.toolCallId,
            toolName: result.toolName,
            result: hook
          };
          if (hook.output) {
            hookMessages.push(textMessage("system", `Hook output: ${hook.output}`));
          }
        }
      }
      if (suppressedFailedFallbackResults > 0 && toolResultMessages.length === 0) {
        const text = finalText || fallbackResponseText;
        if (
          messages.at(-1) === assistantMessage &&
          assistantMessage.content.every(isFallbackToolUsePart)
        ) {
          messages.pop();
          if (text.trim()) {
            messages.push(textMessage("assistant", text));
          }
        }
        yield { type: "done", text, messages };
        return {
          text,
          messages,
          usage,
          turns: turn + 1,
          providerName: activeRoute.providerName,
          model: activeRoute.model,
          attempts
        };
      }
      messages.push(...toolResultMessages, ...hookMessages);
    }

    yield { type: "max_turns_reached" };
    const text = finalText || "Agent loop stopped after reaching the maximum turn count.";
    messages.push(textMessage("assistant", text));
    yield { type: "done", text, messages };
    return {
      text,
      messages,
      usage,
      turns: maxTurns,
      providerName: activeRoute.providerName,
      model: activeRoute.model,
      attempts
    };
  } catch (error) {
    if (isAbortError(error) || input.signal?.aborted) {
      yield {
        type: "cancelled",
        reason: input.signal?.reason ? String(input.signal.reason) : undefined
      };
    }
    throw error;
  } finally {
    mcpTools?.close();
  }
}

async function recoverEmptyFinalAnswer(
  route: AgentRoute,
  messages: MagiMessage[],
  signal: AbortSignal | undefined
): Promise<ProviderResponse> {
  throwIfCancelled(signal);
  return route.adapter.complete({
    model: route.model,
    messages: [
      ...messages,
      textMessage(
        "user",
        "Your previous response produced no visible final answer. Reply now with a concise, user-visible final answer. Do not include hidden reasoning."
      )
    ],
    maxOutputTokens: 1024,
    signal
  });
}

async function* completeRoute(
  route: AgentRoute,
  request: ProviderRequest
): AsyncGenerator<
  AgentQueryEvent,
  {
    response: ProviderResponse;
    streamedText: string;
  }
> {
  throwIfCancelled(request.signal);
  if (!route.adapter.stream) {
    return {
      response: await route.adapter.complete(request),
      streamedText: ""
    };
  }
  const stream = route.adapter.stream(request);
  const streamedTextParts: string[] = [];
  let next = await stream.next();
  while (!next.done) {
    if (next.value.type === "text-delta") {
      streamedTextParts.push(next.value.text);
      yield { type: "text_delta", text: next.value.text };
    }
    throwIfCancelled(request.signal);
    next = await stream.next();
  }
  const response = next.value;
  // When the server doesn't support SSE, stream() falls back to a full response
  // with all the text in one shot — surface it as a text_delta so the TUI can display it
  let streamedText = streamedTextParts.join("");
  if (!streamedText && response.text) {
    streamedText = response.text;
    yield { type: "text_delta", text: response.text };
  }
  return { response, streamedText };
}

function formatProviderRetryEvent(input: {
  route: AgentRoute;
  error: unknown;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  messageSuffix?: string;
}): Extract<AgentQueryEvent, { type: "provider_retry" }> {
  const errorKind = input.error instanceof ProviderError ? input.error.kind : "unknown";
  const suffix = input.messageSuffix ? ` — ${input.messageSuffix}, retrying` : " — retrying";
  return {
    type: "provider_retry",
    error: `${errorMessage(input.error)}${suffix} in ${formatRetryDelay(input.delayMs)} (attempt ${input.attempt}/${input.maxAttempts}, kind ${errorKind})`,
    retryable: true,
    providerName: input.route.providerName,
    model: input.route.model,
    errorKind,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    nextRetryDelayMs: input.delayMs
  };
}

function retryPolicyFor(
  error: unknown,
  hasFallback: boolean
): { fastRetries: number; totalRetries: number } {
  // Connection refused / DNS not found / bad URL won't recover by retrying the
  // same endpoint — fail fast (allow only a fallback switch, no same-route
  // retries) instead of burning the budget on a dead port.
  if (isFastFailNetworkError(error)) {
    return { fastRetries: 0, totalRetries: 0 };
  }
  // Other network errors (timeouts, dropped connections, cold-start TTFB) are
  // the most worth retrying, not the least — a flaky link or slow-waking proxy
  // recovers on its own given time. Give them at least the general budget so a
  // 1-2s blip doesn't kill an entire long task.
  const fastRetries = hasFallback ? 3 : 5;
  return { fastRetries, totalRetries: 8 };
}

function retryDelayMs(
  error: unknown,
  sameRouteRetries: number,
  phase: "fast" | "slow",
  fastRetries = 0
): number {
  if (error instanceof ProviderError && error.kind === "network") {
    // Network backoff used to cap at 1s, which barely outlasts a transient
    // blip and never gives a cold-starting endpoint time to wake. Widen the
    // ceiling so retries actually straddle a slow recovery.
    return Math.min(500 * Math.pow(2, sameRouteRetries - 1), 10_000);
  }
  if (phase === "fast") {
    return Math.min(1000 * Math.pow(2, sameRouteRetries - 1), 8000);
  }
  const slowIndex = sameRouteRetries - fastRetries;
  return Math.min(10_000 * Math.pow(2, slowIndex), 30_000);
}

function formatRetryDelay(delayMs: number): string {
  if (delayMs < 1000) {
    return `${delayMs}ms`;
  }
  return `${Math.round(delayMs / 1000)}s`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function removeTrailingText(text: string, suffix: string): string {
  return suffix && text.endsWith(suffix) ? text.slice(0, -suffix.length) : text;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  const reason = signal.reason;
  if (reason instanceof Error) {
    throw reason;
  }
  throw new DOMException(reason ? String(reason) : "Operation cancelled", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

interface PreparedToolUses {
  results: Array<AgentToolResult | undefined>;
  allowed: Array<{ index: number; toolUse: MagiToolUsePart }>;
  hookResults: AgentQueryEvent[];
}

interface ExecutedToolUses {
  results: AgentToolResult[];
  events: AgentQueryEvent[];
}

async function prepareToolUsesWithPreHooks(
  input: AgentQueryInput,
  toolUses: MagiToolUsePart[],
  promptModel: (request: { model: string; messages: MagiMessage[] }) => Promise<{ text: string }>
): Promise<PreparedToolUses> {
  const results = new Array<AgentToolResult>(toolUses.length);
  const allowed: Array<{ index: number; toolUse: MagiToolUsePart }> = [];
  const hookResults: AgentQueryEvent[] = [];

  for (const [index, toolUse] of toolUses.entries()) {
    const hooks = await executeHooks({
      event: "pre_tool_use",
      hooks: input.hooks ?? [],
      env: input.env,
      context: {
        sessionId: input.sessionId ?? "",
        cwd: input.cwd,
        permissionMode: input.permissionMode,
        toolName: toolUse.name,
        toolInput: toolUse.input,
        toolUseId: toolUse.id
      },
      promptModel
    });
    for (const hook of hooks) {
      hookResults.push({
        type: "hook_result",
        event: "pre_tool_use",
        toolCallId: toolUse.id,
        toolName: toolUse.name,
        result: hook
      });
    }
    const block = hooks.find((hook) => hook.blocked);
    if (block) {
      results[index] = {
        toolCallId: toolUse.id,
        toolName: toolUse.name,
        content: `Blocked by hook: ${block.output || "hook exited with code 2"}`,
        isError: true
      };
      continue;
    }
    allowed.push({ index, toolUse });
  }
  return { results, allowed, hookResults };
}

function applyToolExecutionGuard(
  input: AgentQueryInput,
  prepared: PreparedToolUses,
  toolUses: MagiToolUsePart[]
): void {
  if (!input.toolExecutionGuard) return;
  const allowed: PreparedToolUses["allowed"] = [];
  for (const entry of prepared.allowed) {
    const guardResult = input.toolExecutionGuard({
      toolUse: entry.toolUse,
      toolUses
    });
    if (guardResult) {
      prepared.results[entry.index] = guardResult;
    } else {
      allowed.push(entry);
    }
  }
  prepared.allowed = allowed;
}

async function executePreparedToolUses(
  input: AgentQueryInput,
  prepared: PreparedToolUses,
  mcpTools: McpToolRegistry | undefined,
  promptModel: (request: { messages: MagiMessage[] }) => Promise<{ text: string }>
): Promise<ExecutedToolUses> {
  const results = prepared.results;
  const events: AgentQueryEvent[] = [];
  if (prepared.allowed.length > 0) {
    const builtIn = prepared.allowed.filter(({ toolUse }) => !mcpTools?.hasTool(toolUse.name));
    const mcp = prepared.allowed.filter(({ toolUse }) => mcpTools?.hasTool(toolUse.name));
    const builtInResults = await executeBuiltinAgentTools({
      cwd: input.cwd,
      toolUses: builtIn.map(({ toolUse }) => toolUse),
      env: input.env,
      stateRoot: input.stateRoot,
      memoryRoot: input.memoryRoot,
      sessionId: input.sessionId,
      webSearchConfig: input.webSearchConfig,
      permissionMode: input.permissionMode,
      rules: input.toolRules,
      promptModel,
      userQuestionResolver: async (request) => {
        if (!input.userQuestionResolver) {
          throw new Error("AskUserQuestion requires an interactive user question resolver");
        }
        const answer = await input.userQuestionResolver(request);
        events.push({
          type: "user_question",
          toolUse: request.toolUse,
          question: request.question,
          answer
        });
        return answer;
      },
      userMessageSink: async (request) => {
        const sink =
          input.userMessageSink ??
          (async () => ({
            delivered: true,
            channel: "agent-event",
            deliveredAt: new Date().toISOString()
          }));
        const result = await sink(request);
        events.push({
          type: "user_message",
          toolUse: request.toolUse,
          message: request.message,
          result
        });
        return result;
      },
      approvalResolver: async ({ toolUse, permission }) => {
        if (permission.decision !== "ask") {
          return false;
        }
        return (
          input.approvalResolver?.({ toolUse, reason: permission.reason, diff: permission.diff }) ??
          false
        );
      },
      spawnSubAgent: input.spawnSubAgent,
      signal: input.signal
    });
    for (const [resultIndex, result] of builtInResults.entries()) {
      results[builtIn[resultIndex].index] = result;
    }
    if (mcpTools) {
      for (const { index, toolUse } of mcp) {
        const policy = checkToolPolicy(toolUse, input.toolRules);
        if (policy?.decision === "deny") {
          results[index] = {
            toolCallId: toolUse.id,
            toolName: toolUse.name,
            content: `Permission deny: ${policy.reason}`,
            isError: true,
            permission: policy
          };
          continue;
        }
        const first = await mcpTools.executeTool({ toolUse });
        if (first.permission?.decision === "ask" && input.approvalResolver) {
          const approved = await input.approvalResolver({
            toolUse,
            reason: first.permission.reason
          });
          results[index] = approved
            ? await mcpTools.executeTool({ toolUse, approved: true })
            : first;
        } else {
          results[index] = first;
        }
      }
    }
  }

  return {
    results: results.map((result) => {
      if (!result) {
        throw new Error("Tool execution produced no result");
      }
      return result;
    }),
    events
  };
}

function applyToolPolicyGuard(input: AgentQueryInput, prepared: PreparedToolUses): void {
  if (!input.toolRules) return;
  const allowed: PreparedToolUses["allowed"] = [];
  for (const entry of prepared.allowed) {
    const policy = checkToolPolicy(entry.toolUse, input.toolRules);
    if (policy?.decision === "deny") {
      prepared.results[entry.index] = {
        toolCallId: entry.toolUse.id,
        toolName: entry.toolUse.name,
        content: `Permission deny: ${policy.reason}`,
        isError: true,
        permission: policy
      };
    } else {
      allowed.push(entry);
    }
  }
  prepared.allowed = allowed;
}

interface AgentToolCatalog {
  definitions(): MagiToolDefinition[];
  deferredCount(): number;
  profile: ToolLoadProfile;
  revealFromResults(results: AgentToolResult[]): void;
}

async function createAgentToolCatalog(
  mcpTools: McpToolRegistry | undefined,
  rules: ToolPermissionRules | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<AgentToolCatalog> {
  const profile = resolveToolLoadProfile(env);
  const dynamic = filterToolDefinitionsByRules(
    mcpTools ? await mcpTools.getToolDefinitions() : [],
    rules
  );
  const dynamicNames = new Set(dynamic.map((tool) => tool.name));
  const allBuiltInNames = getBuiltinToolDefinitions().map((tool) => tool.name);
  const exposedBuiltIns = new Set(resolveInitialExposedToolNames(profile));

  return {
    definitions() {
      const builtIns = filterToolDefinitionsByRules(
        [...exposedBuiltIns]
          .map((name) => getBuiltinToolDefinitionByName(name))
          .filter((tool): tool is MagiToolDefinition => tool !== undefined),
        rules
      );
      return [...builtIns, ...dynamic.filter((tool) => !exposedBuiltIns.has(tool.name))];
    },
    deferredCount() {
      return allBuiltInNames.filter((name) => !exposedBuiltIns.has(name)).length;
    },
    profile,
    revealFromResults(results) {
      for (const result of results) {
        for (const name of readToolSearchReveal(result)) {
          if (dynamicNames.has(name)) {
            continue;
          }
          if (filterNamedToolRecordsByRules([{ name }], rules).length === 0) {
            continue;
          }
          if (getBuiltinToolDefinitionByName(name)) {
            exposedBuiltIns.add(name);
          }
        }
      }
    }
  };
}

function formatToolContextEvent(
  toolDefinitions: MagiToolDefinition[],
  deferredToolCount: number,
  toolLoadProfile: ToolLoadProfile
): Extract<AgentQueryEvent, { type: "tool_context" }> {
  const schemaChars = JSON.stringify(toolDefinitions).length;
  return {
    type: "tool_context",
    toolCount: toolDefinitions.length,
    deferredToolCount,
    schemaChars,
    estimatedSchemaTokens: Math.ceil(schemaChars / 4),
    toolNames: toolDefinitions.map((tool) => tool.name),
    toolLoadProfile
  };
}

function readToolSearchReveal(result: AgentToolResult): string[] {
  if (result.toolName !== "ToolSearch" || result.isError) {
    return [];
  }
  return parseToolSearchReveal(result.content);
}

export async function collectAgentQuery(input: AgentQueryInput): Promise<AgentQueryResult> {
  const iterator = runAgentQueryInner(input);
  let next = await iterator.next();
  while (!next.done) {
    next = await iterator.next();
  }
  return next.value;
}

function normalizeToolUses(toolUses: MagiToolUsePart[] | undefined): MagiToolUsePart[] {
  return (toolUses ?? []).map((toolUse) => ({
    type: "tool-use",
    id: toolUse.id,
    name: toolUse.name,
    input: toolUse.input ?? {}
  }));
}

function normalizeProviderResponse(
  response: ProviderResponse,
  toolDefinitions: MagiToolDefinition[]
): { response: ProviderResponse; toolUses: MagiToolUsePart[] } {
  const toolUses = normalizeToolUses(response.toolUses);
  if (toolUses.length > 0) {
    return { response, toolUses };
  }
  const textToolUses = parseTextToolUses(response.text, toolDefinitions);
  if (textToolUses.toolUses.length === 0) {
    return { response, toolUses: [] };
  }
  return {
    response: { ...response, text: textToolUses.text, toolUses: textToolUses.toolUses },
    toolUses: textToolUses.toolUses
  };
}

function inferFallbackToolUse(
  responseText: string,
  messages: MagiMessage[],
  toolDefinitions: MagiToolDefinition[],
  cwd: string,
  rules: ToolPermissionRules | undefined
): MagiToolUsePart | null {
  if (hasSubstantiveAssistantResponse(responseText)) {
    return null;
  }
  const hasVisibleDirList = toolDefinitions.some((tool) => tool.name === "DirList");
  const hasBuiltinDirList = getBuiltinToolDefinitionByName("DirList") !== undefined;
  const allowedByRules = filterNamedToolRecordsByRules([{ name: "DirList" }], rules).length > 0;
  if ((!hasVisibleDirList && !hasBuiltinDirList) || !allowedByRules) {
    return null;
  }
  const latestUserText = latestUserMessageText(messages);
  if (!latestUserText || !explicitlyRequestsDirectoryListing(responseText)) {
    return null;
  }
  const requestedPath = inferDirectoryPath(latestUserText, cwd);
  if (!requestedPath) {
    return null;
  }
  if (hasExistingFallbackToolUse(messages, "DirList", requestedPath)) {
    return null;
  }
  const latestUserIndex = latestUserMessageIndex(messages);
  return {
    type: "tool-use",
    id: `fallback-dirlist-u${latestUserIndex}-${stableIdHash(requestedPath)}`,
    name: "DirList",
    input: { path: requestedPath }
  };
}

function latestUserMessageText(messages: MagiMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "user") {
      return messageText(message).trim();
    }
  }
  return "";
}

function latestUserMessageIndex(messages: MagiMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "user") {
      return index;
    }
  }
  return -1;
}

function hasSubstantiveAssistantResponse(responseText: string): boolean {
  const text = responseText.trim();
  if (text.length < 200) {
    return false;
  }
  if (explicitlyRequestsDirectoryListing(text)) {
    return false;
  }
  return !refusalOrBlockedPattern().test(text);
}

function refusalOrBlockedPattern(): RegExp {
  return /无法|不能|需要你提供|请粘贴|没有权限|读取失败|failed|cannot|unable|permission denied|not accessible|access denied|read failed/iu;
}

function explicitlyRequestsDirectoryListing(text: string): boolean {
  return (
    /(?:我(?:需要|要|先|会|将|准备|可以先)|需要|要|先|准备|将|会|可以先|先来|让我).{0,16}(列出|列一下|查看|看一下|看看|扫描|检查).{0,24}(目录|文件夹|文件列表|桌面|desktop)/iu.test(
      text
    ) ||
    /(?:^|[\n。！？])\s*(列出|列一下|查看|看一下|看看|扫描|检查).{0,24}(目录|文件夹|文件列表|桌面|desktop)/imu.test(
      text
    ) ||
    /(?:我(?:需要|要|先|会|将|准备|可以先)|需要|要|先|准备|将|会|可以先|先来|让我).{0,16}(目录|文件夹|文件列表|桌面|desktop).{0,24}(列出|列一下|查看|看一下|看看|扫描|检查|有什么|有哪些)/iu.test(
      text
    ) ||
    /(?:我(?:需要|要|先|会|将|准备|可以先)|需要|要|先|准备|将|会|可以先|先来|让我).{0,16}(找|查找|寻找|定位).{0,24}(文件|路径)/iu.test(
      text
    ) ||
    /\b(?:i(?:'ll| will| need to| should)|let me|first|先).{0,50}\b(?:list|inspect|scan|check|look at|find|locate)\b.{0,40}\b(?:directory|folder|files?)\b/iu.test(
      text
    ) ||
    /\b(?:list|inspect|scan|check)\b.{0,30}\b(?:directory|folder|files?)\b/iu.test(text)
  );
}

function inferDirectoryPath(text: string, cwd: string): string | null {
  let sawFilePathCandidate = false;
  for (const candidate of explicitPathCandidates(text, cwd)) {
    if (!isLikelyRealFilesystemPath(candidate)) {
      continue;
    }
    if (isLikelyFilePath(candidate)) {
      sawFilePathCandidate = true;
      continue;
    }
    return normalizeFallbackPath(candidate);
  }
  if (!sawFilePathCandidate && explicitlyMentionsDesktopDirectory(text)) {
    return `${homeDirectoryFromCwd(cwd)}/Desktop`;
  }
  return null;
}

function explicitPathCandidates(text: string, cwd: string): string[] {
  const candidates: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (isLikelyBannerLine(line)) {
      continue;
    }
    const matches = line.matchAll(/(?:^|\s)(\/[^\s`"'，。；;<>]+|~\/[^\s`"'，。；;<>]+)/gu);
    for (const match of matches) {
      const raw = match[1];
      const candidate = stripPathPunctuation(raw);
      candidates.push(
        candidate.startsWith("~/") ? `${homeDirectoryFromCwd(cwd)}${candidate.slice(1)}` : candidate
      );
    }
  }
  return candidates;
}

function stripPathPunctuation(path: string): string {
  return path.replace(/[),\].。；;，、]+$/u, "");
}

function isLikelyBannerLine(line: string): boolean {
  return /[✦△▔]/u.test(line) && /\bcwd\s*:/iu.test(line);
}

function isLikelyRealFilesystemPath(path: string): boolean {
  if (!path.startsWith("/") && !path.startsWith("~/")) {
    return false;
  }
  if (/[✦△▔]/u.test(path)) {
    return false;
  }
  if (/^\/[^\w.~/-]/u.test(path)) {
    return false;
  }
  return path.length >= 2;
}

function isLikelyFilePath(path: string): boolean {
  const withoutTrailingSlash = path.replace(/\/+$/u, "");
  const basename = withoutTrailingSlash.slice(withoutTrailingSlash.lastIndexOf("/") + 1);
  if (!basename || (basename.startsWith(".") && basename.indexOf(".", 1) === -1)) {
    return false;
  }
  return /\.[A-Za-z0-9]{1,10}$/u.test(basename);
}

function explicitlyMentionsDesktopDirectory(text: string): boolean {
  return (
    /(桌面|desktop).{0,24}(目录|文件夹|文件列表|有什么|有哪些|文件)/iu.test(text) ||
    /(目录|文件夹|文件列表|有什么|有哪些|文件).{0,24}(桌面|desktop)/iu.test(text)
  );
}

function hasExistingFallbackToolUse(
  messages: MagiMessage[],
  toolName: string,
  requestedPath: string
): boolean {
  const latestUserIndex = latestUserMessageIndex(messages);
  const normalizedPath = normalizeFallbackPath(requestedPath);
  return messages
    .slice(latestUserIndex + 1)
    .some((message) =>
      message.content.some(
        (part) =>
          part.type === "tool-use" &&
          part.id.startsWith("fallback-") &&
          part.name === toolName &&
          normalizeFallbackPath(String(part.input.path ?? "")) === normalizedPath
      )
    );
}

function normalizeFallbackPath(path: string): string {
  return path.replace(/\/+$/u, "") || "/";
}

function stableIdHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function longerText(first: string, second: string): string {
  return second.length > first.length ? second : first;
}

function shouldSuppressFailedFallbackResultForModel(
  result: AgentToolResult,
  assistantTextAlreadyEmitted: string
): boolean {
  return (
    result.isError === true &&
    result.toolCallId.startsWith("fallback-") &&
    hasSubstantiveAssistantResponse(assistantTextAlreadyEmitted)
  );
}

function isFallbackToolUsePart(part: MagiMessage["content"][number]): boolean {
  return part.type === "tool-use" && part.id.startsWith("fallback-");
}

function homeDirectoryFromCwd(cwd: string): string {
  const match = /^(\/Users\/[^/]+)/u.exec(cwd);
  return match?.[1] ?? (cwd.replace(/\/+$/u, "") || ".");
}

function parseTextToolUses(
  text: string,
  toolDefinitions: MagiToolDefinition[]
): { text: string; toolUses: MagiToolUsePart[] } {
  if (!text.includes("<tool_use")) {
    return { text, toolUses: [] };
  }
  const availableTools = new Set(toolDefinitions.map((tool) => tool.name));
  const toolUses: MagiToolUsePart[] = [];
  const blockPattern = /<tool_use\b([^>]*)>([\s\S]*?)<\/tool_use>/g;
  const stripped = text.replace(blockPattern, (block, attrs: string, body: string) => {
    const name =
      readXmlAttribute(attrs, "tool_name") ??
      readXmlAttribute(attrs, "name") ??
      readXmlAttribute(attrs, "tool");
    if (!name || !availableTools.has(name)) {
      return block;
    }
    toolUses.push({
      type: "tool-use",
      id: `text-tool-${toolUses.length + 1}`,
      name,
      input: normalizeTextToolInput(name, parseTextToolArgs(body))
    });
    return "";
  });
  return { text: toolUses.length > 0 ? stripped.trim() : text, toolUses };
}

function parseTextToolArgs(body: string): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const jsonInput = parseTextToolJsonArgs(body);
  if (jsonInput) {
    return jsonInput;
  }
  const argPattern = /<arg\b([^>]*)>([\s\S]*?)<\/arg>/g;
  for (const match of body.matchAll(argPattern)) {
    const name = readXmlAttribute(match[1], "name");
    if (!name) {
      continue;
    }
    input[name] = coerceTextToolValue(decodeXmlEntities(match[2].trim()));
  }
  const directArgPattern = /<([A-Za-z_][A-Za-z0-9_-]*)\b[^>]*>([\s\S]*?)<\/\1>/g;
  for (const match of body.matchAll(directArgPattern)) {
    const name = match[1];
    if (name === "arg" || input[name] !== undefined) {
      continue;
    }
    input[name] = coerceTextToolValue(decodeXmlEntities(match[2].trim()));
  }
  return input;
}

function parseTextToolJsonArgs(body: string): Record<string, unknown> | null {
  const trimmed = decodeXmlEntities(body.trim());
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTextToolInput(
  toolName: string,
  input: Record<string, unknown>
): Record<string, unknown> {
  if (
    (toolName === "FileRead" ||
      toolName === "FileWrite" ||
      toolName === "FileEdit" ||
      toolName === "FilePatch") &&
    input.file_path === undefined &&
    input.path !== undefined
  ) {
    return { ...input, file_path: input.path };
  }
  if (toolName === "Bash" && input.command === undefined && input.cmd !== undefined) {
    return { ...input, command: input.cmd };
  }
  return input;
}

function coerceTextToolValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value && /^-?\d+(?:\.\d+)?$/.test(value)) {
    const numberValue = Number(value);
    if (Number.isFinite(numberValue)) {
      return numberValue;
    }
  }
  if (
    (value.startsWith("{") && value.endsWith("}")) ||
    (value.startsWith("[") && value.endsWith("]"))
  ) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

function readXmlAttribute(attrs: string, name: string): string | undefined {
  const pattern = new RegExp(`${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
  const match = pattern.exec(attrs);
  return match?.[1] ?? match?.[2];
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeRoutes(input: AgentQueryInput): AgentRoute[] {
  if (input.routes?.length) {
    return input.routes;
  }
  if (!input.adapter || !input.model) {
    throw new Error("Agent query requires either routes or adapter+model");
  }
  return [
    {
      providerName: input.providerName ?? input.adapter.name,
      model: input.model,
      adapter: input.adapter
    }
  ];
}
