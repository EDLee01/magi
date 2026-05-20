import { SlashCommandInput } from "./registry.js";

export const command = {
  name: "compact",
  description: "Manually trigger context compaction for the current session",
  usage: "/compact",
  group: "Session",
  handler: (_args: string[], input: SlashCommandInput): string => {
    if (!input.sessionId) {
      return "No active session. Start a session first.";
    }
    if (!input.config.context?.autoCompactTokenThreshold) {
      return [
        "Context compaction is not configured.",
        "Add to config.yaml:",
        "  context:",
        "    autoCompactTokenThreshold: 1000",
        "    compactionModel: <alias>"
      ].join("\n");
    }
    return [
      "Manual compaction requested.",
      `Session: ${input.sessionId}`,
      `Threshold: ${input.config.context.autoCompactTokenThreshold} tokens`,
      `Compaction model: ${input.config.context.compactionModel ?? "default"}`,
      "",
      "Compaction will run on the next provider request for this session."
    ].join("\n");
  }
};
