import { MemoryRootOptions } from "./memory-files.js";
import { MemoryConflictRecord, MemoryNodeStore } from "./memory-node-store.js";
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
