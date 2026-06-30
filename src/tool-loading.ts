/**
 * Dynamic tool loading profiles.
 *
 * - full: legacy behavior (large fixed core, ~25 tools)
 * - medium: small bootstrap + workspace pack on each agent run
 * - minimal: bootstrap only; expand via ToolSearch
 */

export type ToolLoadProfile = "full" | "medium" | "minimal";

export const TOOL_BOOTSTRAP = [
  "ToolSearch",
  "WebSearch",
  "WebFetch",
  "FileRead",
  "Brief",
  "AskUserQuestion"
] as const;

export const TOOL_PACKS: Record<string, readonly string[]> = {
  workspace: ["Glob", "Grep", "WorkspaceDiagnostics", "Bash"],
  edit: ["FileWrite", "FileEdit", "FilePatch"],
  git: ["GitStatus", "GitDiff", "GitLog", "GitShow", "GitSummary"],
  memory: ["Memorize", "MemoryCorrect", "Skill", "DiscoverSkills"],
  plan: ["EnterPlanMode", "ExitPlanMode", "TodoWrite"]
};

/** Full fixed core (legacy `full` profile). */
export const FULL_TOOL_NAMES = [
  ...TOOL_BOOTSTRAP,
  "SendUserMessage",
  ...TOOL_PACKS.workspace,
  ...TOOL_PACKS.edit,
  ...TOOL_PACKS.git,
  ...TOOL_PACKS.memory,
  ...TOOL_PACKS.plan
] as const;

const PROFILE_START_PACKS: Record<ToolLoadProfile, readonly string[]> = {
  full: [],
  medium: ["workspace"],
  minimal: []
};

export function resolveToolLoadProfile(env: NodeJS.ProcessEnv = process.env): ToolLoadProfile {
  const raw = env.MAGI_TOOL_LOAD?.trim().toLowerCase();
  if (raw === "medium" || raw === "minimal" || raw === "full") {
    return raw;
  }
  return "full";
}

export function resolvePackToolNames(packName: string): string[] {
  const key = packName.trim().toLowerCase();
  const pack = TOOL_PACKS[key];
  if (!pack) {
    return [];
  }
  return [...pack];
}

export function listToolPackNames(): string[] {
  return Object.keys(TOOL_PACKS).sort();
}

export function resolveInitialExposedToolNames(
  profile: ToolLoadProfile = resolveToolLoadProfile()
): string[] {
  if (profile === "full") {
    return [...FULL_TOOL_NAMES];
  }
  const names = new Set<string>(TOOL_BOOTSTRAP);
  for (const packName of PROFILE_START_PACKS[profile]) {
    for (const toolName of resolvePackToolNames(packName)) {
      names.add(toolName);
    }
  }
  return [...names];
}

export function resolveLoadedToolNamesForSearch(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(resolveInitialExposedToolNames(resolveToolLoadProfile(env)));
}

export function parseToolSearchReveal(content: string): string[] {
  const packMatch = /^Pack:\s*([A-Za-z0-9_-]+)\s*\nTools:\s*(.+)$/m.exec(content);
  if (packMatch) {
    return packMatch[2]!
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
  }
  const toolMatch = /^Tool:\s*([A-Za-z0-9_]+)\s*$/m.exec(content);
  if (toolMatch?.[1]) {
    return [toolMatch[1]];
  }
  return [];
}

export function estimateToolSchemaTokens(
  toolNames: string[],
  lookup: (name: string) => unknown
): number {
  const tools = toolNames.map((name) => lookup(name)).filter(Boolean);
  return Math.ceil(JSON.stringify(tools).length / 4);
}
