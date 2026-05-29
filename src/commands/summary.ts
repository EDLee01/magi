import { SlashCommandInput } from "./registry.js";

export const command = {
  name: "summary",
  description: "Show session summary with message count and job info",
  usage: "/summary",
  group: "Session",
  handler: (_args: string[], input: SlashCommandInput): string => {
    if (!input.sessionId) {
      return "No active session.";
    }

    const session = input.store.getSession(input.sessionId);
    if (!session) {
      return "Session not found.";
    }

    const messageCount = session.messages.length;
    const jobs = input.store.listJobs(100).filter((j) => j.sessionId === input.sessionId);
    const elapsed = getElapsed(session.createdAt, session.updatedAt);

    return [
      `Session: ${input.sessionId}`,
      `Title: ${session.title ?? "(untitled)"}`,
      `Created: ${session.createdAt}`,
      `Updated: ${session.updatedAt}`,
      `Elapsed: ${elapsed}`,
      `Messages: ${messageCount}`,
      `Jobs: ${jobs.length}`
    ].join("\n");
  }
};

function getElapsed(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  return `${minutes}m ${remainSec}s`;
}
