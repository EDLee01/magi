import { readFileSync, statSync } from "node:fs";
import { resolveWorkspacePath } from "./workspace.js";
import { ToolError } from "./errors.js";

export interface TextStatsResult {
  path: string;
  lines: number;
  words: number;
  chars: number;
  bytes: number;
}
export const TextStatsInputSchema = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseTextStatsInput(input: Record<string, unknown>): { path: string } {
  const p = typeof input.path === "string" ? input.path : "";
  if (!p) throw new ToolError("path is required", "bad-input");
  return { path: p };
}

export function executeTextStats(input: { path: string; cwd: string }): TextStatsResult {
  const resolved = resolveWorkspacePath(input.cwd, input.path).absolutePath;
  const content = readFileSync(resolved, "utf8");
  const stat = statSync(resolved);
  const lines = content.split("\n");
  const lastLine = lines[lines.length - 1];
  const lineCount = lastLine === "" ? lines.length - 1 : lines.length;
  const words = content.split(/\s+/).filter(Boolean).length;
  const chars = content.length;
  return { path: input.path, lines: lineCount, words, chars, bytes: stat.size };
}

export function formatTextStatsResult(result: TextStatsResult): string {
  return `${result.path}: ${result.lines} lines, ${result.words} words, ${result.chars} chars, ${result.bytes} bytes`;
}
