import { SlashCommandInput } from "./registry.js";
import { listPermissionRules, clearPermissionRules, removePermissionRule } from "../permissions.js";

export const command = {
  name: "permissions",
  aliases: ["perms"],
  description: "View or manage persistent permission rules",
  usage: "/permissions [clear|remove <tool>]",
  group: "Config",
  handler: (args: string[], _input: SlashCommandInput): string => {
    if (args[0] === "clear") {
      clearPermissionRules();
      return "Cleared all permission rules.";
    }
    if (args[0] === "remove" && args[1]) {
      const removed = removePermissionRule(args[1]);
      return removed ? `Removed rule for "${args[1]}".` : `No rule found for "${args[1]}".`;
    }

    const rules = listPermissionRules();
    if (rules.length === 0) {
      return "No persistent permission rules. Use 'a' (always) when approving a tool to add one.";
    }

    const lines = ["Persistent permission rules:", ""];
    for (const rule of rules) {
      const date = new Date(rule.createdAt).toLocaleDateString();
      lines.push(`  ${rule.tool.padEnd(24)} (added ${date})`);
    }
    lines.push("", "Use /permissions clear to remove all, or /permissions remove <tool> to remove one.");
    return lines.join("\n");
  }
};
