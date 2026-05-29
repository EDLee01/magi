import { MagiConfig } from "../config.js";
import { MagiPaths } from "../paths.js";
import { SessionStore, SessionSummary } from "../session-store.js";
import { ToolPermissionMode } from "../tools/registry.js";

export interface SlashCommandInput {
  cwd: string;
  config: MagiConfig;
  store: SessionStore;
  paths?: MagiPaths;
  sessionId?: string;
  currentModel?: string;
  permissionMode?: ToolPermissionMode;
  env?: NodeJS.ProcessEnv;
}

export interface SlashCommandModule {
  name: string;
  aliases?: string[];
  description: string;
  usage: string;
  group: string;
  handler: (args: string[], input: SlashCommandInput) => string | Promise<string>;
}

class SlashCommandRegistryImpl {
  private modules = new Map<string, SlashCommandModule>();

  register(cmd: SlashCommandModule): void {
    this.modules.set(cmd.name, cmd);
    for (const alias of cmd.aliases ?? []) {
      this.modules.set(alias, cmd);
    }
  }

  get(name: string): SlashCommandModule | undefined {
    return this.modules.get(name);
  }

  dispatch(
    name: string,
    args: string[],
    input: SlashCommandInput
  ): string | Promise<string> | undefined {
    const cmd = this.modules.get(name);
    if (!cmd) return undefined;
    return cmd.handler(args, input);
  }

  getAll(): SlashCommandModule[] {
    const seen = new Set<string>();
    const result: SlashCommandModule[] = [];
    for (const cmd of this.modules.values()) {
      if (!seen.has(cmd.name)) {
        seen.add(cmd.name);
        result.push(cmd);
      }
    }
    return result;
  }

  getCompletions(partial: string): string[] {
    const normalized = partial.toLowerCase();
    const seen = new Set<string>();
    const result: string[] = [];
    for (const cmd of this.modules.values()) {
      if (
        !seen.has(cmd.name) &&
        (cmd.name.startsWith(normalized) ||
          (cmd.aliases ?? []).some((a) => a.startsWith(normalized)))
      ) {
        seen.add(cmd.name);
        result.push(cmd.usage);
      }
    }
    if (result.length === 0) {
      for (const cmd of this.modules.values()) {
        if (!seen.has(cmd.name)) {
          seen.add(cmd.name);
          result.push(cmd.usage);
        }
      }
    }
    return result;
  }

  getCommandNames(): string[] {
    const seen = new Set<string>();
    for (const cmd of this.modules.values()) {
      seen.add(cmd.name);
    }
    return [...seen];
  }

  /**
   * Find the closest registered command name for a typoed input.
   * Returns the suggestion only if it's clearly close (≤2 edit distance for short
   * names, ≤3 for longer ones). Returns undefined if nothing's close.
   */
  suggestCommand(input: string): string | undefined {
    const normalized = input.toLowerCase().replace(/^\//, "");
    if (!normalized) return undefined;
    // Include all names + aliases
    const candidates = [...this.modules.keys()];
    let best: { name: string; distance: number } | undefined;
    for (const name of candidates) {
      // Cheap pre-filter: lengths must be similar
      if (Math.abs(name.length - normalized.length) > 3) continue;
      // Prefix match wins immediately if input is a strict prefix
      if (name.startsWith(normalized) && normalized.length >= 2) {
        return name;
      }
      const distance = levenshtein(normalized, name);
      if (!best || distance < best.distance) {
        best = { name, distance };
      }
    }
    if (!best) return undefined;
    const threshold = normalized.length <= 4 ? 1 : normalized.length <= 7 ? 2 : 3;
    return best.distance <= threshold ? best.name : undefined;
  }
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Two-row DP
  let prev = new Array(b.length + 1).fill(0);
  let curr = new Array(b.length + 1).fill(0);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1, // insert
        prev[j] + 1, // delete
        prev[j - 1] + cost // substitute
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

export const registry = new SlashCommandRegistryImpl();

/**
 * Parse a raw /-prefixed input line into (name, args).
 * Returns undefined for non-slash input.
 */
export function parseCommandLine(input: string): { name: string; args: string[] } | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }
  const afterSlash = trimmed.slice(1).trimStart();
  if (afterSlash === "") {
    return { name: "", args: [] };
  }
  const parts = afterSlash.split(/\s+/);
  // Absolute paths like /Users/ktz/... are not slash commands
  if (parts[0]!.includes("/")) {
    return undefined;
  }
  return { name: parts[0]!.toLowerCase(), args: parts.slice(1) };
}

// --- Shared formatting utilities (used by TUI and CLI) ---

export function formatModelTarget(
  config: { models: { aliases: Record<string, string> } },
  alias: string
): string {
  return config.models.aliases[alias] ?? alias;
}

export function formatModelPicker(
  config: { models: { aliases: Record<string, string>; router?: Record<string, unknown> } },
  currentModel = "main"
): string {
  const aliases = Object.entries(config.models.aliases);
  if (aliases.length === 0) {
    return "No model aliases configured.\nUse /model <provider:model> after configuring the provider.";
  }
  const lines: string[] = ["Model picker:"];
  // Show "auto" as the first option when router is configured
  const autoConfigured = config.models.router && Object.keys(config.models.router).length > 0;
  let index = 1;
  if (autoConfigured) {
    const marker = currentModel === "auto" ? ">" : " ";
    lines.push(
      `${marker} ${String(index).padStart(2)} ${"auto".padEnd(16)} ${"smart routing".padEnd(24)} ${Object.keys(config.models.router!).length} candidates`
    );
    index += 1;
  }
  for (const [alias, target] of aliases) {
    const marker = alias === currentModel ? ">" : " ";
    lines.push(
      `${marker} ${String(index).padStart(2)} ${alias.padEnd(16)} ${target.padEnd(24)} configured`
    );
    index += 1;
  }
  lines.push("Use /model <alias>.");
  if (autoConfigured) {
    lines.push("Use /route to inspect routing decisions.");
  }
  return lines.join("\n");
}

export function resolveModelPickerSelection(
  config: { models: { aliases: Record<string, string>; router?: Record<string, unknown> } },
  value: string
): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const autoConfigured = config.models.router && Object.keys(config.models.router).length > 0;
  // Allow "auto" when router is configured
  if (trimmed === "auto" && autoConfigured) {
    return "auto";
  }
  const aliases = Object.keys(config.models.aliases);
  if (/^\d+$/.test(trimmed)) {
    const num = Number(trimmed);
    // Position 1 is "auto" if router is configured, then user aliases
    if (autoConfigured) {
      if (num === 1) return "auto";
      return aliases[num - 2];
    }
    return aliases[num - 1];
  }
  if (config.models.aliases[trimmed]) return trimmed;
  return undefined;
}

export function formatSessionSearch(store: SessionStore, query: string): string {
  const normalized = query.trim().toLowerCase();
  const sessions = store.listSessions(25).filter((session) => {
    if (!normalized) return true;
    return (
      session.id.toLowerCase().includes(normalized) ||
      (session.title ?? "").toLowerCase().includes(normalized) ||
      session.cwd.toLowerCase().includes(normalized)
    );
  });
  if (sessions.length === 0) {
    return normalized ? `No sessions match ${query}` : "No sessions";
  }
  return [
    normalized ? `Resume sessions matching ${query}:` : "Resume sessions:",
    ...sessions.map((session, index) => {
      const marker = `${index + 1}.`.padStart(3);
      return `${marker} ${session.id}  ${session.updatedAt}  ${session.messageCount} msg  ${session.title ?? "(untitled)"}  ${session.cwd}`;
    }),
    "Use /resume <number>, /resume <session-id>, or /resume <search text>."
  ].join("\n");
}

export function resolveSessionPickerSelection(
  store: SessionStore,
  query: string
): SessionSummary | undefined {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return undefined;
  const sessions = store.listSessions(25);
  const exactSession = store.getSession(query.trim());
  const direct =
    sessions.find((session) => session.id === query.trim()) ??
    (exactSession
      ? {
          id: exactSession.id,
          title: exactSession.title,
          cwd: exactSession.cwd,
          createdAt: exactSession.createdAt,
          updatedAt: exactSession.updatedAt,
          messageCount: exactSession.messages.length
        }
      : undefined);
  if (direct) return direct;
  if (/^\d+$/.test(normalized)) {
    const index = Number(normalized) - 1;
    if (index >= 0 && index < sessions.length) return sessions[index];
  }
  const matches = sessions.filter(
    (session) =>
      session.id.toLowerCase().includes(normalized) ||
      (session.title ?? "").toLowerCase().includes(normalized) ||
      session.cwd.toLowerCase().includes(normalized)
  );
  return matches.length === 1 ? matches[0] : undefined;
}
