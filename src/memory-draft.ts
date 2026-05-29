import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { atomicWrite } from "./fs-utils.js";
import {
  appendMemoryFile,
  ensureMemoryStructure,
  isMemoryContentSafe,
  memoryRoot,
  MemoryRootOptions,
  resolveMemoryFilePath
} from "./memory-files.js";
import { recordMemoryAudit } from "./memory-audit.js";

export type MemoryDraftStatus = "pending" | "applied" | "rejected";
export type MemoryDraftOperation = "append";

export interface MemoryDraft {
  id: string;
  createdAt: string;
  status: MemoryDraftStatus;
  targetFile: string;
  operation: MemoryDraftOperation;
  content: string;
  reason: string;
  sourceSession?: string;
  confidence?: number;
  requiresReview: boolean;
}

export interface MemoryDraftRecord {
  id: string;
  path: string;
  status: MemoryDraftStatus;
  targetFile: string;
  createdAt: string;
}

export function proposeMemoryDraft(
  input: MemoryRootOptions & {
    targetFile: string;
    content: string;
    reason: string;
    sourceSession?: string;
    confidence?: number;
    id?: string;
  }
): MemoryDraft {
  if (!isMemoryContentSafe(input.content)) {
    throw new Error(
      "Memory Draft rejected because it appears to contain a secret, token, password, or API key"
    );
  }
  const root = ensureMemoryStructure(input);
  resolveMemoryFilePath(root, input.targetFile);
  const draft: MemoryDraft = {
    id: input.id ?? createDraftId(),
    createdAt: new Date().toISOString(),
    status: "pending",
    targetFile: input.targetFile,
    operation: "append",
    content: input.content.trim(),
    reason: input.reason.trim() || "Memory update proposed by agent",
    sourceSession: input.sourceSession,
    confidence: input.confidence,
    requiresReview: true
  };
  const file = draftFilePath(root, draft.id);
  mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, JSON.stringify(draft, null, 2) + "\n");
  recordMemoryAudit({
    ...input,
    root,
    action: "memory.draft.proposed",
    target: draft.targetFile,
    sessionId: input.sourceSession,
    metadata: { draftId: draft.id, reason: draft.reason }
  });
  return draft;
}

export function listDrafts(input: MemoryRootOptions): MemoryDraftRecord[] {
  const root = memoryRoot(input);
  const draftsRoot = path.join(root, "drafts");
  if (!existsSync(draftsRoot)) return [];
  return readdirSync(draftsRoot)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .flatMap((name) => {
      const file = path.join(draftsRoot, name);
      try {
        if (!statSync(file).isFile()) return [];
        const draft = readDraftFile(file);
        return [
          {
            id: draft.id,
            path: file,
            status: draft.status,
            targetFile: draft.targetFile,
            createdAt: draft.createdAt
          }
        ];
      } catch {
        return [];
      }
    });
}

export function showDraft(input: MemoryRootOptions & { id: string }): MemoryDraft {
  return readDraftFile(draftFilePath(memoryRoot(input), input.id));
}

export function applyDraft(input: MemoryRootOptions & { id: string }): MemoryDraft {
  const root = ensureMemoryStructure(input);
  const file = draftFilePath(root, input.id);
  const draft = readDraftFile(file);
  if (draft.status !== "pending") {
    throw new Error(`Memory Draft is not pending: ${draft.id}`);
  }
  appendMemoryFile({
    ...input,
    root,
    filePath: draft.targetFile,
    content: draft.content
  });
  const applied = { ...draft, status: "applied" as const };
  atomicWrite(file, JSON.stringify(applied, null, 2) + "\n");
  recordMemoryAudit({
    ...input,
    root,
    action: "memory.draft.applied",
    target: draft.targetFile,
    sessionId: draft.sourceSession,
    metadata: { draftId: draft.id }
  });
  return applied;
}

export function rejectDraft(input: MemoryRootOptions & { id: string }): MemoryDraft {
  const root = ensureMemoryStructure(input);
  const file = draftFilePath(root, input.id);
  const draft = readDraftFile(file);
  if (draft.status !== "pending") {
    throw new Error(`Memory Draft is not pending: ${draft.id}`);
  }
  const rejected = { ...draft, status: "rejected" as const };
  atomicWrite(file, JSON.stringify(rejected, null, 2) + "\n");
  recordMemoryAudit({
    ...input,
    root,
    action: "memory.draft.rejected",
    target: draft.targetFile,
    sessionId: draft.sourceSession,
    metadata: { draftId: draft.id }
  });
  return rejected;
}

export function formatDraftReview(input: MemoryRootOptions & { id: string }): string {
  const draft = showDraft(input);
  return [
    `Memory Draft: ${draft.id}`,
    `Status: ${draft.status}`,
    `Operation: ${draft.operation}`,
    `Target: ${draft.targetFile}`,
    `Reason: ${draft.reason}`,
    draft.sourceSession ? `Source session: ${draft.sourceSession}` : undefined,
    draft.confidence !== undefined ? `Confidence: ${draft.confidence}` : undefined,
    "",
    "Preview:",
    "```md",
    draft.content,
    "```",
    "",
    `Apply: magi memory draft apply ${draft.id}`,
    `Reject: magi memory draft reject ${draft.id}`
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function draftFilePath(root: string, id: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safeId) throw new Error("Memory Draft id must not be empty");
  return path.join(root, "drafts", `${safeId}.json`);
}

function readDraftFile(file: string): MemoryDraft {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as MemoryDraft;
  if (!parsed.id || !parsed.targetFile || parsed.operation !== "append") {
    throw new Error(`Invalid Memory Draft: ${file}`);
  }
  return parsed;
}

function createDraftId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T.Z]/g, "")
    .slice(0, 14);
  return `patch_${stamp}_${randomUUID().slice(0, 8)}`;
}
