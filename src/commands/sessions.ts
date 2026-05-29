import {
  formatSessionSearch,
  resolveSessionPickerSelection,
  SlashCommandInput
} from "./registry.js";

export const command = {
  name: "sessions",
  aliases: ["resume"],
  description: "List recent sessions or search and resume a session",
  usage: "/sessions\n/resume [query|id|number]",
  group: "Session",
  handler: (args: string[], input: SlashCommandInput): string => {
    if (args.length > 0) {
      const selected = resolveSessionPickerSelection(input.store, args[0]);
      if (selected) {
        return `Resumed ${selected.id}: ${selected.title ?? "(untitled)"}`;
      }
      return formatSessionSearch(input.store, args[0]);
    }
    // No args: /sessions shows short list, /resume shows search prompt
    // We can't detect which alias was used, so show the search format (the richer output)
    const sessions = input.store.listSessions(10);
    if (sessions.length === 0) {
      return "No sessions";
    }
    return formatSessionSearch(input.store, "");
  }
};
