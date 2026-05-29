import { MemoryScope, extractExplicitMemoryWrite } from "./memory.js";
import { classifyMemoryNodeType, MemoryNodeType } from "./memory-node-store.js";
import { ProviderAdapter, ProviderUsage, textMessage } from "./providers/ir.js";

export interface MemoryWriteDecisionRoute {
  adapter: ProviderAdapter;
  model: string;
  providerName: string;
}

export interface MemoryWriteDecision {
  action: "write";
  scope: MemoryScope;
  type: MemoryNodeType;
  content: string;
  confidence: number;
  method: "llm" | "explicit-parser";
  providerName?: string;
  model?: string;
  usage?: ProviderUsage;
}

export interface MemoryCorrectionDecision {
  action: "correct";
  target: string;
  reason: string;
  replacement?: string;
  replacementTitle?: string;
  replacementSummary?: string;
  replacementType?: MemoryNodeType;
  confidence: number;
  method: "llm";
  providerName?: string;
  model?: string;
  usage?: ProviderUsage;
}

export type MemoryDecision = MemoryWriteDecision | MemoryCorrectionDecision;

export async function decideMemoryWrite(input: {
  prompt: string;
  route?: MemoryWriteDecisionRoute;
  signal?: AbortSignal;
}): Promise<MemoryDecision | undefined> {
  const parsed = extractExplicitMemoryWrite(input.prompt);
  if (input.route && isMemoryWriteCandidate(input.prompt, parsed !== undefined)) {
    try {
      return await decideMemoryWriteWithLlm(input.prompt, input.route, input.signal);
    } catch {
      // If the judge is temporarily unavailable, keep explicit legacy formats
      // working. A successful "do not write" LLM decision does not fall back.
      if (!parsed) {
        return undefined;
      }
    }
  }

  if (!parsed) {
    return undefined;
  }
  const type = classifyMemoryNodeType(parsed.text, { scope: parsed.scope });
  return {
    action: "write",
    scope: parsed.scope,
    type,
    content: parsed.text,
    confidence: 1,
    method: "explicit-parser"
  };
}

function isMemoryWriteCandidate(prompt: string, parsedExplicitFormat: boolean): boolean {
  if (parsedExplicitFormat) {
    return true;
  }
  const text = prompt.trim().toLowerCase();
  return [
    "remember",
    "please remember",
    "keep this for later",
    "keep in memory",
    "store this",
    "save this",
    "make a note",
    "note that",
    "记住",
    "记得",
    "记下来",
    "记一下",
    "帮我记",
    "你要记",
    "以后记",
    "memory is wrong",
    "memory is incorrect",
    "remembered wrong",
    "wrong memory",
    "not true",
    "outdated memory",
    "replace that memory",
    "correct that memory",
    "这条记忆不对",
    "这个记忆不对",
    "记忆不对",
    "记错",
    "你记错",
    "不是这样",
    "不准确",
    "过时了",
    "改成",
    "应该是"
  ].some((marker) => text.includes(marker));
}

async function decideMemoryWriteWithLlm(
  prompt: string,
  route: MemoryWriteDecisionRoute,
  signal?: AbortSignal
): Promise<MemoryDecision | undefined> {
  const response = await route.adapter.complete({
    model: route.model,
    messages: [textMessage("user", buildMemoryDecisionPrompt(prompt))],
    temperature: 0,
    maxOutputTokens: 300,
    signal
  });
  const parsed = parseMemoryDecisionJson(response.text);
  if (!parsed) {
    return undefined;
  }
  const action = readMemoryAction(parsed);
  if (action === "none") {
    return undefined;
  }
  if (action === "correct") {
    const target = readNonEmptyString(parsed.target);
    const reason = readNonEmptyString(parsed.reason);
    if (!target || !reason) {
      return undefined;
    }
    const replacement = readNonEmptyString(parsed.replacement);
    const replacementType =
      readMemoryNodeType(parsed.replacementType) ??
      readMemoryNodeType(parsed.replacement_type) ??
      (replacement ? classifyMemoryNodeType(replacement) : undefined);
    return {
      action: "correct",
      target,
      reason,
      replacement,
      replacementTitle:
        readNonEmptyString(parsed.replacementTitle) ?? readNonEmptyString(parsed.replacement_title),
      replacementSummary:
        readNonEmptyString(parsed.replacementSummary) ??
        readNonEmptyString(parsed.replacement_summary),
      replacementType,
      confidence: readConfidence(parsed.confidence),
      method: "llm",
      providerName: route.providerName,
      model: route.model,
      usage: response.usage
    };
  }
  const content = typeof parsed.content === "string" ? parsed.content.trim() : "";
  if (!content) {
    return undefined;
  }
  const scope = readMemoryScope(parsed.scope);
  const type = readMemoryNodeType(parsed.type) ?? classifyMemoryNodeType(content, { scope });
  return {
    action: "write",
    scope,
    type,
    content,
    confidence: readConfidence(parsed.confidence),
    method: "llm",
    providerName: route.providerName,
    model: route.model,
    usage: response.usage
  };
}

function buildMemoryDecisionPrompt(prompt: string): string {
  return [
    "You are Magi's durable-memory write/correction judge.",
    "Decide whether the user's latest message is asking Magi to write durable memory, correct an existing durable memory, or do neither.",
    "Return ONLY one JSON object with this shape:",
    `{"action":"write|correct|none","scope":"user|project|session","type":"user_profile|preference|work_habit|workflow|project|decision|problem|reference|skill_ref|session","content":"string","target":"string","reason":"string","replacement":"string","replacementType":"user_profile|preference|work_habit|workflow|project|decision|problem|reference|skill_ref|session","confidence":number}`,
    "",
    "Use action=write only for explicit remember/store/keep-for-later requests.",
    "Use action=correct when the user says an existing memory/fact is wrong, outdated, remembered incorrectly, or should be replaced. Put the old memory search phrase in target and the corrected durable fact in replacement.",
    "Use action=none for ordinary questions about existing memory, normal task instructions, temporary tool output, or assistant acknowledgements.",
    "For backward compatibility, shouldWrite=true without action is treated as action=write.",
    "Use scope=user unless the message clearly says project/repo/codebase or current session only.",
    "Use type=user_profile for identity/role/name facts; preference for likes/defaults/style; work_habit for recurring working habits; workflow for reusable procedures.",
    "Keep content concise and faithful to the user's language. Remove the request wording.",
    "",
    "User message:",
    prompt.slice(0, 4000)
  ].join("\n");
}

function parseMemoryDecisionJson(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const objectText = extractJsonObject(candidate);
  if (!objectText) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(objectText);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }
  return text.slice(start, end + 1);
}

function readMemoryScope(value: unknown): MemoryScope {
  return value === "project" || value === "session" ? value : "user";
}

function readMemoryAction(value: Record<string, unknown>): "write" | "correct" | "none" {
  if (value.action === "write" || value.action === "correct" || value.action === "none") {
    return value.action;
  }
  return value.shouldWrite === true ? "write" : "none";
}

function readMemoryNodeType(value: unknown): MemoryNodeType | undefined {
  if (
    value === "user_profile" ||
    value === "preference" ||
    value === "work_habit" ||
    value === "workflow" ||
    value === "project" ||
    value === "decision" ||
    value === "problem" ||
    value === "reference" ||
    value === "skill_ref" ||
    value === "session"
  ) {
    return value;
  }
  return undefined;
}

function readConfidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0.8;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
