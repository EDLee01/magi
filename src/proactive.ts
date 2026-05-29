/**
 * Proactive suggestion engine.
 * After a model response completes, suggests next steps based on what happened.
 */

export interface SuggestionContext {
  /** Tools that were used in the last response */
  toolNames: string[];
  /** Last message from the model */
  lastMessage?: string;
  /** Whether there were errors */
  hadErrors: boolean;
}

let proactiveEnabled = false;

export function isProactiveEnabled(): boolean {
  return proactiveEnabled;
}

export function setProactiveEnabled(enabled: boolean): void {
  proactiveEnabled = enabled;
}

export function getProactiveSuggestions(ctx: SuggestionContext): string[] {
  if (!proactiveEnabled) return [];

  const suggestions: string[] = [];
  const seen = new Set<string>();

  function add(label: string, command?: string) {
    const key = command ?? label;
    if (seen.has(key)) return;
    seen.add(key);
    suggestions.push(command ? `\x1b[36m${command}\x1b[39m — ${label}` : label);
  }

  const tools = new Set(ctx.toolNames.map((t) => t.toLowerCase()));

  // File operations
  if (tools.has("filewrite") || tools.has("fileedit") || tools.has("notebookedit")) {
    add("check diff", "/diff");
    add("run tests");
  }

  // Git operations
  if (
    tools.has("gitcommit") ||
    tools.has("gitstage") ||
    tools.has("gitbranchcreate") ||
    tools.has("gitcheckout")
  ) {
    add("view git log", "/diff");
    add("create branch", "/commit");
  }

  // Search/research
  if (tools.has("websearch") || tools.has("webfetch")) {
    add("summarize findings");
  }

  // Cron/background
  if (tools.has("croncreate") || tools.has("cronupdate")) {
    add("list scheduled tasks", "/cron list");
  }

  // Errors
  if (ctx.hadErrors) {
    add("review error output");
  }

  return suggestions;
}
