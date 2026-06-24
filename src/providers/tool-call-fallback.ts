import { MagiToolUsePart } from "./ir.js";

/**
 * Fallback parser for tool calls embedded as TEXT inside a model's content.
 *
 * Some providers (notably Step and GLM relays) intermittently ignore the
 * structured `tool_calls` field and instead emit tool calls inline in the
 * message content using Hermes / XML-style markup, e.g.
 *
 *   <tool_call>
 *   <function=FileRead>
 *   <parameter=file_path>/etc/hosts</parameter>
 *   </function>
 *   </tool_call>
 *
 * or the Hermes JSON variant:
 *
 *   <tool_call>{"name": "FileRead", "arguments": {"file_path": "/etc/hosts"}}</tool_call>
 *
 * When the structured channel is empty, Magi must fall back to scanning the
 * content. Otherwise the tool silently never runs and the model hallucinates
 * a result (most dangerously, a fabricated verification outcome).
 */

interface ParsedFallback {
  toolUses: MagiToolUsePart[];
  /** The content with recognized tool-call blocks removed. */
  text: string;
}

const TOOL_CALL_BLOCK = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
// Self-closing / unwrapped function form, e.g. <function=Name> ... </function>
const FUNCTION_BLOCK = /<function=([^\s>]+)\s*>\s*([\s\S]*?)\s*<\/function>/gi;
const PARAMETER_BLOCK = /<parameter=([^\s>]+)\s*>\s*([\s\S]*?)\s*<\/parameter>/gi;

/**
 * Parse tool calls embedded in content text. Returns the extracted tool uses
 * and the content with those blocks stripped out so they don't leak as text.
 */
export function parseEmbeddedToolCalls(content: string): ParsedFallback {
  if (!content || !content.includes("<")) {
    return { toolUses: [], text: content };
  }

  const toolUses: MagiToolUsePart[] = [];
  let stripped = content;

  // 1. <tool_call> ... </tool_call> wrapped blocks (Hermes JSON or XML inside).
  stripped = stripped.replace(TOOL_CALL_BLOCK, (match, inner: string) => {
    const parsed = parseToolCallInner(inner);
    if (parsed.length === 0) {
      return match; // not recognizable — leave it so it isn't silently dropped
    }
    toolUses.push(...parsed);
    return "";
  });

  // 2. Bare <function=Name> ... </function> blocks not wrapped in <tool_call>.
  stripped = stripped.replace(FUNCTION_BLOCK, (match, name: string, body: string) => {
    if (typeof name !== "string" || !name.trim()) {
      return match;
    }
    toolUses.push({
      type: "tool-use",
      id: makeId(name),
      name: name.trim(),
      input: parseParameters(body)
    });
    return "";
  });

  return { toolUses, text: stripped.trim() };
}

/**
 * Apply the embedded-tool-call fallback to a parsed result. Only kicks in when
 * the structured `tool_calls` channel produced nothing — otherwise the
 * structured result is authoritative and is returned untouched. When the
 * fallback finds tool calls, the recognized blocks are stripped from `text` so
 * they don't also leak to the user as prose.
 */
export function applyEmbeddedToolCallFallback(result: {
  text: string;
  toolUses?: MagiToolUsePart[];
}): { text: string; toolUses: MagiToolUsePart[] } {
  const existing = result.toolUses ?? [];
  if (existing.length > 0 || !hasEmbeddedToolCall(result.text)) {
    return { text: result.text, toolUses: existing };
  }
  const parsed = parseEmbeddedToolCalls(result.text);
  if (parsed.toolUses.length === 0) {
    return { text: result.text, toolUses: existing };
  }
  return { text: parsed.text, toolUses: parsed.toolUses };
}

/**
 * True if the content appears to contain an embedded tool call. Cheap guard so
 * callers only invoke the full parser when the structured channel was empty.
 */
export function hasEmbeddedToolCall(content: string): boolean {
  if (!content) {
    return false;
  }
  return /<tool_call>/i.test(content) || /<function=[^\s>]+\s*>/i.test(content);
}

function parseToolCallInner(inner: string): MagiToolUsePart[] {
  const trimmed = inner.trim();
  if (!trimmed) {
    return [];
  }

  // XML form: <function=Name>...<parameter=...>...</parameter></function>
  if (/<function=/i.test(trimmed)) {
    const out: MagiToolUsePart[] = [];
    FUNCTION_BLOCK.lastIndex = 0;
    let fnMatch: RegExpExecArray | null;
    while ((fnMatch = FUNCTION_BLOCK.exec(trimmed)) !== null) {
      const name = fnMatch[1]?.trim();
      if (!name) {
        continue;
      }
      out.push({
        type: "tool-use",
        id: makeId(name),
        name,
        input: parseParameters(fnMatch[2] ?? "")
      });
    }
    if (out.length > 0) {
      return out;
    }
  }

  // Hermes JSON form: {"name": "...", "arguments": {...}}
  const json = tryParseJsonObject(trimmed);
  if (json) {
    const name = typeof json.name === "string" ? json.name : undefined;
    if (name) {
      const args = json.arguments ?? json.parameters ?? json.input;
      return [
        {
          type: "tool-use",
          id: makeId(name),
          name,
          input: coerceArgs(args)
        }
      ];
    }
  }

  return [];
}

function parseParameters(body: string): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  PARAMETER_BLOCK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PARAMETER_BLOCK.exec(body)) !== null) {
    const key = match[1]?.trim();
    if (!key) {
      continue;
    }
    input[key] = coerceScalar(match[2] ?? "");
  }
  // Some emitters put a raw JSON object as the function body instead of
  // <parameter> blocks. Fall back to JSON if no parameters were found.
  if (Object.keys(input).length === 0) {
    const json = tryParseJsonObject(body.trim());
    if (json) {
      return json;
    }
  }
  return input;
}

/** Coerce a parameter string value into a JSON scalar/object when it looks like one. */
function coerceScalar(raw: string): unknown {
  const value = raw.trim();
  if (value === "") {
    return "";
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    const num = Number(value);
    if (Number.isFinite(num)) {
      return num;
    }
  }
  if (
    (value.startsWith("{") && value.endsWith("}")) ||
    (value.startsWith("[") && value.endsWith("]"))
  ) {
    try {
      return JSON.parse(value);
    } catch {
      return raw;
    }
  }
  return raw;
}

function coerceArgs(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value === "string") {
    const json = tryParseJsonObject(value.trim());
    if (json) {
      return json;
    }
  }
  return {};
}

function tryParseJsonObject(value: string): Record<string, unknown> | undefined {
  if (!value.startsWith("{")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

let counter = 0;
function makeId(name: string): string {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  return `${name}-embedded-${counter}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
