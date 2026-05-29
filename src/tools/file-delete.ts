import { existsSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { resolveWorkspacePath } from "./workspace.js";
import { ToolError } from "./errors.js";

export interface FileDeleteResult {
  path: string;
  sizeBytes: number;
  directories: number;
  files: number;
}

export const FileDeleteInputSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    recursive: { type: "boolean" },
    force: { type: "boolean" }
  },
  required: ["path"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseFileDeleteInput(input: Record<string, unknown>): {
  path: string;
  recursive: boolean;
  force: boolean;
} {
  const p = typeof input.path === "string" ? input.path : "";
  if (!p) throw new ToolError("path is required", "bad-input");
  return { path: p, recursive: input.recursive === true, force: input.force === true };
}

export function executeFileDelete(input: {
  path: string;
  recursive: boolean;
  force: boolean;
  cwd: string;
}): FileDeleteResult {
  const resolved = resolveWorkspacePath(input.cwd, input.path).absolutePath;
  if (!existsSync(resolved)) throw new ToolError(`Path not found: ${input.path}`, "not-found");

  const stat = statSync(resolved);
  let dirs = 0,
    files = 0;

  if (stat.isDirectory() && input.recursive) {
    const entries = readdirSync(resolved, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) dirs++;
      else files++;
    }
  } else if (stat.isFile()) {
    files = 1;
  }

  const size = stat.size;
  rmSync(resolved, { recursive: input.recursive, force: input.force });
  return { path: input.path, sizeBytes: size, directories: dirs, files };
}

export function formatFileDeleteResult(result: FileDeleteResult): string {
  const parts = [`Deleted ${result.path}`];
  if (result.files > 0) parts.push(`${result.files} files`);
  if (result.directories > 0) parts.push(`${result.directories} dirs`);
  parts.push(`(${(result.sizeBytes / 1024).toFixed(1)} KB)`);
  return parts.join(" (") + ")";
}
