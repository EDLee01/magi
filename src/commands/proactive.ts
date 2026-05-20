import { isProactiveEnabled, setProactiveEnabled } from "../proactive.js";
import { SlashCommandInput } from "./registry.js";

export const command = {
  name: "proactive",
  aliases: ["suggestions"],
  description: "Toggle proactive next-step suggestions after responses",
  usage: "/proactive [on|off]",
  group: "Editor",
  handler: (args: string[], _input: SlashCommandInput): string => {
    if (args.length === 0) {
      setProactiveEnabled(!isProactiveEnabled());
    } else if (args[0] === "on" || args[0] === "true") {
      setProactiveEnabled(true);
    } else if (args[0] === "off" || args[0] === "false") {
      setProactiveEnabled(false);
    } else {
      return `Unknown option: ${args[0]}. Use /proactive on, /proactive off, or /proactive`;
    }
    return `Proactive suggestions: ${isProactiveEnabled() ? "ON" : "OFF"}`;
  }
};
