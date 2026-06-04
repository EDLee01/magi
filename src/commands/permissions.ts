import { SlashCommandInput } from "./registry.js";
import { listPermissionRules, clearPermissionRules, removePermissionRule } from "../permissions.js";
import { shellDisplayName } from "../platform/shell.js";
import { ToolPermissionMode } from "../tools/registry.js";

export const PERMISSION_MODES: ToolPermissionMode[] = [
  "default",
  "acceptEdits",
  "dontAsk",
  "bypassPermissions",
  "plan"
];

const PERMISSION_MODE_LABELS: Record<ToolPermissionMode, string> = {
  default: "Default",
  acceptEdits: "Accept Edits",
  dontAsk: "Don't Ask",
  bypassPermissions: "Full Access",
  plan: "Plan"
};

const PERMISSION_MODE_ALIASES: Record<string, ToolPermissionMode> = {
  default: "default",
  acceptedits: "acceptEdits",
  accept: "acceptEdits",
  dontask: "dontAsk",
  bypass: "bypassPermissions",
  bypasspermissions: "bypassPermissions",
  fullaccess: "bypassPermissions",
  full: "bypassPermissions",
  yolo: "bypassPermissions",
  plan: "plan"
};

export function parsePermissionMode(value: string | undefined): ToolPermissionMode | undefined {
  if (!value) return undefined;
  return PERMISSION_MODE_ALIASES[normalizePermissionMode(value)];
}

export function formatPermissionModeLabel(mode: ToolPermissionMode): string {
  return PERMISSION_MODE_LABELS[mode];
}

export function formatPermissionModeUpdate(mode: ToolPermissionMode): string {
  return `Permissions updated to ${formatPermissionModeLabel(mode)}`;
}

export function formatPermissionMode(mode: ToolPermissionMode): string {
  switch (mode) {
    case "default":
      return "Default - ask before non-read-only tools";
    case "acceptEdits":
      return "Accept Edits - allow ordinary edits and commands without approval";
    case "dontAsk":
      return "Don't Ask - deny non-read-only tools instead of asking";
    case "bypassPermissions":
      return `Full Access - skip approval prompts; dangerous ${shellDisplayName()} still needs explicit env approval`;
    case "plan":
      return "Plan - deny write tools";
  }
}

export const command = {
  name: "permissions",
  aliases: ["perms"],
  description: "View or manage persistent permission rules",
  usage:
    "/permissions [mode [default|acceptEdits|dontAsk|fullAccess|bypassPermissions|yolo|plan]|clear|remove <tool>]",
  group: "Config",
  handler: (args: string[], input: SlashCommandInput): string => {
    if (args[0] === "mode") {
      const requestedMode = args.slice(1).join(" ");
      const mode = parsePermissionMode(requestedMode);
      if (requestedMode && !mode) {
        return `Unknown permission mode: ${requestedMode}\n${formatPermissionModeList(input.permissionMode ?? "default")}`;
      }
      if (mode) {
        return formatPermissionModeUpdate(mode);
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

    const lines = [
      `Permission mode: ${formatPermissionMode(input.permissionMode ?? "default")}`,
      "",
      "Persistent permission rules:",
      ""
    ];
    for (const rule of rules) {
      const date = new Date(rule.createdAt).toLocaleDateString();
      lines.push(`  ${rule.tool.padEnd(24)} (added ${date})`);
    }
    lines.push(
      "",
      "Use /permissions mode to switch modes, /permissions clear to remove all, or /permissions remove <tool> to remove one."
    );
    return lines.join("\n");
  }
};

function formatPermissionModeList(currentMode: ToolPermissionMode): string {
  return [
    `Permission mode: ${formatPermissionMode(currentMode)}`,
    "",
    "Available permission modes:",
    ...PERMISSION_MODES.map((mode) => {
      const marker = mode === currentMode ? ">" : " ";
      return `${marker} ${formatPermissionMode(mode)}`;
    }),
    "",
    "Use /permissions mode <mode>."
  ].join("\n");
}

function normalizePermissionMode(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}
