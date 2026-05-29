import { MemoryRootOptions } from "./memory-files.js";
import { MemoryConflictGroup, MemoryConflictRecord, MemoryNodeStore } from "./memory-node-store.js";
import { MagiPaths } from "./paths.js";

export interface ListMemoryConflictsInput extends MemoryRootOptions {
  paths: MagiPaths;
  limit?: number;
}

export function listMemoryConflicts(input: ListMemoryConflictsInput): MemoryConflictRecord[] {
  const store = MemoryNodeStore.open(input.paths);
  try {
    return store.listConflicts({ limit: input.limit });
  } finally {
    store.close();
  }
}

export function listMemoryConflictGroups(input: ListMemoryConflictsInput): MemoryConflictGroup[] {
  const store = MemoryNodeStore.open(input.paths);
  try {
    return store.listConflictGroups({ limit: input.limit });
  } finally {
    store.close();
  }
}

export function formatMemoryConflicts(records: MemoryConflictRecord[]): string {
  if (records.length === 0) {
    return "No Memory graph conflicts.";
  }
  const lines = [`Memory graph conflicts: ${records.length}`];
  for (const [index, record] of records.entries()) {
    lines.push("");
    lines.push(`${index + 1}. ${record.from.title} <-> ${record.to.title}`);
    lines.push(
      `   from: ${record.from.id} (${record.from.status}, weight ${record.from.weight.toFixed(2)})`
    );
    lines.push(
      `   to: ${record.to.id} (${record.to.status}, weight ${record.to.weight.toFixed(2)})`
    );
    lines.push(`   recommendation: ${record.recommendation}`);
    lines.push(`   reason: ${record.reason}`);
    const edgeReason =
      typeof record.edge.metadata.reason === "string" ? record.edge.metadata.reason : "";
    if (edgeReason) {
      lines.push(`   edge reason: ${edgeReason}`);
    }
  }
  return lines.join("\n");
}

export function formatMemoryConflictGroups(groups: MemoryConflictGroup[]): string {
  if (groups.length === 0) {
    return "No Memory graph conflict groups.";
  }
  const lines = [`Memory graph conflict groups: ${groups.length}`];
  for (const [index, group] of groups.entries()) {
    lines.push("");
    lines.push(`${index + 1}. ${group.id}`);
    lines.push(`   nodes: ${group.nodes.length}`);
    lines.push(`   conflicts: ${group.conflicts.length}`);
    lines.push(`   recommendation: ${group.recommendation}`);
    if (group.preferredNodeId) {
      const preferred = group.nodes.find((node) => node.id === group.preferredNodeId);
      lines.push(
        `   preferred: ${preferred?.title ?? group.preferredNodeId} (${group.preferredNodeId})`
      );
    }
    lines.push(`   reason: ${group.reason}`);
    for (const node of group.nodes.slice(0, 8)) {
      lines.push(
        `   - ${node.title} (${node.id}, ${node.status}, weight ${node.weight.toFixed(2)})`
      );
    }
    for (const conflict of group.conflicts.slice(0, 5)) {
      lines.push(
        `     conflict: ${conflict.from.title} <-> ${conflict.to.title} weight ${conflict.edge.weight.toFixed(2)}`
      );
    }
  }
  return lines.join("\n");
}
