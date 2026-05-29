import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { atomicWrite } from "./fs-utils.js";
import { recordMemoryAudit } from "./memory-audit.js";
import { ensureMemoryStructure, memoryRoot, MemoryRootOptions } from "./memory-files.js";
import { DecayUnusedMemoryResult, MemoryNodeStore } from "./memory-node-store.js";
import { MagiPaths } from "./paths.js";

export interface MemoryMaintenancePolicy {
  olderThanDays: number;
  decay: number;
  minWeight: number;
  limit: number;
}

export interface MaintainMemoryInput extends MemoryRootOptions {
  paths: MagiPaths;
  apply?: boolean;
  olderThanDays?: number;
  decay?: number;
  minWeight?: number;
  limit?: number;
  sessionId?: string;
}

export interface ConfigureMemoryMaintenanceInput extends MemoryRootOptions {
  olderThanDays?: number;
  decay?: number;
  minWeight?: number;
  limit?: number;
  sessionId?: string;
}

export interface ConfigureMemoryMaintenanceResult {
  policy: MemoryMaintenancePolicy;
  changed: boolean;
  path: string;
}

export const DEFAULT_MEMORY_MAINTENANCE_POLICY: MemoryMaintenancePolicy = {
  olderThanDays: 45,
  decay: 0.08,
  minWeight: 0.2,
  limit: 100
};

export function maintainMemory(input: MaintainMemoryInput): DecayUnusedMemoryResult {
  const policy = resolveMemoryMaintenancePolicy(input);
  const store = MemoryNodeStore.open(input.paths);
  try {
    const result = store.decayUnusedNodes({
      apply: input.apply,
      olderThanDays: policy.olderThanDays,
      decay: policy.decay,
      minWeight: policy.minWeight,
      limit: policy.limit
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

export function configureMemoryMaintenance(
  input: ConfigureMemoryMaintenanceInput
): ConfigureMemoryMaintenanceResult {
  const previous = readMemoryMaintenancePolicy(input);
  const next = normalizeMemoryMaintenancePolicy({
    olderThanDays: input.olderThanDays ?? previous.olderThanDays,
    decay: input.decay ?? previous.decay,
    minWeight: input.minWeight ?? previous.minWeight,
    limit: input.limit ?? previous.limit
  });
  ensureMemoryStructure(input);
  const file = memoryMaintenancePolicyFile(input);
  mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, `${JSON.stringify(next, null, 2)}\n`);
  const changed = JSON.stringify(previous) !== JSON.stringify(next);
  recordMemoryAudit({
    ...input,
    action: "memory.maintenance.configured",
    sessionId: input.sessionId,
    target: file,
    metadata: {
      changed,
      previous,
      policy: next
    }
  });
  return { policy: next, changed, path: file };
}

export function readMemoryMaintenancePolicy(input: MemoryRootOptions): MemoryMaintenancePolicy {
  const file = memoryMaintenancePolicyFile(input);
  if (!existsSync(file)) {
    return { ...DEFAULT_MEMORY_MAINTENANCE_POLICY };
  }
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<MemoryMaintenancePolicy>;
  return normalizeMemoryMaintenancePolicy({
    olderThanDays: parsed.olderThanDays ?? DEFAULT_MEMORY_MAINTENANCE_POLICY.olderThanDays,
    decay: parsed.decay ?? DEFAULT_MEMORY_MAINTENANCE_POLICY.decay,
    minWeight: parsed.minWeight ?? DEFAULT_MEMORY_MAINTENANCE_POLICY.minWeight,
    limit: parsed.limit ?? DEFAULT_MEMORY_MAINTENANCE_POLICY.limit
  });
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
      `- ${item.node.title} (${item.node.id}) ${item.previousWeight.toFixed(3)} -> ${item.nextWeight.toFixed(3)} type=${item.node.type} effectiveDecay=${item.effectiveDecay.toFixed(3)} age=${item.ageDays}d`
    );
  }
  if (result.changed.length > 20) {
    lines.push(`... ${result.changed.length - 20} more`);
  }
  return lines.join("\n");
}

export function formatMemoryMaintenancePolicy(
  result: MemoryMaintenancePolicy | ConfigureMemoryMaintenanceResult
): string {
  const policy = "policy" in result ? result.policy : result;
  const lines = [
    "Memory maintenance policy",
    `olderThanDays: ${policy.olderThanDays}`,
    `decay: ${policy.decay.toFixed(3)}`,
    `minWeight: ${policy.minWeight.toFixed(3)}`,
    `limit: ${policy.limit}`
  ];
  if ("changed" in result) {
    lines.push(`changed: ${result.changed ? "yes" : "no"}`);
    lines.push(`path: ${result.path}`);
  }
  return lines.join("\n");
}

function resolveMemoryMaintenancePolicy(input: MaintainMemoryInput): MemoryMaintenancePolicy {
  const stored = readMemoryMaintenancePolicy(input);
  return normalizeMemoryMaintenancePolicy({
    olderThanDays: input.olderThanDays ?? stored.olderThanDays,
    decay: input.decay ?? stored.decay,
    minWeight: input.minWeight ?? stored.minWeight,
    limit: input.limit ?? stored.limit
  });
}

function memoryMaintenancePolicyFile(input: MemoryRootOptions): string {
  return path.join(memoryRoot(input), "maintenance-policy.json");
}

function normalizeMemoryMaintenancePolicy(
  input: Partial<MemoryMaintenancePolicy>
): MemoryMaintenancePolicy {
  return {
    olderThanDays: clampNumber(
      input.olderThanDays ?? DEFAULT_MEMORY_MAINTENANCE_POLICY.olderThanDays,
      0,
      3650
    ),
    decay: clampNumber(input.decay ?? DEFAULT_MEMORY_MAINTENANCE_POLICY.decay, 0, 1),
    minWeight: clampNumber(input.minWeight ?? DEFAULT_MEMORY_MAINTENANCE_POLICY.minWeight, 0, 1),
    limit: Math.max(
      1,
      Math.min(Math.floor(input.limit ?? DEFAULT_MEMORY_MAINTENANCE_POLICY.limit), 1000)
    )
  };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(Number.isFinite(value) ? value : min, max));
}
