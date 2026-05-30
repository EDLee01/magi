import {
  formatToolUsageReason,
  recordToolSearchContext,
  ToolUsageStats,
  toolUsageScore
} from "../tool-usage-stats.js";

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
  const select = /^select:(.+)$/i.exec(input.query.trim());
  if (select) {
    const requested = select[1].trim();
    const tool = tools.find((item) => item.name.toLowerCase() === requested.toLowerCase());
    if (!tool) {
      throw new Error(`Tool not found: ${requested}`);
    }
    return formatSelectedTool(tool);
  }

  const analysis = analyzeToolSearchQuery(input.query);
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
    "Use query select:<tool_name> for the full schema."
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
  const expandedTerms = expandTerms(terms);
  const intents = INTENT_PROFILES.filter((profile) =>
    matchesIntent(profile, normalizedQuery, terms)
  ).map((profile) => profile.name);
  return { terms, expandedTerms, normalizedQuery, intents };
}

function matchesIntent(
  profile: ToolIntentProfile,
  normalizedQuery: string,
  terms: string[]
): boolean {
  const termSet = new Set(terms);
  if (profile.triggers.some((trigger) => termSet.has(trigger))) return true;
  return (profile.phrases ?? []).some((phrase) => normalizedQuery.includes(phrase));
}

function expandTerms(terms: string[]): string[] {
  const expanded = new Set<string>();
  for (const term of terms) {
    expanded.add(term);
    for (const alias of TERM_ALIASES[term] ?? []) {
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
        .filter((term) => term.length > 1 && !STOPWORDS.has(term))
    )
  );
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
  zip: ["archive", "package"]
};

const INTENT_PROFILES: ToolIntentProfile[] = [
  {
    name: "file-edit",
    triggers: ["patch", "edit", "modify", "change", "refactor", "fix"],
    categories: ["files"],
    tags: ["patch", "edit", "write", "file"],
    toolBoosts: { FilePatch: 180, FileEdit: 120, FileWrite: 70, NotebookEdit: 50 }
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
    triggers: ["search", "grep", "glob", "find", "locate"],
    categories: ["search", "workspace"],
    tags: ["grep", "glob", "find", "workspace"],
    toolBoosts: { Grep: 160, Glob: 120, FileFind: 90, WorkspaceDiagnostics: 55 }
  },
  {
    name: "web-research",
    triggers: ["web", "browser", "browse", "fetch", "http", "research", "page"],
    categories: ["web"],
    tags: ["web", "browser", "fetch", "search", "http"],
    toolBoosts: { WebSearch: 160, WebFetch: 135, WebBrowser: 115, Browser: 85, HttpRequest: 70 }
  },
  {
    name: "browser-automation",
    triggers: ["browser", "playwright", "automation", "automate", "ui", "page"],
    phrases: ["click button", "fill form", "take screenshot"],
    categories: ["web"],
    tags: ["browser", "automation", "playwright", "screenshot"],
    toolBoosts: { Browser: 190, WebBrowser: 60, Snip: 45 }
  },
  {
    name: "memory-write",
    triggers: ["remember", "memorize", "persist"],
    phrases: ["future sessions", "durable memory", "write memory"],
    categories: ["memory"],
    tags: ["memory", "persist", "graph"],
    toolBoosts: { Memorize: 260, LearningDraft: 90, SessionSearch: 45 }
  },
  {
    name: "memory-correction",
    triggers: ["correct", "wrong", "outdated", "replace", "dispute", "supersede", "incorrect"],
    phrases: ["memory is wrong", "not true anymore", "replace memory", "纠正记忆", "记忆不对"],
    categories: ["memory"],
    tags: ["memory", "correct", "dispute", "supersede", "graph"],
    toolBoosts: { MemoryCorrect: 300, Memorize: 95, SessionSearch: 70 }
  },
  {
    name: "memory-recall",
    triggers: ["memory", "recall", "history", "previous"],
    categories: ["memory"],
    tags: ["memory", "session", "history", "recall", "learning"],
    toolBoosts: { SessionSearch: 150, Memorize: 120, MemoryCorrect: 100, LearningDraft: 90 }
  },
  {
    name: "skill-learning",
    triggers: ["skill", "learning", "learn", "workflow"],
    categories: ["skills", "memory"],
    tags: ["skill", "learning", "workflow", "draft"],
    toolBoosts: { Skill: 150, SkillManage: 120, LearningDraft: 110 }
  },
  {
    name: "verification",
    triggers: ["verify", "verification", "test", "tests", "build", "benchmark", "e2e"],
    phrases: ["run test", "run tests", "verification tests", "focused verification"],
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
    triggers: ["git", "diff", "commit", "branch", "pr", "issue", "github"],
    categories: ["git", "github"],
    tags: ["git", "github", "diff", "branch", "pr", "issue"],
    toolBoosts: {
      GitDiff: 120,
      GitStatus: 105,
      GitLog: 85,
      GitShow: 75,
      GitHubPRDiff: 115,
      GitHubIssueView: 80
    }
  },
  {
    name: "planning-state",
    triggers: ["plan", "todo", "task", "progress", "state"],
    categories: ["state", "planning"],
    tags: ["todo", "task", "plan", "progress"],
    toolBoosts: { TodoWrite: 145, TaskCreate: 105, TaskUpdate: 95, EnterPlanMode: 80 }
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
