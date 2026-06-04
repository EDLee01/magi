/**
 * 6-layer context builder for the agent system prompt.
 *
 * Layers (in order):
 * 1. System instructions (core behavior rules)
 * 2. Project rules (AGENTS.md / .magi/rules/)
 * 3. Hot memory (durable user/project/profile memory)
 * 4. Dynamic memory (retrieved long-tail memory)
 * 5. Git context (branch, status)
 * 6. Environment (date, cwd, platform)
 */

import { execSync } from "node:child_process";

import { loadAgentInstructions, formatAgentInstructions } from "../rules/agents-loader.js";
import { MagiPaths } from "../paths.js";
import { MemoryNode, MemoryNodeStore } from "../memory-node-store.js";

const HOT_MEMORY_CHAR_LIMIT = 8000;

export interface ContextLayer {
  name: string;
  content: string;
}

export interface ContextBuildInput {
  cwd: string;
  paths?: MagiPaths;
  systemInstructions?: string;
  memoryContext?: string;
  userMemoryIndex?: string;
  hotMemorySink?: (nodes: MemoryNode[]) => void;
  hotMemoryLimit?: number;
  hotMemoryMinWeight?: number;
  hotMemoryFilter?: (nodes: MemoryNode[]) => MemoryNode[];
  includeGit?: boolean;
  includeDate?: boolean;
  platform?: string;
}

export interface BuiltContext {
  systemPrompt: string;
  layers: ContextLayer[];
}

export function buildLayeredContext(input: ContextBuildInput): BuiltContext {
  const layers: ContextLayer[] = [];

  // Layer 1: System instructions
  if (input.systemInstructions) {
    layers.push({ name: "system", content: input.systemInstructions });
  }

  // Layer 2: Project rules (AGENTS.md)
  const projectRules = loadProjectRules(input.cwd);
  if (projectRules) {
    layers.push({ name: "project-rules", content: projectRules });
  }

  // Layer 3: Hot memory. This is first-class context, not a best-effort
  // search result. Keep it before skills/recall so user/project facts frame
  // later operating guidance.
  const hotMemory =
    input.userMemoryIndex ??
    loadHotMemory(input.paths, input.hotMemorySink, {
      limit: input.hotMemoryLimit,
      minWeight: input.hotMemoryMinWeight,
      filter: input.hotMemoryFilter
    });
  if (hotMemory) {
    layers.push({ name: "hot-memory", content: hotMemory });
  }

  // Layer 4: Dynamic memory (selected relevant memories)
  if (input.memoryContext) {
    layers.push({ name: "dynamic-memory", content: input.memoryContext });
  }

  // Layer 5: Git context
  if (input.includeGit !== false) {
    const git = getGitContext(input.cwd);
    if (git) {
      layers.push({ name: "git", content: git });
    }
  }

  // Layer 6: Environment
  const env = buildEnvironmentLayer(input);
  layers.push({ name: "environment", content: env });

  const systemPrompt = layers.map((l) => l.content).join("\n\n");
  return { systemPrompt, layers };
}

function loadProjectRules(cwd: string): string | undefined {
  const files = loadAgentInstructions(cwd);
  if (files.length === 0) {
    return undefined;
  }
  return formatAgentInstructions(files).trimEnd();
}

function loadHotMemory(
  paths?: MagiPaths,
  hotMemorySink?: (nodes: MemoryNode[]) => void,
  options: {
    limit?: number;
    minWeight?: number;
    filter?: (nodes: MemoryNode[]) => MemoryNode[];
  } = {}
): string | undefined {
  if (!paths) {
    return undefined;
  }
  if (options.limit !== undefined && options.limit <= 0) {
    return undefined;
  }
  const nodeMemory = formatNodeHotMemory(paths, hotMemorySink, options);
  if (!nodeMemory) {
    return undefined;
  }
  return [
    "[Hot Memory]",
    "Durable memory graph nodes. Treat these as high-priority context; current explicit user instructions can override them.",
    nodeMemory
  ]
    .join("\n\n")
    .slice(0, HOT_MEMORY_CHAR_LIMIT)
    .trimEnd();
}

function formatNodeHotMemory(
  paths: MagiPaths,
  hotMemorySink?: (nodes: MemoryNode[]) => void,
  options: {
    limit?: number;
    minWeight?: number;
    filter?: (nodes: MemoryNode[]) => MemoryNode[];
  } = {}
): string | undefined {
  let store: MemoryNodeStore | undefined;
  try {
    if (options.limit !== undefined && options.limit <= 0) {
      return undefined;
    }
    store = MemoryNodeStore.open(paths);
    const nodes = options.filter
      ? options.filter(store.listHotNodes({ limit: 50, minWeight: options.minWeight ?? 0.25 }))
      : store.listHotNodes({ limit: options.limit ?? 12, minWeight: options.minWeight ?? 0.25 });
    if (nodes.length === 0) {
      return undefined;
    }
    hotMemorySink?.(nodes);
    return ["## Weighted Memory Nodes", ...nodes.map(formatMemoryNode)].join("\n\n");
  } catch {
    return undefined;
  } finally {
    store?.close();
  }
}

function formatMemoryNode(node: MemoryNode): string {
  return [
    `### ${node.title}`,
    `id: ${node.id}`,
    `type: ${node.type}`,
    `weight: ${node.weight.toFixed(2)}`,
    `summary: ${node.summary}`,
    node.body
  ]
    .filter(Boolean)
    .join("\n");
}

export function getGitContext(cwd: string): string | undefined {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    let status: string;
    try {
      const raw = execSync("git status --porcelain -u", {
        cwd,
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
      const lines = raw.split("\n").filter(Boolean);
      if (lines.length === 0) {
        status = "clean";
      } else if (lines.length <= 10) {
        status = lines.join(", ");
      } else {
        status = `${lines.length} changed files`;
      }
    } catch {
      status = "unknown";
    }
    return `[Git] branch=${branch} status=${status}`;
  } catch {
    return undefined;
  }
}

function buildEnvironmentLayer(input: ContextBuildInput): string {
  const parts: string[] = [];
  if (input.includeDate !== false) {
    parts.push(`date=${new Date().toISOString().slice(0, 10)}`);
  }
  parts.push(`cwd=${input.cwd}`);
  if (input.platform) {
    parts.push(`platform=${input.platform}`);
  }
  return `[Environment] ${parts.join(" ")}`;
}
