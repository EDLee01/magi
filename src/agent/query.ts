import {
  MagiMessage,
  MagiToolUsePart,
  MagiToolDefinition,
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  ProviderUsage,
  textMessage
} from "../providers/ir.js";
import { ProviderError } from "../providers/errors.js";
import { HookDefinition, McpServerConfig, WebSearchConfig } from "../config.js";
import { executeHooks, HookResult } from "../hooks/runner.js";
import { AgentToolResult, BUILTIN_AGENT_TOOLS, executeBuiltinAgentTools, ToolPermissionMode } from "./tools.js";
import { SubAgentRequest, SubAgentResult } from "../tools/registry.js";
import { McpToolRegistry } from "../mcp/tool-registry.js";
import { AskUserQuestionRequest, AskUserQuestionAnswer, UserQuestionResolver } from "../tools/user-question.js";
import { SendUserMessageRequest, SendUserMessageResult, UserMessageSink } from "../tools/user-message.js";

export type AgentQueryEvent =
  | { type: "request_start" }
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; toolUse: MagiToolUsePart }
  | { type: "assistant_message"; message: MagiMessage }
  | { type: "tool_result"; toolCallId: string; toolName: string; content: string; isError?: boolean; retryable?: boolean }
  | { type: "hook_result"; event: string; toolCallId?: string; toolName?: string; result: HookResult }
  | { type: "compact_boundary"; summaryId: string; sourceMessageCount: number; estimatedTokensBefore: number }
  | { type: "approval_request"; toolUse: MagiToolUsePart; reason: string }
  | { type: "user_question"; toolUse: MagiToolUsePart; question: AskUserQuestionRequest; answer: AskUserQuestionAnswer }
  | { type: "user_message"; toolUse: MagiToolUsePart; message: SendUserMessageRequest; result: SendUserMessageResult }
  | { type: "usage"; usage: ProviderUsage }
  | { type: "fallback_switched"; fromProvider: string; fromModel: string; toProvider: string; toModel: string; errorKind?: string }
  | { type: "cancelled"; reason?: string }
  | { type: "error"; error: string; retryable: boolean }
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
  approvalResolver?: (request: { toolUse: MagiToolUsePart; reason: string; diff?: string }) => Promise<boolean> | boolean;
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
  stream?: boolean;
}

export async function* runAgentQuery(input: AgentQueryInput): AsyncGenerator<AgentQueryEvent, AgentQueryResult> {
  const inner = runAgentQueryInner(input);
  let result: IteratorResult<AgentQueryEvent, AgentQueryResult>;
  while (true) {
    result = await inner.next();
    if (result.done) return result.value;
    input.onStreamEvent?.(result.value);
    yield result.value;
  }
}

async function* runAgentQueryInner(input: AgentQueryInput): AsyncGenerator<AgentQueryEvent, AgentQueryResult> {
  const messages = [...input.messages];
  const usage: ProviderUsage = { inputTokens: 0, outputTokens: 0 };
  const maxTurns = input.maxTurns ?? 100;
  const routes = normalizeRoutes(input);
  const attempts: AgentRouteAttempt[] = [];
  let routeIndex = 0;
  let activeRoute = routes[routeIndex];
  let finalText = "";
  const mcpTools = input.mcp ? new McpToolRegistry({ servers: input.mcp.servers, env: input.env, tokenLookup: input.mcp.tokenLookup, tokenRefresh: input.mcp.tokenRefresh }) : undefined;

  try {
    const toolDefinitions = await getAgentToolDefinitions(mcpTools);
    yield { type: "request_start" };

    for (let turn = 0; turn < maxTurns; turn++) {
      throwIfCancelled(input.signal);
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
          const retryable = error instanceof ProviderError && error.retryable;
          attempts.push({
            providerName: activeRoute.providerName,
            model: activeRoute.model,
            ok: false,
            errorKind: error instanceof ProviderError ? error.kind : "unknown"
          });

          // Retry same route for transient errors (502, 503, timeout, rate-limit)
          const sameRouteRetries = attempts.filter(
            (a) => !a.ok && a.providerName === activeRoute.providerName && a.model === activeRoute.model
          ).length;

          const nextRoute = routes[routeIndex + 1];
          const hasFallback = retryable && nextRoute !== undefined;

          // Fast retries: exponential backoff 1s -> 2s -> 4s (max 8s).
          const maxFastRetries = hasFallback ? 3 : 5;
          if (retryable && sameRouteRetries < maxFastRetries) {
            const delayMs = Math.min(1000 * Math.pow(2, sameRouteRetries - 1), 8000);
            yield {
              type: "error",
              error: `${error instanceof Error ? error.message : String(error)} — retrying in ${Math.round(delayMs / 1000)}s (attempt ${sameRouteRetries + 1}/${maxFastRetries})`,
              retryable: true
            };
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          }

          // No fallback available: the proxy is likely having a transient issue.
          // Don't give up after fast retries — keep retrying with longer
          // intervals (10s -> 20s -> 30s) up to ~60s total so brief blips recover.
          if (retryable && !hasFallback && sameRouteRetries < 8) {
            const slowIndex = sameRouteRetries - maxFastRetries;
            const delayMs = Math.min(10_000 * Math.pow(2, slowIndex), 30_000);
            yield {
              type: "error",
              error: `${error instanceof Error ? error.message : String(error)} — proxy still down, retrying in ${Math.round(delayMs / 1000)}s (attempt ${sameRouteRetries + 1}/8)`,
              retryable: true
            };
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
              errorKind: error instanceof ProviderError ? error.kind : "unknown"
            };
            continue;
          }
          yield {
            type: "error",
            error: error instanceof Error ? error.message : String(error),
            retryable
          };
          throw error;
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

      if (toolUses.length === 0 && !response.text.trim() && response.usage && response.usage.outputTokens > 0) {
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

      if (response.text && !streamedTextThisTurn) {
        finalText += response.text;
        yield { type: "text_delta", text: response.text };
      }
      for (const toolUse of toolUses) {
        yield { type: "tool_use", toolUse };
      }
      const assistantMessage: MagiMessage = {
        role: "assistant",
        content: [
          ...(response.text ? [{ type: "text" as const, text: response.text }] : []),
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

      const promptModel = async ({ model, messages }: { model: string; messages: MagiMessage[] }) => {
        throwIfCancelled(input.signal);
        const response = await activeRoute.adapter.complete({ model, messages, signal: input.signal });
        return { text: response.text };
      };
      const prepared = await prepareToolUsesWithPreHooks(input, toolUses, promptModel);
      for (const hookResult of prepared.hookResults) {
        yield hookResult;
      }
      const executed = await executePreparedToolUses(input, prepared, mcpTools, async ({ messages }) => {
        throwIfCancelled(input.signal);
        const response = await activeRoute.adapter.complete({ model: activeRoute.model, messages, signal: input.signal });
        return { text: response.text };
      });
      for (const event of executed.events) {
        yield event;
      }
      const toolResults = executed.results;
      const toolResultMessages: MagiMessage[] = [];
      const hookMessages: MagiMessage[] = [];
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
        toolResultMessages.push({
          role: "tool",
          content: [{
            type: "tool-result",
            toolCallId: result.toolCallId,
            content: result.content,
            isError: result.isError,
            retryable: result.retryable
          }]
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
      yield { type: "cancelled", reason: input.signal?.reason ? String(input.signal.reason) : undefined };
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

async function* completeRoute(route: AgentRoute, request: ProviderRequest): AsyncGenerator<AgentQueryEvent, {
  response: ProviderResponse;
  streamedText: string;
}> {
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
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
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
        const sink = input.userMessageSink ?? (async () => ({
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
        return input.approvalResolver?.({ toolUse, reason: permission.reason, diff: permission.diff }) ?? false;
      },
      spawnSubAgent: input.spawnSubAgent,
      signal: input.signal
    });
    for (const [resultIndex, result] of builtInResults.entries()) {
      results[builtIn[resultIndex].index] = result;
    }
    if (mcpTools) {
      for (const { index, toolUse } of mcp) {
        const first = await mcpTools.executeTool({ toolUse });
        if (first.permission?.decision === "ask" && input.approvalResolver) {
          const approved = await input.approvalResolver({ toolUse, reason: first.permission.reason });
          results[index] = approved ? await mcpTools.executeTool({ toolUse, approved: true }) : first;
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

async function getAgentToolDefinitions(mcpTools: McpToolRegistry | undefined): Promise<MagiToolDefinition[]> {
  if (!mcpTools) {
    return BUILTIN_AGENT_TOOLS;
  }
  const dynamic = await mcpTools.getToolDefinitions();
  const builtInNames = new Set(BUILTIN_AGENT_TOOLS.map((tool) => tool.name));
  return [
    ...BUILTIN_AGENT_TOOLS,
    ...dynamic.filter((tool) => !builtInNames.has(tool.name))
  ];
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
    const name = readXmlAttribute(attrs, "tool_name") ?? readXmlAttribute(attrs, "name");
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

function normalizeTextToolInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  if ((toolName === "FileRead" || toolName === "FileWrite" || toolName === "FileEdit") && input.file_path === undefined && input.path !== undefined) {
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
  if ((value.startsWith("{") && value.endsWith("}")) || (value.startsWith("[") && value.endsWith("]"))) {
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
    .replace(/&quot;/g, "\"")
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
  return [{
    providerName: input.providerName ?? input.adapter.name,
    model: input.model,
    adapter: input.adapter
  }];
}
