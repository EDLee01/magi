import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { atomicWrite } from "./fs-utils.js";
import {
  ensureMemoryStructure,
  listMemoryFiles,
  memoryRoot,
  MemoryRootOptions
} from "./memory-files.js";
import { MemoryDraft, proposeMemoryDraft } from "./memory-draft.js";
import { recordMemoryAudit } from "./memory-audit.js";
import { MagiPaths } from "./paths.js";
import { MemoryNodeStore } from "./memory-node-store.js";
import { syncMemoryGraph } from "./memory-wiki-indexer.js";

export type DreamStatus = "pending" | "applied" | "rejected";

export interface DreamOperation {
  type: "duplicate" | "conflict" | "archive_candidate";
  targetFile: string;
  reason: string;
  content?: string;
  relatedFiles?: string[];
  graphNodeIds?: string[];
  graphMerge?: {
    keepNodeId: string;
    duplicateNodeId: string;
  };
  graphConflictGroup?: {
    groupId: string;
    preferredNodeId?: string;
    nodeIds: string[];
    conflictEdgeIds: number[];
  };
}

export interface DreamManifest {
  id: string;
  createdAt: string;
  status: DreamStatus;
  summary: string;
  operations: DreamOperation[];
  draftIds: string[];
  graphNodeIds?: string[];
  graphReview?: {
    decision: "archive" | "keep";
    nodeIds: string[];
    reviewedAt: string;
    redirectedEdgeCount?: number;
    resolvedEdgeConflictCount?: number;
    fusedWeightCount?: number;
  };
}

export interface DreamRecord {
  id: string;
  path: string;
  status: DreamStatus;
  createdAt: string;
  operationCount: number;
  draftCount: number;
}

export function runDream(input: MemoryRootOptions & { paths?: MagiPaths }): DreamManifest {
  const root = ensureMemoryStructure(input);
  const id = createDreamId();
  const dreamRoot = path.join(root, "dreams", id);
  mkdirSync(path.join(dreamRoot, "before_after"), { recursive: true });

  const operations = analyzeMemory(input);
  const draftIds: string[] = [];
  for (const op of operations) {
    if (op.content) {
      const draft = proposeMemoryDraft({
        ...input,
        root,
        targetFile: op.targetFile,
        content: op.content,
        reason: `Dream: ${op.reason}`,
        id: `${id}_${draftIds.length + 1}`
      });
      draftIds.push(draft.id);
    }
  }

  const manifest: DreamManifest = {
    id,
    createdAt: new Date().toISOString(),
    status: "pending",
    summary: formatDreamSummary(operations),
    operations,
    draftIds,
    graphNodeIds: extractGraphNodeIds(operations)
  };
  atomicWrite(path.join(dreamRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  atomicWrite(path.join(dreamRoot, "summary.md"), formatDreamMarkdown(manifest));
  atomicWrite(
    path.join(dreamRoot, "proposed_patches.json"),
    JSON.stringify({ draftIds, operations }, null, 2) + "\n"
  );
  atomicWrite(path.join(dreamRoot, "conflicts.md"), formatConflictsMarkdown(operations));
  recordMemoryAudit({
    ...input,
    root,
    action: "memory.dream.created",
    target: id,
    metadata: {
      operationCount: operations.length,
      draftIds
    }
  });
  return manifest;
}

export function listDreams(input: MemoryRootOptions): DreamRecord[] {
  const dreamsRoot = path.join(memoryRoot(input), "dreams");
  if (!existsSync(dreamsRoot)) return [];
  return readdirSync(dreamsRoot)
    .sort()
    .flatMap((name) => {
      const manifestFile = path.join(dreamsRoot, name, "manifest.json");
      try {
        if (!statSync(manifestFile).isFile()) return [];
        const manifest = readDreamManifest(manifestFile);
        return [
          {
            id: manifest.id,
            path: path.dirname(manifestFile),
            status: manifest.status,
            createdAt: manifest.createdAt,
            operationCount: manifest.operations.length,
            draftCount: manifest.draftIds.length
          }
        ];
      } catch {
        return [];
      }
    });
}

export function showDream(input: MemoryRootOptions & { id: string }): DreamManifest {
  return readDreamManifest(dreamManifestPath(memoryRoot(input), input.id));
}

export function applyDream(
  input: MemoryRootOptions & {
    id: string;
    applyDraft: (draftId: string) => MemoryDraft;
    paths?: MagiPaths;
  }
): DreamManifest {
  const root = ensureMemoryStructure(input);
  const file = dreamManifestPath(root, input.id);
  const manifest = readDreamManifest(file);
  if (manifest.status !== "pending") {
    throw new Error(`Dream is not pending: ${manifest.id}`);
  }
  for (const draftId of manifest.draftIds) {
    input.applyDraft(draftId);
  }
  const graphMergeResult = mergeDreamGraphDuplicates({
    paths: input.paths,
    dreamId: manifest.id,
    operations: manifest.operations
  });
  const graphNodeIds = extractGraphNodeIds(manifest.operations, manifest.graphNodeIds);
  const archivedGraphNodeIds = archiveDreamGraphNodes({
    paths: input.paths,
    dreamId: manifest.id,
    nodeIds: graphNodeIds
  });
  const reviewedGraphNodeIds = Array.from(
    new Set([...graphMergeResult.mergedNodeIds, ...archivedGraphNodeIds])
  );
  const applied: DreamManifest = {
    ...manifest,
    status: "applied",
    graphNodeIds,
    graphReview: {
      decision: "archive",
      nodeIds: reviewedGraphNodeIds,
      reviewedAt: new Date().toISOString(),
      redirectedEdgeCount: graphMergeResult.redirectedEdgeCount,
      resolvedEdgeConflictCount: graphMergeResult.resolvedEdgeConflictCount,
      fusedWeightCount: graphMergeResult.fusedWeightCount
    }
  };
  atomicWrite(file, JSON.stringify(applied, null, 2) + "\n");
  recordMemoryAudit({
    ...input,
    root,
    action: "memory.dream.applied",
    target: manifest.id,
    metadata: {
      draftIds: manifest.draftIds,
      graphNodeIds,
      archivedGraphNodeIds: reviewedGraphNodeIds,
      graphMerges: graphMergeResult.mergedNodeIds,
      redirectedEdgeCount: graphMergeResult.redirectedEdgeCount,
      resolvedEdgeConflictCount: graphMergeResult.resolvedEdgeConflictCount,
      fusedWeightCount: graphMergeResult.fusedWeightCount
    }
  });
  return applied;
}

export function rejectDream(
  input: MemoryRootOptions & {
    id: string;
    rejectDraft: (draftId: string) => MemoryDraft;
    paths?: MagiPaths;
  }
): DreamManifest {
  const root = ensureMemoryStructure(input);
  const file = dreamManifestPath(root, input.id);
  const manifest = readDreamManifest(file);
  if (manifest.status !== "pending") {
    throw new Error(`Dream is not pending: ${manifest.id}`);
  }
  for (const draftId of manifest.draftIds) {
    input.rejectDraft(draftId);
  }
  const graphNodeIds = extractGraphNodeIds(manifest.operations, manifest.graphNodeIds);
  const keptGraphNodeIds = keepDreamGraphNodes({
    paths: input.paths,
    dreamId: manifest.id,
    nodeIds: graphNodeIds
  });
  const rejected: DreamManifest = {
    ...manifest,
    status: "rejected",
    graphNodeIds,
    graphReview: {
      decision: "keep",
      nodeIds: keptGraphNodeIds,
      reviewedAt: new Date().toISOString()
    }
  };
  atomicWrite(file, JSON.stringify(rejected, null, 2) + "\n");
  recordMemoryAudit({
    ...input,
    root,
    action: "memory.dream.rejected",
    target: manifest.id,
    metadata: { draftIds: manifest.draftIds, graphNodeIds, keptGraphNodeIds }
  });
  return rejected;
}

function analyzeMemory(input: MemoryRootOptions & { paths?: MagiPaths }): DreamOperation[] {
  const operations: DreamOperation[] = [];
  const files = listMemoryFiles(input).filter(
    (file) =>
      !file.path.startsWith("drafts/") &&
      !file.path.startsWith("dreams/") &&
      !file.path.startsWith("archive/") &&
      !file.path.startsWith("logs/")
  );
  const seenLines = new Map<string, { file: string; line: string }>();
  for (const file of files) {
    const text = readFileSync(file.absolutePath, "utf8");
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 12 && !line.startsWith("#") && !line.startsWith("---"));
    const duplicates: string[] = [];
    for (const line of lines) {
      const key = normalizeLine(line);
      const seen = seenLines.get(key);
      if (seen && seen.file !== file.path) {
        duplicates.push(line);
        operations.push({
          type: "duplicate",
          targetFile: file.path,
          reason: `Similar Memory already exists in ${seen.file}. Review whether these should be merged.`,
          content: `\n<!-- Dream duplicate review -->\n- Duplicate candidate from ${file.path}: ${line}\n- Similar existing memory in ${seen.file}: ${seen.line}\n`,
          relatedFiles: [seen.file, file.path]
        });
      } else {
        seenLines.set(key, { file: file.path, line });
      }
    }
    if (duplicates.length === 0 && file.path.startsWith("sessions/") && text.length > 3000) {
      operations.push({
        type: "archive_candidate",
        targetFile: "archive/README.md",
        reason: `${file.path} is a long session-derived Memory. Review whether older details should be archived.`,
        content: `\n<!-- Dream archive candidate -->\n- ${file.path}: long session-derived Memory may need summarization or archival.\n`,
        relatedFiles: [file.path]
      });
    }
  }
  if (input.paths) {
    syncMemoryGraph({ ...input, paths: input.paths });
    const graphDuplicateOperations = analyzeGraphDuplicateCandidates(input.paths);
    operations.push(...graphDuplicateOperations);
    operations.push(...analyzeGraphCleanupCandidates(input.paths));
    operations.push(...analyzeGraphConflictGroups(input.paths, graphDuplicateOperations));
  }
  return operations.slice(0, 20);
}

function analyzeGraphDuplicateCandidates(paths: MagiPaths): DreamOperation[] {
  const store = MemoryNodeStore.open(paths);
  try {
    return store.listDuplicateCandidates({ limit: 10 }).map((candidate) => ({
      type: "duplicate" as const,
      targetFile: "archive/README.md",
      reason: `Graph node ${candidate.duplicate.id}: ${candidate.reason}`,
      content: `\n<!-- Dream graph duplicate candidate -->\n- Merge candidate: archive ${candidate.duplicate.title} (${candidate.duplicate.id}) because it duplicates ${candidate.keep.title} (${candidate.keep.id}).\n`,
      relatedFiles: [`graph:${candidate.keep.id}`, `graph:${candidate.duplicate.id}`],
      graphNodeIds: [candidate.duplicate.id],
      graphMerge: {
        keepNodeId: candidate.keep.id,
        duplicateNodeId: candidate.duplicate.id
      }
    }));
  } finally {
    store.close();
  }
}

function analyzeGraphCleanupCandidates(paths: MagiPaths): DreamOperation[] {
  const store = MemoryNodeStore.open(paths);
  try {
    return store
      .listCleanupCandidates({ olderThanDays: 90, maxWeight: 0.35, limit: 10 })
      .map((candidate) => ({
        type: "archive_candidate" as const,
        targetFile: "archive/README.md",
        reason: `Graph node ${candidate.node.id}: ${candidate.reason}`,
        content: `\n<!-- Dream graph archive candidate -->\n- ${candidate.node.title} (${candidate.node.id}): ${candidate.reason}\n`,
        relatedFiles: [`graph:${candidate.node.id}`],
        graphNodeIds: [candidate.node.id]
      }));
  } finally {
    store.close();
  }
}

function analyzeGraphConflictGroups(
  paths: MagiPaths,
  existingOperations: DreamOperation[] = []
): DreamOperation[] {
  const alreadyReviewed = new Set(extractGraphReviewNodeIds(existingOperations));
  const store = MemoryNodeStore.open(paths);
  try {
    return store.listConflictGroups({ limit: 10 }).flatMap((group) => {
      if (group.nodes.some((node) => alreadyReviewed.has(node.id))) {
        return [];
      }
      const preferredNodeId = group.preferredNodeId;
      if (!preferredNodeId) {
        return [];
      }
      const archiveNodeIds = group.nodes
        .map((node) => node.id)
        .filter((id) => id !== preferredNodeId);
      if (archiveNodeIds.length === 0) {
        return [];
      }
      const preferred = group.nodes.find((node) => node.id === preferredNodeId);
      return [
        {
          type: "conflict" as const,
          targetFile: "archive/README.md",
          reason: `Graph conflict group ${group.id}: prefer ${preferred?.title ?? preferredNodeId}; review archiving ${archiveNodeIds.length} conflicting node(s).`,
          content: [
            "",
            "<!-- Dream graph conflict group -->",
            `- Conflict group: ${group.id}`,
            `- Preferred node: ${preferred?.title ?? preferredNodeId} (${preferredNodeId})`,
            ...group.nodes
              .filter((node) => node.id !== preferredNodeId)
              .map(
                (node) =>
                  `- Archive candidate: ${node.title} (${node.id}, ${node.status}, weight ${node.weight.toFixed(2)})`
              ),
            ""
          ].join("\n"),
          relatedFiles: group.nodes.map((node) => `graph:${node.id}`),
          graphNodeIds: archiveNodeIds,
          graphConflictGroup: {
            groupId: group.id,
            preferredNodeId,
            nodeIds: group.nodes.map((node) => node.id),
            conflictEdgeIds: group.conflicts.map((conflict) => conflict.edge.id)
          }
        }
      ];
    });
  } finally {
    store.close();
  }
}

function extractGraphReviewNodeIds(operations: DreamOperation[]): string[] {
  const ids = new Set(extractGraphNodeIds(operations));
  for (const op of operations) {
    if (op.graphMerge) {
      ids.add(op.graphMerge.keepNodeId);
      ids.add(op.graphMerge.duplicateNodeId);
    }
    if (op.graphConflictGroup) {
      for (const id of op.graphConflictGroup.nodeIds) {
        ids.add(id);
      }
    }
  }
  return Array.from(ids).filter(Boolean);
}

function mergeDreamGraphDuplicates(input: {
  paths?: MagiPaths;
  dreamId: string;
  operations: DreamOperation[];
}): {
  mergedNodeIds: string[];
  redirectedEdgeCount: number;
  resolvedEdgeConflictCount: number;
  fusedWeightCount: number;
} {
  const mergeOperations = input.operations.filter((op) => op.graphMerge);
  if (!input.paths || mergeOperations.length === 0) {
    return {
      mergedNodeIds: [],
      redirectedEdgeCount: 0,
      resolvedEdgeConflictCount: 0,
      fusedWeightCount: 0
    };
  }
  const store = MemoryNodeStore.open(input.paths);
  try {
    const mergedNodeIds: string[] = [];
    let redirectedEdgeCount = 0;
    let resolvedEdgeConflictCount = 0;
    let fusedWeightCount = 0;
    for (const op of mergeOperations) {
      const merge = op.graphMerge!;
      const result = store.mergeDuplicateNode({
        keepId: merge.keepNodeId,
        duplicateId: merge.duplicateNodeId,
        reason: `Merged by Dream ${input.dreamId}`,
        metadata: { dreamId: input.dreamId }
      });
      if (result.archived.length > 0) {
        mergedNodeIds.push(result.duplicate.id);
      }
      redirectedEdgeCount += result.redirectedEdges.length;
      resolvedEdgeConflictCount += result.resolvedEdgeConflictCount;
      if (result.nextKeepWeight > result.previousKeepWeight) {
        fusedWeightCount += 1;
      }
    }
    return { mergedNodeIds, redirectedEdgeCount, resolvedEdgeConflictCount, fusedWeightCount };
  } finally {
    store.close();
  }
}

function archiveDreamGraphNodes(input: {
  paths?: MagiPaths;
  dreamId: string;
  nodeIds: string[];
}): string[] {
  if (!input.paths || input.nodeIds.length === 0) return [];
  const store = MemoryNodeStore.open(input.paths);
  try {
    return store
      .archiveNodes({
        ids: input.nodeIds,
        reason: `Archived by Dream ${input.dreamId}`,
        metadata: { dreamId: input.dreamId }
      })
      .map((node) => node.id);
  } finally {
    store.close();
  }
}

function keepDreamGraphNodes(input: {
  paths?: MagiPaths;
  dreamId: string;
  nodeIds: string[];
}): string[] {
  if (!input.paths || input.nodeIds.length === 0) return [];
  const store = MemoryNodeStore.open(input.paths);
  try {
    return store
      .keepNodes({
        ids: input.nodeIds,
        reason: `Kept by Dream ${input.dreamId}`,
        metadata: { dreamId: input.dreamId }
      })
      .map((node) => node.id);
  } finally {
    store.close();
  }
}

function extractGraphNodeIds(operations: DreamOperation[], storedIds: string[] = []): string[] {
  const ids = new Set(storedIds.filter(Boolean));
  for (const op of operations) {
    if (op.graphNodeIds && op.graphNodeIds.length > 0) {
      for (const id of op.graphNodeIds) {
        if (id.trim()) ids.add(id.trim());
      }
      continue;
    }
    for (const related of op.relatedFiles ?? []) {
      if (related.startsWith("graph:")) {
        const id = related.slice("graph:".length).trim();
        if (id) ids.add(id);
      }
    }
  }
  return Array.from(ids);
}

function formatDreamSummary(operations: DreamOperation[]): string {
  if (operations.length === 0) {
    return "Dream found no duplicate, conflict, or archive candidates.";
  }
  const counts = operations.reduce<Record<string, number>>((acc, op) => {
    acc[op.type] = (acc[op.type] ?? 0) + 1;
    return acc;
  }, {});
  return `Dream found ${operations.length} review candidate(s): ${Object.entries(counts)
    .map(([type, count]) => `${count} ${type}`)
    .join(", ")}.`;
}

function formatDreamMarkdown(manifest: DreamManifest): string {
  return [
    `# Dream ${manifest.id}`,
    "",
    manifest.summary,
    "",
    `Status: ${manifest.status}`,
    `Created: ${manifest.createdAt}`,
    "",
    "## Operations",
    ...manifest.operations.map((op, index) =>
      [
        "",
        `### ${index + 1}. ${op.type}`,
        `Target: ${op.targetFile}`,
        `Reason: ${op.reason}`,
        op.relatedFiles?.length ? `Related: ${op.relatedFiles.join(", ")}` : undefined
      ]
        .filter(Boolean)
        .join("\n")
    ),
    ""
  ].join("\n");
}

function formatConflictsMarkdown(operations: DreamOperation[]): string {
  const conflicts = operations.filter((op) => op.type === "conflict");
  if (conflicts.length === 0) return "# Conflicts\n\nNo conflicts detected.\n";
  return (
    ["# Conflicts", "", ...conflicts.map((op) => `- ${op.targetFile}: ${op.reason}`)].join("\n") +
    "\n"
  );
}

function dreamManifestPath(root: string, id: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safeId) throw new Error("Dream id must not be empty");
  return path.join(root, "dreams", safeId, "manifest.json");
}

function readDreamManifest(file: string): DreamManifest {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as DreamManifest;
  if (!parsed.id || !Array.isArray(parsed.operations) || !Array.isArray(parsed.draftIds)) {
    throw new Error(`Invalid Dream manifest: ${file}`);
  }
  return parsed;
}

function createDreamId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T.Z]/g, "")
    .slice(0, 14);
  return `dream_${stamp}_${randomUUID().slice(0, 8)}`;
}

function normalizeLine(line: string): string {
  return line
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .trim();
}
