import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { atomicWrite } from "./fs-utils.js";
import { ensureMemoryStructure, listMemoryFiles, memoryRoot, MemoryRootOptions } from "./memory-files.js";
import { MemoryDraft, proposeMemoryDraft } from "./memory-draft.js";
import { recordMemoryAudit } from "./memory-audit.js";

export type DreamStatus = "pending" | "applied" | "rejected";

export interface DreamOperation {
  type: "duplicate" | "conflict" | "archive_candidate";
  targetFile: string;
  reason: string;
  content?: string;
  relatedFiles?: string[];
}

export interface DreamManifest {
  id: string;
  createdAt: string;
  status: DreamStatus;
  summary: string;
  operations: DreamOperation[];
  draftIds: string[];
}

export interface DreamRecord {
  id: string;
  path: string;
  status: DreamStatus;
  createdAt: string;
  operationCount: number;
  draftCount: number;
}

export function runDream(input: MemoryRootOptions): DreamManifest {
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
    draftIds
  };
  atomicWrite(path.join(dreamRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  atomicWrite(path.join(dreamRoot, "summary.md"), formatDreamMarkdown(manifest));
  atomicWrite(path.join(dreamRoot, "proposed_patches.json"), JSON.stringify({ draftIds, operations }, null, 2) + "\n");
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
        return [{
          id: manifest.id,
          path: path.dirname(manifestFile),
          status: manifest.status,
          createdAt: manifest.createdAt,
          operationCount: manifest.operations.length,
          draftCount: manifest.draftIds.length
        }];
      } catch {
        return [];
      }
    });
}

export function showDream(input: MemoryRootOptions & { id: string }): DreamManifest {
  return readDreamManifest(dreamManifestPath(memoryRoot(input), input.id));
}

export function applyDream(input: MemoryRootOptions & { id: string; applyDraft: (draftId: string) => MemoryDraft }): DreamManifest {
  const root = ensureMemoryStructure(input);
  const file = dreamManifestPath(root, input.id);
  const manifest = readDreamManifest(file);
  if (manifest.status !== "pending") {
    throw new Error(`Dream is not pending: ${manifest.id}`);
  }
  for (const draftId of manifest.draftIds) {
    input.applyDraft(draftId);
  }
  const applied = { ...manifest, status: "applied" as const };
  atomicWrite(file, JSON.stringify(applied, null, 2) + "\n");
  recordMemoryAudit({
    ...input,
    root,
    action: "memory.dream.applied",
    target: manifest.id,
    metadata: { draftIds: manifest.draftIds }
  });
  return applied;
}

export function rejectDream(input: MemoryRootOptions & { id: string; rejectDraft: (draftId: string) => MemoryDraft }): DreamManifest {
  const root = ensureMemoryStructure(input);
  const file = dreamManifestPath(root, input.id);
  const manifest = readDreamManifest(file);
  if (manifest.status !== "pending") {
    throw new Error(`Dream is not pending: ${manifest.id}`);
  }
  for (const draftId of manifest.draftIds) {
    input.rejectDraft(draftId);
  }
  const rejected = { ...manifest, status: "rejected" as const };
  atomicWrite(file, JSON.stringify(rejected, null, 2) + "\n");
  recordMemoryAudit({
    ...input,
    root,
    action: "memory.dream.rejected",
    target: manifest.id,
    metadata: { draftIds: manifest.draftIds }
  });
  return rejected;
}

function analyzeMemory(input: MemoryRootOptions): DreamOperation[] {
  const operations: DreamOperation[] = [];
  const files = listMemoryFiles(input).filter((file) =>
    !file.path.startsWith("drafts/")
      && !file.path.startsWith("dreams/")
      && !file.path.startsWith("archive/")
      && !file.path.startsWith("logs/")
  );
  const seenLines = new Map<string, { file: string; line: string }>();
  for (const file of files) {
    const text = readFileSync(file.absolutePath, "utf8");
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) =>
      line.length > 12 && !line.startsWith("#") && !line.startsWith("---")
    );
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
  return operations.slice(0, 20);
}

function formatDreamSummary(operations: DreamOperation[]): string {
  if (operations.length === 0) {
    return "Dream found no duplicate, conflict, or archive candidates.";
  }
  const counts = operations.reduce<Record<string, number>>((acc, op) => {
    acc[op.type] = (acc[op.type] ?? 0) + 1;
    return acc;
  }, {});
  return `Dream found ${operations.length} review candidate(s): ${
    Object.entries(counts).map(([type, count]) => `${count} ${type}`).join(", ")
  }.`;
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
    ...manifest.operations.map((op, index) => [
      "",
      `### ${index + 1}. ${op.type}`,
      `Target: ${op.targetFile}`,
      `Reason: ${op.reason}`,
      op.relatedFiles?.length ? `Related: ${op.relatedFiles.join(", ")}` : undefined
    ].filter(Boolean).join("\n")),
    ""
  ].join("\n");
}

function formatConflictsMarkdown(operations: DreamOperation[]): string {
  const conflicts = operations.filter((op) => op.type === "conflict");
  if (conflicts.length === 0) return "# Conflicts\n\nNo conflicts detected.\n";
  return [
    "# Conflicts",
    "",
    ...conflicts.map((op) => `- ${op.targetFile}: ${op.reason}`)
  ].join("\n") + "\n";
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
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  return `dream_${stamp}`;
}

function normalizeLine(line: string): string {
  return line.toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, " ").trim();
}
