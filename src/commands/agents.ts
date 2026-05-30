import { SlashCommandInput } from "./registry.js";

const SUBAGENT_TYPES = [
  {
    name: "general",
    description:
      "General-purpose sub-agent. Inherits the parent's model. Best for arbitrary tasks the model wants to delegate."
  },
  {
    name: "explore",
    description:
      "Read-only investigation. Routed to the 'fast' alias for cheap, broad searches across files."
  },
  {
    name: "plan",
    description:
      "Strategic planning. Routed to the 'deep' alias (Opus). Returns a step-by-step implementation plan."
  },
  {
    name: "verification",
    description:
      "Build/test/lint and report PASS/FAIL/PARTIAL with evidence. Routed to the 'review' alias."
  }
];

export const command = {
  name: "agents",
  aliases: ["subagents"],
  description: "List sub-agent types available to the Agent tool",
  usage: "/agents",
  group: "Agents",
  handler: (_args: string[], _input: SlashCommandInput): string => {
    const lines = ["Sub-agent types (use as Agent({subagent_type: ...})):", ""];
    for (const t of SUBAGENT_TYPES) {
      lines.push(`  ${t.name.padEnd(14)} ${t.description}`);
    }
    lines.push("");
    lines.push("Optional Agent params:");
    lines.push(
      "  target: <peer-name>     dispatch to a remote daemon (use ListPeers / `magi peers`)"
    );
    lines.push("  run_in_background: true fire-and-forget; check /tasks for the result");
    return lines.join("\n");
  }
};
