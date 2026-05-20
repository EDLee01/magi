import { SlashCommandInput } from "./registry.js";
import { formatMemory } from "../memory.js";
import { listMemdirEntries, deleteMemdirEntry, findMemdirEntry } from "../memdir.js";

export const command = {
  name: "memory",
  description: "View, manage, or delete persistent memories",
  usage: "/memory [list|show <name>|delete <name>|legacy [scope]]",
  group: "Memory",
  handler: (args: string[], input: SlashCommandInput): string => {
    if (!input.paths) {
      return "Memory paths are unavailable";
    }
    const sub = args[0] ?? "list";

    // Backwards compat: /memory <scope> with scope = user|project|session
    if (sub === "user" || sub === "project" || sub === "session") {
      return formatMemory({ paths: input.paths, cwd: input.cwd, scope: sub, sessionId: input.sessionId });
    }

    if (sub === "list" || args.length === 0) {
      const entries = listMemdirEntries(input.paths);
      if (entries.length === 0) {
        return [
          "No memdir entries.",
          "",
          `Memdir directory: ${input.paths.root}/memdir/`,
          "Memories are saved here as typed markdown files (user/feedback/project/reference).",
          "Use /memory show <name> to view one, /memory delete <name> to remove."
        ].join("\n");
      }
      const lines = ["Memdir entries:"];
      const byType: Record<string, typeof entries> = { user: [], feedback: [], project: [], reference: [] };
      for (const e of entries) byType[e.type].push(e);
      for (const type of ["user", "feedback", "project", "reference"]) {
        const list = byType[type];
        if (list.length === 0) continue;
        lines.push("");
        lines.push(`  ${type}:`);
        for (const e of list) {
          lines.push(`    ${e.filename.padEnd(40)} ${e.description}`);
        }
      }
      lines.push("");
      lines.push("Use /memory show <filename-or-name> to view, /memory delete <filename-or-name> to remove.");
      return lines.join("\n");
    }

    if (sub === "show") {
      const target = args[1];
      if (!target) return "Usage: /memory show <filename-or-name>";
      const entry = findMemdirEntry(input.paths, target);
      if (!entry) return `Memory not found: ${target}`;
      return [
        `# ${entry.name}`,
        `Type: ${entry.type}`,
        `File: ${entry.filename}`,
        `Description: ${entry.description}`,
        "",
        entry.body
      ].join("\n");
    }

    if (sub === "delete" || sub === "remove" || sub === "rm") {
      const target = args[1];
      if (!target) return "Usage: /memory delete <filename-or-name>";
      const entry = findMemdirEntry(input.paths, target);
      if (!entry) return `Memory not found: ${target}`;
      const ok = deleteMemdirEntry(input.paths, entry.filename);
      return ok ? `Deleted memory: ${entry.filename}` : `Failed to delete: ${entry.filename}`;
    }

    if (sub === "legacy") {
      const scope = args[1] === "user" || args[1] === "project" || args[1] === "session" ? args[1] : undefined;
      return formatMemory({ paths: input.paths, cwd: input.cwd, scope, sessionId: input.sessionId });
    }

    return `Unknown subcommand: ${sub}. Usage: ${command.usage}`;
  }
};
