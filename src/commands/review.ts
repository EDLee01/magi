import { SlashCommandInput } from "./registry.js";

export const command = {
  name: "review",
  description: "Switch to review-oriented route",
  usage: "/review [target]",
  group: "Tools",
  handler: (args: string[], _input: SlashCommandInput): string => {
    if (args.length > 0) {
      return `Review route: use /model review, then describe what to review for ${args.join(" ")}.`;
    }
    return "Review route: use /model review, then describe what to review.";
  }
};
