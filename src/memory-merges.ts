import { MemoryRootOptions } from "./memory-files.js";
import { MemoryMergeRecord, MemoryNodeStore } from "./memory-node-store.js";
import { MagiPaths } from "./paths.js";

export interface ListMemoryMergesInput extends MemoryRootOptions {
  paths: MagiPaths;
  limit?: number;
}

export function listMemoryMerges(input: ListMemoryMergesInput): MemoryMergeRecord[] {
  const store = MemoryNodeStore.open(input.paths);
  try {
    return store.listMergeRecords({ limit: input.limit });
  } finally {
    store.close();
  }
}

export function formatMemoryMerges(records: MemoryMergeRecord[]): string {
  if (records.length === 0) {
    return "No Memory graph merges.";
  }
  const lines = [`Memory graph merges: ${records.length}`];
  for (const [index, record] of records.entries()) {
    lines.push("");
    lines.push(`${index + 1}. ${record.duplicate.title} -> ${record.keep.title}`);
    lines.push(
      `   keep: ${record.keep.id} (${record.keep.status}, weight ${record.keep.weight.toFixed(2)})`
    );
    lines.push(
      `   duplicate: ${record.duplicate.id} (${record.duplicate.status}, weight ${record.duplicate.weight.toFixed(2)})`
    );
    if (record.previousWeight !== undefined && record.nextWeight !== undefined) {
      lines.push(
        `   weight: ${record.previousWeight.toFixed(2)} -> ${record.nextWeight.toFixed(2)}`
      );
    }
    lines.push(`   redirected edges: ${record.redirectedEdgeCount}`);
    lines.push(`   resolved edge conflicts: ${record.resolvedEdgeConflictCount}`);
    if (record.duplicateUseCount !== undefined) {
      lines.push(`   absorbed duplicate uses: ${record.duplicateUseCount}`);
    }
    lines.push(`   merged at: ${record.mergedAt}`);
    lines.push(`   reason: ${record.reason}`);
    if (record.dreamId) {
      lines.push(`   dream: ${record.dreamId}`);
    }
  }
  return lines.join("\n");
}
