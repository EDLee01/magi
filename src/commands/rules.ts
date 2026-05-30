import { formatAgentInstructions, loadAgentInstructions } from "../rules/agents-loader.js";
import { SlashCommandInput } from "./registry.js";

export const command = {
  name: "rules",
  description: "Show loaded project and user instructions",
  usage: "/rules",
  group: "Memory",
  handler: (_args: string[], input: SlashCommandInput): string => {
    return formatAgentInstructions(loadAgentInstructions(input.cwd)).trimEnd();
  }
};
