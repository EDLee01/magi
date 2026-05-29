import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { resolveWorkspacePath } from "./workspace.js";
import { ToolError } from "./errors.js";

export interface DirEntry {
  name: string;
  type: "file" | "dir" | "symlink";
  sizeBytes: number;
  modifiedAt: string;
}
export interface DirListResult {
  path: string;
  entries: DirEntry[];
  totalFiles: number;
  totalDirs: number;
  totalSize: number;
}

export const DirListInputSchema = {
  type: "object",
  properties: { path: { type: "string" }, max_results: { type: "number" } },
  required: ["path"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseDirListInput(input: Record<string, unknown>): {
  path: string;
  maxResults: number;
} {
  const p = typeof input.path === "string" ? input.path : "";
  if (!p) throw new ToolError("path is required", "bad-input");
  return { path: p, maxResults: typeof input.max_results === "number" ? input.max_results : 200 };
}

export function executeDirList(input: {
  path: string;
  maxResults: number;
  cwd: string;
}): DirListResult {
  const resolved = resolveWorkspacePath(input.cwd, input.path).absolutePath;
  const names = readdirSync(resolved).slice(0, input.maxResults);
  let totalFiles = 0,
    totalDirs = 0,
    totalSize = 0;
  const entries: DirEntry[] = names.map((name) => {
    const full = path.join(resolved, name);
    try {
      const stat = statSync(full);
      const type = stat.isDirectory()
        ? ("dir" as const)
        : stat.isSymbolicLink()
          ? ("symlink" as const)
          : ("file" as const);
      if (type === "file") {
        totalFiles++;
        totalSize += stat.size;
      }
      if (type === "dir") totalDirs++;
      return {
        name,
        type,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString().slice(0, 19).replace("T", " ")
      };
    } catch {
      return { name, type: "file" as const, sizeBytes: 0, modifiedAt: "unknown" };
    }
  });
  return { path: input.path, entries, totalFiles, totalDirs, totalSize };
}

export function formatDirListResult(result: DirListResult): string {
  const lines = result.entries.map((e) => {
    const icon = e.type === "dir" ? "[DIR]" : e.type === "symlink" ? "[LNK]" : "     ";
    const size =
      e.type === "file" ? `${(e.sizeBytes / 1024).toFixed(1)} KB`.padStart(10) : " ".repeat(10);
    return `${icon} ${e.name.padEnd(30)} ${size}  ${e.modifiedAt}`;
  });
  return [
    `Directory: ${result.path} (${result.entries.length} items)`,
    ...lines,
    `\n${result.totalFiles} files, ${result.totalDirs} dirs, ${(result.totalSize / 1024).toFixed(1)} KB total`
  ].join("\n");
}
