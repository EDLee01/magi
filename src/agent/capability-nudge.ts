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

const WEB_RESEARCH_PATTERNS: RegExp[] = [
  /(搜索|查找|检索|查询|调研|查一下).{0,24}(文献|论文|资料|研究|最新|联网|网上|网络)/u,
  /(文献|论文|arxiv|scholar).{0,24}(搜索|检索|查找|综述|review|survey)/iu,
  /\b(search|find|lookup|research).{0,40}\b(literature|papers?|arxiv|scholar|pubmed|studies)\b/i,
  /\b(llm|ai agent|agent|rag).{0,24}\bmemory\b/i,
  /\b(arxiv|semantic scholar|google scholar|pubmed)\b/i
];

export function isWebResearchTask(prompt: string): boolean {
  const text = prompt.trim();
  if (!text || isCapabilityQuestion(text)) {
    return false;
  }
  return WEB_RESEARCH_PATTERNS.some((pattern) => pattern.test(text));
}

export function buildWebResearchNudge(): string {
  return [
    "[Web research task]",
    "The user wants live or recent information from the web or academic sources.",
    "Call WebSearch first (WebFetch only for a specific URL the user already gave).",
    "Do not use Brief or SendUserMessage to claim you lack internet access.",
    "Do not tell the user to search elsewhere unless WebSearch already failed with an error.",
    "Summarize findings with links after you have search results."
  ].join("\n");
}
