// Re-export layer for the modular slash command system.
// Maintains backward compatibility for existing code and tests.

import { MagiConfig } from "./config.js";
import { MemoryScope } from "./memory.js";
import { registry } from "./commands/registry.js";
import { MagiPaths } from "./paths.js";
import { SessionStore } from "./session-store.js";

export {
  registry,
  parseCommandLine,
  formatModelTarget,
  formatModelPicker,
  resolveModelPickerSelection,
  formatSessionSearch,
  resolveSessionPickerSelection
} from "./commands/registry.js";
export type { SlashCommandInput, SlashCommandModule } from "./commands/registry.js";
import { registerAllCommands } from "./commands/register-all.js";
export { registerAllCommands };
registerAllCommands();

// --- Backward-compatible types ---

export type SlashCommand =
  | { type: "help" }
  | { type: "status" }
  | { type: "model"; alias?: string }
  | { type: "resume"; sessionId?: string }
  | { type: "memory"; scope?: MemoryScope }
  | { type: "review" }
  | { type: "sessions" }
  | { type: "clear" }
  | { type: "summary" }
  | { type: "cost" }
  | { type: "doctor" }
  | { type: "compact" }
  | { type: "goal"; args: string[] }
  | { type: "commit"; args: string[] }
  | { type: "diff"; args: string[] }
  | { type: "unknown"; name: string };

export interface SlashCommandSpec {
  name: string;
  usage: string;
  group: string;
  description: string;
}

// --- Backward-compatible constants ---

export const SLASH_COMMANDS: SlashCommandSpec[] = [
  {
    name: "help",
    usage: "/help [command]",
    group: "Help",
    description: "Show command groups and shortcuts"
  },
  {
    name: "status",
    usage: "/status",
    group: "Session",
    description: "Show cwd, providers, aliases, and state"
  },
  { name: "sessions", usage: "/sessions", group: "Session", description: "List recent sessions" },
  {
    name: "resume",
    usage: "/resume [query]",
    group: "Session",
    description: "Search and resume a session"
  },
  {
    name: "context",
    usage: "/context",
    group: "Context",
    description: "Show token budget and context categories"
  },
  {
    name: "model",
    usage: "/model [alias]",
    group: "Model",
    description: "Show or switch model alias"
  },
  {
    name: "memory",
    usage: "/memory [init|list|show|search|drafts|draft|dream|dreams]",
    group: "Memory",
    description: "Manage Memory files, drafts, and Dream runs"
  },
  {
    name: "rules",
    usage: "/rules",
    group: "Memory",
    description: "Show loaded project and user instructions"
  },
  {
    name: "review",
    usage: "/review [target]",
    group: "Tools",
    description: "Switch to review-oriented route"
  },
  {
    name: "run",
    usage: "/run <command>",
    group: "Tools",
    description: "Run commands through the local runner bridge"
  },
  {
    name: "mcp",
    usage: "/mcp [list|tools|resources]",
    group: "Extensions",
    description: "Inspect MCP servers"
  },
  {
    name: "plugins",
    usage: "/plugins",
    group: "Extensions",
    description: "List installed local plugins"
  },
  {
    name: "skills",
    usage: "/skills [name]",
    group: "Skills",
    description: "List installed skills"
  },
  {
    name: "agents",
    usage: "/agents",
    group: "Agents",
    description: "List available sub-agent types"
  },
  {
    name: "commit",
    usage: "/commit [-m <msg>]",
    group: "Git",
    description: "Commit staged git changes"
  },
  { name: "diff", usage: "/diff [path]", group: "Git", description: "Show git diff" },
  { name: "clear", usage: "/clear", group: "Session", description: "Start a fresh session" },
  { name: "summary", usage: "/summary", group: "Session", description: "Show session summary" },
  {
    name: "goal",
    usage: "/goal <objective> | /goal",
    group: "Session",
    description: "Start or show the current session goal"
  },
  { name: "cost", usage: "/cost", group: "Session", description: "Show job and cost info" },
  { name: "doctor", usage: "/doctor", group: "Tools", description: "Run workspace diagnostics" },
  {
    name: "compact",
    usage: "/compact",
    group: "Session",
    description: "Trigger context compaction"
  },
  { name: "exit", usage: "/exit", group: "Help", description: "Exit the interactive terminal" }
];

// --- Backward-compatible functions ---

/**
 * Parse a /-prefixed input into a backward-compatible SlashCommand.
 */
export function parseSlashCommand(input: string): SlashCommand | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const [name, ...rest] = trimmed.slice(1).split(/\s+/);
  const n = name?.toLowerCase() ?? "";

  if (n === "" || n === "help") return { type: "help" };
  if (n === "status") return { type: "status" };
  if (n === "model") return { type: "model", alias: rest[0] };
  if (n === "sessions") return { type: "sessions" };
  if (n === "resume") return { type: "resume", sessionId: rest[0] };
  if (n === "context") return { type: "unknown", name: "context" };
  if (n === "memory") {
    const scope =
      rest[0] === "user" || rest[0] === "project" || rest[0] === "session" ? rest[0] : undefined;
    return { type: "memory", scope };
  }
  if (n === "rules") return { type: "unknown", name: "rules" };
  if (n === "review") return { type: "review" };
  if (n === "run") return { type: "unknown", name: "run" };
  if (n === "mcp") return { type: "unknown", name: "mcp" };
  if (n === "plugins") return { type: "unknown", name: "plugins" };
  if (n === "skills" || n === "skill") return { type: "unknown", name: n };
  if (n === "agents") return { type: "unknown", name: "agents" };
  if (n === "clear" || n === "reset" || n === "new") return { type: "clear" };
  if (n === "commit") return { type: "commit", args: rest };
  if (n === "diff") return { type: "diff", args: rest };
  if (n === "summary") return { type: "summary" };
  if (n === "cost") return { type: "cost" };
  if (n === "doctor") return { type: "doctor" };
  if (n === "compact") return { type: "compact" };
  if (n === "goal") return { type: "goal", args: rest };
  return { type: "unknown", name: n };
}

/**
 * Backward-compatible slash command dispatcher.
 */
export function runSlashCommand(input: {
  command: SlashCommand;
  config: MagiConfig;
  store: SessionStore;
  cwd: string;
  paths?: MagiPaths;
  sessionId?: string;
  currentModel?: string;
}): string {
  const { command, ...context } = input;
  const cmd = command; // avoid shadowing the import
  const registryContext = {
    config: context.config,
    store: context.store,
    cwd: context.cwd,
    paths: context.paths,
    sessionId: context.sessionId,
    currentModel: context.currentModel
  };

  const name = cmd.type === "unknown" ? cmd.name : cmd.type;
  let args: string[] = [];
  if (cmd.type === "model") args = cmd.alias ? [cmd.alias] : [];
  else if (cmd.type === "resume") args = cmd.sessionId ? [cmd.sessionId] : [];
  else if (cmd.type === "memory") args = cmd.scope ? [cmd.scope] : [];
  else if (cmd.type === "goal") args = cmd.args ?? [];
  else if (cmd.type === "commit") args = cmd.args ?? [];
  else if (cmd.type === "diff") args = cmd.args ?? [];

  const result = registry.dispatch(name, args, registryContext);
  if (result === undefined) {
    return `Unknown slash command: /${command.type === "unknown" ? command.name : command.type}`;
  }
  if (typeof result === "string") return result;
  // Async dispatch result not supported in back-compat sync path
  return `Slash command /${name} requires interactive mode (it returns asynchronously). Use the TUI to invoke it.`;
}

/**
 * Backward-compatible slash suggestion formatter.
 */
export function formatSlashSuggestions(query = ""): string {
  const normalized = query.replace(/^\//, "").trim().toLowerCase();
  const matches = SLASH_COMMANDS.filter((cmd) => {
    if (!normalized) return true;
    return (
      cmd.name.includes(normalized) ||
      cmd.usage.toLowerCase().includes(normalized) ||
      cmd.description.toLowerCase().includes(normalized) ||
      cmd.group.toLowerCase().includes(normalized)
    );
  });
  if (matches.length === 0) {
    return `No slash commands match /${normalized}\n`;
  }
  return [
    `Slash commands${normalized ? ` matching /${normalized}` : ""}:`,
    ...matches.map((cmd, index) => {
      const marker = index === 0 ? ">" : " ";
      return `${marker} ${cmd.usage.padEnd(28)} ${cmd.group.padEnd(8)} ${cmd.description}`;
    }),
    "Use /help for groups, /resume <query> to search sessions, /exit to quit."
  ].join("\n");
}
