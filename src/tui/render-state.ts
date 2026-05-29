import { MagiEventView } from "../events.js";
import {
  buildTuiTranscriptState,
  formatTuiTranscriptEntry,
  TuiTranscriptEntry,
  TuiTranscriptState
} from "./transcript.js";

export type TuiBlockKind =
  | "status"
  | "pending"
  | "query"
  | "tool"
  | "approval"
  | "question"
  | "git"
  | "memory"
  | "todo"
  | "hook"
  | "assistant"
  | "message"
  | "context"
  | "config"
  | "fallback";

export interface TuiRenderState {
  sessionId?: string;
  jobId?: string;
  model?: string;
  cwd?: string;
  blocks: TuiBlock[];
  pending: TuiPendingBlock[];
  summary: TuiStateSummary;
  transcript: TuiTranscriptState;
}

export interface TuiStateSummary {
  visibleEvents: number;
  pending: number;
  completed: number;
  failed: number;
  lastEventId?: number;
}

export interface TuiBlock {
  id: string;
  kind: TuiBlockKind;
  status: string;
  title: string;
  detail?: string;
  timestamp?: string;
  eventId?: number;
  compact?: string;
}

export interface TuiPendingBlock {
  id: string;
  kind: "approval" | "question";
  jobId?: string;
  toolUseId: string;
  title: string;
  detail?: string;
  target?: string;
}

export function buildTuiRenderState(input: {
  events: MagiEventView[];
  sessionId?: string;
  jobId?: string;
  model?: string;
  cwd?: string;
  limit?: number;
}): TuiRenderState {
  const transcript = buildTuiTranscriptState(input.events, {
    sessionId: input.sessionId,
    jobId: input.jobId,
    limit: input.limit
  });
  const pending = transcript.pending.map(pendingEventToBlock);
  const blocks = transcript.entries
    .filter((entry) => entry.status !== "pending")
    .map(transcriptEntryToBlock);
  return {
    sessionId: input.sessionId ?? transcript.sessionId,
    jobId: input.jobId ?? transcript.jobId,
    model: input.model,
    cwd: input.cwd,
    blocks,
    pending,
    summary: {
      visibleEvents: transcript.entries.length,
      pending: transcript.pending.length,
      completed: transcript.completed,
      failed: transcript.failed,
      lastEventId: transcript.lastEventId
    },
    transcript
  };
}

export function eventToTuiBlock(event: MagiEventView): TuiBlock | undefined {
  const entry = formatTuiTranscriptEntry(event);
  return entry ? transcriptEntryToBlock(entry) : undefined;
}

function transcriptEntryToBlock(entry: TuiTranscriptEntry): TuiBlock {
  const kind = channelToBlockKind(entry.channel);
  return {
    id: `event-${entry.id}`,
    kind,
    status: entry.status,
    title: entry.title,
    detail: entry.detail,
    timestamp: entry.timestamp,
    eventId: entry.id,
    compact: formatCompactBlock(entry)
  };
}

function pendingEventToBlock(event: MagiEventView): TuiPendingBlock {
  const kind = readString(event.metadata.interactionKind) === "question" ? "question" : "approval";
  const toolUseId = readString(event.metadata.toolUseId) ?? event.target ?? "unknown";
  const reason = readString(event.metadata.reason);
  return {
    id: `${event.jobId ?? "job"}-${kind}-${toolUseId}`,
    kind,
    jobId: event.jobId,
    toolUseId,
    target: event.target,
    title:
      kind === "question"
        ? `Question waiting (${toolUseId})`
        : `Approval waiting for ${event.target ?? "tool"}`,
    detail: reason ?? event.message
  };
}

function formatCompactBlock(entry: TuiTranscriptEntry): string {
  const detail = entry.detail ? ` - ${entry.detail}` : "";
  return `${statusGlyph(entry.status)} ${entry.title}${detail}`;
}

function channelToBlockKind(channel: string): TuiBlockKind {
  switch (channel) {
    case "tool":
    case "query":
    case "approval":
    case "question":
    case "git":
    case "memory":
    case "todo":
    case "hook":
    case "assistant":
    case "message":
    case "context":
    case "config":
    case "fallback":
      return channel;
    default:
      return "status";
  }
}

function statusGlyph(status: string): string {
  switch (status) {
    case "completed":
    case "resolved":
    case "answered":
      return "✓";
    case "failed":
    case "denied":
      return "✗";
    case "pending":
      return "…";
    case "cancelled":
      return "⊘";
    case "timeout":
      return "!";
    default:
      return "•";
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
