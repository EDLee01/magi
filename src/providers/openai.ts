import { ProviderConfig } from "../config.js";
import { ProviderError, providerErrorFromResponse } from "./errors.js";
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

export class OpenAiAdapter implements ProviderAdapter {
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
    const apiKey = getApiKey(this.name, this.config, this.env);
    const endpoint = this.config.endpoint ?? "chat";
    const baseUrl = normalizeBaseUrl(this.config.baseUrl ?? "https://api.openai.com/v1");
    const response = await fetchProvider(
      this.name,
      this.fetchImpl,
      `${baseUrl}/${endpoint === "responses" ? "responses" : "chat/completions"}`,
      {
        method: "POST",
        signal: request.signal,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(
          endpoint === "responses" ? toResponsesBody(request) : toChatBody(request)
        )
      },
      { timeoutMs: resolveProviderTimeoutMs(this.config, this.env) }
    );

    if (!response.ok) {
      throw providerErrorFromResponse(this.name, response);
    }

    const data = await response.json();
    return endpoint === "responses" ? parseResponsesResult(data) : parseChatResult(data);
  }

  async *stream(request: ProviderRequest): AsyncGenerator<ProviderStreamEvent, ProviderResponse> {
    if (request.tools?.length && request.stream !== true) {
      return await this.complete(request);
    }

    const apiKey = getApiKey(this.name, this.config, this.env);
    const endpoint = this.config.endpoint ?? "chat";
    const baseUrl = normalizeBaseUrl(this.config.baseUrl ?? "https://api.openai.com/v1");
    const response = await fetchProvider(
      this.name,
      this.fetchImpl,
      `${baseUrl}/${endpoint === "responses" ? "responses" : "chat/completions"}`,
      {
        method: "POST",
        signal: request.signal,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(
          endpoint === "responses"
            ? toStreamingResponsesBody(request)
            : toStreamingChatBody(request)
        )
      },
      { timeoutMs: resolveProviderTimeoutMs(this.config, this.env) }
    );

    if (!response.ok) {
      throw providerErrorFromResponse(this.name, response);
    }
    if (!isEventStreamResponse(response)) {
      const data = await response.json();
      return endpoint === "responses" ? parseResponsesResult(data) : parseChatResult(data);
    }

    let text = "";
    let usage: ProviderResponse["usage"];
    const toolCalls = new Map<number, { id?: string; name?: string; arguments: string }>();
    for await (const event of readSseEvents(response.body)) {
      if (event.data === "[DONE]") {
        yield { type: "done" };
        return finalizeOpenAiStream(text, toolCalls, usage);
      }
      // Skip empty data lines (keep-alives) so a stray `data: \n` doesn't
      // crash the stream.
      if (!event.data) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data) as unknown;
      } catch {
        // Malformed chunk: skip rather than aborting the whole stream.
        continue;
      }
      const delta = readStreamText(parsed);
      if (delta) {
        text += delta;
        yield { type: "text-delta", text: delta };
      }
      mergeOpenAiToolCallDeltas(toolCalls, parsed);
      const eventUsage = readUsage(parsed);
      if (eventUsage) {
        usage = eventUsage;
        yield { type: "usage", usage: eventUsage };
      }
    }

    yield { type: "done" };
    return finalizeOpenAiStream(text, toolCalls, usage);
  }
}

function isEventStreamResponse(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") === true;
}

export function parseOpenAiStream(text: string): ProviderStreamEvent[] {
  const events: ProviderStreamEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) {
      continue;
    }

    const data = line.slice("data:".length).trim();
    if (!data) {
      continue;
    }
    if (data === "[DONE]") {
      events.push({ type: "done" });
      continue;
    }

    const parsed = JSON.parse(data) as unknown;
    const delta = readStreamText(parsed);
    if (delta) {
      events.push({ type: "text-delta", text: delta });
    }

    const usage = readUsage(parsed);
    if (usage) {
      events.push({ type: "usage", usage });
    }
  }
  return events;
}

function toChatBody(request: ProviderRequest): Record<string, unknown> {
  const tools = request.tools?.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  }));
  return {
    model: request.model,
    messages: request.messages.map(toChatMessage),
    tools,
    tool_choice: tools?.length ? "auto" : undefined,
    parallel_tool_calls: tools?.length ? true : undefined,
    temperature: request.temperature,
    max_completion_tokens: request.maxOutputTokens
  };
}

function toStreamingChatBody(request: ProviderRequest): Record<string, unknown> {
  return {
    ...toChatBody(request),
    stream: true,
    stream_options: { include_usage: true }
  };
}

function toResponsesBody(request: ProviderRequest): Record<string, unknown> {
  return {
    model: request.model,
    input: request.messages.map((message) => ({
      role: message.role,
      content: messageText(message)
    })),
    tools: request.tools?.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    })),
    temperature: request.temperature,
    max_output_tokens: request.maxOutputTokens
  };
}

function toStreamingResponsesBody(request: ProviderRequest): Record<string, unknown> {
  return {
    ...toResponsesBody(request),
    stream: true
  };
}

function toChatMessage(message: MagiMessage): Record<string, unknown> {
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
  // For user/system, support text + image content parts
  if (message.role === "user" || message.role === "system") {
    const parts: Record<string, unknown>[] = [];
    for (const part of message.content) {
      if (part.type === "image") {
        parts.push({
          type: "image_url",
          image_url: { url: `data:${part.mimeType};base64,${part.data}` }
        });
      } else if (part.type === "text") {
        parts.push({ type: "text", text: part.text });
      }
    }
    if (parts.some((p) => p.type === "image_url")) {
      return { role: message.role, content: parts };
    }
  }
  return {
    role: message.role,
    content: messageText(message)
  };
}

function parseChatResult(data: unknown): ProviderResponse {
  if (!isRecord(data)) {
    throw new ProviderError("OpenAI chat response must be an object", {
      kind: "bad-request",
      retryable: false
    });
  }
  const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
  const text = isRecord(choice) && isRecord(choice.message) ? readMessageText(choice.message) : "";
  const toolUses =
    isRecord(choice) && isRecord(choice.message)
      ? readOpenAiToolUses(choice.message.tool_calls)
      : [];
  const fallback = applyEmbeddedToolCallFallback({ text, toolUses });
  return {
    text: fallback.text,
    toolUses: fallback.toolUses,
    usage: readUsage(data),
    raw: data
  };
}

function readMessageText(message: Record<string, unknown>): string {
  const contentText = readContentText(message.content);
  if (contentText) {
    return contentText;
  }
  for (const key of ["output_text", "text", "final", "answer"]) {
    const value = message[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return "";
}

function readContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (!isRecord(part)) {
        return "";
      }
      if (typeof part.text === "string") {
        return part.text;
      }
      if (typeof part.content === "string") {
        return part.content;
      }
      if (isRecord(part.text) && typeof part.text.value === "string") {
        return part.text.value;
      }
      return "";
    })
    .join("");
}

function parseResponsesResult(data: unknown): ProviderResponse {
  if (!isRecord(data)) {
    throw new ProviderError("OpenAI responses result must be an object", {
      kind: "bad-request",
      retryable: false
    });
  }
  const text =
    typeof data.output_text === "string" ? data.output_text : readResponsesOutputText(data);
  return {
    text,
    toolUses: readResponsesToolUses(data),
    usage: readUsage(data),
    raw: data
  };
}

function readResponsesOutputText(data: Record<string, unknown>): string {
  if (!Array.isArray(data.output)) {
    return "";
  }
  return data.output
    .flatMap((item) => (isRecord(item) && Array.isArray(item.content) ? item.content : []))
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .join("");
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

function readResponsesToolUses(data: Record<string, unknown>): MagiToolUsePart[] {
  if (!Array.isArray(data.output)) {
    return [];
  }
  return data.output.flatMap((item): MagiToolUsePart[] => {
    if (!isRecord(item) || item.type !== "function_call" || typeof item.name !== "string") {
      return [];
    }
    return [
      {
        type: "tool-use",
        id: typeof item.call_id === "string" ? item.call_id : item.name,
        name: item.name,
        input: parseToolInput(item.arguments)
      }
    ];
  });
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

function finalizeOpenAiStream(
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

function readStreamText(data: unknown): string | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  if (data.type === "response.output_text.delta" && typeof data.delta === "string") {
    return data.delta;
  }
  const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
  if (isRecord(choice) && isRecord(choice.delta)) {
    const contentText = readContentText(choice.delta.content);
    if (contentText) {
      return contentText;
    }
    for (const key of ["output_text", "text"]) {
      const value = choice.delta[key];
      if (typeof value === "string" && value) {
        return value;
      }
    }
  }
  return undefined;
}

function readUsage(data: unknown): { inputTokens: number; outputTokens: number } | undefined {
  if (!isRecord(data) || !isRecord(data.usage)) {
    return undefined;
  }
  const inputTokens = readNumber(data.usage.prompt_tokens) ?? readNumber(data.usage.input_tokens);
  const outputTokens =
    readNumber(data.usage.completion_tokens) ?? readNumber(data.usage.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined;
  }
  return { inputTokens, outputTokens };
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
