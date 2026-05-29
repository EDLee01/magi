import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

import { ToolError } from "./errors.js";
import { resolveWorkspacePath } from "./workspace.js";

export interface FileCopyResult {
  source: string;
  destination: string;
  sizeBytes: number;
  overwritten: boolean;
}

export const FileCopyInputSchema = {
  type: "object",
  properties: {
    source: { type: "string" },
    destination: { type: "string" },
    overwrite: { type: "boolean" }
  },
  required: ["source", "destination"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseFileCopyInput(input: Record<string, unknown>): {
  source: string;
  destination: string;
  overwrite: boolean;
} {
  const source = readString(input, "source");
  const destination = readString(input, "destination");
  const overwrite = input.overwrite === true;
  return { source, destination, overwrite };
}

export function executeFileCopy(input: {
  source: string;
  destination: string;
  overwrite: boolean;
  cwd: string;
}): FileCopyResult {
  const src = resolveWorkspacePath(input.cwd, input.source).absolutePath;
  const dst = resolveWorkspacePath(input.cwd, input.destination).absolutePath;

  if (!existsSync(src)) {
    throw new ToolError(`Source not found: ${input.source}`, "not-found");
  }
  const dstExistedBefore = existsSync(dst);
  if (dstExistedBefore && !input.overwrite) {
    throw new ToolError(
      `Destination exists: ${input.destination}. Use overwrite: true to replace.`,
      "outside-workspace"
    );
  }

  mkdirSync(path.dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  const stat = statSync(dst);

  return {
    source: input.source,
    destination: input.destination,
    sizeBytes: stat.size,
    overwritten: dstExistedBefore
  };
}

export function formatFileCopyResult(result: FileCopyResult): string {
  return `Copied ${result.source} → ${result.destination} (${result.sizeBytes} bytes)${result.overwritten ? " [overwritten]" : ""}`;
}

function readString(input: Record<string, unknown>, name: string): string {
  if (typeof input[name] !== "string" || !input[name]) {
    throw new Error(`Tool input ${name} must be a non-empty string`);
  }
  return input[name] as string;
}
