import { recordMemoryAudit } from "./memory-audit.js";
import { MemoryRootOptions } from "./memory-files.js";
import {
  ApplyMemoryFeedbackResult,
  MemoryFeedbackTrend,
  MemoryFeedbackSignal,
  MemoryNode,
  MemoryNodeStore,
  MemoryNodeType
} from "./memory-node-store.js";
import { syncMemoryGraph } from "./memory-wiki-indexer.js";
import { MagiPaths } from "./paths.js";

export interface MemoryFeedbackInput extends MemoryRootOptions {
  paths: MagiPaths;
  target: string;
  signal: MemoryFeedbackSignal;
  reason?: string;
  replacement?: string;
  replacementTitle?: string;
  replacementSummary?: string;
  replacementType?: MemoryNodeType;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export type MemoryFeedbackResult = ApplyMemoryFeedbackResult;

export interface ListMemoryFeedbackTrendsInput extends MemoryRootOptions {
  paths: MagiPaths;
  limit?: number;
  minEvents?: number;
}

export function applyMemoryFeedback(input: MemoryFeedbackInput): MemoryFeedbackResult {
  syncMemoryGraph({ appRoot: input.appRoot, root: input.root, paths: input.paths });
  const store = MemoryNodeStore.open(input.paths);
  try {
    const target = resolveFeedbackTarget(store, input.target);
    const result = store.applyFeedback({
      nodeId: target.id,
      signal: input.signal,
      reason: input.reason,
      replacement: input.replacement?.trim()
        ? {
            type: input.replacementType ?? target.type,
            title: input.replacementTitle?.trim() || target.title,
            summary: input.replacementSummary?.trim() || input.replacement,
            body: input.replacement,
            source: "explicit",
            sourceSessionId: input.sessionId,
            metadata: { source: "memory-feedback" }
          }
        : undefined,
      metadata: {
        source: "memory-feedback",
        sessionId: input.sessionId,
        ...(input.metadata ?? {})
      }
    });
    recordMemoryAudit({
      ...input,
      action: "memory.feedback.applied",
      target: result.node.id,
      sessionId: input.sessionId,
      metadata: {
        signal: result.signal,
        reason: input.reason,
        previousWeight: result.previousWeight,
        nextWeight: result.nextWeight,
        replacementNodeId: result.replacement?.id,
        edgeCount: result.edges.length,
        ...(input.metadata ?? {})
      }
    });
    return result;
  } finally {
    store.close();
  }
}

export function formatMemoryFeedbackResult(result: MemoryFeedbackResult): string {
  const lines = [
    `Memory feedback applied: ${result.node.id}`,
    `signal: ${result.signal}`,
    `title: ${result.node.title}`,
    `status: ${result.node.status}`,
    `weight: ${result.previousWeight.toFixed(2)} -> ${result.nextWeight.toFixed(2)}`
  ];
  if (result.replacement) {
    lines.push(`replacement: ${result.replacement.id}`);
    lines.push(`replacement title: ${result.replacement.title}`);
    lines.push(`edges: ${result.edges.length}`);
  }
  return lines.join("\n");
}

export function listMemoryFeedbackTrends(
  input: ListMemoryFeedbackTrendsInput
): MemoryFeedbackTrend[] {
  syncMemoryGraph({ appRoot: input.appRoot, root: input.root, paths: input.paths });
  const store = MemoryNodeStore.open(input.paths);
  try {
    return store.listFeedbackTrends({ limit: input.limit, minEvents: input.minEvents });
  } finally {
    store.close();
  }
}

export function formatMemoryFeedbackTrends(trends: MemoryFeedbackTrend[]): string {
  if (trends.length === 0) {
    return "No Memory feedback trends.";
  }
  const lines = [`Memory feedback trends: ${trends.length}`];
  for (const [index, trend] of trends.entries()) {
    lines.push("");
    lines.push(`${index + 1}. ${trend.node.title} (${trend.node.id})`);
    lines.push(`   signal: useful=${trend.useful} irrelevant=${trend.irrelevant} net=${trend.net}`);
    lines.push(
      `   status: ${trend.node.status} type=${trend.node.type} weight=${trend.node.weight.toFixed(2)}`
    );
    if (trend.lastSignal) {
      lines.push(
        `   last: ${trend.lastSignal}${trend.lastFeedbackAt ? ` at ${trend.lastFeedbackAt}` : ""}`
      );
    }
    if (trend.lastReason) {
      lines.push(`   reason: ${trend.lastReason}`);
    }
  }
  return lines.join("\n");
}

function resolveFeedbackTarget(store: MemoryNodeStore, target: string): MemoryNode {
  const value = target.trim();
  if (!value) {
    throw new Error("Memory feedback target must not be empty");
  }
  const byId = store.getNode(value);
  if (byId && byId.status !== "archived") {
    return byId;
  }
  const hits = store.searchGraph({ query: value, limit: 3, minScore: 1 });
  if (hits.length === 0) {
    throw new Error(`Memory node not found for feedback target: ${value}`);
  }
  const exact = hits.filter(
    (hit) =>
      hit.node.title.toLowerCase() === value.toLowerCase() ||
      hit.chunk.heading.toLowerCase() === value.toLowerCase() ||
      hit.node.body.toLowerCase() === value.toLowerCase()
  );
  const candidates = exact.length > 0 ? exact : hits;
  if (candidates.length > 1 && candidates[0].score === candidates[1].score) {
    throw new Error(`Memory feedback target is ambiguous: ${value}`);
  }
  return candidates[0].node;
}
