/**
 * Standalone bidirectional format conversion between Magi IR, OpenAI Chat, and Anthropic Messages.
 * Extracted from the adapter implementations for reuse in proxy servers and testing.
 */

import {
  MagiMessage,
  MagiToolDefinition,
  MagiToolUsePart,
  ProviderRequest,
  ProviderResponse,
  messageText
} from "./ir.js";

// ─── Magi IR → OpenAI Chat ───────────────────────────────────────────────────

export interface OpenAiChatRequest {
  model: string;
  messages: OpenAiChatMessage[];
  tools?: OpenAiToolDef[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  stream_options?: { include_usage: boolean };
}

export interface OpenAiChatMessage {
  role: string;
  content?: string;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

export interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAiToolDef {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

export interface OpenAiChatResponse {
  choices: Array<{
    message: { role: string; content?: string; tool_calls?: OpenAiToolCall[] };
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

// ─── Magi IR → Anthropic Messages ───────────────────────────────────────────

export interface AnthropicMessagesRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessage[];
  tools?: AnthropicToolDef[];
  temperature?: number;
  stream?: boolean;
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface AnthropicToolDef {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicMessagesResponse {
  content: AnthropicContentBlock[];
  usage?: { input_tokens: number; output_tokens: number };
}

// ─── Conversion: Magi IR → OpenAI Chat ──────────────────────────────────────

export function magiToOpenAiChat(
  request: ProviderRequest,
  options?: { stream?: boolean }
): OpenAiChatRequest {
  const messages: OpenAiChatMessage[] = request.messages.map(magiMessageToOpenAi);
  const tools: OpenAiToolDef[] | undefined = request.tools?.map(magiToolToOpenAi);
  return {
    model: request.model,
    messages,
    tools: tools?.length ? tools : undefined,
    temperature: request.temperature,
    max_tokens: request.maxOutputTokens,
    stream: options?.stream,
    stream_options: options?.stream ? { include_usage: true } : undefined
  };
}

function magiMessageToOpenAi(message: MagiMessage): OpenAiChatMessage {
  if (message.role === "tool") {
    const first = message.content[0];
    return {
      role: "tool",
      tool_call_id: first?.type === "tool-result" ? first.toolCallId : "unknown",
      content: messageText(message)
    };
  }
  if (message.role === "assistant") {
    const toolUses = message.content.filter((p) => p.type === "tool-use") as MagiToolUsePart[];
    if (toolUses.length > 0) {
      return {
        role: "assistant",
        content:
          message.content
            .filter((p) => p.type === "text")
            .map((p) => (p.type === "text" ? p.text : ""))
            .join("") || undefined,
        tool_calls: toolUses.map((tu) => ({
          id: tu.id,
          type: "function" as const,
          function: { name: tu.name, arguments: JSON.stringify(tu.input) }
        }))
      };
    }
  }
  return { role: message.role, content: messageText(message) };
}

function magiToolToOpenAi(tool: MagiToolDefinition): OpenAiToolDef {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
  };
}

// ─── Conversion: OpenAI Chat → Magi IR ──────────────────────────────────────

export function openAiChatToMagi(response: OpenAiChatResponse): ProviderResponse {
  const choice = response.choices?.[0];
  if (!choice) {
    return { text: "" };
  }
  const text = choice.message.content ?? "";
  const toolUses: MagiToolUsePart[] = (choice.message.tool_calls ?? []).map((tc) => ({
    type: "tool-use",
    id: tc.id,
    name: tc.function.name,
    input: safeParseJson(tc.function.arguments)
  }));
  return {
    text,
    toolUses: toolUses.length > 0 ? toolUses : undefined,
    usage: response.usage
      ? {
          inputTokens: response.usage.prompt_tokens,
          outputTokens: response.usage.completion_tokens
        }
      : undefined,
    raw: response
  };
}

// ─── Conversion: Magi IR → Anthropic Messages ───────────────────────────────

export function magiToAnthropicMessages(
  request: ProviderRequest,
  options?: { stream?: boolean }
): AnthropicMessagesRequest {
  const system = request.messages
    .filter((m) => m.role === "system")
    .map(messageText)
    .join("\n\n");
  const messages: AnthropicMessage[] = request.messages
    .filter((m) => m.role !== "system")
    .map(magiMessageToAnthropic);
  const tools: AnthropicToolDef[] | undefined = request.tools?.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema
  }));
  return {
    model: request.model,
    max_tokens: request.maxOutputTokens ?? 4096,
    system: system || undefined,
    messages,
    tools: tools?.length ? tools : undefined,
    temperature: request.temperature,
    stream: options?.stream
  };
}

function magiMessageToAnthropic(message: MagiMessage): AnthropicMessage {
  if (message.role === "assistant") {
    const blocks: AnthropicContentBlock[] = message.content.map((part) => {
      if (part.type === "tool-use") {
        return { type: "tool_use", id: part.id, name: part.name, input: part.input };
      }
      return {
        type: "text",
        text: part.type === "text" ? part.text : part.type === "tool-result" ? part.content : ""
      };
    });
    return { role: "assistant", content: blocks };
  }
  if (message.role === "tool") {
    const blocks: AnthropicContentBlock[] = message.content.map((part) => ({
      type: "tool_result",
      tool_use_id: part.type === "tool-result" ? part.toolCallId : "unknown",
      content: part.type === "tool-result" ? part.content : messageText(message),
      is_error: part.type === "tool-result" ? part.isError : undefined
    }));
    return { role: "user", content: blocks };
  }
  return { role: "user", content: messageText(message) };
}

// ─── Conversion: Anthropic Messages → Magi IR ──────────────────────────────

export function anthropicMessagesToMagi(response: AnthropicMessagesResponse): ProviderResponse {
  const text = response.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
  const toolUses: MagiToolUsePart[] = response.content
    .filter(
      (b): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
        b.type === "tool_use"
    )
    .map((b) => ({ type: "tool-use", id: b.id, name: b.name, input: b.input }));
  return {
    text,
    toolUses: toolUses.length > 0 ? toolUses : undefined,
    usage: response.usage
      ? {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens
        }
      : undefined,
    raw: response
  };
}

// ─── Cross-format: OpenAI Chat ↔ Anthropic Messages ─────────────────────────

export function openAiChatToAnthropicMessages(
  request: OpenAiChatRequest
): AnthropicMessagesRequest {
  const system = request.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content ?? "")
    .join("\n\n");
  const messages: AnthropicMessage[] = request.messages
    .filter((m) => m.role !== "system")
    .map(openAiMessageToAnthropic);
  const tools: AnthropicToolDef[] | undefined = request.tools?.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters
  }));
  return {
    model: request.model,
    max_tokens: request.max_tokens ?? 4096,
    system: system || undefined,
    messages,
    tools: tools?.length ? tools : undefined,
    temperature: request.temperature,
    stream: request.stream
  };
}

function openAiMessageToAnthropic(message: OpenAiChatMessage): AnthropicMessage {
  if (message.role === "assistant" && message.tool_calls?.length) {
    const blocks: AnthropicContentBlock[] = [];
    if (message.content) {
      blocks.push({ type: "text", text: message.content });
    }
    for (const tc of message.tool_calls) {
      blocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: safeParseJson(tc.function.arguments)
      });
    }
    return { role: "assistant", content: blocks };
  }
  if (message.role === "tool") {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: message.tool_call_id ?? "unknown",
          content: message.content ?? ""
        }
      ]
    };
  }
  if (message.role === "assistant") {
    return { role: "assistant", content: message.content ?? "" };
  }
  return { role: "user", content: message.content ?? "" };
}

export function anthropicMessagesToOpenAiChat(
  response: AnthropicMessagesResponse
): OpenAiChatResponse {
  const text = response.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
  const toolCalls: OpenAiToolCall[] = response.content
    .filter(
      (b): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
        b.type === "tool_use"
    )
    .map((b) => ({
      id: b.id,
      type: "function",
      function: { name: b.name, arguments: JSON.stringify(b.input) }
    }));
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: text || undefined,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined
        }
      }
    ],
    usage: response.usage
      ? {
          prompt_tokens: response.usage.input_tokens,
          completion_tokens: response.usage.output_tokens
        }
      : undefined
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeParseJson(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
