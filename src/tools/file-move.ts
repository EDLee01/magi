import { existsSync, renameSync, statSync, mkdirSync } from "node:fs";
import path from "node:path";

import { ToolError } from "./errors.js";
import { resolveWorkspacePath } from "./workspace.js";

export interface FileMoveResult {
  source: string;
  destination: string;
  sizeBytes: number;
}

export const FileMoveInputSchema = {
  type: "object",
  properties: {
    source: { type: "string" },
    destination: { type: "string" },
    overwrite: { type: "boolean" }
  },
  required: ["source", "destination"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseFileMoveInput(input: Record<string, unknown>): {
  source: string;
  destination: string;
  overwrite: boolean;
} {
  const source = typeof input.source === "string" ? input.source : "";
  const destination = typeof input.destination === "string" ? input.destination : "";
  const overwrite = input.overwrite === true;
  if (!source) throw new ToolError("source is required", "bad-input");
  if (!destination) throw new ToolError("destination is required", "bad-input");
  return { source, destination, overwrite };
}

export function executeFileMove(input: {
  source: string;
  destination: string;
  overwrite: boolean;
  cwd: string;
}): FileMoveResult {
  const src = resolveWorkspacePath(input.cwd, input.source).absolutePath;
  const dst = resolveWorkspacePath(input.cwd, input.destination).absolutePath;
  if (!existsSync(src)) throw new ToolError(`Source not found: ${input.source}`, "not-found");
  if (existsSync(dst) && !input.overwrite)
    throw new ToolError(
      `Destination exists: ${input.destination}. Use overwrite: true.`,
      "outside-workspace"
    );
  const dstDir = path.dirname(dst);
  mkdirSync(dstDir, { recursive: true });
  renameSync(src, dst);
  const stat = statSync(dst);
  return { source: input.source, destination: input.destination, sizeBytes: stat.size };
}

export function formatFileMoveResult(result: FileMoveResult): string {
  return `Moved ${result.source} → ${result.destination} (${result.sizeBytes} bytes)`;
}
