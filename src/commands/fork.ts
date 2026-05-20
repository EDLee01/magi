import { SlashCommandInput } from "./registry.js";

export const command = {
  name: "fork",
  description: "Fork the current session — creates a copy you can branch from",
  usage: "/fork [new-title]",
  group: "Session",
  handler: (args: string[], input: SlashCommandInput): string => {
    if (!input.sessionId) return "No active session to fork.";
    const title = args.join(" ").trim() || undefined;
    const newId = input.store.forkSession({ sessionId: input.sessionId, title });
    if (!newId) return "Session not found.";
    return [
      `Forked session: ${newId}`,
      `Use 'magi resume ${newId}' (or /sessions to switch) to continue from the fork.`,
      "The current session remains unchanged."
    ].join("\n");
  }
};
