import { mkdirSync } from "node:fs";
import { resolveWorkspacePath } from "./workspace.js";
import { ToolError } from "./errors.js";

export interface DirCreateResult {
  path: string;
}

export const DirCreateInputSchema = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseDirCreateInput(input: Record<string, unknown>): { path: string } {
  const p = typeof input.path === "string" ? input.path : "";
  if (!p) throw new ToolError("path is required", "bad-input");
  return { path: p };
}

export function executeDirCreate(input: { path: string; cwd: string }): DirCreateResult {
  const resolved = resolveWorkspacePath(input.cwd, input.path).absolutePath;
  mkdirSync(resolved, { recursive: true });
  return { path: input.path };
}

export function formatDirCreateResult(result: DirCreateResult): string {
  return `Created directory: ${result.path}`;
}
