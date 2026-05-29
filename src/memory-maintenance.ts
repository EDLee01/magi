import { recordMemoryAudit } from "./memory-audit.js";
import { MemoryRootOptions } from "./memory-files.js";
import { DecayUnusedMemoryResult, MemoryNodeStore } from "./memory-node-store.js";
import { MagiPaths } from "./paths.js";

export interface MaintainMemoryInput extends MemoryRootOptions {
  paths: MagiPaths;
  apply?: boolean;
  olderThanDays?: number;
  decay?: number;
  minWeight?: number;
  limit?: number;
  sessionId?: string;
}

export function maintainMemory(input: MaintainMemoryInput): DecayUnusedMemoryResult {
  const store = MemoryNodeStore.open(input.paths);
  try {
    const result = store.decayUnusedNodes({
      apply: input.apply,
      olderThanDays: input.olderThanDays,
      decay: input.decay,
      minWeight: input.minWeight,
      limit: input.limit
    });
    recordMemoryAudit({
      ...input,
      action: input.apply ? "memory.maintenance.applied" : "memory.maintenance.previewed",
      sessionId: input.sessionId,
      metadata: {
        changedCount: result.changed.length,
        olderThanDays: result.olderThanDays,
        decay: result.decay,
        minWeight: result.minWeight,
        applied: result.applied,
        nodeIds: result.changed.map((item) => item.node.id)
      }
    });
    return result;
  } finally {
    store.close();
  }
}

export function formatMemoryMaintenanceResult(result: DecayUnusedMemoryResult): string {
  const lines = [
    result.applied ? "Memory maintenance applied" : "Memory maintenance preview",
    `olderThanDays: ${result.olderThanDays}`,
    `decay: ${result.decay.toFixed(3)}`,
    `minWeight: ${result.minWeight.toFixed(3)}`,
    `changed: ${result.changed.length}`
  ];
  for (const item of result.changed.slice(0, 20)) {
    lines.push(
      `- ${item.node.title} (${item.node.id}) ${item.previousWeight.toFixed(3)} -> ${item.nextWeight.toFixed(3)} age=${item.ageDays}d`
    );
  }
  if (result.changed.length > 20) {
    lines.push(`... ${result.changed.length - 20} more`);
  }
  return lines.join("\n");
}
