import { MagiUsageError } from "../errors.js";
import { HookDefinition } from "../config.js";
import { triggerHooks } from "../hooks/events.js";
import { ProviderAdapter } from "../providers/ir.js";
import {
  ContextSummaryRecord,
  MessageRecord,
  SessionRecord,
  SessionStore
} from "../session-store.js";

export interface CompactSessionResult {
  summary: ContextSummaryRecord;
  recovered: RecoveredContext;
}

export interface CompactSessionWithHooksResult extends CompactSessionResult {
  hooks: {
    pre: Awaited<ReturnType<typeof triggerHooks>>;
    post: Awaited<ReturnType<typeof triggerHooks>>;
  };
}

export interface RecoveredContext {
  sessionId: string;
  summary?: ContextSummaryRecord;
  recentMessages: MessageRecord[];
}

export interface MicrocompactResult {
  messages: MessageRecord[];
  removedDuplicateToolResults: number;
  truncatedToolResults: number;
  mergedSystemMessages: number;
}

export function compactSession(input: {
  store: SessionStore;
  sessionId: string;
  recentMessages?: number;
  maxSummaryChars?: number;
}): CompactSessionResult {
  const session = input.store.getSession(input.sessionId);
  if (!session) {
    throw new MagiUsageError(`Session not found: ${input.sessionId}`);
  }

  const recentMessages = input.recentMessages ?? 20;
  const summaryText = buildDeterministicSummary(session, {
    recentMessages,
    maxSummaryChars: input.maxSummaryChars ?? 6000
  });
  const summary = input.store.recordContextSummary({
    sessionId: session.id,
    summary: summaryText,
    sourceMessageCount: session.messages.length,
    metadata: {
      kind: "deterministic-extractive-summary",
      recentMessages
    }
  });

  return {
    summary,
    recovered: recoverSessionContext({
      store: input.store,
      sessionId: session.id,
      recentMessages
    })
  };
}

export async function compactSessionWithHooks(input: {
  store: SessionStore;
  sessionId: string;
  hooks: HookDefinition[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  modelRunner?: {
    adapter: ProviderAdapter;
    model: string;
    providerName: string;
  };
  recentMessages?: number;
  maxSummaryChars?: number;
  trigger?: "manual" | "auto";
  customInstructions?: string;
}): Promise<CompactSessionWithHooksResult> {
  const session = input.store.getSession(input.sessionId);
  if (!session) {
    throw new MagiUsageError(`Session not found: ${input.sessionId}`);
  }
  const trigger = input.trigger ?? "manual";
  const pre = await triggerHooks({
    event: "pre_compact",
    hooks: input.hooks,
    store: input.store,
    sessionId: session.id,
    cwd: input.cwd,
    env: input.env,
    context: {
      source: "compact",
      message: `Compacting session ${session.id}`,
      notificationType: "compact_started",
      trigger,
      customInstructions: input.customInstructions,
      sourceMessageCount: session.messages.length
    }
  });
  const block = pre.find((hook) => hook.blocked);
  if (block) {
    throw new MagiUsageError(
      `Compaction blocked by hook: ${block.output || block.error || "blocked"}`
    );
  }

  const compacted = input.modelRunner
    ? await compactSessionWithModel({
        store: input.store,
        sessionId: session.id,
        adapter: input.modelRunner.adapter,
        model: input.modelRunner.model,
        providerName: input.modelRunner.providerName,
        recentMessages: input.recentMessages,
        maxSummaryChars: input.maxSummaryChars
      })
    : compactSession({
        store: input.store,
        sessionId: session.id,
        recentMessages: input.recentMessages,
        maxSummaryChars: input.maxSummaryChars
      });
  const post = await triggerHooks({
    event: "post_compact",
    hooks: input.hooks,
    store: input.store,
    sessionId: session.id,
    cwd: input.cwd,
    env: input.env,
    context: {
      source: "compact",
      message: `Compacted session ${session.id}`,
      notificationType: "compact_completed",
      trigger,
      customInstructions: input.customInstructions,
      compactSummary: compacted.summary.summary,
      sourceMessageCount: compacted.summary.sourceMessageCount
    }
  });

  return {
    ...compacted,
    hooks: { pre, post }
  };
}

export async function compactSessionWithModel(input: {
  store: SessionStore;
  sessionId: string;
  adapter: ProviderAdapter;
  model: string;
  providerName: string;
  recentMessages?: number;
  maxSummaryChars?: number;
  maxOutputTokens?: number;
}): Promise<CompactSessionResult> {
  const session = input.store.getSession(input.sessionId);
  if (!session) {
    throw new MagiUsageError(`Session not found: ${input.sessionId}`);
  }
  if (!input.model.trim()) {
    throw new MagiUsageError("Compaction model must be explicit");
  }

  const recentMessages = input.recentMessages ?? 20;
  const micro = microcompactMessages(session.messages, {
    maxToolResultChars: 2_000
  });
  const response = await input.adapter.complete({
    model: input.model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: buildSummarizationPrompt(session, micro.messages)
          }
        ]
      }
    ],
    maxOutputTokens: input.maxOutputTokens ?? 20_000
  });
  const summaryText = truncateAtLineBoundary(response.text.trim(), input.maxSummaryChars ?? 20_000);
  if (!summaryText) {
    throw new MagiUsageError("Compaction model returned an empty summary");
  }
  const summary = input.store.recordContextSummary({
    sessionId: session.id,
    summary: summaryText,
    sourceMessageCount: session.messages.length,
    metadata: {
      kind: "llm-summary",
      provider: input.providerName,
      model: input.model,
      recentMessages,
      microcompact: {
        removedDuplicateToolResults: micro.removedDuplicateToolResults,
        truncatedToolResults: micro.truncatedToolResults,
        mergedSystemMessages: micro.mergedSystemMessages
      }
    }
  });

  return {
    summary,
    recovered: recoverSessionContext({
      store: input.store,
      sessionId: session.id,
      recentMessages
    })
  };
}

export function microcompactMessages(
  messages: MessageRecord[],
  input: {
    maxToolResultChars?: number;
  } = {}
): MicrocompactResult {
  const maxToolResultChars = input.maxToolResultChars ?? 2_000;
  const compacted: MessageRecord[] = [];
  const seenToolResults = new Set<string>();
  let removedDuplicateToolResults = 0;
  let truncatedToolResults = 0;
  let mergedSystemMessages = 0;

  for (const message of messages) {
    if (message.role === "tool") {
      const normalized = singleLine(message.content, maxToolResultChars);
      if (seenToolResults.has(normalized)) {
        removedDuplicateToolResults += 1;
        continue;
      }
      seenToolResults.add(normalized);
      if (message.content.length > maxToolResultChars) {
        truncatedToolResults += 1;
        compacted.push({
          ...message,
          content: `${message.content.slice(0, maxToolResultChars).trimEnd()}\n[tool result truncated]`
        });
        continue;
      }
    }

    if (message.role === "system" && compacted.at(-1)?.role === "system") {
      const previous = compacted[compacted.length - 1];
      compacted[compacted.length - 1] = {
        ...previous,
        content: `${previous.content}\n${message.content}`
      };
      mergedSystemMessages += 1;
      continue;
    }

    compacted.push(message);
  }

  return {
    messages: compacted,
    removedDuplicateToolResults,
    truncatedToolResults,
    mergedSystemMessages
  };
}

export function recoverSessionContext(input: {
  store: SessionStore;
  sessionId: string;
  recentMessages?: number;
}): RecoveredContext {
  const session = input.store.getSession(input.sessionId);
  if (!session) {
    throw new MagiUsageError(`Session not found: ${input.sessionId}`);
  }
  const count = input.recentMessages ?? 20;
  return {
    sessionId: session.id,
    summary: input.store.getLatestContextSummary(session.id),
    recentMessages: session.messages.slice(Math.max(0, session.messages.length - count))
  };
}

export function formatCompactResult(result: CompactSessionResult): string {
  return [
    `summaryId: ${result.summary.id}`,
    `sessionId: ${result.summary.sessionId}`,
    `sourceMessages: ${result.summary.sourceMessageCount}`,
    `recoveredRecentMessages: ${result.recovered.recentMessages.length}`,
    "summary:",
    result.summary.summary,
    ""
  ].join("\n");
}

function buildDeterministicSummary(
  session: SessionRecord,
  input: {
    recentMessages: number;
    maxSummaryChars: number;
  }
): string {
  const lines: string[] = [
    `Session ${session.id}`,
    `Title: ${session.title ?? "(untitled)"}`,
    `Cwd: ${session.cwd}`,
    `Messages: ${session.messages.length}`
  ];

  const requiredFacts = extractRequiredFacts(session.messages);
  if (requiredFacts.length > 0) {
    lines.push("Required facts:");
    for (const fact of requiredFacts) {
      lines.push(`- ${fact}`);
    }
  }

  const recent = session.messages.slice(
    Math.max(0, session.messages.length - input.recentMessages)
  );
  if (recent.length > 0) {
    lines.push("Recent messages:");
    for (const message of recent) {
      lines.push(`- ${message.role}: ${singleLine(message.content, 300)}`);
    }
  }

  return truncateAtLineBoundary(lines.join("\n"), input.maxSummaryChars);
}

function buildSummarizationPrompt(session: SessionRecord, messages: MessageRecord[]): string {
  // Pre-extract structured facts mechanically so the LLM has them as ground
  // truth and won't drop file paths, install lists, or error states even if
  // the conversation is too long for it to summarize accurately.
  const facts = extractRequiredFacts(messages);
  const lines: string[] = [
    "Summarize this Magi session concisely while preserving:",
    "- Key decisions made",
    "- Files modified and their current state",
    "- Pending tasks",
    "- Requirements, constraints, blockers, and facts needed to continue",
    "",
    "Below are MECHANICALLY EXTRACTED facts. Treat them as ground truth and",
    "include them verbatim in your summary. Add narrative context only where",
    "it helps a future session pick up the work.",
    "",
    `Session: ${session.id}`,
    `Title: ${session.title ?? "(untitled)"}`,
    `Cwd: ${session.cwd}`,
    ""
  ];
  if (facts.length > 0) {
    lines.push("Mechanically extracted facts:");
    for (const fact of facts) {
      lines.push(`- ${fact}`);
    }
    lines.push("");
  }
  lines.push("Messages:");
  for (const message of messages) {
    lines.push(`- ${message.role}: ${singleLine(message.content, 2_000)}`);
  }
  return lines.join("\n");
}

function extractRequiredFacts(messages: MessageRecord[]): string[] {
  const facts: string[] = [];
  const seen = new Set<string>();

  const add = (text: string, role?: string): void => {
    const normalized = singleLine(text, 500);
    const key = role ? `${role}: ${normalized}` : normalized;
    if (!seen.has(key)) {
      facts.push(key);
      seen.add(key);
    }
  };

  // The first user message captures the original task / intent. Always keep
  // it so the model can re-orient after compaction.
  const firstUser = messages.find((m) => m.role === "user");
  if (firstUser) {
    add(`task: ${singleLine(firstUser.content, 300)}`);
  }

  for (const message of messages) {
    // 1. Explicit text markers users / models can put in messages.
    for (const line of message.content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (/^(FACT|TODO|DECISION|CONSTRAINT|REQUIREMENT|BLOCKER|NOTE):/i.test(trimmed)) {
        add(trimmed, message.role);
      }
    }

    // 2. Tool results — extract structured side effects so that even if
    // the LLM summary is fuzzy, the workspace state is recoverable.
    if (message.role === "tool") {
      const content = message.content;

      // File writes / edits — preserved exactly so future turns can locate
      // the files we touched.
      const fileWrite = /^Wrote (\S+)/m.exec(content);
      if (fileWrite) add(`file_written: ${fileWrite[1]}`);

      const fileEdit = /^Edited (\S+)/m.exec(content);
      if (fileEdit) add(`file_edited: ${fileEdit[1]}`);

      const fileDelete = /^Deleted (\S+)/m.exec(content);
      if (fileDelete) add(`file_deleted: ${fileDelete[1]}`);

      const fileMove = /^Moved (\S+) (?:→|->|to) (\S+)/m.exec(content);
      if (fileMove) add(`file_moved: ${fileMove[1]} -> ${fileMove[2]}`);

      // Package installs. Captures pip/npm/cargo style output.
      const pipInstall = /Successfully installed ([^\n]+)/m.exec(content);
      if (pipInstall) add(`installed: ${pipInstall[1].trim()}`);

      const npmAdded = /^added (\d+) packages? in /m.exec(content);
      if (npmAdded) add(`npm_installed_packages: ${npmAdded[1]}`);

      // Errors: capture exit codes, ToolError messages, stack traces.
      const exitCode = /^Exit code: ([1-9]\d*)/m.exec(content);
      if (exitCode) add(`error_exit_code: ${exitCode[1]}`);

      const toolError = /^ToolError: ([^\n]+)/m.exec(content);
      if (toolError) add(`tool_error: ${toolError[1].trim()}`);

      // Git operations — what branch, what was committed.
      const gitCommit = /\[([a-z0-9-]+) ([a-f0-9]{7,12})\] /m.exec(content);
      if (gitCommit) add(`git_commit: ${gitCommit[2]} on ${gitCommit[1]}`);
    }

    // 3. Approval decisions — what the user explicitly allowed or denied.
    if (message.role === "user") {
      const trimmed = message.content.trim();
      if (/^(approved|allow|yes|denied|deny|no)\b/i.test(trimmed) && trimmed.length < 100) {
        add(`decision: ${trimmed}`, "user");
      }
    }
  }
  return facts;
}

function singleLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function truncateAtLineBoundary(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const clipped = value.slice(0, maxChars);
  const boundary = clipped.lastIndexOf("\n");
  return `${clipped.slice(0, boundary > 0 ? boundary : maxChars).trimEnd()}\n[truncated]`;
}
