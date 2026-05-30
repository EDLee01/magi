import {
  computeSessionContextBudget,
  formatSessionContextBudget
} from "../context/token-budget.js";
import { SlashCommandInput } from "./registry.js";

export const command = {
  name: "context",
  description: "Show token budget and context categories for the active session",
  usage: "/context",
  group: "Context",
  handler: (_args: string[], input: SlashCommandInput): string => {
    if (!input.sessionId) {
      return "No active session. Start or resume a session first.";
    }
    const session = input.store.getSession(input.sessionId);
    if (!session) {
      return `Session not found: ${input.sessionId}`;
    }
    const summaries = input.store.listContextSummaries(session.id);
    return formatSessionContextBudget(
      computeSessionContextBudget({ session, summaries })
    ).trimEnd();
  }
};
