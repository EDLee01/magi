import { SlashCommandInput } from "./registry.js";

export const command = {
  name: "clear",
  aliases: ["reset", "new"],
  description: "Start a fresh session (clears current conversation context)",
  usage: "/clear",
  group: "Session",
  handler: (_args: string[], input: SlashCommandInput): string => {
    const newId = input.store.createSession({
      title: "",
      cwd: input.cwd,
      metadata: { mode: "interactive", clearedFrom: input.sessionId }
    });
    return [
      `Cleared context. Created new session: ${newId}`,
      `Previous session: ${input.sessionId ?? "none"}`,
      "The current session ID has been updated."
    ].join("\n");
  }
};
