import { ProviderConfig } from "../config.js";
import { MagiConfigError } from "../errors.js";
import { providerErrorFromResponse } from "./errors.js";
import {
  FetchLike,
  fetchProvider,
  getApiKey,
  normalizeBaseUrl,
  resolveProviderTimeoutMs
} from "./http.js";
import {
  MagiMessage,
  MagiToolUsePart,
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  messageText
} from "./ir.js";
import { readSseEvents } from "./sse.js";
import { applyEmbeddedToolCallFallback } from "./tool-call-fallback.js";

// Providers fall back to tiny output caps when max_tokens is omitted (SiliconFlow
// defaults to 512; the previous hard-coded Anthropic fallback was 1024), which
// silently truncates agent turns. Resolve a generous default, tunable via env.
export function resolveDefaultMaxOutputTokens(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MAGI_DEFAULT_MAX_OUTPUT_TOKENS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 16000;
}

export class MessagesCompatibleAdapter implements ProviderAdapter {
  readonly name: string;
  private readonly config: ProviderConfig;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: FetchLike;

  constructor(input: {
    name: string;
    config: ProviderConfig;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: FetchLike;
  }) {
    this.name = input.name;
    this.config = input.config;
    this.env = input.env ?? process.env;
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    if (!this.config.baseUrl) {
      throw new MagiConfigError(`Provider ${this.name} requires baseUrl`);
    }

    if (this.config.format === "anthropic-messages") {
      return this.completeAnthropicMessages(request);
    }

    const apiKey = getApiKey(this.name, this.config, this.env);
    const baseUrl = normalizeBaseUrl(this.config.baseUrl);
    const response = await fetchProvider(
      this.name,
      this.fetchImpl,
      `${baseUrl}/chat/completions`,
      {
        method: "POST",
        signal: request.signal,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages.map(toMessage),
          tools: request.tools?.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema
            }
          })),
          temperature: request.temperature,
          max_tokens: request.maxOutputTokens ?? resolveDefaultMaxOutputTokens(this.env)
        })
      },
      { timeoutMs: resolveProviderTimeoutMs(this.config, this.env) }
    );

    if (!response.ok) {
      throw providerErrorFromResponse(this.name, response);
    }

    const data = await response.json();
    return parseCompatibleResult(data);
  }

  async *stream(request: ProviderRequest): AsyncGenerator<ProviderStreamEvent, ProviderResponse> {
    if (!this.config.baseUrl) {
      throw new MagiConfigError(`Provider ${this.name} requires baseUrl`);
    }

    if (this.config.format === "anthropic-messages") {
      return yield* this.streamAnthropicMessages(request);
    }

    const apiKey = getApiKey(this.name, this.config, this.env);
    const baseUrl = normalizeBaseUrl(this.config.baseUrl);
    const response = await fetchProvider(
      this.name,
      this.fetchImpl,
      `${baseUrl}/chat/completions`,
      {
        method: "POST",
        signal: request.signal,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages.map(toMessage),
          tools: request.tools?.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema
            }
          })),
          temperature: request.temperature,
          max_tokens: request.maxOutputTokens ?? resolveDefaultMaxOutputTokens(this.env),
          stream: true,
          stream_options: { include_usage: true }
        })
      },
      { timeoutMs: resolveProviderTimeoutMs(this.config, this.env) }
    );

    if (!response.ok) {
      throw providerErrorFromResponse(this.name, response);
    }
    if (!isEventStreamResponse(response)) {
      const data = await response.json();
      return parseCompatibleResult(data);
    }

    const textParts: string[] = [];
    let usage: ProviderResponse["usage"];
    const toolCalls = new Map<number, { id?: string; name?: string; arguments: string }>();
    for await (const event of readSseEvents(response.body)) {
      if (event.data === "[DONE]") {
        yield { type: "done" };
        return finalizeOpenAiCompatibleStream(textParts.join(""), toolCalls, usage);
      }
      const parsed = JSON.parse(event.data) as unknown;
      const delta = readOpenAiStreamText(parsed);
      if (delta) {
        textParts.push(delta);
        yield { type: "text-delta", text: delta };
      }
      mergeOpenAiToolCallDeltas(toolCalls, parsed);
      const eventUsage = readOpenAiUsage(parsed);
      if (eventUsage) {
        usage = eventUsage;
        yield { type: "usage", usage: eventUsage };
      }
    }

    yield { type: "done" };
    return finalizeOpenAiCompatibleStream(textParts.join(""), toolCalls, usage);
  }

  private async completeAnthropicMessages(request: ProviderRequest): Promise<ProviderResponse> {
    if (!this.config.baseUrl) {
      throw new MagiConfigError(`Provider ${this.name} requires baseUrl`);
    }

    const apiKey = getApiKey(this.name, this.config, this.env);
    const baseUrl = normalizeBaseUrl(this.config.baseUrl);
    const response = await fetchProvider(
      this.name,
      this.fetchImpl,
      `${baseUrl}/v1/messages`,
      {
        method: "POST",
        signal: request.signal,
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "prompt-caching-2024-07-31",
          "content-type": "application/json"
        },
        body: JSON.stringify(toAnthropicMessagesBody(request))
      },
      { timeoutMs: resolveProviderTimeoutMs(this.config, this.env) }
    );

    if (!response.ok) {
      throw providerErrorFromResponse(this.name, response);
    }

    const data = await response.json();
    return parseAnthropicMessagesResult(data);
  }

  private async *streamAnthropicMessages(
    request: ProviderRequest
  ): AsyncGenerator<ProviderStreamEvent, ProviderResponse> {
    if (!this.config.baseUrl) {
      throw new MagiConfigError(`Provider ${this.name} requires baseUrl`);
    }

    const apiKey = getApiKey(this.name, this.config, this.env);
    const baseUrl = normalizeBaseUrl(this.config.baseUrl);
    const response = await fetchProvider(
      this.name,
      this.fetchImpl,
      `${baseUrl}/v1/messages`,
      {
        method: "POST",
        signal: request.signal,
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "prompt-caching-2024-07-31",
          "content-type": "application/json"
        },
        body: JSON.stringify({ ...toAnthropicMessagesBody(request), stream: true })
      },
      { timeoutMs: resolveProviderTimeoutMs(this.config, this.env) }
    );

    if (!response.ok) {
      throw providerErrorFromResponse(this.name, response);
    }
    if (!isEventStreamResponse(response)) {
      const data = await response.json();
      return parseAnthropicMessagesResult(data);
    }

    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    let textLength = 0;
    let usage: ProviderResponse["usage"];
    const toolCalls = new Map<number, { id?: string; name?: string; input: string }>();
    for await (const event of readSseEvents(response.body)) {
      // Skip empty data lines and keep-alive comments. The upstream may send
      // `data: ` (no payload), `data: [DONE]`, or comment-only events; none of
      // these are valid JSON. Crashing here kills the whole TUI session.
      if (!event.data || event.data === "[DONE]") {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data) as unknown;
      } catch {
        // Malformed JSON in a stream chunk: skip it rather than aborting.
        continue;
      }
      const delta = readAnthropicStreamText(parsed);
      if (delta) {
        textParts.push(delta);
        textLength += delta.length;
        yield { type: "text-delta", text: delta };
      }
      // Some upstreams (e.g. proxies that force extended thinking) may produce
      // ONLY thinking blocks and no text block when the model decides to stop
      // after reasoning. Capture thinking content as a fallback so the user
      // sees something instead of an empty response.
      const thinkingDelta = readAnthropicStreamThinking(parsed);
      if (thinkingDelta) {
        thinkingParts.push(thinkingDelta);
      }
      mergeAnthropicToolUseDeltas(toolCalls, parsed);
      const eventUsage = readAnthropicStreamUsage(parsed);
      if (eventUsage) {
        usage = eventUsage;
        yield { type: "usage", usage: eventUsage };
      }
      if (isRecord(parsed) && parsed.type === "message_stop") {
        const text = textParts.join("");
        const thinking = thinkingParts.join("");
        const finalText = finalizeAnthropicText(text, thinking, toolCalls.size);
        if (finalText !== text) {
          // Surface the fallback to the live stream too so the TUI shows it.
          yield { type: "text-delta", text: finalText.slice(textLength) };
        }
        yield { type: "done" };
        return { text: finalText, toolUses: toolUsesFromAnthropicStream(toolCalls), usage };
      }
    }

    const text = textParts.join("");
    const thinking = thinkingParts.join("");
    const finalText = finalizeAnthropicText(text, thinking, toolCalls.size);
    if (finalText !== text) {
      yield { type: "text-delta", text: finalText.slice(textLength) };
    }
    yield { type: "done" };
    return { text: finalText, toolUses: toolUsesFromAnthropicStream(toolCalls), usage };
  }
}

function isEventStreamResponse(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") === true;
}

function toMessage(message: MagiMessage): Record<string, unknown> {
  if (message.role === "tool") {
    const first = message.content[0];
    const toolCallId = first?.type === "tool-result" ? first.toolCallId : "unknown";
    return {
      role: "tool",
      tool_call_id: toolCallId,
      content: messageText(message)
    };
  }
  if (message.role === "assistant") {
    const toolUses = message.content.filter((part) => part.type === "tool-use");
    if (toolUses.length > 0) {
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
      return {
        role: "assistant",
        content: text || undefined,
        tool_calls: toolUses.map((toolUse) => ({
          id: toolUse.id,
          type: "function",
          function: {
            name: toolUse.name,
            arguments: JSON.stringify(toolUse.input)
          }
        }))
      };
    }
  }
  return {
    role: message.role,
    content: messageText(message)
  };
}

function parseCompatibleResult(data: unknown): ProviderResponse {
  if (!isRecord(data)) {
    return { text: "", raw: data };
  }
  const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
  const text =
    isRecord(choice) && isRecord(choice.message) && typeof choice.message.content === "string"
      ? choice.message.content
      : "";
  const toolUses =
    isRecord(choice) && isRecord(choice.message)
      ? readOpenAiToolUses(choice.message.tool_calls)
      : [];
  const usage =
    isRecord(data.usage) &&
    typeof data.usage.prompt_tokens === "number" &&
    typeof data.usage.completion_tokens === "number"
      ? {
          inputTokens: data.usage.prompt_tokens,
          outputTokens: data.usage.completion_tokens
        }
      : undefined;
  const fallback = applyEmbeddedToolCallFallback({ text, toolUses });
  return { text: fallback.text, toolUses: fallback.toolUses, usage, raw: data };
}

function toAnthropicMessagesBody(request: ProviderRequest): Record<string, unknown> {
  const systemText = request.messages
    .filter((message) => message.role === "system")
    .map(messageText)
    .join("\n\n");
  const messages = request.messages
    .filter((message) => message.role !== "system")
    .map(toAnthropicMessage);

  // Prompt caching: attach cache_control to the LAST tool when tools exist
  // (caches the system + tools prefix). Same strategy as the legacy
  // magi-agent — exactly one cache marker per request, on the largest static
  // prefix. Tool defs are 30KB+ for 85 tools, and hotaitool.net's TTFB
  // doubles with tools, so caching matters here.
  const hasTools = request.tools && request.tools.length > 0;
  const tools = request.tools?.map((tool, index, arr) => {
    const base = {
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema
    } as Record<string, unknown>;
    if (index === arr.length - 1) {
      base.cache_control = { type: "ephemeral" };
    }
    return base;
  });

  // System prompt as a content array. If there are NO tools, put the cache
  // marker on the system block instead so the system prompt itself gets
  // cached. We never add two markers — only the largest static prefix.
  // Always emit a non-empty system block. Some messages-compatible relays
  // (e.g. hotaitool.net) inject their own "generate a title" system prompt
  // when the request omits `system`, which hijacks the response into
  // `{"title": "..."}`. Sending any system text suppresses that injection.
  const effectiveSystemText = systemText || "You are Magi, a helpful AI assistant.";
  const systemBlocks = [
    {
      type: "text" as const,
      text: effectiveSystemText,
      ...(hasTools ? {} : { cache_control: { type: "ephemeral" } })
    }
  ];

  return {
    model: request.model,
    max_tokens: request.maxOutputTokens ?? resolveDefaultMaxOutputTokens(),
    temperature: request.temperature,
    system: systemBlocks,
    messages,
    tools
  };
}

function parseAnthropicMessagesResult(data: unknown): ProviderResponse {
  if (!isRecord(data)) {
    return { text: "", raw: data };
  }
  const text = Array.isArray(data.content)
    ? data.content
        .map((part) =>
          isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""
        )
        .join("")
    : "";
  const thinking = Array.isArray(data.content)
    ? data.content
        .map((part) =>
          isRecord(part) && part.type === "thinking" && typeof part.thinking === "string"
            ? part.thinking
            : ""
        )
        .join("")
    : "";
  const toolUses = Array.isArray(data.content) ? readAnthropicToolUses(data.content) : [];
  const finalText = finalizeAnthropicText(text, thinking, toolUses.length);
  const usage =
    isRecord(data.usage) &&
    typeof data.usage.input_tokens === "number" &&
    typeof data.usage.output_tokens === "number"
      ? {
          inputTokens: data.usage.input_tokens,
          outputTokens: data.usage.output_tokens
        }
      : undefined;
  return { text: finalText, toolUses, usage, raw: data };
}

function toAnthropicMessage(message: MagiMessage): Record<string, unknown> {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content.map((part) => {
        if (part.type === "tool-use") {
          return {
            type: "tool_use",
            id: part.id,
            name: part.name,
            input: part.input
          };
        }
        return {
          type: "text",
          text: part.type === "text" ? part.text : part.type === "tool-result" ? part.content : ""
        };
      })
    };
  }
  if (message.role === "tool") {
    return {
      role: "user",
      content: message.content.map((part) => ({
        type: "tool_result",
        tool_use_id: part.type === "tool-result" ? part.toolCallId : "unknown",
        content: part.type === "tool-result" ? part.content : messageText(message),
        is_error: part.type === "tool-result" ? part.isError : undefined,
        retryable: part.type === "tool-result" ? part.retryable : undefined
      }))
    };
  }
  // user role: support text + image parts
  const hasImage = message.content.some((p) => p.type === "image");
  if (!hasImage) {
    // No image — keep the legacy flat-text shape for backwards compat
    return { role: "user", content: messageText(message) };
  }
  const parts: Record<string, unknown>[] = [];
  for (const part of message.content) {
    if (part.type === "image") {
      parts.push({
        type: "image",
        source: {
          type: "base64",
          media_type: part.mimeType,
          data: part.data
        }
      });
    } else if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "tool-result") {
      parts.push({ type: "text", text: part.content });
    }
  }
  return { role: "user", content: parts };
}

function readOpenAiToolUses(value: unknown): MagiToolUsePart[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((toolCall): MagiToolUsePart[] => {
    if (
      !isRecord(toolCall) ||
      !isRecord(toolCall.function) ||
      typeof toolCall.function.name !== "string"
    ) {
      return [];
    }
    return [
      {
        type: "tool-use",
        id: typeof toolCall.id === "string" ? toolCall.id : toolCall.function.name,
        name: toolCall.function.name,
        input: parseToolInput(toolCall.function.arguments)
      }
    ];
  });
}

function readAnthropicToolUses(content: unknown[]): MagiToolUsePart[] {
  return content.flatMap((part): MagiToolUsePart[] => {
    if (!isRecord(part) || part.type !== "tool_use" || typeof part.name !== "string") {
      return [];
    }
    return [
      {
        type: "tool-use",
        id: typeof part.id === "string" ? part.id : part.name,
        name: part.name,
        input: isRecord(part.input) ? part.input : {}
      }
    ];
  });
}

function readOpenAiStreamText(data: unknown): string | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
  return isRecord(choice) && isRecord(choice.delta) && typeof choice.delta.content === "string"
    ? choice.delta.content
    : undefined;
}

function readOpenAiUsage(data: unknown): { inputTokens: number; outputTokens: number } | undefined {
  if (!isRecord(data) || !isRecord(data.usage)) {
    return undefined;
  }
  const inputTokens =
    typeof data.usage.prompt_tokens === "number" ? data.usage.prompt_tokens : undefined;
  const outputTokens =
    typeof data.usage.completion_tokens === "number" ? data.usage.completion_tokens : undefined;
  return inputTokens !== undefined && outputTokens !== undefined
    ? { inputTokens, outputTokens }
    : undefined;
}

function mergeOpenAiToolCallDeltas(
  toolCalls: Map<number, { id?: string; name?: string; arguments: string }>,
  data: unknown
): void {
  if (!isRecord(data)) {
    return;
  }
  const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
  if (!isRecord(choice) || !isRecord(choice.delta) || !Array.isArray(choice.delta.tool_calls)) {
    return;
  }
  for (const rawToolCall of choice.delta.tool_calls) {
    if (!isRecord(rawToolCall)) {
      continue;
    }
    const index = typeof rawToolCall.index === "number" ? rawToolCall.index : 0;
    const current = toolCalls.get(index) ?? { arguments: "" };
    if (typeof rawToolCall.id === "string") {
      current.id = rawToolCall.id;
    }
    if (isRecord(rawToolCall.function)) {
      if (typeof rawToolCall.function.name === "string") {
        current.name = rawToolCall.function.name;
      }
      if (typeof rawToolCall.function.arguments === "string") {
        current.arguments += rawToolCall.function.arguments;
      }
    }
    toolCalls.set(index, current);
  }
}

function toolUsesFromOpenAiStream(
  toolCalls: Map<number, { id?: string; name?: string; arguments: string }>
): MagiToolUsePart[] {
  return [...toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, toolCall]): MagiToolUsePart[] => {
      if (!toolCall.name) {
        return [];
      }
      return [
        {
          type: "tool-use",
          id: toolCall.id ?? toolCall.name,
          name: toolCall.name,
          input: parseToolInput(toolCall.arguments)
        }
      ];
    });
}

function finalizeOpenAiCompatibleStream(
  text: string,
  toolCalls: Map<number, { id?: string; name?: string; arguments: string }>,
  usage: ProviderResponse["usage"]
): ProviderResponse {
  const fallback = applyEmbeddedToolCallFallback({
    text,
    toolUses: toolUsesFromOpenAiStream(toolCalls)
  });
  return { text: fallback.text, toolUses: fallback.toolUses, usage };
}

function readAnthropicStreamText(data: unknown): string | undefined {
  if (!isRecord(data) || data.type !== "content_block_delta" || !isRecord(data.delta)) {
    return undefined;
  }
  return data.delta.type === "text_delta" && typeof data.delta.text === "string"
    ? data.delta.text
    : undefined;
}

function readAnthropicStreamThinking(data: unknown): string | undefined {
  if (!isRecord(data) || data.type !== "content_block_delta" || !isRecord(data.delta)) {
    return undefined;
  }
  return data.delta.type === "thinking_delta" && typeof data.delta.thinking === "string"
    ? data.delta.thinking
    : undefined;
}

function finalizeAnthropicText(text: string, thinking: string, toolCallCount: number): string {
  // If the response already has text, or any tool calls, no fallback needed.
  if (text.trim().length > 0 || toolCallCount > 0) {
    return text;
  }
  // No text and no tools — but we may have thinking content. Surface it so the
  // user is not left staring at a silent prompt. Some proxies force extended
  // thinking and the model occasionally exhausts its budget on reasoning
  // alone, producing a valid-but-empty response.
  const trimmedThinking = thinking.trim();
  if (trimmedThinking.length > 0) {
    return `\x1b[90m[reasoning fallback — model produced no final answer]\x1b[39m\n${trimmedThinking}`;
  }
  // Truly empty response: model returned nothing. Surface this so the user
  // doesn't think the CLI hung silently.
  return "\x1b[90m[empty response from model — try again or switch models with /model]\x1b[39m";
}

function readAnthropicStreamUsage(
  data: unknown
): { inputTokens: number; outputTokens: number } | undefined {
  if (!isRecord(data) || !isRecord(data.usage)) {
    return undefined;
  }
  const inputTokens =
    typeof data.usage.input_tokens === "number" ? data.usage.input_tokens : undefined;
  const outputTokens =
    typeof data.usage.output_tokens === "number" ? data.usage.output_tokens : undefined;
  return inputTokens !== undefined && outputTokens !== undefined
    ? { inputTokens, outputTokens }
    : undefined;
}

function mergeAnthropicToolUseDeltas(
  toolCalls: Map<number, { id?: string; name?: string; input: string }>,
  data: unknown
): void {
  if (!isRecord(data)) {
    return;
  }
  if (
    data.type === "content_block_start" &&
    typeof data.index === "number" &&
    isRecord(data.content_block) &&
    data.content_block.type === "tool_use"
  ) {
    toolCalls.set(data.index, {
      id: typeof data.content_block.id === "string" ? data.content_block.id : undefined,
      name: typeof data.content_block.name === "string" ? data.content_block.name : undefined,
      input: ""
    });
    return;
  }
  if (
    data.type === "content_block_delta" &&
    typeof data.index === "number" &&
    isRecord(data.delta) &&
    data.delta.type === "input_json_delta"
  ) {
    const current = toolCalls.get(data.index) ?? { input: "" };
    if (typeof data.delta.partial_json === "string") {
      current.input += data.delta.partial_json;
    }
    toolCalls.set(data.index, current);
  }
}

function toolUsesFromAnthropicStream(
  toolCalls: Map<number, { id?: string; name?: string; input: string }>
): MagiToolUsePart[] {
  return [...toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, toolCall]): MagiToolUsePart[] => {
      if (!toolCall.name) {
        return [];
      }
      return [
        {
          type: "tool-use",
          id: toolCall.id ?? toolCall.name,
          name: toolCall.name,
          input: parseToolInput(toolCall.input)
        }
      ];
    });
}

function parseToolInput(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
