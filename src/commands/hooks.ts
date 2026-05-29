import { SlashCommandInput } from "./registry.js";

export const command = {
  name: "hooks",
  description: "List configured hooks (pre/post tool use, session events, etc.)",
  usage: "/hooks [event]",
  group: "Configuration",
  handler: (args: string[], input: SlashCommandInput): string => {
    const hooks = input.config.hooks ?? [];
    if (hooks.length === 0) {
      return [
        "No hooks configured.",
        "",
        `Hooks fire on lifecycle events. Add them in ~/.magi-next/config.yaml:`,
        "",
        "  hooks:",
        "    - event: pre_tool_use",
        "      type: command",
        "      command: ./scripts/check-tool.sh",
        "      if: \"toolName == 'Bash'\"",
        "",
        "Supported events:",
        "  pre_tool_use, post_tool_use, post_tool_use_failure",
        "  session_start, session_end, user_prompt_submit",
        "  pre_compact, post_compact",
        "  permission_request, permission_denied",
        "  config_change, notification",
        "",
        "See documentation for the full list of events and context fields."
      ].join("\n");
    }

    const filterEvent = args[0];
    const filtered = filterEvent ? hooks.filter((h) => h.event === filterEvent) : hooks;

    if (filtered.length === 0) {
      return `No hooks for event: ${filterEvent}`;
    }

    const byEvent = new Map<string, typeof hooks>();
    for (const h of filtered) {
      const list = byEvent.get(h.event) ?? [];
      list.push(h);
      byEvent.set(h.event, list);
    }

    const lines = [`Configured hooks (${filtered.length}):`];
    for (const [event, list] of byEvent) {
      lines.push("");
      lines.push(`  ${event}:`);
      for (const h of list) {
        const condition = h.if ? `  if: ${h.if}` : "";
        const detail =
          h.type === "command" ? `${h.command}${condition}` : `[${h.type}]${condition}`;
        lines.push(`    - ${detail}`);
      }
    }
    return lines.join("\n");
  }
};
