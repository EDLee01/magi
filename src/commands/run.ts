import { SlashCommandInput } from "./registry.js";

export const command = {
  name: "run",
  aliases: ["runner"],
  description: "Run shell commands through the local runner bridge",
  usage: "/run <command>",
  group: "Tools",
  handler: (args: string[], _input: SlashCommandInput): string => {
    if (args.length === 0) {
      return [
        "Usage: /run <command>",
        "",
        "Interactive runner execution is available through the CLI:",
        "  magi runner run <command>",
        "",
        "For normal agent work, ask Magi to run a command so permissions and audit are preserved."
      ].join("\n");
    }
    return [
      `Runner command requested: ${args.join(" ")}`,
      "Use `magi runner run <command>` for direct runner execution, or ask Magi in plain language so tool permissions apply."
    ].join("\n");
  }
};
