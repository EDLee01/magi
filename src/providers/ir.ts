export type MagiMessageRole = "system" | "user" | "assistant" | "tool";

export interface MagiTextPart {
  type: "text";
  text: string;
}

export interface MagiToolResultPart {
  type: "tool-result";
  toolCallId: string;
  content: string;
  isError?: boolean;
  retryable?: boolean;
}

export interface MagiToolUsePart {
  type: "tool-use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * An image attached to a message. Base64-encoded data with a MIME type
 * (image/png, image/jpeg, image/gif, image/webp). Each provider adapter
 * is responsible for translating into its own representation.
 */
export interface MagiImagePart {
  type: "image";
  mimeType: string;
  /** Base64-encoded image bytes (without the data: URL prefix). */
  data: string;
}

export type MagiContentPart = MagiTextPart | MagiToolResultPart | MagiToolUsePart | MagiImagePart;

export interface MagiMessage {
  role: MagiMessageRole;
  content: MagiContentPart[];
}

export interface MagiToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ProviderRequest {
  model: string;
  messages: MagiMessage[];
  tools?: MagiToolDefinition[];
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderResponse {
  text: string;
  toolUses?: MagiToolUsePart[];
  usage?: ProviderUsage;
  raw?: unknown;
}

export type ProviderStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "usage"; usage: ProviderUsage }
  | { type: "done" };

export interface ProviderAdapter {
  readonly name: string;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
  stream?(request: ProviderRequest): AsyncGenerator<ProviderStreamEvent, ProviderResponse>;
}

export function textMessage(role: MagiMessageRole, text: string): MagiMessage {
  return {
    role,
    content: [{ type: "text", text }]
  };
}

export function messageText(message: MagiMessage): string {
  return message.content
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      if (part.type === "tool-use") {
        return JSON.stringify({ id: part.id, name: part.name, input: part.input });
      }
      if (part.type === "image") {
        return `[image ${part.mimeType}]`;
      }
      return part.content;
    })
    .join("");
}

/**
 * Magic prefix for encoding images in a string-only prompt channel.
 * Format: <IMAGE_PREFIX>mimeType|base64data<IMAGE_SUFFIX>
 * Multiple images may be concatenated. Anything else is text.
 */
const IMAGE_PREFIX = "<<MAGI_IMAGE:";
const IMAGE_SUFFIX = ":MAGI_IMAGE>>";

export function encodePromptWithImages(prompt: string, images: Array<{ mimeType: string; data: string }>): string {
  if (images.length === 0) return prompt;
  const blocks = images.map(img => `${IMAGE_PREFIX}${img.mimeType}|${img.data}${IMAGE_SUFFIX}`);
  return blocks.join("") + prompt;
}

/**
 * Parse a prompt string that may contain encoded image blocks and return
 * a list of MagiContentParts (text and image). Used by the agent loop to
 * convert string prompts (which is the channel everywhere) back into
 * structured messages for vision-capable providers.
 */
export function parsePromptIntoParts(prompt: string): MagiContentPart[] {
  const parts: MagiContentPart[] = [];
  let cursor = 0;
  while (cursor < prompt.length) {
    const startIdx = prompt.indexOf(IMAGE_PREFIX, cursor);
    if (startIdx === -1) {
      const remaining = prompt.slice(cursor);
      if (remaining.length > 0) parts.push({ type: "text", text: remaining });
      break;
    }
    if (startIdx > cursor) {
      parts.push({ type: "text", text: prompt.slice(cursor, startIdx) });
    }
    const endIdx = prompt.indexOf(IMAGE_SUFFIX, startIdx + IMAGE_PREFIX.length);
    if (endIdx === -1) {
      // Malformed — treat the rest as text
      parts.push({ type: "text", text: prompt.slice(startIdx) });
      break;
    }
    const body = prompt.slice(startIdx + IMAGE_PREFIX.length, endIdx);
    const sep = body.indexOf("|");
    if (sep > 0) {
      const mimeType = body.slice(0, sep);
      const data = body.slice(sep + 1);
      parts.push({ type: "image", mimeType, data });
    }
    cursor = endIdx + IMAGE_SUFFIX.length;
  }
  if (parts.length === 0) {
    parts.push({ type: "text", text: prompt });
  }
  return parts;
}
