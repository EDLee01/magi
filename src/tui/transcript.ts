/**
 * Transcript: convert agent audit events into TUI-friendly entries.
 *
 * Pure functions, no I/O. Takes `MagiEventView` records (already produced by
 * events.toEventView) and produces structured entries plus aggregate state
 * suitable for rendering in the TUI status panel.
 */

import { MagiEventView } from "../events.js";

export interface TuiTranscriptEntry {
  id: number;
  timestamp: string;
  channel: string;
  status: string;
  title: string;
  detail?: string;
  raw: MagiEventView;
}

export interface TuiTranscriptState {
  sessionId?: string;
  jobId?: string;
  entries: TuiTranscriptEntry[];
  pending: MagiEventView[];
  completed: number;
  failed: number;
  lastEventId?: number;
}

export function formatTuiTranscriptEntry(event: MagiEventView): TuiTranscriptEntry | undefined {
  const toolUseId =
    readString(event.metadata.toolUseId) ??
    readString(event.metadata.id) ??
    readString(event.metadata.toolCallId);
  const target = event.target ?? "unknown";
  const suffix = toolUseId ? ` (${toolUseId})` : "";

  // Suppress noisy internal events — only show tool/approval/question events
  if (event.action === "agent.query.started") {
    return undefined;
  }
  if (event.action === "agent.plan.created") {
    const actions = Array.isArray(event.metadata.actions)
      ? event.metadata.actions.length
      : undefined;
    return transcriptEntry(
      event,
      "query",
      "local plan created",
      actions !== undefined ? `${actions} actions` : undefined
    );
  }
  if (event.action === "agent.request.started") {
    return undefined;
  }
  if (event.action === "agent.tool_context.reported") {
    const toolCount = readNumber(event.metadata.toolCount);
    const estimatedTokens = readNumber(event.metadata.estimatedSchemaTokens);
    const deferred = readNumber(event.metadata.deferredToolCount);
    const detail = [
      estimatedTokens !== undefined ? `~${estimatedTokens} schema tokens` : undefined,
      deferred !== undefined ? `${deferred} deferred` : undefined
    ]
      .filter((item): item is string => Boolean(item))
      .join(", ");
    return transcriptEntry(event, "tools", `${toolCount ?? "?"} exposed`, detail || undefined);
  }
  if (event.action === "tool.file.read") {
    return transcriptEntry(event, "tool", "FileRead completed", event.target);
  }
  if (event.action === "tool.file.write.approved") {
    return transcriptEntry(event, "tool", "FileWrite completed", event.target);
  }
  if (event.action === "tool.search") {
    return transcriptEntry(event, "tool", "Grep completed", event.target);
  }
  if (event.action === "tool.shell.run") {
    const exitCode = readNumber(event.metadata.exitCode);
    return transcriptEntry(
      event,
      "tool",
      "Bash completed",
      exitCode !== undefined ? `exit=${exitCode}` : undefined
    );
  }
  if (event.action === "tool.git.summary") {
    return transcriptEntry(event, "git", "summary completed");
  }
  if (event.action === "agent.assistant.message") {
    const count = readNumber(event.metadata.toolUseCount) ?? 0;
    return count > 0
      ? transcriptEntry(event, "assistant", `requested ${count} ${count === 1 ? "tool" : "tools"}`)
      : undefined;
  }
  if (event.action === "agent.tool.use") {
    return transcriptEntry(event, "tool", `${target} requested`, suffixText(suffix));
  }
  if (event.action === "agent.tool.completed") {
    return transcriptEntry(event, "tool", `${target} completed`, suffixText(suffix));
  }
  if (event.action === "agent.tool.failed") {
    return transcriptEntry(event, "tool", `${target} failed`, suffixText(suffix));
  }
  if (event.action === "agent.permission.denied") {
    return transcriptEntry(event, "approval", `denied ${target}`, suffixText(suffix));
  }
  if (event.action === "agent.approval.requested") {
    return transcriptEntry(event, "approval", `requested ${target}`, suffixText(suffix));
  }
  if (event.action === "agent.approval.pending") {
    const reason = readString(event.metadata.reason);
    return transcriptEntry(
      event,
      "approval",
      `waiting for ${target}${suffix}`,
      reason ? `reason: ${reason}` : undefined
    );
  }
  if (event.action === "agent.approval.resolved" || event.action === "control.approval.resolved") {
    const approved = readBoolean(event.metadata.approved);
    const decision = approved === undefined ? "resolved" : approved ? "approved" : "denied";
    return transcriptEntry(event, "approval", `${decision} ${target}`, suffixText(suffix));
  }
  if (event.action === "agent.approval.timeout") {
    return transcriptEntry(event, "approval", `timed out ${target}`, suffixText(suffix));
  }
  if (
    event.action === "agent.approval.cancelled" ||
    event.action === "control.approval.cancelled"
  ) {
    return transcriptEntry(event, "approval", `cancelled ${target}`, suffixText(suffix));
  }
  if (event.action === "agent.user_question.pending") {
    const count = readNumber(event.metadata.questionCount);
    return transcriptEntry(
      event,
      "question",
      `waiting for answer${count ? ` (${count})` : ""}${suffix}`,
      "choose an option below"
    );
  }
  if (
    event.action === "agent.user_question.resolved" ||
    event.action === "control.user_question.resolved"
  ) {
    return transcriptEntry(event, "question", "resolved", suffixText(suffix));
  }
  if (event.action === "agent.user_question.answered") {
    const count = readNumber(event.metadata.questionCount);
    return transcriptEntry(
      event,
      "question",
      `answered${count ? ` (${count})` : ""}`,
      suffixText(suffix)
    );
  }
  if (event.action === "agent.user_question.timeout") {
    return transcriptEntry(event, "question", "timed out", suffixText(suffix));
  }
  if (
    event.action === "agent.user_question.cancelled" ||
    event.action === "control.user_question.cancelled"
  ) {
    return transcriptEntry(event, "question", "cancelled", suffixText(suffix));
  }
  if (event.action === "agent.user_message.sent") {
    return transcriptEntry(event, "message", `sent by ${target}`);
  }
  if (event.action === "agent.todo.updated") {
    const count = readNumber(event.metadata.todoCount);
    return transcriptEntry(
      event,
      "todo",
      "updated",
      count !== undefined ? `${count} items` : undefined
    );
  }
  if (event.action === "agent.config.updated") {
    return transcriptEntry(event, "config", `updated ${target}`);
  }
  if (event.action === "agent.provider.fallback") {
    const fromProvider = readString(event.metadata.fromProvider) ?? "unknown";
    const fromModel = readString(event.metadata.fromModel);
    const toProvider = readString(event.metadata.toProvider) ?? event.target ?? "unknown";
    const toModel = readString(event.metadata.toModel);
    const errorKind = readString(event.metadata.errorKind);
    const from = fromModel ? `${fromProvider}/${fromModel}` : fromProvider;
    const to = toModel ? `${toProvider}/${toModel}` : toProvider;
    return transcriptEntry(
      event,
      "fallback",
      `${from} -> ${to}`,
      errorKind ? `error: ${errorKind}` : undefined
    );
  }
  if (event.action === "agent.provider.retry") {
    const provider = readString(event.metadata.providerName) ?? event.target ?? "unknown";
    const model = readString(event.metadata.model);
    const errorKind = readString(event.metadata.errorKind);
    const attempt = readNumber(event.metadata.attempt);
    const maxAttempts = readNumber(event.metadata.maxAttempts);
    const delayMs = readNumber(event.metadata.nextRetryDelayMs);
    const route = model ? `${provider}/${model}` : provider;
    const detail = [
      attempt !== undefined && maxAttempts !== undefined
        ? `attempt ${attempt}/${maxAttempts}`
        : undefined,
      delayMs !== undefined ? `next ${delayMs}ms` : undefined,
      errorKind ? `error: ${errorKind}` : undefined
    ]
      .filter((item): item is string => Boolean(item))
      .join(", ");
    return transcriptEntry(event, "fallback", `retry ${route}`, detail || undefined);
  }
  if (event.action === "agent.context.compacted") {
    return transcriptEntry(event, "context", "compacted", event.target);
  }
  if (event.action === "agent.hook.completed") {
    return transcriptEntry(event, "hook", `${target} completed`);
  }
  if (event.action === "agent.hook.failed") {
    return transcriptEntry(event, "hook", `${target} failed`);
  }
  if (event.action === "agent.memory.written") {
    const scope = readString(event.metadata.scope);
    return transcriptEntry(event, "memory", "wrote", scope);
  }
  if (event.action === "agent.memory.draft.created") {
    const scope = readString(event.metadata.scope);
    return transcriptEntry(event, "memory", "draft created", scope);
  }
  if (event.action === "agent.memory.duplicate") {
    const scope = readString(event.metadata.scope);
    return transcriptEntry(event, "memory", "duplicate skipped", scope);
  }
  if (event.action === "agent.memory.conflict") {
    const scope = readString(event.metadata.scope);
    return transcriptEntry(event, "memory", "conflict skipped", scope);
  }
  if (event.action === "agent.query.completed") {
    return undefined;
  }
  if (event.action === "agent.query.failed") {
    return transcriptEntry(event, "query", "failed", event.message);
  }
  if (event.action === "agent.query.cancelled") {
    return transcriptEntry(event, "query", "cancelled", event.message);
  }
  return undefined;
}

export function buildTuiTranscriptState(
  events: MagiEventView[],
  input: {
    sessionId?: string;
    jobId?: string;
    limit?: number;
  } = {}
): TuiTranscriptState {
  const ordered = [...events].sort((a, b) => a.id - b.id);
  const visibleEntries = ordered
    .map(formatTuiTranscriptEntry)
    .filter((entry): entry is TuiTranscriptEntry => Boolean(entry));
  const limit = input.limit ?? 12;
  const entries = visibleEntries.slice(Math.max(0, visibleEntries.length - limit));
  return {
    sessionId: input.sessionId ?? ordered.at(-1)?.sessionId,
    jobId: input.jobId ?? findLastJobId(ordered),
    entries,
    pending: currentPendingInteractions(ordered),
    completed: ordered.filter(
      (event) =>
        event.status === "completed" || event.status === "resolved" || event.status === "answered"
    ).length,
    failed: ordered.filter(
      (event) =>
        event.status === "failed" ||
        event.status === "denied" ||
        event.status === "timeout" ||
        event.status === "cancelled"
    ).length,
    lastEventId: ordered.at(-1)?.id
  };
}

export function formatTuiTranscriptStatus(state: TuiTranscriptState): string {
  const header = [
    `session: ${state.sessionId ?? "none"}`,
    `job: ${state.jobId ?? "none"}`,
    `events: ${state.entries.length}`,
    `pending: ${state.pending.length}`,
    `completed: ${state.completed}`,
    `failed: ${state.failed}`
  ].join("  ");
  return [
    "Transcript:",
    header,
    state.pending.length > 0
      ? formatPendingTuiInteractions(state.pending)
      : "Pending interactions: none",
    ...state.entries.map((entry) => {
      const detail = entry.detail ? ` - ${entry.detail}` : "";
      return `${entry.timestamp} ${entry.channel.padEnd(9)} ${entry.status.padEnd(9)} ${entry.title}${detail}`;
    })
  ].join("\n");
}

export function formatTuiLiveEvent(
  event: MagiEventView,
  options: { showToolTrace?: boolean } = {}
): string | undefined {
  if (isNoisyLiveEvent(event) && options.showToolTrace !== true) {
    return undefined;
  }
  const entry = formatTuiTranscriptEntry(event);
  if (!entry) {
    return undefined;
  }
  const detail = entry.detail
    ? entry.detail.startsWith("(") ||
      entry.detail.startsWith("on ") ||
      entry.detail.startsWith("exit=")
      ? ` ${entry.detail}`
      : ` - ${entry.detail}`
    : "";
  const channelColor = getChannelColor(entry.channel);
  const statusIcon = getStatusIcon(entry.status);
  return `${channelColor}${statusIcon} [${entry.channel}]\x1b[39m ${entry.title}${detail}`;
}

function isNoisyLiveEvent(event: MagiEventView): boolean {
  if (event.action === "agent.assistant.message") {
    return true;
  }
  if (event.action === "agent.provider.retry") {
    return true;
  }
  if (event.action === "agent.tool.use" || event.action === "agent.tool.completed") {
    return true;
  }
  if (
    event.action === "tool.file.read" ||
    event.action === "tool.file.write.approved" ||
    event.action === "tool.search" ||
    event.action === "tool.shell.run" ||
    event.action === "tool.git.summary"
  ) {
    return true;
  }
  return false;
}

function findLastJobId(events: MagiEventView[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].jobId) {
      return events[index].jobId;
    }
  }
  return undefined;
}

function formatPendingTuiInteractions(events: MagiEventView[]): string {
  return [
    "Pending interactions:",
    ...events.map((event) => {
      const toolUseId = readString(event.metadata.toolUseId) ?? event.target ?? "unknown";
      return `- ${event.category} ${toolUseId} job=${event.jobId ?? "unknown"} ${event.target ?? ""}`.trimEnd();
    })
  ].join("\n");
}

function currentPendingInteractions(events: MagiEventView[]): MagiEventView[] {
  const pending = new Map<string, MagiEventView>();
  for (const event of events) {
    const kind = readString(event.metadata.interactionKind);
    const toolUseId = readString(event.metadata.toolUseId);
    if (!kind || !toolUseId || (kind !== "approval" && kind !== "question")) {
      continue;
    }
    const key = `${event.jobId ?? ""}\0${kind}\0${toolUseId}`;
    if (event.status === "pending") {
      pending.set(key, event);
    } else if (
      event.status === "resolved" ||
      event.status === "answered" ||
      event.status === "timeout" ||
      event.status === "cancelled" ||
      event.status === "denied"
    ) {
      pending.delete(key);
    }
  }
  return [...pending.values()];
}

function transcriptEntry(
  event: MagiEventView,
  channel: string,
  title: string,
  detail?: string
): TuiTranscriptEntry {
  return {
    id: event.id,
    timestamp: event.createdAt,
    channel,
    status: event.status,
    title,
    detail,
    raw: event
  };
}

function suffixText(value: string): string | undefined {
  return value ? value.trim() : undefined;
}

function getChannelColor(channel: string): string {
  switch (channel) {
    case "tool":
      return "\x1b[36m"; // cyan
    case "tools":
      return "\x1b[36m"; // cyan
    case "query":
      return "\x1b[34m"; // blue
    case "approval":
      return "\x1b[33m"; // yellow
    case "question":
      return "\x1b[33m"; // yellow
    case "git":
      return "\x1b[35m"; // magenta
    case "hook":
      return "\x1b[90m"; // gray
    case "memory":
      return "\x1b[32m"; // green
    case "fallback":
      return "\x1b[31m"; // red
    case "context":
      return "\x1b[90m"; // gray
    case "config":
      return "\x1b[90m"; // gray
    case "todo":
      return "\x1b[32m"; // green
    case "assistant":
      return "\x1b[34m"; // blue
    case "message":
      return "\x1b[37m"; // white
    default:
      return "\x1b[39m"; // default
  }
}

function getStatusIcon(status: string): string {
  switch (status) {
    case "started":
      return "▶";
    case "completed":
      return "✓";
    case "resolved":
      return "✓";
    case "answered":
      return "✓";
    case "failed":
      return "✗";
    case "denied":
      return "✗";
    case "timeout":
      return "⏱";
    case "cancelled":
      return "⊘";
    case "pending":
      return "⏳";
    default:
      return "·";
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
