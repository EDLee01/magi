import { MagiConfig } from "../config.js";
import { ResolvedModel, resolveModelAlias } from "./model-alias.js";

/**
 * Task classification for intelligent model routing.
 * When alias is "auto", the router picks the best model based on prompt characteristics.
 */

export type RouteKind =
  | "quick"
  | "coding"
  | "reasoning"
  | "vision"
  | "long_context"
  | "review"
  | "planning"
  | "extraction"
  | "tool_heavy"
  | "agent";

export interface ModelCapabilities {
  family: string;
  role?: "haiku" | "sonnet" | "opus" | "main";
  contextWindow: number;
  supportsVision: boolean;
  specialty?: "coding" | "reasoning" | "vision" | "general";
  priority?: number;
}

export interface RouterCandidate {
  providerName: string;
  model: string;
  capabilities: ModelCapabilities;
}

export interface RouterConfig {
  candidates: Record<string, ModelCapabilities>;
}

/**
 * Optional context that influences routing decisions beyond the prompt itself.
 */
export interface RouteContext {
  hasImage?: boolean;
  /** True when EnterPlanMode is active. Routes prefer Opus/strongest models. */
  isPlanMode?: boolean;
  /** Estimated total context size (history + prompt) in tokens. Forces long_context route when above threshold. */
  estimatedContextTokens?: number;
  /** Threshold above which to force long_context (default 200k). */
  longContextThreshold?: number;
}

/** Telemetry record for a routing decision. */
export interface RouteDecision {
  routeKind: RouteKind;
  chosenAlias: string;
  chosenScore: number;
  resolved: ResolvedModel;
  candidates: Array<{ alias: string; score: number }>;
  context: RouteContext;
}

const CODE_KEYWORDS =
  /\b(function|class|import|export|const|let|var|def|fn|struct|impl|interface|enum|module|package|async|await|yield|instanceof|extends|implements|typeof|void|int|string|bool|float|double|null|undefined|nil|None|True|False|self|super|static|private|protected|pub)\b/;
const REASONING_KEYWORDS =
  /\b(why|how|explain|analyze|compare|evaluate|reason|think|consider|argue|debate|prove|derive|deduce|infer|conclude|hypothesis|theory|because|therefore|consequently|furthermore|moreover|however|nevertheless|although|whereas|implications?|trade-?offs?|pros?\s+and\s+cons?)\b/i;
const REVIEW_KEYWORDS =
  /\b(review|refactor|improve|optimize|clean\s*up|simplify|restructure|rewrite|audit|check|lint|fix\s+style|code\s+quality|best\s+practice|technical\s+debt)\b/i;
const PLANNING_KEYWORDS =
  /\b(plan|design|architect|strategy|approach|roadmap|breakdown|decompose|structure|organize|outline|proposal|rfc|spec|specification)\b/i;
const EXTRACTION_KEYWORDS =
  /\b(extract|parse|convert|transform|summarize|summarise|list\s+all|find\s+all|collect|gather|enumerate|catalog)\b/i;
const AGENT_KEYWORDS =
  /\b(implement|build|create|add\s+feature|set\s+up|configure|deploy|migrate|upgrade|install|scaffold|bootstrap|integrate)\b/i;

const TOOL_HEAVY_KEYWORDS =
  /\b(refactor.*(?:files|codebase|repo)|search.*and.*replace|across.*(?:files|repo)|repo-?wide|all.*\.(?:ts|js|tsx|jsx|go|py|rs|java)\b|mass\s+(?:rename|update)|migrate.*(?:codebase|imports?)|run.*(?:tests?|build|lint).*and|setup.*(?:project|repo)|scaffold|bootstrap|find.*(?:and|then).*(?:fix|edit|update).*(?:all|every))\b/i;

export function classifyTask(prompt: string, context: RouteContext | boolean = {}): RouteKind {
  // Backwards compat: second arg used to be `hasImage` boolean
  const ctx: RouteContext = typeof context === "boolean" ? { hasImage: context } : context;
  const longContextThreshold = ctx.longContextThreshold ?? 200_000;

  // 1. Forced long-context — total context exceeds threshold
  if (
    ctx.estimatedContextTokens !== undefined &&
    ctx.estimatedContextTokens >= longContextThreshold
  ) {
    return "long_context";
  }

  // 2. Plan mode — always favor planning route
  if (ctx.isPlanMode) {
    return "planning";
  }

  // 3. Vision
  if (ctx.hasImage) {
    return "vision";
  }

  // 4. Long-context based on prompt size alone
  if (estimateTokens(prompt) > 50_000) {
    return "long_context";
  }

  // 5. Keyword-based classification — review/planning take precedence over tool_heavy
  if (PLANNING_KEYWORDS.test(prompt) && prompt.length > 100) {
    return "planning";
  }
  if (REVIEW_KEYWORDS.test(prompt)) {
    return "review";
  }

  // 6. Heavy tool usage — only if not already classified
  if (TOOL_HEAVY_KEYWORDS.test(prompt)) {
    return "tool_heavy";
  }

  if (AGENT_KEYWORDS.test(prompt) && prompt.length > 60) {
    return "agent";
  }
  // Extraction takes precedence even if code keywords appear, when the prompt
  // pattern clearly says "extract/list/find all X from Y"
  if (/\b(?:extract|list|find|enumerate)\s+(?:all|every|the)\b/i.test(prompt)) {
    return "extraction";
  }
  if (EXTRACTION_KEYWORDS.test(prompt) && !CODE_KEYWORDS.test(prompt)) {
    return "extraction";
  }
  if (REASONING_KEYWORDS.test(prompt) && !CODE_KEYWORDS.test(prompt)) {
    return "reasoning";
  }
  if (CODE_KEYWORDS.test(prompt)) {
    return "coding";
  }
  const length = prompt.length;
  if (length < 280) {
    return "quick";
  }
  return "coding";
}

export function scoreCandidate(capabilities: ModelCapabilities, routeKind: RouteKind): number {
  let score = capabilities.priority ?? 0;

  // Model family × task type scoring
  switch (routeKind) {
    case "coding":
      if (capabilities.family === "claude") score += 28;
      else if (capabilities.family === "deepseek") score += 24;
      else if (capabilities.family === "gpt") score += 20;
      if (capabilities.specialty === "coding") score += 22;
      break;
    case "reasoning":
      if (capabilities.family === "deepseek") score += 30;
      else if (capabilities.family === "claude") score += 22;
      else if (capabilities.family === "gpt") score += 18;
      if (capabilities.specialty === "reasoning") score += 14;
      break;
    case "planning":
      if (capabilities.role === "opus") score += 30;
      else if (capabilities.family === "claude") score += 24;
      else if (capabilities.family === "deepseek") score += 20;
      break;
    case "agent":
      if (capabilities.role === "opus") score += 30;
      else if (capabilities.family === "claude") score += 26;
      else if (capabilities.family === "deepseek") score += 18;
      else if (capabilities.family === "gpt") score += 20;
      if (capabilities.specialty === "coding") score += 18;
      break;
    case "extraction":
      if (capabilities.role === "haiku") score += 20;
      else if (capabilities.role === "sonnet") score += 16;
      else if (capabilities.family === "gpt") score += 14;
      break;
    case "tool_heavy":
      if (capabilities.family === "claude") score += 28;
      else if (capabilities.family === "gpt") score += 22;
      else if (capabilities.family === "deepseek") score += 16;
      if (capabilities.specialty === "coding") score += 18;
      break;
    case "quick":
      if (capabilities.role === "haiku") score += 18;
      else if (capabilities.role === "sonnet") score += 10;
      break;
    case "long_context":
      if (capabilities.contextWindow >= 1_000_000) score += 24;
      else if (capabilities.contextWindow >= 200_000) score += 16;
      break;
    case "vision":
      if (capabilities.supportsVision) score += 20;
      if (capabilities.specialty === "vision") score += 14;
      break;
    case "review":
      if (capabilities.family === "claude") score += 24;
      else if (capabilities.family === "gpt") score += 20;
      if (capabilities.specialty === "coding") score += 16;
      break;
  }

  // Context window bonus (always relevant)
  if (capabilities.contextWindow >= 1_000_000) score += 24;
  else if (capabilities.contextWindow >= 250_000) score += 16;
  else if (capabilities.contextWindow >= 128_000) score += 8;

  // Role bonus is task-specific. Opus only wins for genuinely complex/strategic
  // tasks. For everyday coding/reasoning, prefer sonnet (cost/speed sweet spot).
  if (routeKind === "planning" || routeKind === "agent") {
    // Strategic tasks favor opus
    if (capabilities.role === "opus") score += 10;
    else if (capabilities.role === "sonnet" || capabilities.role === "main") score += 4;
  } else if (routeKind === "quick" || routeKind === "extraction") {
    // Cheap tasks favor haiku
    if (capabilities.role === "haiku") score += 6;
    else if (capabilities.role === "sonnet" || capabilities.role === "main") score += 2;
    // Opus gets nothing for trivial tasks — too expensive
  } else {
    // Default tasks (coding/reasoning/review/tool_heavy/long_context/vision):
    // Sonnet is the sweet spot. Opus gets a smaller bonus (not dominant).
    if (capabilities.role === "sonnet" || capabilities.role === "main") score += 6;
    else if (capabilities.role === "opus") score += 3;
    else if (capabilities.role === "haiku") score += 1;
  }

  return score;
}

export function routeAuto(
  config: MagiConfig,
  prompt: string,
  context: RouteContext | boolean = {}
): ResolvedModel | undefined {
  const decision = routeAutoDetailed(config, prompt, context);
  return decision?.resolved;
}

/**
 * Like routeAuto but returns a full decision record (task kind, candidate scores, etc.)
 * for telemetry and debugging.
 */
export function routeAutoDetailed(
  config: MagiConfig,
  prompt: string,
  context: RouteContext | boolean = {}
): RouteDecision | undefined {
  const ctx: RouteContext = typeof context === "boolean" ? { hasImage: context } : context;
  const routerConfig = config.models.router;
  if (!routerConfig || Object.keys(routerConfig).length === 0) {
    return undefined;
  }

  const routeKind = classifyTask(prompt, ctx);
  const candidates: Array<{ alias: string; score: number }> = [];
  let bestScore = -1;
  let bestAlias: string | undefined;

  for (const [alias, capabilities] of Object.entries(routerConfig)) {
    const score = scoreCandidate(capabilities, routeKind);
    candidates.push({ alias, score });
    if (score > bestScore) {
      bestScore = score;
      bestAlias = alias;
    }
  }

  if (!bestAlias) {
    return undefined;
  }

  const resolved = resolveModelAlias(config, bestAlias);
  return {
    routeKind,
    chosenAlias: bestAlias,
    chosenScore: bestScore,
    resolved,
    candidates: candidates.sort((a, b) => b.score - a.score),
    context: ctx
  };
}

function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token for English, ~2 for CJK
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g) ?? []).length;
  const nonCjkLength = text.length - cjkCount;
  return Math.ceil(nonCjkLength / 4) + Math.ceil(cjkCount / 2);
}
