import {
  formatToolUsageReason,
  recordToolSearchContext,
  ToolUsageStats,
  toolUsageScore
} from "../tool-usage-stats.js";
import { listToolPackNames, resolvePackToolNames } from "../tool-loading.js";

export interface ToolSearchableRecord {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  category?: string;
  tags?: string[];
  isReadOnly(input: Record<string, unknown>): boolean;
  isDestructive(input: Record<string, unknown>): boolean;
  isConcurrencySafe(input: Record<string, unknown>): boolean;
}

export interface ToolSearchInput {
  query: string;
  maxResults: number;
}

export interface ToolSearchOptions {
  usageStats?: ToolUsageStats;
  stateRoot?: string;
  coreToolNames?: ReadonlySet<string>;
}

export const ToolSearchInputSchema = {
  type: "object",
  properties: {
    query: { type: "string" },
    max_results: { type: "number" }
  },
  required: ["query"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseToolSearchInput(input: Record<string, unknown>): ToolSearchInput {
  assertAllowedKeys(input, ["query", "max_results"], "ToolSearch input");
  const query = readNonEmptyString(input.query, "query");
  const maxResults = input.max_results === undefined ? 5 : readMaxResults(input.max_results);
  return { query, maxResults };
}

export function executeToolSearch(
  input: ToolSearchInput,
  tools: ToolSearchableRecord[],
  options: ToolSearchOptions = {}
): string {
  const query = input.query.trim();
  const select = /^select:(.+)$/i.exec(query);
  if (select) {
    const requested = select[1].trim();
    const pack = /^pack:(.+)$/i.exec(requested);
    if (pack) {
      return formatSelectedPack(pack[1].trim(), tools, options);
    }
    const tool = tools.find((item) => item.name.toLowerCase() === requested.toLowerCase());
    if (!tool) {
      throw new Error(`Tool not found: ${requested}`);
    }
    return formatSelectedTool(tool);
  }

  const packOnly = /^pack:([A-Za-z0-9_-]+)$/i.exec(query);
  if (packOnly) {
    return formatSelectedPack(packOnly[1].trim(), tools, options);
  }

  if (/^(capabilities|list:deferred|list:tools)$/i.test(query)) {
    return formatDeferredToolCatalog(tools, options.coreToolNames);
  }

  const analysis = analyzeToolSearchQuery(query);
  const matches = searchTools(input.query, tools, analysis, options).slice(0, input.maxResults);
  if (matches.length === 0) {
    return `No tools match ${JSON.stringify(input.query)}`;
  }
  recordToolSearchContext({
    stateRoot: options.stateRoot,
    query: input.query,
    intents: analysis.intents,
    toolNames: matches.map((match) => match.tool.name)
  });
  return [
    `ToolSearch results for ${JSON.stringify(input.query)} (${matches.length})`,
    analysis.intents.length > 0 ? `intent: ${analysis.intents.join(", ")}` : undefined,
    ...matches.map(({ tool, score, reasons }, index) =>
      [
        `${index + 1}. ${tool.name} [${tool.category ?? "uncategorized"}] score=${score}`,
        `   ${tool.description ?? "No description"}`,
        `   tags: ${(tool.tags ?? []).join(", ") || "none"}`,
        `   matched: ${formatMatchReasons(reasons)}`,
        `   schema: ${schemaSummary(tool.inputSchema)}`
      ].join("\n")
    ),
    "",
    "Use query select:<tool_name> or pack:<pack_name> for the full schema.",
    `Available packs: ${listToolPackNames().join(", ")}`
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

interface ToolSearchAnalysis {
  terms: string[];
  expandedTerms: string[];
  normalizedQuery: string;
  intents: string[];
}

interface ToolSearchMatch {
  tool: ToolSearchableRecord;
  score: number;
  reasons: string[];
}

interface ToolIntentProfile {
  name: string;
  triggers: string[];
  phrases?: string[];
  categories?: string[];
  tags?: string[];
  toolBoosts?: Record<string, number>;
}

function searchTools(
  query: string,
  tools: ToolSearchableRecord[],
  analysis = analyzeToolSearchQuery(query),
  options: ToolSearchOptions = {}
): ToolSearchMatch[] {
  return tools
    .map((tool) => ({ tool, ...scoreTool(tool, analysis, options) }))
    .filter((item) => item.score > 0)
    .sort(
      (left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name)
    );
}

function scoreTool(
  tool: ToolSearchableRecord,
  analysis: ToolSearchAnalysis,
  options: ToolSearchOptions
): { score: number; reasons: string[] } {
  const name = tool.name.toLowerCase();
  const nameTerms = tokenizeToolText(tool.name);
  const descriptionTerms = tokenizeToolText(tool.description ?? "");
  const category = (tool.category ?? "").toLowerCase();
  const tagTerms = new Set((tool.tags ?? []).flatMap(tokenizeToolText));
  const schemaTerms = new Set(tokenizeSchema(tool.inputSchema));
  let score = 0;
  const reasons: string[] = [];
  for (const term of analysis.expandedTerms) {
    if (name === term) {
      score += 120;
      addReason(reasons, `exact name:${term}`);
    }
    if (nameTerms.includes(term)) {
      score += 60;
      addReason(reasons, `name:${term}`);
    } else if (name.includes(term)) {
      score += 35;
      addReason(reasons, `name contains:${term}`);
    }
    if (category === term) {
      score += 36;
      addReason(reasons, `category:${term}`);
    }
    if (tagTerms.has(term)) {
      score += 32;
      addReason(reasons, `tag:${term}`);
    }
    if (descriptionTerms.includes(term)) {
      score += 14;
      addReason(reasons, `description:${term}`);
    }
    if (schemaTerms.has(term)) {
      score += 5;
      addReason(reasons, `schema:${term}`);
    }
  }
  for (const profile of INTENT_PROFILES) {
    if (!analysis.intents.includes(profile.name)) {
      continue;
    }
    const boost = profile.toolBoosts?.[tool.name] ?? 0;
    if (boost > 0) {
      score += boost;
      addReason(reasons, `intent:${profile.name}`);
    }
    if (profile.categories?.includes(category)) {
      score += 28;
      addReason(reasons, `intent category:${profile.name}`);
    }
    const matchedTags = (profile.tags ?? []).filter((tag) => tagTerms.has(tag));
    if (matchedTags.length > 0) {
      score += matchedTags.length * 18;
      addReason(reasons, `intent tag:${matchedTags.slice(0, 2).join(",")}`);
    }
  }
  const usage = options.usageStats?.tools[tool.name];
  const usageSignals = scoreUsageSignals(usage, analysis.intents);
  if (usageSignals.score !== 0) {
    score += usageSignals.score;
    for (const reason of usageSignals.reasons) {
      addReason(reasons, reason);
    }
  }
  if (
    options.coreToolNames?.has(tool.name) &&
    analysis.intents.includes("web-research") &&
    (tool.name === "WebSearch" || tool.name === "WebFetch")
  ) {
    score += 100;
    addReason(reasons, "core web tool");
  }
  return { score, reasons };
}

function scoreUsageSignals(
  usage: ToolUsageStats["tools"][string] | undefined,
  intents: string[]
): { score: number; reasons: string[] } {
  if (!usage) {
    return { score: 0, reasons: [] };
  }
  let score = 0;
  const reasons: string[] = [];
  let hasIntentScore = false;
  for (const intent of intents) {
    const record = usage.intents[intent];
    const intentScore = toolUsageScore(record);
    if (intentScore === 0) {
      continue;
    }
    hasIntentScore = true;
    score += intentScore;
    const reason = formatToolUsageReason(record, intent);
    if (reason) {
      reasons.push(reason);
    }
  }
  if (!hasIntentScore) {
    score += toolUsageScore(usage);
  }
  const recoveryIntent = intents[0];
  const globalReason = formatToolUsageReason(usage, undefined, recoveryIntent);
  if (globalReason && toolUsageScore(usage) !== 0) {
    reasons.push(globalReason);
  }
  return { score, reasons };
}

function analyzeToolSearchQuery(query: string): ToolSearchAnalysis {
  const normalizedQuery = normalizeText(query);
  const terms = tokenizeToolText(query);
  const expandedTerms = Array.from(
    new Set([...expandTerms(terms), ...expandChineseQueryTerms(query)])
  );
  let intents = INTENT_PROFILES.filter((profile) =>
    matchesIntent(profile, query, normalizedQuery, terms)
  ).map((profile) => profile.name);
  if (intents.includes("cron-management") && intents.includes("planning-state")) {
    intents = intents.filter((intent) => intent !== "planning-state");
  }
  return { terms, expandedTerms, normalizedQuery, intents };
}

function matchesIntent(
  profile: ToolIntentProfile,
  rawQuery: string,
  normalizedQuery: string,
  terms: string[]
): boolean {
  const termSet = new Set(terms);
  if (profile.triggers.some((trigger) => termSet.has(trigger))) return true;
  const haystacks = [rawQuery.toLowerCase(), normalizedQuery];
  return (profile.phrases ?? []).some((phrase) =>
    haystacks.some((haystack) => haystack.includes(phrase.toLowerCase()))
  );
}

function expandTerms(terms: string[]): string[] {
  const expanded = new Set<string>();
  for (const term of terms) {
    expanded.add(term);
    for (const alias of TERM_ALIASES[term] ?? []) {
      expanded.add(alias);
    }
    for (const alias of ENGLISH_TYPO_ALIASES[term] ?? []) {
      expanded.add(alias);
    }
  }
  return Array.from(expanded);
}

/** Map common Chinese task phrases to English ToolSearch terms. Longest phrases first. */
function expandChineseQueryTerms(query: string): string[] {
  const expanded = new Set<string>();
  const lower = query.toLowerCase();
  for (const [phrase, aliases] of CHINESE_PHRASE_ALIASES) {
    if (!lower.includes(phrase)) {
      continue;
    }
    for (const alias of aliases) {
      expanded.add(alias);
    }
  }
  return Array.from(expanded);
}

function tokenizeToolText(text: string): string[] {
  return Array.from(
    new Set(
      splitCamelCase(text)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_-]+/gu, " ")
        .split(/\s+/)
        .map((term) => term.trim())
        .filter((term) => isSignificantToken(term) && !STOPWORDS.has(term))
    )
  );
}

function isSignificantToken(term: string): boolean {
  if (term.length > 1) {
    return true;
  }
  return /\p{Script=Han}/u.test(term);
}

function tokenizeSchema(schema: Record<string, unknown>): string[] {
  return tokenizeToolText(JSON.stringify(schema));
}

function normalizeText(text: string): string {
  return tokenizeToolText(text).join(" ");
}

function splitCamelCase(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

function addReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

function formatMatchReasons(reasons: string[]): string {
  if (reasons.length === 0) {
    return "lexical";
  }
  const visible = reasons.slice(0, 4);
  const usage = reasons.find((reason) => reason.startsWith("usage:"));
  if (usage && !visible.includes(usage)) {
    visible[visible.length - 1] = usage;
  }
  return visible.join("; ");
}

function formatSelectedTool(tool: ToolSearchableRecord): string {
  return [
    `Tool: ${tool.name}`,
    `Category: ${tool.category ?? "uncategorized"}`,
    `Description: ${tool.description ?? "No description"}`,
    `Read-only: ${tool.isReadOnly({}) ? "yes" : "depends on input or mode"}`,
    `Destructive: ${tool.isDestructive({}) ? "yes" : "no"}`,
    `Concurrency-safe: ${tool.isConcurrencySafe({}) ? "yes" : "no"}`,
    `Tags: ${(tool.tags ?? []).join(", ") || "none"}`,
    "Input schema:",
    JSON.stringify(tool.inputSchema, null, 2)
  ].join("\n");
}

function formatSelectedPack(
  packName: string,
  tools: ToolSearchableRecord[],
  options: ToolSearchOptions
): string {
  const requested = resolvePackToolNames(packName);
  if (requested.length === 0) {
    throw new Error(
      `Unknown tool pack: ${packName}. Available packs: ${listToolPackNames().join(", ")}`
    );
  }
  const available = requested.filter((name) => tools.some((tool) => tool.name === name));
  if (available.length === 0) {
    throw new Error(`Tool pack ${packName} has no registered tools`);
  }
  recordToolSearchContext({
    stateRoot: options.stateRoot,
    query: `pack:${packName}`,
    intents: ["pack"],
    toolNames: available
  });
  return [
    `Pack: ${packName}`,
    `Tools: ${available.join(", ")}`,
    `Loaded ${available.length} tools for upcoming turns.`,
    "",
    ...available.map((name) => {
      const tool = tools.find((item) => item.name === name);
      return tool ? `- ${tool.name}: ${tool.description ?? "No description"}` : `- ${name}`;
    })
  ].join("\n");
}

export function formatDeferredToolCatalog(
  tools: ToolSearchableRecord[],
  coreToolNames?: ReadonlySet<string>
): string {
  const deferred = tools.filter((tool) => !coreToolNames?.has(tool.name));
  if (deferred.length === 0) {
    return "No deferred tools are available.";
  }
  const byCategory = new Map<string, ToolSearchableRecord[]>();
  for (const tool of deferred) {
    const category = tool.category ?? "uncategorized";
    const bucket = byCategory.get(category) ?? [];
    bucket.push(tool);
    byCategory.set(category, bucket);
  }
  const lines = [
    `Deferred tools discoverable via ToolSearch (${deferred.length}):`,
    ...[...byCategory.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([category, items]) => {
        const names = items
          .map((tool) => tool.name)
          .sort((left, right) => left.localeCompare(right));
        return `- ${category}: ${names.join(", ")}`;
      }),
    "",
    "Use query select:<tool_name> for a tool's full schema, or search by topic keyword."
  ];
  return lines.join("\n");
}

function schemaSummary(schema: Record<string, unknown>): string {
  const properties = isRecord(schema.properties) ? Object.keys(schema.properties) : [];
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item) => typeof item === "string")
    : [];
  return `required=[${required.join(", ")}] properties=[${properties.join(", ")}]`;
}

function readMaxResults(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 20) {
    throw new Error("Tool input max_results must be an integer from 1 to 20");
  }
  return value;
}

function readNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Tool input ${label} must be a non-empty string`);
  }
  return value.trim();
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown field: ${unknown[0]}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TERM_ALIASES: Record<string, string[]> = {
  apply: ["patch", "edit", "write"],
  approval: ["question", "plan"],
  artifact: ["file", "output"],
  automate: ["browser", "web", "playwright"],
  automation: ["browser", "web", "playwright"],
  background: ["task", "agent"],
  benchmark: ["verify", "test"],
  browse: ["browser", "web", "fetch"],
  browser: ["web", "playwright"],
  build: ["verify", "test"],
  change: ["edit", "patch", "write"],
  cli: ["shell", "bash", "command"],
  code: ["file", "lsp", "search"],
  command: ["bash", "shell"],
  context: ["session", "memory"],
  diff: ["patch", "git"],
  docs: ["documentation", "schema", "tool"],
  edit: ["patch", "file", "write"],
  e2e: ["verify", "test"],
  export: ["archive", "package"],
  fetch: ["web", "browser"],
  file: ["workspace"],
  fix: ["patch", "edit"],
  history: ["session", "recall"],
  inspect: ["diagnostics", "read", "search"],
  issue: ["github"],
  javascript: ["typescript", "lsp"],
  js: ["typescript", "lsp"],
  learn: ["learning", "memory"],
  locate: ["search", "grep", "glob"],
  logs: ["session", "history"],
  memory: ["recall", "graph", "learning"],
  modify: ["patch", "edit", "write"],
  multi: ["agent", "parallel"],
  open: ["browser", "web", "fetch"],
  page: ["browser", "web"],
  package: ["archive", "zip"],
  parallel: ["agent", "subagent"],
  patch: ["edit", "diff", "file"],
  plan: ["todo", "state"],
  playwright: ["browser", "automation"],
  pr: ["github"],
  previous: ["session", "history", "recall"],
  read: ["file", "fetch"],
  recall: ["memory", "session"],
  refactor: ["patch", "edit", "lsp"],
  remember: ["memory", "memorize", "persist"],
  replace: ["correct", "supersede"],
  remote: ["ssh"],
  research: ["search", "web", "agent"],
  run: ["execute"],
  schema: ["tool", "docs"],
  search: ["grep", "glob", "web"],
  shell: ["bash", "command"],
  symbol: ["lsp", "typescript"],
  test: ["verify", "build"],
  tests: ["verify", "build"],
  tool: ["schema", "docs"],
  typescript: ["lsp", "symbol"],
  ui: ["browser", "screenshot"],
  verify: ["test", "build"],
  verification: ["verify", "test", "build"],
  web: ["browser", "fetch", "search"],
  wrong: ["correct", "dispute", "supersede"],
  workflow: ["learning", "memory"],
  zip: ["archive", "package"],
  capabilities: ["tool", "search", "list"],
  ability: ["tool", "capability"],
  internet: ["web", "search", "fetch"],
  online: ["web", "search", "fetch"],
  联网: ["web", "search"],
  搜索: ["web", "search", "grep"],
  修改: ["edit", "patch", "modify", "file"],
  编辑: ["edit", "patch", "file"],
  写入: ["write", "file"],
  覆盖: ["write", "overwrite", "file"],
  文件: ["file", "write", "edit"],
  删除: ["delete", "file", "remove"],
  删: ["delete", "file", "remove"],
  复制: ["copy", "file"],
  移动: ["move", "file"],
  工具: ["tool", "search", "capabilities"],
  记住: ["remember", "memorize", "memory", "persist"],
  记忆: ["memory", "memorize", "recall"],
  偏好: ["preference", "memory", "memorize"],
  待办: ["todo", "task", "plan"],
  提交: ["commit", "git", "log"],
  历史: ["history", "log", "session"],
  分支: ["branch", "git"],
  计划: ["plan", "todo", "task"],
  任务: ["task", "todo"],
  创建: ["create", "write"],
  查找: ["search", "grep", "glob", "find"],
  匹配: ["glob", "pattern", "grep", "find"],
  测试: ["test", "verify", "build"],
  浏览器: ["browser", "web", "automation"],
  远程: ["ssh", "remote"],
  定时: ["cron", "schedule"],
  技能: ["skill", "learning", "workflow"],
  聊过: ["session", "history", "recall", "search"],
  之前: ["session", "history", "previous", "recall"],
  搜: ["search", "grep", "glob", "web"],
  记: ["remember", "memory", "memorize"],
  查: ["search", "grep", "find", "git", "web"],
  改: ["edit", "patch", "modify", "file"],
  搞: ["create", "branch", "git", "run"],
  撸: ["test", "verify", "run", "build"],
  截: ["screenshot", "snip", "browser"],
  图: ["screenshot", "snip", "image"],
  树: ["tree", "directory", "list"],
  盘: ["disk", "usage", "space"],
  杀: ["kill", "process"],
  进程: ["process", "kill", "monitor"],
  只读: ["read", "file"],
  代码: ["code", "grep", "lsp", "file"],
  函数: ["function", "symbol", "lsp", "grep"],
  回滚: ["reset", "git", "revert"],
  暂存: ["stash", "git", "stage"],
  评论: ["comment", "issue", "pr", "github"],
  详情: ["view", "issue", "pr", "github"],
  笔记: ["learning", "draft", "notebook"],
  目录: ["tree", "directory", "list", "glob"],
  空间: ["disk", "usage", "space"],
  监控: ["monitor", "process", "task"],
  请求: ["http", "request", "api"],
  解码: ["base64", "decode"],
  解析: ["json", "query", "parse"]
};

const ENGLISH_TYPO_ALIASES: Record<string, string[]> = {
  serch: ["search", "web", "grep"],
  editt: ["edit", "file", "patch"],
  serach: ["search", "web", "grep"],
  commmit: ["commit", "git"],
  brach: ["branch", "git"],
  commt: ["commit", "git"]
};

/** Longest phrases first so compound matches win over shorter prefixes. */
const CHINESE_PHRASE_ALIASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["修改文件内容", ["edit", "patch", "file", "modify", "write"]],
  ["编辑文件", ["edit", "patch", "file", "write"]],
  ["修改文件", ["edit", "patch", "file", "modify", "write"]],
  ["改一下", ["edit", "patch", "file", "modify"]],
  ["写文件", ["write", "file"]],
  ["新建文件", ["write", "file"]],
  ["新建一个文件", ["write", "file", "create"]],
  ["新建一个", ["write", "file", "create"]],
  ["写入文件", ["write", "file"]],
  ["应用补丁", ["patch", "edit", "file"]],
  ["打补丁", ["patch", "edit", "file"]],
  ["覆盖写入", ["write", "file", "overwrite"]],
  ["删文件", ["delete", "file", "remove"]],
  ["删除文件", ["delete", "file", "remove"]],
  ["复制文件", ["copy", "file"]],
  ["复制文件到", ["copy", "file", "move"]],
  ["复制到目录", ["copy", "file", "move", "directory"]],
  ["移动文件", ["move", "file"]],
  ["有什么工具可以用", ["tool", "capabilities", "search", "list"]],
  ["什么工具可以用", ["tool", "capabilities", "search", "list"]],
  ["有哪些工具", ["tool", "capabilities", "search", "list"]],
  ["看看之前聊过什么", ["session", "history", "recall", "search", "previous"]],
  ["之前聊过什么", ["session", "history", "recall", "search", "previous"]],
  ["聊过什么", ["session", "history", "recall", "search"]],
  ["记住这个偏好", ["remember", "memory", "memorize", "preference", "persist"]],
  ["记住这个", ["remember", "memory", "memorize", "persist"]],
  ["以后记得", ["remember", "memory", "memorize", "persist"]],
  ["保存偏好", ["remember", "memory", "preference", "memorize"]],
  ["纠正记忆", ["correct", "memory", "dispute", "supersede"]],
  ["纠正之前的记忆", ["correct", "memory", "dispute", "supersede"]],
  ["之前的记忆", ["correct", "memory", "recall", "session"]],
  ["记忆不对", ["correct", "memory", "dispute", "supersede"]],
  ["记忆错了", ["correct", "memory", "dispute", "supersede"]],
  ["查看提交历史", ["git", "log", "commit", "history"]],
  ["提交历史", ["git", "log", "commit", "history"]],
  ["git提交", ["git", "log", "commit"]],
  ["创建分支", ["branch", "git", "create"]],
  ["创建新分支", ["branch", "git", "create"]],
  ["新建分支", ["branch", "git", "create"]],
  ["创建待办", ["todo", "task", "plan", "create"]],
  ["待办任务", ["todo", "task", "plan"]],
  ["待办事项", ["todo", "task", "plan"]],
  ["计划模式", ["plan", "todo", "enter"]],
  ["搜索文件", ["search", "grep", "glob", "file"]],
  ["搜索代码", ["grep", "search", "code", "glob"]],
  ["代码搜索", ["grep", "search", "code", "glob"]],
  ["查找文件", ["search", "grep", "glob", "file", "find"]],
  ["找文件", ["search", "glob", "grep", "file", "find"]],
  ["列出文件", ["glob", "list", "file", "find"]],
  ["查找匹配", ["search", "glob", "grep", "pattern", "file", "find"]],
  ["匹配文件", ["glob", "pattern", "grep", "file", "find"]],
  ["联网搜索", ["web", "search", "fetch"]],
  ["上网搜索", ["web", "search", "fetch"]],
  ["打开网页", ["web", "browser", "fetch", "page"]],
  ["浏览器自动化", ["browser", "automation", "playwright"]],
  ["点击按钮", ["browser", "click", "automation"]],
  ["运行测试", ["test", "verify", "build"]],
  ["跑测试", ["test", "verify", "build"]],
  ["typescript定义", ["typescript", "lsp", "definition", "symbol"]],
  ["符号引用", ["lsp", "typescript", "reference", "symbol"]],
  ["远程服务器", ["ssh", "remote", "exec"]],
  ["定时任务", ["cron", "schedule"]],
  ["创建工作流技能", ["skill", "learning", "workflow"]],
  ["学习技能", ["skill", "learning", "workflow"]],
  ["并行子任务", ["agent", "parallel", "subagent"]],
  ["子代理", ["agent", "subagent", "parallel"]],
  ["改下代码", ["edit", "patch", "code", "file"]],
  ["改代码", ["edit", "patch", "code", "file"]],
  ["搜一下", ["search", "grep", "glob", "find"]],
  ["搜一下这个函数", ["grep", "lsp", "search", "symbol", "function"]],
  ["函数在哪", ["grep", "lsp", "search", "symbol", "find"]],
  ["搞个新分支", ["branch", "git", "create"]],
  ["搞个分支", ["branch", "git", "create"]],
  ["stash一下", ["stash", "git"]],
  ["stash 一下", ["stash", "git"]],
  ["回滚commit", ["reset", "git", "revert", "checkout"]],
  ["回滚 commit", ["reset", "git", "revert", "checkout"]],
  ["撸个测试", ["test", "verify", "build", "run"]],
  ["跑个测试", ["test", "verify", "build", "run"]],
  ["fix bug", ["patch", "edit", "fix", "grep"]],
  ["查看目录树", ["tree", "directory", "list", "glob"]],
  ["目录树结构", ["tree", "directory", "list", "glob"]],
  ["截个图", ["screenshot", "snip", "browser"]],
  ["截图", ["screenshot", "snip", "browser"]],
  ["后台监控", ["monitor", "process", "task", "output"]],
  ["监控进程", ["monitor", "process", "kill"]],
  ["http请求", ["http", "request", "api"]],
  ["发http请求", ["http", "request", "api"]],
  ["调api", ["http", "request", "api"]],
  ["learning笔记", ["learning", "draft", "memory"]],
  ["learning 笔记", ["learning", "draft", "memory"]],
  ["worktree", ["worktree", "git", "branch"]],
  ["进worktree", ["worktree", "enter", "git"]],
  ["磁盘空间", ["disk", "usage", "space"]],
  ["还剩多少空间", ["disk", "usage", "space"]],
  ["kill进程", ["kill", "process"]],
  ["kill 掉", ["kill", "process"]],
  ["列出cron", ["cron", "list", "schedule"]],
  ["列出 cron", ["cron", "list", "schedule"]],
  ["cron任务", ["cron", "list", "schedule"]],
  ["notebook单元格", ["notebook", "read", "edit"]],
  ["读notebook", ["notebook", "read"]],
  ["peer列表", ["peer", "list"]],
  ["帮我查一下", ["search", "grep", "find", "web"]],
  ["查一下", ["search", "grep", "find", "web"]],
  ["搜索web并记住", ["web", "search", "memorize", "memory"]],
  ["git pr评论", ["github", "pr", "view", "issue"]],
  ["pr评论", ["github", "pr", "view", "comment"]],
  ["issue详情", ["github", "issue", "view"]],
  ["记住偏好", ["remember", "memory", "preference", "memorize"]],
  ["只读看看", ["read", "file"]],
  ["只读看看文件", ["read", "file"]],
  ["不要改文件", ["grep", "glob", "search", "read"]],
  ["先搜索", ["grep", "glob", "search", "find"]],
  ["decode base64", ["base64", "decode"]],
  ["base64字符串", ["base64", "decode", "encode"]],
  ["json path", ["json", "query", "parse"]],
  ["parse json", ["json", "query", "parse"]],
  ["playwright打开", ["browser", "playwright", "automation"]],
  ["用playwright", ["browser", "playwright", "automation"]],
  ["处理一下", ["agent", "bash", "patch", "tool", "search"]],
  ["帮我处理", ["agent", "bash", "patch", "tool"]]
];

const INTENT_PROFILES: ToolIntentProfile[] = [
  {
    name: "capability-inquiry",
    triggers: ["capabilities", "capability", "abilities", "ability", "support", "available"],
    phrases: [
      "can you",
      "do you have",
      "what tools",
      "what can you",
      "are you able",
      "能不能",
      "有没有",
      "可以联网",
      "联网搜索",
      "有什么能力",
      "能做什么",
      "有什么工具",
      "什么工具可以用",
      "有哪些工具"
    ],
    categories: ["tools", "web", "agent", "git", "github", "shell", "memory", "skills"],
    tags: ["tool", "web", "browser", "agent", "git", "search"],
    toolBoosts: {
      WebSearch: 120,
      WebFetch: 110,
      WebBrowser: 105,
      Browser: 100,
      Agent: 95,
      HttpRequest: 85,
      LSP: 80,
      CronCreate: 75
    }
  },
  {
    name: "tool-discovery",
    triggers: ["工具"],
    phrases: ["有什么工具", "什么工具可以用", "有哪些工具", "what tools", "list tools"],
    categories: ["tools"],
    tags: ["tool", "search", "schema", "docs"],
    toolBoosts: { ToolSearch: 260, DiscoverSkills: 60, Config: 40 }
  },
  {
    name: "file-edit",
    triggers: ["patch", "edit", "modify", "change", "refactor", "fix", "修改", "编辑", "写入"],
    phrases: [
      "修改文件",
      "编辑文件",
      "改文件",
      "写文件",
      "新建文件",
      "应用补丁",
      "打补丁",
      "改一下",
      "新建一个文件",
      "新建文件",
      "覆盖写入"
    ],
    categories: ["files"],
    tags: ["patch", "edit", "write", "file"],
    toolBoosts: { FilePatch: 180, FileEdit: 120, FileWrite: 90, NotebookEdit: 50 }
  },
  {
    name: "file-write",
    triggers: ["write", "overwrite", "覆盖", "写入"],
    phrases: [
      "覆盖写入",
      "写入文件",
      "写文件",
      "新建文件",
      "新建一个文件",
      "write file",
      "overwrite"
    ],
    categories: ["files"],
    tags: ["write", "file"],
    toolBoosts: { FileWrite: 260, FileEdit: 70, FilePatch: 40, NotebookEdit: 40 }
  },
  {
    name: "file-management",
    triggers: ["delete", "copy", "move", "remove", "删", "删除", "复制", "移动"],
    phrases: ["删文件", "删除文件", "复制文件", "移动文件", "复制到", "复制到目录"],
    categories: ["files"],
    tags: ["delete", "copy", "move", "file"],
    toolBoosts: { FileDelete: 220, FileCopy: 210, FileMove: 200, FileWrite: 40, FilePatch: 20 }
  },
  {
    name: "archive-management",
    triggers: ["archive", "zip", "tar", "compress", "package", "export"],
    phrases: ["release archive", "create archive", "zip release"],
    categories: ["files"],
    tags: ["archive", "zip", "tar", "compress"],
    toolBoosts: { ArchiveCreate: 190, ArchiveExtract: 70 }
  },
  {
    name: "workspace-search",
    triggers: ["search", "grep", "glob", "find", "locate", "查找", "搜索", "匹配"],
    phrases: [
      "搜索文件",
      "查找文件",
      "找文件",
      "列出文件",
      "匹配文件",
      "文件匹配",
      "查找匹配",
      "搜索代码",
      "代码搜索",
      "不要改文件",
      "先搜索"
    ],
    categories: ["search", "workspace"],
    tags: ["grep", "glob", "find", "workspace"],
    toolBoosts: { Grep: 160, Glob: 120, FileFind: 90, WorkspaceDiagnostics: 55 }
  },
  {
    name: "web-research",
    triggers: ["web", "browser", "browse", "fetch", "http", "research", "page"],
    phrases: ["search the web", "can you search the web", "serch the web", "look up online"],
    categories: ["web"],
    tags: ["web", "browser", "fetch", "search", "http"],
    toolBoosts: { WebSearch: 200, WebFetch: 135, WebBrowser: 90, Browser: 85, HttpRequest: 70 }
  },
  {
    name: "browser-automation",
    triggers: ["browser", "playwright", "automation", "automate", "ui", "page"],
    phrases: [
      "click button",
      "fill form",
      "take screenshot",
      "截个图",
      "截图",
      "用playwright",
      "playwright打开"
    ],
    categories: ["web"],
    tags: ["browser", "automation", "playwright", "screenshot"],
    toolBoosts: { Browser: 190, WebBrowser: 60, Snip: 120 }
  },
  {
    name: "file-read",
    triggers: ["read", "只读"],
    phrases: ["只读看看", "read only", "先看看文件"],
    categories: ["files"],
    tags: ["read", "file"],
    toolBoosts: { FileRead: 240, Grep: 80, Glob: 70, FilePatch: 10, FileWrite: 5 }
  },
  {
    name: "http-api",
    triggers: ["http", "api", "request", "请求"],
    phrases: ["发 http", "调 api", "http 请求", "发http请求", "调api"],
    categories: ["web"],
    tags: ["http", "request", "api"],
    toolBoosts: { HttpRequest: 240, WebFetch: 60, WebSearch: 20 }
  },
  {
    name: "data-encoding",
    triggers: ["base64", "json", "decode", "parse", "解码", "解析"],
    phrases: ["decode base64", "base64 字符串", "json path", "parse json"],
    categories: ["files"],
    tags: ["base64", "json", "query"],
    toolBoosts: { Base64: 230, JsonQuery: 220, TextStats: 40 }
  },
  {
    name: "system-diagnostics",
    triggers: ["disk", "process", "system", "whoami", "盘", "进程", "监控"],
    phrases: ["磁盘空间", "还剩多少空间", "kill 进程", "who am i", "磁盘还剩"],
    categories: ["shell", "workspace"],
    tags: ["disk", "process", "system", "monitor"],
    toolBoosts: {
      DiskUsage: 220,
      SystemInfo: 180,
      WhoAmI: 170,
      KillProcess: 200,
      ProcessList: 150,
      Monitor: 140
    }
  },
  {
    name: "notebook-tools",
    triggers: ["notebook", "单元格"],
    phrases: ["读 notebook", "notebook 单元格", "notebook单元格"],
    categories: ["files"],
    tags: ["notebook"],
    toolBoosts: { NotebookRead: 230, NotebookEdit: 180 }
  },
  {
    name: "directory-tree",
    triggers: ["tree", "目录", "树"],
    phrases: ["目录树", "查看目录树", "目录树结构", "tree view"],
    categories: ["files", "workspace"],
    tags: ["tree", "directory", "list"],
    toolBoosts: { TreeView: 230, DirList: 120, Glob: 80 }
  },
  {
    name: "git-advanced",
    triggers: ["stash", "reset", "revert", "回滚", "暂存"],
    phrases: ["stash 一下", "回滚 commit", "git stash", "git reset"],
    categories: ["git"],
    tags: ["git", "stash", "reset"],
    toolBoosts: { GitStash: 230, GitReset: 220, GitCheckout: 100, GitLog: 40 }
  },
  {
    name: "github-detail",
    triggers: ["issue", "pr", "评论", "详情"],
    phrases: ["issue 详情", "pr 评论", "git pr 评论", "pr评论"],
    categories: ["github"],
    tags: ["github", "issue", "pr"],
    toolBoosts: {
      GitHubIssueView: 220,
      GitHubPRView: 210,
      GitHubPRDiff: 80,
      GitHubPRList: 60
    }
  },
  {
    name: "worktree-flow",
    triggers: ["worktree"],
    phrases: ["进 worktree", "enter worktree", "worktree 改代码"],
    categories: ["git"],
    tags: ["worktree", "git"],
    toolBoosts: { EnterWorktree: 240, ExitWorktree: 120, GitCheckout: 80 }
  },
  {
    name: "cron-management",
    triggers: ["cron", "定时"],
    phrases: ["列出 cron", "cron 任务", "cron任务", "定时任务列表", "列出 cron 任务"],
    categories: ["schedule"],
    tags: ["cron", "schedule"],
    toolBoosts: { CronList: 280, CronCreate: 80, CronUpdate: 70, CronDelete: 60 }
  },
  {
    name: "peer-network",
    triggers: ["peer"],
    phrases: ["peer 列表", "peer列表", "list peers"],
    categories: ["remote"],
    tags: ["peer", "network"],
    toolBoosts: { ListPeers: 240, NetworkCheck: 80 }
  },
  {
    name: "generic-lookup",
    triggers: ["查", "搜"],
    phrases: ["帮我查一下", "查一下", "搜一下", "帮我搜一下"],
    categories: ["search", "web", "tools"],
    tags: ["search", "grep", "find"],
    toolBoosts: { Grep: 140, Glob: 120, ToolSearch: 100, WebSearch: 90, LSP: 70 }
  },
  {
    name: "memory-write",
    triggers: ["remember", "memorize", "persist", "记住", "记忆", "偏好"],
    phrases: [
      "future sessions",
      "durable memory",
      "write memory",
      "记住这个",
      "以后记得",
      "保存偏好"
    ],
    categories: ["memory"],
    tags: ["memory", "persist", "graph"],
    toolBoosts: { Memorize: 260, LearningDraft: 90, SessionSearch: 45 }
  },
  {
    name: "memory-correction",
    triggers: ["correct", "wrong", "outdated", "replace", "dispute", "supersede", "incorrect"],
    phrases: [
      "memory is wrong",
      "not true anymore",
      "replace memory",
      "纠正记忆",
      "记忆不对",
      "纠正之前的记忆"
    ],
    categories: ["memory"],
    tags: ["memory", "correct", "dispute", "supersede", "graph"],
    toolBoosts: { MemoryCorrect: 300, Memorize: 95, SessionSearch: 70 }
  },
  {
    name: "memory-recall",
    triggers: ["memory", "recall", "history", "previous", "聊过", "之前"],
    phrases: ["看看之前聊过什么", "之前聊过什么", "聊过什么", "之前的对话", "历史会话"],
    categories: ["memory"],
    tags: ["memory", "session", "history", "recall", "learning"],
    toolBoosts: { SessionSearch: 180, Memorize: 120, MemoryCorrect: 100, LearningDraft: 90 }
  },
  {
    name: "skill-learning",
    triggers: ["skill", "learning", "learn", "workflow", "笔记"],
    phrases: ["learning 笔记", "learning笔记", "draft 笔记"],
    categories: ["skills", "memory"],
    tags: ["skill", "learning", "workflow", "draft"],
    toolBoosts: { Skill: 150, SkillManage: 120, LearningDraft: 160 }
  },
  {
    name: "verification",
    triggers: ["verify", "verification", "test", "tests", "build", "benchmark", "e2e"],
    phrases: [
      "run test",
      "run tests",
      "verification tests",
      "focused verification",
      "撸个测试",
      "跑个测试"
    ],
    categories: ["verification", "shell"],
    tags: ["verify", "test", "build", "bash"],
    toolBoosts: { VerifyPlanExecution: 220, Bash: 80, WorkspaceDiagnostics: 80 }
  },
  {
    name: "typescript-symbols",
    triggers: ["typescript", "javascript", "symbol", "definition", "reference", "hover", "lsp"],
    categories: ["lsp"],
    tags: ["lsp", "typescript", "symbols", "references"],
    toolBoosts: { LSP: 200, Grep: 45 }
  },
  {
    name: "git-workflow",
    triggers: ["git", "diff", "commit", "branch", "pr", "issue", "github", "提交", "分支"],
    phrases: ["提交历史", "查看提交", "git diff", "暂存区", "创建分支", "新建分支", "创建新分支"],
    categories: ["git", "github"],
    tags: ["git", "github", "diff", "branch", "pr", "issue"],
    toolBoosts: {
      GitDiff: 120,
      GitStatus: 105,
      GitLog: 130,
      GitShow: 75,
      GitHubPRDiff: 115,
      GitHubIssueView: 80
    }
  },
  {
    name: "github-pr-diff",
    triggers: [],
    phrases: ["pr diff", "查看 pr diff", "pull request diff", "github pr diff"],
    categories: ["github"],
    tags: ["github", "pr", "diff"],
    toolBoosts: { GitHubPRDiff: 300, GitHubPRView: 120, GitDiff: 40 }
  },
  {
    name: "planning-state",
    triggers: ["plan", "todo", "task", "progress", "state", "待办", "计划", "任务"],
    phrases: ["待办任务", "待办事项", "创建待办", "计划模式", "任务进度"],
    categories: ["state", "planning"],
    tags: ["todo", "task", "plan", "progress"],
    toolBoosts: { TodoWrite: 210, TaskCreate: 85, TaskUpdate: 95, EnterPlanMode: 80 }
  },
  {
    name: "shell-command",
    triggers: ["bash", "shell", "command", "cli"],
    categories: ["shell"],
    tags: ["bash", "command", "terminal"],
    toolBoosts: { Bash: 150, Which: 50 }
  },
  {
    name: "parallel-agent",
    triggers: ["agent", "subagent", "parallel", "multi", "background"],
    categories: ["agent", "state"],
    tags: ["agent", "subagent", "parallel", "task"],
    toolBoosts: { Agent: 160, TaskCreate: 70, TaskGet: 55 }
  },
  {
    name: "vague-action",
    triggers: ["处理"],
    phrases: ["处理一下", "帮我处理", "handle this"],
    categories: ["agent", "shell", "tools"],
    tags: ["agent", "bash", "tool"],
    toolBoosts: { Agent: 180, Bash: 160, ToolSearch: 140, FilePatch: 100 }
  }
];

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "for",
  "from",
  "how",
  "in",
  "into",
  "is",
  "me",
  "my",
  "of",
  "on",
  "or",
  "please",
  "the",
  "this",
  "to",
  "with"
]);
