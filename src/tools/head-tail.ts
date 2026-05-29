import { readFileSync, statSync } from "node:fs";

import { ToolError } from "./errors.js";
import { resolveWorkspacePath } from "./workspace.js";

export interface HeadTailResult {
  path: string;
  lines: string[];
  count: number;
  totalLines: number;
}
export const HeadTailInputSchema = {
  type: "object",
  properties: { path: { type: "string" }, lines: { type: "number" }, tail: { type: "boolean" } },
  required: ["path"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseHeadTailInput(input: Record<string, unknown>): {
  path: string;
  lines: number;
  tail: boolean;
} {
  const p = typeof input.path === "string" ? input.path : "";
  if (!p) throw new ToolError("path is required", "bad-input");
  return {
    path: p,
    lines: typeof input.lines === "number" ? Math.min(Math.max(input.lines, 1), 500) : 50,
    tail: input.tail === true
  };
}

export function executeHeadTail(input: {
  path: string;
  lines: number;
  tail: boolean;
  cwd: string;
}): HeadTailResult {
  const resolved = resolveWorkspacePath(input.cwd, input.path).absolutePath;
  const content = readFileSync(resolved, "utf8");
  const allLines = content.split("\n");
  const totalLines = allLines.length;
  const count = Math.min(input.lines, totalLines);
  const lines = input.tail ? allLines.slice(-count) : allLines.slice(0, count);
  return { path: input.path, lines, count, totalLines };
}

export function formatHeadTailResult(result: HeadTailResult): string {
  return result.lines.join("\n") + `\n--- ${result.count}/${result.totalLines} lines ---`;
}
