/**
 * Detect meta-questions about Magi's own capabilities so the agent loop can
 * inject a short reminder before the model replies as a generic chatbot.
 */

const CAPABILITY_PATTERNS: RegExp[] = [
  /\b(can you|do you have|are you able|what can you|what tools|web search|search the web|access the internet|internet access|online search)\b/i,
  /(有没有|能不能|是否可以|可不可以|能否|联网|上网|搜索能力|联网搜索|联网能力|你有.{0,12}能力|能.{0,6}搜索|能.{0,6}联网)/u,
  /\b(capabilities|ability|abilities)\b/i
];

const URL_IN_PROMPT = /https?:\/\/[^\s<>"')\]]+/i;

const URL_FETCH_PATTERNS: RegExp[] = [
  /(阅读|读一下|读|打开|访问|抓取|获取|查看|研究|安装|配置|按照|follow|fetch|read|open|visit).{0,32}(https?:\/\/|文档|doc|url|链接|link)/iu,
  /(https?:\/\/).{0,80}(文档|doc|setup|install|配置|安装)/iu
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
    "[Capability question — use your loaded tools, not chatbot defaults]",
    "The user is asking what you can do, not requesting a task yet.",
    "WebSearch is already in your core tool list for this turn — answer YES for web/internet/search questions.",
    "WebFetch is also loaded for URLs. WebBrowser, Browser, and HttpRequest are discoverable via ToolSearch.",
    "Do NOT say you lack internet access, web search, or real-time data.",
    "Do NOT cite training-data cutoffs or reply as a generic chatbot.",
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

export function isUrlFetchTask(prompt: string): boolean {
  const text = prompt.trim();
  if (!text || isCapabilityQuestion(text) || isWebResearchTask(text)) {
    return false;
  }
  if (!URL_IN_PROMPT.test(text)) {
    return false;
  }
  return URL_FETCH_PATTERNS.some((pattern) => pattern.test(text));
}

export function buildUrlFetchNudge(): string {
  return [
    "[URL fetch task]",
    "The user gave a specific URL. Call WebFetch on that URL first — do not use WebSearch to guess whether the page exists.",
    "After you have the page content, follow the user's instructions (install, configure, summarize, etc.).",
    "Do not claim the URL is invalid or the domain unknown before WebFetch returns an error."
  ].join("\n");
}

export function buildPromptNudges(prompt: string): string[] {
  const text = prompt.trim();
  if (!text) {
    return [];
  }
  if (isCapabilityQuestion(text)) {
    return [buildCapabilityQuestionNudge()];
  }
  if (isWebResearchTask(text)) {
    return [buildWebResearchNudge()];
  }
  if (isUrlFetchTask(text)) {
    return [buildUrlFetchNudge()];
  }
  return [];
}

export function augmentPromptWithNudges(prompt: string): string {
  const nudges = buildPromptNudges(prompt);
  if (nudges.length === 0) {
    return prompt;
  }
  return `${prompt}\n\n${nudges.join("\n\n")}`;
}
