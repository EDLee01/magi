import { SlashCommandInput } from "./registry.js";

export const command = {
  name: "rename",
  description: "Rename the current session",
  usage: "/rename <new-title>",
  group: "Session",
  handler: (args: string[], input: SlashCommandInput): string => {
    if (!input.sessionId) return "No active session.";
    const title = args.join(" ").trim();
    if (!title) return "Usage: /rename <new-title>";
    const ok = input.store.renameSession(input.sessionId, title);
    return ok ? `Session renamed to: ${title}` : "Session not found.";
  }
};
