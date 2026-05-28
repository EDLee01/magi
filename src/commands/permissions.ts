import { SlashCommandInput } from "./registry.js";
import { listPermissionRules, clearPermissionRules, removePermissionRule } from "../permissions.js";
import { ToolPermissionMode } from "../tools/registry.js";

export const PERMISSION_MODES: ToolPermissionMode[] = ["default", "acceptEdits", "bypassPermissions", "plan"];

export function parsePermissionMode(value: string | undefined): ToolPermissionMode | undefined {
  return PERMISSION_MODES.find(mode => mode.toLowerCase() === value?.toLowerCase());
}

export function formatPermissionMode(mode: ToolPermissionMode): string {
  switch (mode) {
    case "default":
      return "default - ask before non-read-only tools";
    case "acceptEdits":
      return "acceptEdits - allow tool edits without approval";
    case "bypassPermissions":
      return "bypassPermissions - skip approval prompts";
    case "plan":
      return "plan - deny write tools";
  }
}

export const command = {
  name: "permissions",
  aliases: ["perms"],
  description: "View or manage persistent permission rules",
  usage: "/permissions [mode [default|acceptEdits|bypassPermissions|plan]|clear|remove <tool>]",
  group: "Config",
  handler: (args: string[], input: SlashCommandInput): string => {
    if (args[0] === "mode") {
      const mode = parsePermissionMode(args[1]);
      if (args[1] && !mode) {
        return `Unknown permission mode: ${args[1]}\n${formatPermissionModeList(input.permissionMode ?? "default")}`;
      }
      if (mode) {
        return `Permission mode: ${formatPermissionMode(mode)}`;
      }
      return formatPermissionModeList(input.permissionMode ?? "default");
    }
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
      return [
        `Permission mode: ${formatPermissionMode(input.permissionMode ?? "default")}`,
        "",
        "No persistent permission rules. Use 'a' (always) when approving a tool to add one.",
        "Use /permissions mode to switch modes."
      ].join("\n");
    }

    const lines = [`Permission mode: ${formatPermissionMode(input.permissionMode ?? "default")}`, "", "Persistent permission rules:", ""];
    for (const rule of rules) {
      const date = new Date(rule.createdAt).toLocaleDateString();
      lines.push(`  ${rule.tool.padEnd(24)} (added ${date})`);
    }
    lines.push("", "Use /permissions mode to switch modes, /permissions clear to remove all, or /permissions remove <tool> to remove one.");
    return lines.join("\n");
  }
};

function formatPermissionModeList(currentMode: ToolPermissionMode): string {
  return [
    `Permission mode: ${formatPermissionMode(currentMode)}`,
    "",
    "Available permission modes:",
    ...PERMISSION_MODES.map(mode => {
      const marker = mode === currentMode ? ">" : " ";
      return `${marker} ${formatPermissionMode(mode)}`;
    }),
    "",
    "Use /permissions mode <mode>."
  ].join("\n");
}
