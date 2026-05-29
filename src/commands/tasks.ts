import path from "node:path";
import { existsSync } from "node:fs";

import { SlashCommandInput } from "./registry.js";
import { SessionStore } from "../session-store.js";

export const command = {
  name: "tasks",
  aliases: ["jobs"],
  description: "List background tasks (sub-agent jobs)",
  usage: "/tasks [show <id>]",
  group: "State",
  handler: (args: string[], input: SlashCommandInput): string => {
    if (!input.paths) {
      return "Tasks require a configured paths root.";
    }
    const dbPath = path.join(input.paths.stateRoot, "sessions.sqlite");
    if (!existsSync(dbPath)) {
      return "No sessions database found yet.";
    }
    const store = new SessionStore(dbPath);
    const sub = args[0];

    if (sub === "show" || sub === "view") {
      const id = args[1];
      if (!id) return "Usage: /tasks show <id>";
      const job = store.getJob(id);
      if (!job) return `Task not found: ${id}`;
      const meta = (job.metadata ?? {}) as Record<string, unknown>;
      const lines = [
        `Task: ${job.id}`,
        `Status: ${job.status}`,
        `Kind:   ${job.kind}`,
        `Session: ${job.sessionId}`,
        `Created: ${new Date(job.createdAt).toISOString()}`
      ];
      if (job.updatedAt) lines.push(`Updated: ${new Date(job.updatedAt).toISOString()}`);
      if (typeof meta.description === "string") lines.push(`Description: ${meta.description}`);
      if (typeof meta.subagentType === "string") lines.push(`Sub-agent type: ${meta.subagentType}`);
      if (typeof meta.result === "string") {
        lines.push("");
        lines.push("Result:");
        lines.push(meta.result);
      }
      if (typeof meta.error === "string") {
        lines.push("");
        lines.push("Error:");
        lines.push(meta.error);
      }
      return lines.join("\n");
    }

    const jobs = store.listJobs(50);
    if (jobs.length === 0) {
      return "No background tasks found.";
    }
    const lines = ["Background tasks (most recent first):"];
    lines.push("");
    lines.push(`  ${"ID".padEnd(38)} ${"Status".padEnd(10)} ${"Kind".padEnd(12)} Description`);
    for (const job of jobs) {
      const meta = (job.metadata ?? {}) as Record<string, unknown>;
      const desc =
        typeof meta.description === "string"
          ? meta.description
          : typeof meta.subagentType === "string"
            ? `[${meta.subagentType}]`
            : "";
      lines.push(`  ${job.id.padEnd(38)} ${job.status.padEnd(10)} ${job.kind.padEnd(12)} ${desc}`);
    }
    lines.push("");
    lines.push("Use /tasks show <id> to view a task's full output.");
    return lines.join("\n");
  }
};
