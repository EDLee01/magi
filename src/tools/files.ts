import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { HookDefinition } from "../config.js";
import { triggerHook } from "../hooks/trigger.js";
import { ToolError } from "./errors.js";
import { isBinaryBuffer, resolveWorkspacePath } from "./workspace.js";

export interface ReadFileResult {
  path: string;
  content: string;
  sizeBytes: number;
}

export interface WriteFileResult {
  path: string;
  diff: string;
  approved: boolean;
}

export interface EditFileResult extends WriteFileResult {
  occurrences: number;
}

export function readWorkspaceFile(input: {
  cwd: string;
  filePath: string;
  maxBytes?: number;
}): ReadFileResult {
  const maxBytes = input.maxBytes ?? 256 * 1024;
  const resolved = resolveWorkspacePath(input.cwd, input.filePath);
  const stat = statSync(resolved.absolutePath);
  if (!stat.isFile()) {
    throw new ToolError(`${input.filePath} is not a file`, "not-found");
  }
  if (stat.size > maxBytes) {
    throw new ToolError(`${input.filePath} is ${stat.size} bytes, above the ${maxBytes} byte read limit`, "file-too-large");
  }

  const content = readFileSync(resolved.absolutePath);
  if (isBinaryBuffer(content)) {
    throw new ToolError(`${input.filePath} appears to be binary`, "binary-file");
  }

  return {
    path: resolved.relativePath,
    content: content.toString("utf8"),
    sizeBytes: stat.size
  };
}

export function writeWorkspaceFile(input: {
  cwd: string;
  filePath: string;
  content: string;
  approved: boolean;
  hooks?: HookDefinition[];
  sessionId?: string;
}): WriteFileResult {
  if (!input.approved) {
    throw new ToolError(`Writing ${input.filePath} requires diff approval`, "approval-required");
  }

  const resolved = resolveWorkspacePath(input.cwd, input.filePath);
  const before = existsSync(resolved.absolutePath) ? readFileSync(resolved.absolutePath, "utf8") : "";
  const diff = createUnifiedDiff(resolved.relativePath, before, input.content);
  mkdirSync(path.dirname(resolved.absolutePath), { recursive: true });
  atomicWriteFile(resolved.absolutePath, input.content);
  
  if (input.hooks) {
    void triggerHook({
      event: "file_changed",
      hooks: input.hooks,
      context: {
        sessionId: input.sessionId,
        cwd: input.cwd,
        filePath: resolved.relativePath,
        action: "write"
      }
    });
  }

  return {
    path: resolved.relativePath,
    diff,
    approved: true
  };
}

export function editWorkspaceFile(input: {
  cwd: string;
  filePath: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
  approved: boolean;
  hooks?: HookDefinition[];
  sessionId?: string;
}): EditFileResult {
  if (!input.approved) {
    throw new ToolError(`Editing ${input.filePath} requires diff approval`, "approval-required");
  }
  if (!input.oldString) {
    throw new ToolError("old_string must not be empty", "bad-input");
  }

  const resolved = resolveWorkspacePath(input.cwd, input.filePath);
  const before = readFileSync(resolved.absolutePath, "utf8");
  const occurrences = countOccurrences(before, input.oldString);
  if (occurrences === 0) {
    throw new ToolError("old_string not found in file", "not-found");
  }
  if (occurrences > 1 && !input.replaceAll) {
    throw new ToolError("old_string is not unique; use replace_all or provide more context", "bad-input");
  }
  const after = input.replaceAll
    ? before.split(input.oldString).join(input.newString)
    : before.replace(input.oldString, input.newString);
  const diff = createUnifiedDiff(resolved.relativePath, before, after);
  atomicWriteFile(resolved.absolutePath, after);
  
  if (input.hooks) {
    void triggerHook({
      event: "file_changed",
      hooks: input.hooks,
      context: {
        sessionId: input.sessionId,
        cwd: input.cwd,
        filePath: resolved.relativePath,
        action: "edit"
      }
    });
  }

  return {
    path: resolved.relativePath,
    diff,
    approved: true,
    occurrences
  };
}

export function createUnifiedDiff(filePath: string, before: string, after: string): string {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  return [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    "@@",
    ...beforeLines.filter((line, index) => index < beforeLines.length - 1 || line !== "").map((line) => `-${line}`),
    ...afterLines.filter((line, index) => index < afterLines.length - 1 || line !== "").map((line) => `+${line}`),
    ""
  ].join("\n");
}

function atomicWriteFile(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, filePath);
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    index = text.indexOf(needle, index);
    if (index === -1) {
      return count;
    }
    count += 1;
    index += needle.length;
  }
}
