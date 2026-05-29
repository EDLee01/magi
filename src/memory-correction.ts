import { recordMemoryAudit } from "./memory-audit.js";
import { MemoryRootOptions } from "./memory-files.js";
import { MemoryNode, MemoryNodeStore, MemoryNodeType } from "./memory-node-store.js";
import { syncMemoryGraph } from "./memory-wiki-indexer.js";
import { MagiPaths } from "./paths.js";

export interface CorrectMemoryInput extends MemoryRootOptions {
  paths: MagiPaths;
  target: string;
  reason: string;
  replacement?: string;
  replacementTitle?: string;
  replacementSummary?: string;
  replacementType?: MemoryNodeType;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface CorrectMemoryResult {
  disputed: MemoryNode;
  replacement?: MemoryNode;
  edgeCount: number;
}

export function correctMemory(input: CorrectMemoryInput): CorrectMemoryResult {
  syncMemoryGraph({ appRoot: input.appRoot, root: input.root, paths: input.paths });
  const store = MemoryNodeStore.open(input.paths);
  try {
    const target = resolveCorrectionTarget(store, input.target);
    const result = store.correctNode({
      nodeId: target.id,
      reason: input.reason,
      replacement: input.replacement?.trim()
        ? {
            type: input.replacementType ?? target.type,
            title: input.replacementTitle?.trim() || target.title,
            summary: input.replacementSummary?.trim() || input.replacement,
            body: input.replacement,
            source: "explicit",
            sourceSessionId: input.sessionId,
            metadata: { source: "memory-correction" }
          }
        : undefined,
      metadata: {
        source: "memory-correction",
        sessionId: input.sessionId,
        ...(input.metadata ?? {})
      }
    });
    recordMemoryAudit({
      ...input,
      action: "memory.corrected",
      target: result.disputed.id,
      sessionId: input.sessionId,
      metadata: {
        reason: input.reason,
        disputedNodeId: result.disputed.id,
        replacementNodeId: result.replacement?.id,
        edgeCount: result.edges.length,
        ...(input.metadata ?? {})
      }
    });
    return {
      disputed: result.disputed,
      replacement: result.replacement,
      edgeCount: result.edges.length
    };
  } finally {
    store.close();
  }
}

export function formatMemoryCorrectionResult(result: CorrectMemoryResult): string {
  const lines = [
    `Corrected Memory node: ${result.disputed.id}`,
    `status: ${result.disputed.status}`,
    `title: ${result.disputed.title}`,
    `weight: ${result.disputed.weight.toFixed(2)}`
  ];
  if (result.replacement) {
    lines.push(`replacement: ${result.replacement.id}`);
    lines.push(`replacement title: ${result.replacement.title}`);
    lines.push(`edges: ${result.edgeCount}`);
  }
  return lines.join("\n");
}

function resolveCorrectionTarget(store: MemoryNodeStore, target: string): MemoryNode {
  const value = target.trim();
  if (!value) {
    throw new Error("Memory correction target must not be empty");
  }
  const byId = store.getNode(value);
  if (byId && byId.status !== "archived") {
    return byId;
  }
  const hits = store.searchGraph({ query: value, limit: 3, minScore: 1 });
  if (hits.length === 0) {
    throw new Error(`Memory node not found for correction target: ${value}`);
  }
  const exact = hits.filter(
    (hit) =>
      hit.node.title.toLowerCase() === value.toLowerCase() ||
      hit.chunk.heading.toLowerCase() === value.toLowerCase() ||
      hit.node.body.toLowerCase() === value.toLowerCase()
  );
  const candidates = exact.length > 0 ? exact : hits;
  if (candidates.length > 1 && candidates[0].score === candidates[1].score) {
    throw new Error(`Memory correction target is ambiguous: ${value}`);
  }
  return candidates[0].node;
}
