import path from "node:path";

import type { MemoryNode, MemoryNodeType } from "../memory-node-store.js";
import { textMessage, type ProviderAdapter, type ProviderUsage } from "../providers/ir.js";
import type { SkillRecord } from "../skills/loader.js";

export type RecallSource = "hotMemory" | "memorySearch" | "session" | "skill";

export type RecallTaskKind =
  | "tool_execution"
  | "coding"
  | "research"
  | "writing"
  | "conversation"
  | "memory_dependent"
  | "skill_dependent";

export interface RecallPlannerInput {
  prompt: string;
  cwd: string;
  hasMemory: boolean;
  hasSkills: boolean;
}

export interface ModelRecallPlannerRoute {
  adapter: ProviderAdapter;
  model: string;
  providerName: string;
}

export interface ModelRecallPlannerInput extends RecallPlannerInput {
  route?: ModelRecallPlannerRoute;
  skills?: SkillRecord[];
  signal?: AbortSignal;
}

export interface RecallDecision {
  taskKind: RecallTaskKind;
  budgets: Record<RecallSource, number>;
  reasons: Record<RecallSource, string[]>;
  skipped: Record<RecallSource, string[]>;
  matchedTerms: Record<RecallSource, string[]>;
  method?: "fallback" | "model";
  constraints?: string[];
  selectedSkills?: string[];
  planner?: {
    providerName: string;
    model: string;
    usage?: ProviderUsage;
  };
  fallbackReason?: string;
}

export interface SkillRecallHit {
  skill: SkillRecord;
  score: number;
  matchedTerms: string[];
}

export interface HotMemorySelection {
  nodes: MemoryNode[];
  skipped: Array<{ nodeId: string; title: string; type: MemoryNodeType; reason: string }>;
}

const RECALL_SOURCES: RecallSource[] = ["hotMemory", "memorySearch", "session", "skill"];

const SOURCE_BUDGET_MAX: Record<RecallSource, number> = {
  hotMemory: 5,
  memorySearch: 5,
  session: 3,
  skill: 3
};

const SOURCE_BUDGET_DEFAULT: Record<RecallSource, number> = {
  hotMemory: 3,
  memorySearch: 5,
  session: 3,
  skill: 3
};

const GLOBAL_HOT_MEMORY_BUDGET = 3;
const GLOBAL_HOT_MEMORY_REASON = "global hot memory is enabled by default";
const GLOBAL_HOT_MEMORY_TERM = "global-hot-memory";

const HISTORY_TERMS = [
  "继续",
  "刚才",
  "上次",
  "之前",
  "前面",
  "恢复",
  "再做",
  "接着",
  "那个任务",
  "按那个",
  "按前面",
  "我们说过",
  "我们之前",
  "continue",
  "resume",
  "previous",
  "earlier",
  "before",
  "last time",
  "same task",
  "that task",
  "handoff"
];

const MEMORY_TERMS = [
  "还记得",
  "记得",
  "记住",
  "记忆",
  "上次",
  "之前",
  "以前",
  "流程",
  "工作流",
  "偏好",
  "习惯",
  "约定",
  "背景",
  "项目",
  "资料",
  "workflow",
  "workflows",
  "memory",
  "remember",
  "recall",
  "previous",
  "last time",
  "preference",
  "habit",
  "context",
  "background",
  "agreement",
  "convention",
  "project",
  "reference"
];

const MEMORY_QUERY_TERMS = [
  "how should",
  "where is",
  "怎么",
  "如何",
  "在哪",
  "哪里",
  "怎么做",
  "怎么处理",
  "where",
  "how",
  "which",
  "what"
];

const SKILL_TERMS = ["skill", "skills", "技能", "工作流", "workflow", "workflows"];

const CODING_TERMS = [
  "代码",
  "实现",
  "修复",
  "测试",
  "构建",
  "编译",
  "报错",
  "bug",
  "fix",
  "implement",
  "code",
  "test",
  "build",
  "compile",
  "refactor",
  "repo",
  "repository"
];

const RESEARCH_TERMS = [
  "查",
  "搜索",
  "论文",
  "文献",
  "资料",
  "research",
  "search",
  "paper",
  "literature",
  "source"
];

const WRITING_TERMS = [
  "写",
  "润色",
  "总结",
  "报告",
  "文档",
  "draft",
  "write",
  "polish",
  "summarize",
  "summary",
  "report",
  "doc"
];

const TOOL_TERMS = [
  "创建",
  "新建",
  "写入",
  "读取",
  "检查",
  "删除",
  "移动",
  "复制",
  "目录",
  "文件夹",
  "文件",
  "create",
  "write",
  "read",
  "check",
  "delete",
  "move",
  "copy",
  "folder",
  "directory",
  "file"
];

const NEGATION_CUES = [
  "不要",
  "不用",
  "无需",
  "不需要",
  "不必",
  "禁止",
  "别",
  "请勿",
  "勿",
  "避免",
  "别用",
  "不读",
  "不读取",
  "不要读取",
  "不要调用",
  "no",
  "not",
  "don't",
  "do not",
  "without",
  "avoid",
  "skip",
  "never",
  "disable",
  "disabled"
];

const POSITIVE_REMEMBER_PHRASES = [
  "不要忘记",
  "别忘记",
  "记得",
  "remember",
  "don't forget",
  "do not forget"
];

const HOT_MEMORY_CORE_TYPES = new Set<MemoryNodeType>(["user_profile", "preference", "work_habit"]);

const RECALL_PLANNER_SYSTEM_PROMPT = [
  "You are Magi's recall planner. Decide which stored context sources should be retrieved before the main agent turn.",
  "",
  "Return ONLY a JSON object with this shape:",
  `{"taskKind":"tool_execution|coding|research|writing|conversation|memory_dependent|skill_dependent","sources":{"hotMemory":{"needed":false,"budget":0,"reason":""},"memorySearch":{"needed":false,"budget":0,"reason":""},"session":{"needed":false,"budget":0,"reason":""},"skill":{"needed":false,"budget":0,"reason":"","skills":[]}},"constraints":[]}`,
  "",
  "Source meanings:",
  "- hotMemory: stable user profile, preferences, or work habits. It has a small global default budget; increase it only when durable preferences are clearly relevant.",
  "- memorySearch: stored project/user/session memory search. Use for prior agreements, project background, reusable workflows, or references that the current task depends on.",
  "- session: prior session transcript search. Use when the user refers to earlier conversation, previous tasks, or cross-session continuity.",
  "- skill: load skill bodies. Users may not know skill names; select by skill summaries only when a skill is clearly useful.",
  "",
  "Decision rules:",
  "- Judge by task semantics, not keyword presence alone.",
  "- A selected source must have a concrete reason. If no concrete reason exists, set needed false and budget 0.",
  "- Source names in the prompt are not evidence by themselves. Select a source only when the current task has a concrete need for it.",
  "- Ordinary local filesystem or tool-execution tasks with explicit paths usually need no recall.",
  "- Do not inspect memory contents; only the current prompt, cwd, and skill metadata are available.",
  "- If unsure, set needed false."
].join("\n");

export async function planRecallWithModel(input: ModelRecallPlannerInput): Promise<RecallDecision> {
  if (!input.route) {
    return planRecall(input);
  }

  try {
    const response = await input.route.adapter.complete({
      model: input.route.model,
      messages: [
        textMessage("system", RECALL_PLANNER_SYSTEM_PROMPT),
        textMessage("user", buildRecallPlannerUserPrompt(input))
      ],
      temperature: 0,
      maxOutputTokens: 800,
      signal: input.signal
    });
    const decision = normalizeModelRecallDecision(parseJsonObject(response.text), input);
    return {
      ...decision,
      method: "model",
      planner: {
        providerName: input.route.providerName,
        model: input.route.model,
        usage: response.usage
      }
    };
  } catch (error) {
    if (isAbortError(error) || input.signal?.aborted === true) {
      throw error;
    }
    return {
      ...planRecall(input),
      fallbackReason: error instanceof Error ? error.message : String(error)
    };
  }
}

export function planRecall(input: RecallPlannerInput): RecallDecision {
  const text = normalizeText(input.prompt);
  const historyMatches = findMatches(text, HISTORY_TERMS, { ignoreNegated: true });
  const memoryMatches = findMatches(text, MEMORY_TERMS, { ignoreNegated: true });
  const memoryQueryMatches = findMatches(text, MEMORY_QUERY_TERMS, { ignoreNegated: true });
  const skillMatches = findMatches(text, SKILL_TERMS, { ignoreNegated: true });
  const hasPath = hasLocalPath(input.prompt);
  const taskKind = classifyTask({
    text,
    hasPath,
    historyMatches,
    memoryMatches,
    skillMatches
  });

  const budgets = zeroBudgets();
  const reasons = emptyReasons();
  const matchedTerms = emptyTerms();

  if (input.hasMemory) {
    ensureGlobalHotMemoryBudget(budgets, reasons, matchedTerms);

    if (historyMatches.length > 0) {
      budgets.session = Math.max(budgets.session, 3);
      reasons.session.push("prompt references prior conversation");
      matchedTerms.session.push(...historyMatches);

      budgets.memorySearch = Math.max(budgets.memorySearch, 5);
      reasons.memorySearch.push("prompt references prior context");
      matchedTerms.memorySearch.push(...historyMatches);
    }

    if (memoryMatches.length > 0 || memoryQueryMatches.length > 0) {
      budgets.memorySearch = Math.max(budgets.memorySearch, 5);
      reasons.memorySearch.push(
        memoryMatches.length > 0
          ? "prompt asks for memory, project background, or workflow context"
          : "question-shaped prompt may need stored workflow or reference context"
      );
      matchedTerms.memorySearch.push(...memoryMatches, ...memoryQueryMatches);
      if (memoryMatches.length > 0) {
        budgets.hotMemory = Math.max(budgets.hotMemory, 3);
        reasons.hotMemory.push("prompt asks for durable memory or preference context");
        matchedTerms.hotMemory.push(...memoryMatches);
      }
    }
  }

  if (input.hasSkills) {
    if (skillMatches.length > 0) {
      budgets.skill = 3;
      reasons.skill.push("prompt has explicit skill or workflow intent");
      matchedTerms.skill.push(...skillMatches);
    } else if (taskKind === "coding") {
      budgets.skill = 1;
      reasons.skill.push("coding task can use high-confidence skill-name matches");
      matchedTerms.skill.push(taskKind);
    }
  }

  return {
    taskKind,
    budgets,
    reasons,
    skipped: buildSkipped(budgets, input),
    matchedTerms: dedupeRecord(matchedTerms),
    method: "fallback",
    constraints: []
  };
}

export function scoreSkillForRecall(
  skill: SkillRecord,
  prompt: string
): SkillRecallHit | undefined {
  const terms = tokenizeRecallText(prompt);
  if (terms.length === 0) return undefined;

  const name = normalizeText(skill.name);
  const summary = normalizeText(skill.summary);
  const matchedTerms: string[] = [];
  let score = 0;

  for (const term of terms) {
    if (name === term || name.includes(term) || term.includes(name)) {
      score += 12;
      matchedTerms.push(term);
      continue;
    }
    if (summary.includes(term)) {
      score += 5;
      matchedTerms.push(term);
    }
  }

  const explicitSkillIntent =
    findMatches(normalizeText(prompt), SKILL_TERMS, { ignoreNegated: true }).length > 0;
  const minimum = explicitSkillIntent ? 5 : 12;
  if (score < minimum) return undefined;
  return { skill, score, matchedTerms: unique(matchedTerms) };
}

/**
 * True only when the prompt contains the skill's full name as standalone
 * token(s) (e.g. "verify ...", "blackbox verify skill", or "用 stuck 帮我").
 * This is stricter than scoreSkillForRecall's substring scoring on purpose: it
 * is used to *force* skill recall past a zero keyword-budget, so it must not
 * fire on incidental substrings like a "route-clean.txt" filename matching a
 * "route-clean-helper" skill. Negated mentions ("不要调用 skills") still tokenize
 * normally, so callers should also respect explicit skip intent.
 */
export function promptNamesSkillExactly(skillName: string, prompt: string): boolean {
  const name = normalizeText(skillName);
  if (!name) return false;
  const promptTerms = tokenizeRecallText(prompt);
  if (promptTerms.some((term) => term === name)) return true;

  const nameParts = name.split(/[-_]+/).filter(Boolean);
  if (nameParts.length <= 1) return false;
  for (let index = 0; index <= promptTerms.length - nameParts.length; index += 1) {
    if (nameParts.every((part, offset) => promptTerms[index + offset] === part)) {
      return true;
    }
  }
  return false;
}

export function selectHotMemoryNodes(input: {
  nodes: MemoryNode[];
  prompt: string;
  cwd: string;
  budget: number;
}): HotMemorySelection {
  if (input.budget <= 0) {
    return {
      nodes: [],
      skipped: input.nodes.map((node) => ({
        nodeId: node.id,
        title: node.title,
        type: node.type,
        reason: "hot memory budget is zero"
      }))
    };
  }

  const text = normalizeText(input.prompt);
  const cwdTerms = projectTerms(input.cwd);
  const selected: MemoryNode[] = [];
  const skipped: HotMemorySelection["skipped"] = [];

  for (const node of input.nodes) {
    const nodeText = normalizeText(`${node.title} ${node.summary} ${node.body}`);
    const nodeMatchesPrompt = tokenizeRecallText(input.prompt).some((term) =>
      nodeText.includes(term)
    );
    const nodeMatchesProject = cwdTerms.some(
      (term) => nodeText.includes(term) || hasTerm(text, term)
    );
    const isHotMemoryCore = HOT_MEMORY_CORE_TYPES.has(node.type);
    if (!isHotMemoryCore) {
      skipped.push({
        nodeId: node.id,
        title: node.title,
        type: node.type,
        reason:
          "global hot memory only includes durable user profile, preference, or work habit nodes"
      });
      continue;
    }

    const isGlobalCore = node.weight >= 0.8;

    if (isGlobalCore || nodeMatchesPrompt || nodeMatchesProject) {
      selected.push(node);
      if (selected.length >= input.budget) break;
      continue;
    }

    skipped.push({
      nodeId: node.id,
      title: node.title,
      type: node.type,
      reason: "memory node did not match prompt, cwd, or global-core criteria"
    });
  }

  return { nodes: selected, skipped };
}

export function filterMemoryHitsByRecallEvidence<
  T extends { file: string; title: string; snippet: string }
>(hits: T[], prompt: string, cwd: string): T[] {
  const terms = tokenizeRecallText(prompt).filter((term) => !WEAK_RECALL_EVIDENCE_TERMS.has(term));
  const cwdTerms = projectTerms(cwd);
  const isPersonalMemoryQuery = hasPersonalMemoryIntent(prompt);
  return hits.filter((hit) => {
    const header = normalizeText(`${hit.file} ${hit.title}`);
    const body = normalizeText(hit.snippet);
    if (hit.file.startsWith("legacy/")) {
      const legacyMatchCount = terms.filter((term) => body.includes(term)).length;
      return legacyMatchCount >= 1 || cwdTerms.some((term) => body.includes(term));
    }
    const strongTermMatch = terms.some((term) => header.includes(term));
    const bodyMatchCount = terms.filter((term) => body.includes(term)).length;
    const cwdMatch = cwdTerms.some((term) => header.includes(term) || body.includes(term));
    if (isPersonalMemoryQuery && isPersonalMemoryHit(hit) && bodyMatchCount >= 1) {
      return true;
    }
    return strongTermMatch || bodyMatchCount >= 2 || cwdMatch;
  });
}

function hasPersonalMemoryIntent(prompt: string): boolean {
  const text = normalizeText(prompt);
  const hasUserCue = /\b(my|me|user)\b/.test(text) || hasTerm(text, "用户") || hasTerm(text, "我");
  const hasPreferenceCue =
    findMatches(text, ["preference", "prefer", "habit", "偏好", "习惯"]).length > 0;
  const hasMemoryCue =
    findMatches(text, ["remember", "recall", "memory", "记得", "记忆", "记住"]).length > 0;
  return hasUserCue && hasPreferenceCue && hasMemoryCue;
}

function isPersonalMemoryHit(hit: { file: string; title: string; snippet: string }): boolean {
  const file = hit.file.toLowerCase();
  if (
    file === "user.md#user" ||
    file === "preferences.md#preferences" ||
    file === "user.md" ||
    file === "preferences.md"
  ) {
    return true;
  }
  const text = normalizeText(`${hit.title} ${hit.snippet}`);
  return (
    findMatches(text, ["user", "preference", "prefer", "habit", "用户", "偏好", "习惯"]).length >= 2
  );
}

function classifyTask(input: {
  text: string;
  hasPath: boolean;
  historyMatches: string[];
  memoryMatches: string[];
  skillMatches: string[];
}): RecallTaskKind {
  if (input.skillMatches.length > 0) return "skill_dependent";
  if (input.historyMatches.length > 0 || input.memoryMatches.length > 0) return "memory_dependent";
  if (input.hasPath && findMatches(input.text, TOOL_TERMS).length > 0) return "tool_execution";
  if (findMatches(input.text, CODING_TERMS).length > 0) return "coding";
  if (findMatches(input.text, RESEARCH_TERMS).length > 0) return "research";
  if (findMatches(input.text, WRITING_TERMS).length > 0) return "writing";
  return "conversation";
}

function buildRecallPlannerUserPrompt(input: ModelRecallPlannerInput): string {
  const skillLines = (input.skills ?? [])
    .slice(0, 60)
    .map((skill) => `- ${skill.name}: ${skill.summary.slice(0, 320)}`);
  return [
    "[Magi recall planner input]",
    "",
    `memory available: ${input.hasMemory ? "yes" : "no"}`,
    `skills available: ${input.hasSkills ? "yes" : "no"}`,
    `cwd: ${input.cwd}`,
    "",
    "Installed skill metadata (name and summary only):",
    skillLines.length > 0 ? skillLines.join("\n") : "(none)",
    "",
    "User prompt:",
    input.prompt.slice(0, 4000)
  ].join("\n");
}

function normalizeModelRecallDecision(
  parsed: unknown,
  input: ModelRecallPlannerInput
): RecallDecision {
  if (!isRecord(parsed)) {
    throw new Error("recall planner returned a non-object response");
  }

  const fallback = planRecall(input);
  const budgets = zeroBudgets();
  const reasons = emptyReasons();
  const skipped = emptyReasons();
  const matchedTerms = emptyTerms();
  const selectedSkills = sanitizeSelectedSkills(
    [
      ...readStringArray(readPlannerSource(parsed.sources, "skill")?.skills),
      ...readStringArray(parsed.selectedSkills)
    ],
    input.skills ?? []
  );

  for (const source of RECALL_SOURCES) {
    const sourceObject = readPlannerSource(parsed.sources, source);
    const reason = readString(sourceObject?.reason).trim();
    const available = source === "skill" ? input.hasSkills : input.hasMemory;
    const wanted = sourceObject?.needed === true;
    const hasReason = reason.length > 0;
    const shouldUse = available && wanted && hasReason;

    if (shouldUse) {
      const requestedBudget = readNumber(sourceObject?.budget);
      budgets[source] = clampBudget(
        requestedBudget && requestedBudget > 0 ? requestedBudget : SOURCE_BUDGET_DEFAULT[source],
        SOURCE_BUDGET_MAX[source]
      );
      reasons[source].push(reason);
      matchedTerms[source].push(source === "skill" ? "model-selected" : "model-selected");
      continue;
    }

    budgets[source] = 0;
    if (!available) {
      skipped[source].push(source === "skill" ? "skills are unavailable" : "memory is unavailable");
    } else if (wanted && !hasReason) {
      skipped[source].push("planner selected this source without a concrete reason");
    } else if (reason) {
      skipped[source].push(reason);
    } else {
      skipped[source].push("planner found no sufficient need for this recall source");
    }
  }

  if (budgets.skill <= 0) {
    selectedSkills.length = 0;
  } else if (selectedSkills.length > budgets.skill) {
    selectedSkills.length = budgets.skill;
  }
  if (input.hasMemory) {
    ensureGlobalHotMemoryBudget(budgets, reasons, matchedTerms, skipped);
  }

  return {
    taskKind: normalizeTaskKind(readString(parsed.taskKind)) ?? fallback.taskKind,
    budgets,
    reasons,
    skipped,
    matchedTerms: dedupeRecord(matchedTerms),
    constraints: unique(readStringArray(parsed.constraints)).slice(0, 8),
    selectedSkills
  };
}

function readPlannerSource(
  sources: unknown,
  source: RecallSource
): Record<string, unknown> | undefined {
  if (!isRecord(sources)) return undefined;
  const aliases: Record<RecallSource, string[]> = {
    hotMemory: ["hotMemory", "hot_memory", "profileMemory", "profile"],
    memorySearch: ["memorySearch", "memory_search", "memory", "storedMemory"],
    session: ["session", "sessions", "priorSessions", "prior_sessions"],
    skill: ["skill", "skills"]
  };
  for (const key of aliases[source]) {
    const value = sources[key];
    if (isRecord(value)) return value;
  }
  return undefined;
}

function ensureGlobalHotMemoryBudget(
  budgets: Record<RecallSource, number>,
  reasons: Record<RecallSource, string[]>,
  matchedTerms: Record<RecallSource, string[]>,
  skipped?: Record<RecallSource, string[]>
): void {
  budgets.hotMemory = Math.max(budgets.hotMemory, GLOBAL_HOT_MEMORY_BUDGET);
  if (!reasons.hotMemory.includes(GLOBAL_HOT_MEMORY_REASON)) {
    reasons.hotMemory.unshift(GLOBAL_HOT_MEMORY_REASON);
  }
  if (!matchedTerms.hotMemory.includes(GLOBAL_HOT_MEMORY_TERM)) {
    matchedTerms.hotMemory.unshift(GLOBAL_HOT_MEMORY_TERM);
  }
  if (skipped) {
    skipped.hotMemory = [];
  }
}

function parseJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? extractJsonObject(text);
  return JSON.parse(candidate);
}

function extractJsonObject(text: string): string {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    throw new Error("recall planner response did not contain a JSON object");
  }
  return text.slice(first, last + 1);
}

function normalizeTaskKind(value: string): RecallTaskKind | undefined {
  const allowed: RecallTaskKind[] = [
    "tool_execution",
    "coding",
    "research",
    "writing",
    "conversation",
    "memory_dependent",
    "skill_dependent"
  ];
  return allowed.includes(value as RecallTaskKind) ? (value as RecallTaskKind) : undefined;
}

function sanitizeSelectedSkills(names: string[], skills: SkillRecord[]): string[] {
  const available = new Map(skills.map((skill) => [normalizeText(skill.name), skill.name]));
  if (available.size === 0) return [];
  return unique(
    names
      .map((name) => available.get(normalizeText(name)))
      .filter((name): name is string => Boolean(name))
  );
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim())
    : [];
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampBudget(value: number, max: number): number {
  return Math.max(0, Math.min(max, Math.floor(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"))
  );
}

function buildSkipped(
  budgets: Record<RecallSource, number>,
  input: RecallPlannerInput
): Record<RecallSource, string[]> {
  const skipped = emptyReasons();
  for (const source of RECALL_SOURCES) {
    if (budgets[source] > 0) continue;
    if (source === "hotMemory" || source === "memorySearch" || source === "session") {
      skipped[source].push(
        input.hasMemory
          ? "no sufficient evidence that this recall source is needed"
          : "memory is unavailable"
      );
    } else {
      skipped[source].push(
        input.hasSkills ? "no sufficient evidence that a skill is needed" : "skills are unavailable"
      );
    }
  }
  return skipped;
}

function zeroBudgets(): Record<RecallSource, number> {
  return {
    hotMemory: 0,
    memorySearch: 0,
    session: 0,
    skill: 0
  };
}

function emptyReasons(): Record<RecallSource, string[]> {
  return {
    hotMemory: [],
    memorySearch: [],
    session: [],
    skill: []
  };
}

function emptyTerms(): Record<RecallSource, string[]> {
  return {
    hotMemory: [],
    memorySearch: [],
    session: [],
    skill: []
  };
}

function dedupeRecord(record: Record<RecallSource, string[]>): Record<RecallSource, string[]> {
  return {
    hotMemory: unique(record.hotMemory),
    memorySearch: unique(record.memorySearch),
    session: unique(record.session),
    skill: unique(record.skill)
  };
}

function findMatches(
  text: string,
  candidates: string[],
  options: { ignoreNegated?: boolean } = {}
): string[] {
  return unique(
    candidates.filter(
      (term) => hasTerm(text, term) && (!options.ignoreNegated || hasUnnegatedTerm(text, term))
    )
  );
}

function hasLocalPath(text: string): boolean {
  return (
    /(?:^|\s)(?:\/[\w .@%+=:,~/-]+|~\/[\w .@%+=:,~/-]+)(?:\s|$)/.test(text) ||
    /(?:^|\s)(?:\.{1,2}\/[\w .@%+=:,~/-]+)(?:\s|$)/.test(text)
  );
}

function projectTerms(cwd: string): string[] {
  const base = path.basename(cwd);
  const parent = path.basename(path.dirname(cwd));
  return unique([...tokenizeRecallText(base), ...tokenizeRecallText(parent)]).filter(
    (term) => term.length >= 5 && !GENERIC_PROJECT_TERMS.has(term)
  );
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenizeRecallText(text: string): string[] {
  const terms: string[] = [];
  for (const term of text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .split(/\s+/)
    .map((item) => item.trim())) {
    if (isRecallTerm(term)) {
      terms.push(term);
    }
    terms.push(...cjkNgrams(term));
  }
  return unique(terms);
}

function cjkNgrams(term: string): string[] {
  const grams: string[] = [];
  const runs = term.match(/[\u3400-\u9fff\uf900-\ufaff]+/gu) ?? [];
  for (const run of runs) {
    const chars = Array.from(run);
    for (let size = 2; size <= 4; size += 1) {
      if (chars.length < size) continue;
      for (let index = 0; index <= chars.length - size; index += 1) {
        const gram = chars.slice(index, index + size).join("");
        if (isRecallTerm(gram)) {
          grams.push(gram);
        }
      }
    }
  }
  return grams;
}

function isRecallTerm(term: string): boolean {
  return term.length >= 3 || (/[\u4e00-\u9fff]/.test(term) && term.length >= 2);
}

function hasTerm(text: string, term: string): boolean {
  const normalized = normalizeText(term);
  if (!normalized) return false;
  if (/^[a-z0-9_-]+$/i.test(normalized)) {
    return tokenizeRecallText(text).includes(normalized);
  }
  return text.includes(normalized);
}

function hasUnnegatedTerm(text: string, term: string): boolean {
  const normalizedTerm = normalizeText(term);
  if (!normalizedTerm) return false;
  return splitRecallClauses(text).some(
    (clause) => hasTerm(clause, normalizedTerm) && !isTermNegatedInClause(clause, normalizedTerm)
  );
}

function isTermNegatedInClause(clause: string, normalizedTerm: string): boolean {
  if (!hasTerm(clause, normalizedTerm)) return false;
  const termIndex = firstTermIndex(clause, normalizedTerm);
  if (termIndex < 0) return false;
  if (
    POSITIVE_REMEMBER_PHRASES.some((phrase) => {
      const phraseIndex = clause.indexOf(phrase);
      return phraseIndex >= 0 && phraseIndex <= termIndex;
    })
  ) {
    return false;
  }
  return NEGATION_CUES.some((cue) => {
    const cueIndex = clause.indexOf(cue);
    return cueIndex >= 0 && cueIndex <= termIndex && termIndex - cueIndex <= 24;
  });
}

function firstTermIndex(text: string, term: string): number {
  const direct = text.indexOf(term);
  if (direct >= 0) return direct;
  const tokens = tokenizeRecallText(text);
  return tokens.includes(term) ? text.indexOf(tokens.find((token) => token === term) ?? term) : -1;
}

function splitRecallClauses(text: string): string[] {
  return normalizeText(text)
    .split(/[\n\r,，。；;!?！？]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

const GENERIC_PROJECT_TERMS = new Set([
  "magi",
  "query",
  "test",
  "tests",
  "tmp",
  "temp",
  "users",
  "desktop"
]);

const WEAK_RECALL_EVIDENCE_TERMS = new Set(["next"]);
