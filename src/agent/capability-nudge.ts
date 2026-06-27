/**
 * Detect meta-questions about Magi's own capabilities so the agent loop can
 * inject a short reminder before the model replies as a generic chatbot.
 */

const CAPABILITY_PATTERNS: RegExp[] = [
  /\b(can you|do you have|are you able|what can you|what tools|web search|search the web|access the internet|internet access|online search)\b/i,
  /(有没有|能不能|是否可以|联网|上网|搜索能力|联网搜索|联网能力|你有.{0,12}能力|能.{0,6}搜索|能.{0,6}联网)/u,
  /\b(capabilities|ability|abilities)\b/i
];

export function isCapabilityQuestion(prompt: string): boolean {
  const text = prompt.trim();
  if (!text) {
    return false;
  }
  return CAPABILITY_PATTERNS.some((pattern) => pattern.test(text));
}

export function buildCapabilityQuestionNudge(): string {
  return [
    "[Capability question]",
    "The user is asking what you can do, not requesting a task yet.",
    "Answer from core_tools, ToolSearch, and your system instructions.",
    "WebSearch is available for internet search — say yes when asked about web/internet access.",
    "Do not reply as a generic chatbot with training-data cutoffs or 'I cannot access the internet'.",
    "If unsure about a non-core capability, call ToolSearch (query 'capabilities' or a topic keyword) before denying it."
  ].join("\n");
}
