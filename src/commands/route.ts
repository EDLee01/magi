import path from "node:path";
import { existsSync } from "node:fs";

import { SlashCommandInput } from "./registry.js";
import { SessionStore } from "../session-store.js";
import { classifyTask, routeAutoDetailed } from "../routing/model-router.js";

export const command = {
  name: "route",
  aliases: ["routing"],
  description: "Show recent auto-routing decisions or test routing for a prompt",
  usage: "/route [test <prompt> | recent]",
  group: "Configuration",
  handler: (args: string[], input: SlashCommandInput): string => {
    const sub = args[0] ?? "recent";

    if (sub === "test") {
      const prompt = args.slice(1).join(" ").trim();
      if (!prompt) {
        return "Usage: /route test <prompt>";
      }
      const decision = routeAutoDetailed(input.config, prompt, {});
      if (!decision) {
        return [
          "Auto-routing not available — no models.router configured.",
          "",
          "Add a router config in ~/.magi-next/config.yaml:",
          "  models:",
          "    router:",
          "      fast:  { family: claude, role: haiku, contextWindow: 200000, supportsVision: true }",
          "      main:  { family: claude, role: sonnet, contextWindow: 200000, supportsVision: true }",
          "      deep:  { family: claude, role: opus, contextWindow: 200000, supportsVision: true }"
        ].join("\n");
      }
      const lines = [
        `Task kind:  ${decision.routeKind}`,
        `Chosen:     ${decision.chosenAlias} -> ${decision.resolved.providerName}:${decision.resolved.model}`,
        `Score:      ${decision.chosenScore}`,
        "",
        "Candidates:"
      ];
      for (const c of decision.candidates) {
        const marker = c.alias === decision.chosenAlias ? "*" : " ";
        lines.push(`  ${marker} ${c.alias.padEnd(20)} score=${c.score}`);
      }
      return lines.join("\n");
    }

    if (sub === "kind") {
      const prompt = args.slice(1).join(" ").trim();
      if (!prompt) return "Usage: /route kind <prompt>";
      const kind = classifyTask(prompt, {});
      return `Task kind: ${kind}`;
    }

    // Default: show recent routing decisions from audit log
    if (!input.paths) {
      return "Routing telemetry requires a configured paths root.";
    }
    const dbPath = path.join(input.paths.stateRoot, "sessions.sqlite");
    if (!existsSync(dbPath)) {
      return "No sessions database found yet.";
    }
    const store = new SessionStore(dbPath);
    const events = store.listAuditEvents(200).filter((e) => e.action === "agent.route.auto");
    if (events.length === 0) {
      return [
        "No routing decisions recorded yet.",
        "",
        "Auto-routing is triggered when modelAlias is 'auto'. Use /route test <prompt> to preview routing for a prompt."
      ].join("\n");
    }
    const lines = ["Recent auto-routing decisions:", ""];
    lines.push(`  ${"When".padEnd(20)} ${"Kind".padEnd(13)} ${"Alias".padEnd(12)} Score`);
    for (const event of events.slice(0, 30)) {
      const meta = (event.metadata ?? {}) as Record<string, unknown>;
      const kind = String(meta.routeKind ?? "?");
      const alias = String(meta.chosenAlias ?? "?");
      const score = String(meta.chosenScore ?? "?");
      const when = new Date(event.createdAt).toISOString().slice(0, 19).replace("T", " ");
      lines.push(`  ${when.padEnd(20)} ${kind.padEnd(13)} ${alias.padEnd(12)} ${score}`);
    }
    lines.push("");
    lines.push("Use /route test <prompt> to preview routing for a hypothetical prompt.");
    return lines.join("\n");
  }
};
