import { SlashCommandInput } from "./registry.js";

export const command = {
  name: "rewind",
  description: "Drop the last assistant turn (and any messages after it)",
  usage: "/rewind",
  group: "Session",
  handler: (_args: string[], input: SlashCommandInput): string => {
    if (!input.sessionId) return "No active session.";
    const session = input.store.getSession(input.sessionId);
    if (!session) return "Session not found.";
    if (session.messages.length === 0) return "Session has no messages.";

    // Find the last user message — we'll truncate after it (drop the assistant
    // reply and any subsequent stuff). If the last message is a user message
    // already, drop that too so the user can re-type.
    let cutoffMessageId: number | undefined;
    let droppedKind = "";
    const messages = session.messages;
    const lastIdx = messages.length - 1;
    if (messages[lastIdx].role === "assistant") {
      // Find the user message that triggered it
      for (let i = lastIdx - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          cutoffMessageId = messages[i].id;
          droppedKind = "the last assistant turn";
          break;
        }
      }
    } else if (messages[lastIdx].role === "user") {
      // No assistant reply yet — drop the user message itself
      cutoffMessageId = messages[lastIdx - 1]?.id ?? 0;
      droppedKind = "the last (unanswered) user message";
    }
    if (cutoffMessageId === undefined) {
      return "Could not find a user/assistant pair to rewind.";
    }
    const removed = input.store.truncateMessagesAfter(input.sessionId, cutoffMessageId);
    if (removed === 0) return "Nothing to rewind.";
    return `Rewound ${droppedKind} (${removed} message${removed === 1 ? "" : "s"} dropped).`;
  }
};
