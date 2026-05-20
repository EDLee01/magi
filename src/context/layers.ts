/**
 * 6-layer context builder for the agent system prompt.
 *
 * Layers (in order):
 * 1. System instructions (core behavior rules)
 * 2. Project rules (AGENTS.md / .magi/rules/)
 * 3. User memory index (MEMORY.md)
 * 4. Dynamic memory (LLM-selected relevant memories)
 * 5. Git context (branch, status)
 * 6. Environment (date, cwd, platform)
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

import { loadAgentInstructions, formatAgentInstructions } from "../rules/agents-loader.js";
import { MagiPaths } from "../paths.js";

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

  // Layer 3: User memory index
  const memoryIndex = input.userMemoryIndex ?? loadUserMemoryIndex(input.paths);
  if (memoryIndex) {
    layers.push({ name: "memory-index", content: `[User memory]\n${memoryIndex}` });
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

function loadUserMemoryIndex(paths?: MagiPaths): string | undefined {
  if (!paths) {
    return undefined;
  }
  const indexFile = path.join(paths.root, "memory.md");
  if (!existsSync(indexFile)) {
    return undefined;
  }
  const content = readFileSync(indexFile, "utf8").trim();
  return content || undefined;
}

export function getGitContext(cwd: string): string | undefined {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    let status: string;
    try {
      const raw = execSync("git status --porcelain -u", {
        cwd,
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
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
