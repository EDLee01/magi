import { StoredAuditRecord } from "./session-store.js";

export type MagiEventCategory =
  | "query"
  | "tool"
  | "hook"
  | "approval"
  | "question"
  | "message"
  | "todo"
  | "config"
  | "git"
  | "context"
  | "control"
  | "cron"
  | "memory"
  | "agent"
  | "runner"
  | "unknown";

export type MagiEventStatus =
  | "started"
  | "completed"
  | "failed"
  | "requested"
  | "pending"
  | "resolved"
  | "timeout"
  | "cancelled"
  | "denied"
  | "updated"
  | "sent"
  | "answered"
  | "recorded"
  | "info";

export interface MagiEventView {
  id: number;
  sessionId: string;
  jobId?: string;
  eventName: string;
  action: string;
  category: MagiEventCategory;
  status: MagiEventStatus;
  target?: string;
  createdAt: string;
  message: string;
  metadata: Record<string, unknown>;
}

export function toEventView(event: StoredAuditRecord): MagiEventView {
  return {
    id: event.id,
    sessionId: event.sessionId,
    jobId: event.jobId,
    eventName: event.action,
    action: event.action,
    category: eventCategory(event),
    status: eventStatus(event),
    target: event.target,
    createdAt: event.createdAt,
    message: formatEventMessage(event),
    metadata: event.metadata ?? {}
  };
}

export function formatEventList(events: MagiEventView[]): string {
  if (events.length === 0) {
    return "Recent events: none";
  }
  return [
    "Recent events:",
    ...events.map(
      (event) =>
        `${event.createdAt} ${event.action}${event.target ? ` ${event.target}` : ""} - ${event.message}`
    )
  ].join("\n");
}

export function formatEventMessage(event: StoredAuditRecord): string {
  const metadata = event.metadata ?? {};
  if (event.action === "agent.tool.use") {
    const id = typeof metadata.id === "string" ? ` (${metadata.id})` : "";
    return `tool requested${id}`;
  }
  if (event.action === "agent.tool.completed") {
    const toolCallId = typeof metadata.toolCallId === "string" ? ` ${metadata.toolCallId}` : "";
    return `tool completed${toolCallId}`;
  }
  if (event.action === "agent.tool.failed") {
    const toolCallId = typeof metadata.toolCallId === "string" ? ` ${metadata.toolCallId}` : "";
    return `tool failed${toolCallId}`;
  }
  if (event.action === "agent.todo.updated") {
    const count = typeof metadata.todoCount === "number" ? ` (${metadata.todoCount} items)` : "";
    return `todo list updated${count}`;
  }
  if (event.action === "agent.config.updated") {
    return "config updated";
  }
  if (event.action === "agent.user_question.answered") {
    const count =
      typeof metadata.questionCount === "number" ? ` (${metadata.questionCount} questions)` : "";
    return `user question answered${count}`;
  }
  if (event.action === "agent.user_question.pending") {
    const toolUseId = typeof metadata.toolUseId === "string" ? ` ${metadata.toolUseId}` : "";
    return `user question pending${toolUseId}`;
  }
  if (
    event.action === "agent.user_question.resolved" ||
    event.action === "control.user_question.resolved"
  ) {
    const toolUseId = typeof metadata.toolUseId === "string" ? ` ${metadata.toolUseId}` : "";
    return `user question resolved${toolUseId}`;
  }
  if (event.action === "agent.user_question.timeout") {
    const toolUseId = typeof metadata.toolUseId === "string" ? ` ${metadata.toolUseId}` : "";
    return `user question timed out${toolUseId}`;
  }
  if (
    event.action === "agent.user_question.cancelled" ||
    event.action === "control.user_question.cancelled"
  ) {
    const toolUseId = typeof metadata.toolUseId === "string" ? ` ${metadata.toolUseId}` : "";
    return `user question cancelled${toolUseId}`;
  }
  if (event.action === "agent.user_message.sent") {
    return "user message sent";
  }
  if (event.action === "agent.skill.loaded") {
    return "skill loaded";
  }
  if (event.action === "agent.request.started") {
    const model = typeof metadata.model === "string" ? ` ${metadata.model}` : "";
    return `provider request started${model}`;
  }
  if (event.action === "agent.tool_context.reported") {
    const toolCount = typeof metadata.toolCount === "number" ? metadata.toolCount : undefined;
    const estimatedTokens =
      typeof metadata.estimatedSchemaTokens === "number"
        ? metadata.estimatedSchemaTokens
        : undefined;
    return `tool context ${toolCount ?? "?"} tools${estimatedTokens !== undefined ? ` ~${estimatedTokens} tokens` : ""}`;
  }
  if (event.action === "agent.text.delta") {
    const length = typeof metadata.length === "number" ? ` (${metadata.length} chars)` : "";
    return `assistant text streamed${length}`;
  }
  if (event.action === "agent.assistant.message") {
    const toolUseCount = typeof metadata.toolUseCount === "number" ? metadata.toolUseCount : 0;
    return toolUseCount > 0
      ? `assistant requested ${toolUseCount} tools`
      : "assistant message recorded";
  }
  if (event.action === "agent.usage.reported") {
    const inputTokens = typeof metadata.inputTokens === "number" ? metadata.inputTokens : undefined;
    const outputTokens =
      typeof metadata.outputTokens === "number" ? metadata.outputTokens : undefined;
    return inputTokens !== undefined && outputTokens !== undefined
      ? `usage input=${inputTokens} output=${outputTokens}`
      : "usage reported";
  }
  if (event.action === "agent.query.done") {
    const length = typeof metadata.textLength === "number" ? ` (${metadata.textLength} chars)` : "";
    return `query loop done${length}`;
  }
  if (event.action === "agent.query.max_turns") {
    return "query reached maximum turns";
  }
  if (event.action === "agent.provider.fallback") {
    const from = typeof metadata.fromProvider === "string" ? metadata.fromProvider : "unknown";
    const to =
      typeof metadata.toProvider === "string" ? metadata.toProvider : (event.target ?? "unknown");
    return `provider fallback ${from} -> ${to}`;
  }
  if (event.action === "agent.provider.retry") {
    const provider = typeof metadata.providerName === "string" ? metadata.providerName : "unknown";
    const attempt = typeof metadata.attempt === "number" ? metadata.attempt : undefined;
    const maxAttempts = typeof metadata.maxAttempts === "number" ? metadata.maxAttempts : undefined;
    const suffix =
      attempt !== undefined && maxAttempts !== undefined ? ` ${attempt}/${maxAttempts}` : "";
    return `provider retry ${provider}${suffix}`;
  }
  if (event.action === "agent.approval.requested") {
    return "approval requested";
  }
  if (event.action === "agent.approval.pending") {
    const toolUseId = typeof metadata.toolUseId === "string" ? ` ${metadata.toolUseId}` : "";
    return `approval pending${toolUseId}`;
  }
  if (event.action === "agent.approval.resolved" || event.action === "control.approval.resolved") {
    const approved =
      typeof metadata.approved === "boolean" ? ` ${metadata.approved ? "approved" : "denied"}` : "";
    return `approval resolved${approved}`;
  }
  if (event.action === "agent.approval.timeout") {
    const toolUseId = typeof metadata.toolUseId === "string" ? ` ${metadata.toolUseId}` : "";
    return `approval timed out${toolUseId}`;
  }
  if (
    event.action === "agent.approval.cancelled" ||
    event.action === "control.approval.cancelled"
  ) {
    const toolUseId = typeof metadata.toolUseId === "string" ? ` ${metadata.toolUseId}` : "";
    return `approval cancelled${toolUseId}`;
  }
  if (event.action === "agent.permission.denied") {
    return "permission denied";
  }
  if (event.action === "agent.context.compacted") {
    return "context compacted";
  }
  if (event.action === "agent.query.started") {
    return "query started";
  }
  if (event.action === "agent.query.completed") {
    const turns = typeof metadata.turns === "number" ? ` in ${metadata.turns} turns` : "";
    return `query completed${turns}`;
  }
  if (event.action === "agent.query.failed") {
    const error = typeof metadata.error === "string" ? `: ${metadata.error}` : "";
    return `query failed${error}`;
  }
  if (event.action === "agent.query.cancelled") {
    const reason = typeof metadata.reason === "string" ? `: ${metadata.reason}` : "";
    return `query cancelled${reason}`;
  }
  if (event.action === "agent.hook.completed" || event.action === "agent.hook.failed") {
    const hookType = typeof metadata.hookType === "string" ? metadata.hookType : "hook";
    return `${hookType} ${event.action.endsWith("failed") ? "failed" : "completed"}`;
  }
  if (event.action === "cron.job.executed") {
    return "cron job executed";
  }
  if (event.action.startsWith("control.")) {
    return event.action.replace(/^control\./, "control ").replace(/\./g, " ");
  }
  if (event.action.startsWith("tool.")) {
    return event.action.replace(/^tool\./, "tool ").replace(/\./g, " ");
  }
  if (event.action.startsWith("memory.")) {
    return event.action.replace(/^memory\./, "memory ").replace(/\./g, " ");
  }
  if (event.action.startsWith("runner.")) {
    return event.action.replace(/^runner\./, "runner ").replace(/\./g, " ");
  }
  return event.target ? `${event.action} ${event.target}` : event.action;
}

function eventCategory(event: StoredAuditRecord): MagiEventCategory {
  const action = event.action;
  const target = event.target ?? "";
  if (
    action.startsWith("agent.query") ||
    action === "agent.request.started" ||
    action === "agent.tool_context.reported" ||
    action === "agent.text.delta" ||
    action === "agent.assistant.message" ||
    action === "agent.usage.reported"
  )
    return "query";
  if (action.startsWith("agent.tool")) {
    return target.startsWith("Git") ? "git" : "tool";
  }
  if (action.startsWith("agent.hook")) return "hook";
  if (action.startsWith("agent.approval") || action.startsWith("agent.permission"))
    return "approval";
  if (action.startsWith("agent.user_question")) return "question";
  if (action.startsWith("agent.user_message")) return "message";
  if (action.startsWith("agent.todo")) return "todo";
  if (action.startsWith("agent.config")) return "config";
  if (action.startsWith("agent.context")) return "context";
  if (action.startsWith("agent.provider")) return "query";
  if (action.startsWith("control.")) return "control";
  if (action.startsWith("cron.")) return "cron";
  if (action.startsWith("memory.")) return "memory";
  if (action.startsWith("runner.")) return "runner";
  if (action.startsWith("tool.git")) return "git";
  if (action.startsWith("tool.")) return "tool";
  if (action.startsWith("agent.")) return "agent";
  return "unknown";
}

function eventStatus(event: StoredAuditRecord): MagiEventStatus {
  const action = event.action;
  if (action.endsWith(".started")) return "started";
  if (action.endsWith(".completed") || action.endsWith(".executed") || action.endsWith(".loaded"))
    return "completed";
  if (action.endsWith(".failed")) return "failed";
  if (action.endsWith(".requested")) return "requested";
  if (action.endsWith(".pending")) return "pending";
  if (action.endsWith(".resolved")) return "resolved";
  if (action.endsWith(".timeout")) return "timeout";
  if (action.endsWith(".cancelled")) return "cancelled";
  if (action.endsWith(".denied")) return "denied";
  if (action.endsWith(".updated")) return "updated";
  if (action.endsWith(".sent")) return "sent";
  if (action.endsWith(".answered")) return "answered";
  if (action.endsWith(".recorded") || action.endsWith(".created") || action.endsWith(".append"))
    return "recorded";
  if (action.endsWith(".approved")) return "completed";
  return "info";
}
