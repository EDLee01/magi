import { formatPluginList, listLocalPlugins } from "../plugins/manifest.js";
import { SlashCommandInput } from "./registry.js";

export const command = {
  name: "plugins",
  description: "List installed local plugins",
  usage: "/plugins",
  group: "Extensions",
  handler: (_args: string[], input: SlashCommandInput): string => {
    if (!input.paths) {
      return "Plugin paths are unavailable";
    }
    return formatPluginList(listLocalPlugins(input.paths)).trimEnd();
  }
};
