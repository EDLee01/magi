import { formatEventList, toEventView } from "../events.js";
import { buildTuiRenderState } from "../tui/render-state.js";
import { renderTuiState } from "../tui/renderer.js";
import { SlashCommandInput } from "./registry.js";

export const command = {
  name: "status",
  description: "Show cwd, providers, aliases, and state",
  usage: "/status",
  group: "Session",
  handler: (_args: string[], input: SlashCommandInput): string => {
    const recentRecords = input.sessionId
      ? input.store.listSessionAuditEvents(input.sessionId, 50)
      : input.store.listAuditEvents(50);
    const views = recentRecords.map(toEventView);
    const pending = views.filter(
      (event) =>
        event.status === "pending" &&
        (event.category === "approval" || event.category === "question")
    );
    const events = views.slice(0, 5);
    const renderState = buildTuiRenderState({
      events: views,
      sessionId: input.sessionId,
      model: `${input.currentModel ?? "main"} (${formatModelTarget(input.config, input.currentModel ?? "main")})`,
      cwd: input.cwd,
      limit: 8
    });
    return [
      `cwd: ${input.cwd}`,
      `session: ${input.sessionId ?? "none"}`,
      `model: ${input.currentModel ?? "main"} (${formatModelTarget(input.config, input.currentModel ?? "main")})`,
      `providers: ${Object.keys(input.config.providers).join(", ") || "none"}`,
      `aliases: ${Object.keys(input.config.models.aliases).join(", ") || "none"}`,
      renderTuiState(renderState, { color: false, width: 100, maxBlocks: 8 }),
      formatPendingInteractions(pending),
      formatEventList(events)
    ].join("\n");
  }
};

function formatModelTarget(
  config: { models: { aliases: Record<string, string> } },
  alias: string
): string {
  return config.models.aliases[alias] ?? alias;
}

function formatPendingInteractions(events: ReturnType<typeof toEventView>[]): string {
  if (events.length === 0) {
    return "Pending interactions: none";
  }
  return [
    "Pending interactions:",
    ...events.map((event) => {
      const toolUseId =
        typeof event.metadata.toolUseId === "string"
          ? event.metadata.toolUseId
          : (event.target ?? "unknown");
      return `- ${event.category} ${toolUseId} job=${event.metadata.jobId ?? "unknown"} ${event.message}`;
    })
  ].join("\n");
}
