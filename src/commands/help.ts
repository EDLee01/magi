import { registry, SlashCommandInput } from "./registry.js";

export const command = {
  name: "help",
  description: "Show command groups and shortcuts",
  usage: "/help [command]",
  group: "Help",
  handler: (args: string[], input: SlashCommandInput): string => {
    if (args.length > 0) {
      return showCommandDetail(args[0]);
    }
    const hint = checkProviderHints(input);
    return hint + showAllCommands();
  }
};

function showAllCommands(): string {
  const commands = registry.getAll();
  // Group commands
  const groups = new Map<string, typeof commands>();
  for (const cmd of commands) {
    const list = groups.get(cmd.group) ?? [];
    list.push(cmd);
    groups.set(cmd.group, list);
  }

  const lines: string[] = ["Slash commands:"];
  for (const [group, cmds] of groups) {
    lines.push("");
    lines.push(`  ${group}:`);
    for (const cmd of cmds) {
      lines.push(`    ${cmd.usage.padEnd(28)} ${cmd.description}`);
    }
  }
  lines.push("");
  lines.push("  Use /help <command> for details on a specific command.");
  lines.push("  Use /exit to quit.");
  return lines.join("\n");
}

function checkProviderHints(input: SlashCommandInput): string {
  const aliases = input.config.models?.aliases ?? {};
  const aliasCount = Object.keys(aliases).length;
  const providers = input.config.providers ?? {};
  const providerCount = Object.keys(providers).length;
  if (providerCount === 0 || aliasCount === 0) {
    return [
      "⚠ No provider is configured.",
      "  Run 'magi init' to set up a provider + API key.",
      "  Or set ANTHROPIC_AUTH_TOKEN in your shell and run 'magi init' again.",
      ""
    ].join("\n");
  }
  return "";
}

function showCommandDetail(name: string): string {
  const cmd = registry.get(name);
  if (!cmd) {
    return `Unknown command: /${name}. Use /help to list all commands.`;
  }
  const aliases =
    cmd.aliases && cmd.aliases.length > 0
      ? ` (aliases: ${cmd.aliases.map((a) => `/${a}`).join(", ")})`
      : "";
  return [
    `/${cmd.name}${aliases}`,
    `  ${cmd.description}`,
    `  Usage: ${cmd.usage}`,
    `  Group: ${cmd.group}`
  ].join("\n");
}
