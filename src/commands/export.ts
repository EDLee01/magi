import { writeFileSync } from "node:fs";
import path from "node:path";
import { SlashCommandInput } from "./registry.js";

export const command = {
  name: "export",
  description: "Export the current session transcript to a file",
  usage: "/export [path]",
  group: "Session",
  handler: (args: string[], input: SlashCommandInput): string => {
    if (!input.sessionId) return "No active session to export.";
    const session = input.store.getSession(input.sessionId);
    if (!session) return "Session not found.";
    const target = args[0]
      ? path.resolve(input.cwd, args[0])
      : path.join(input.cwd, `magi-session-${input.sessionId.slice(0, 8)}.md`);
    const lines: string[] = [
      `# ${session.title ?? "Magi session"}`,
      "",
      `- Session: ${session.id}`,
      `- Cwd: ${session.cwd}`,
      `- Created: ${session.createdAt}`,
      `- Updated: ${session.updatedAt}`,
      `- Messages: ${session.messages.length}`,
      ""
    ];
    for (const msg of session.messages) {
      lines.push(
        `## ${msg.role === "user" ? "User" : msg.role === "assistant" ? "Assistant" : msg.role} — ${msg.createdAt}`
      );
      lines.push("");
      lines.push(msg.content);
      lines.push("");
    }
    try {
      writeFileSync(target, lines.join("\n"), "utf8");
    } catch (error) {
      return `Failed to write ${target}: ${error instanceof Error ? error.message : String(error)}`;
    }
    return `Exported ${session.messages.length} messages to ${target}`;
  }
};
