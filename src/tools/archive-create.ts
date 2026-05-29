import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { ToolError } from "./errors.js";
import { resolveWorkspacePath } from "./workspace.js";

export interface ArchiveCreateResult {
  path: string;
  format: string;
  sizeBytes: number;
  fileCount: number;
}
export const ArchiveCreateInputSchema = {
  type: "object",
  properties: {
    source: { type: "string" },
    output: { type: "string" },
    format: { type: "string", enum: ["tar.gz", "zip"] }
  },
  required: ["source", "output"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseArchiveCreateInput(input: Record<string, unknown>): {
  source: string;
  output: string;
  format: string;
} {
  return {
    source: typeof input.source === "string" ? input.source : "",
    output: typeof input.output === "string" ? input.output : "",
    format: input.format === "zip" ? "zip" : "tar.gz"
  };
}

export function executeArchiveCreate(input: {
  source: string;
  output: string;
  format: string;
  cwd: string;
}): ArchiveCreateResult {
  const src = resolveWorkspacePath(input.cwd, input.source).absolutePath;
  const dst = resolveWorkspacePath(input.cwd, input.output).absolutePath;
  if (!existsSync(src)) throw new ToolError(`Source not found: ${input.source}`, "not-found");

  if (input.format === "zip") {
    const result = spawnSync("zip", ["-r", dst, ".", "-i", src], {
      cwd: input.cwd,
      encoding: "utf8"
    });
    if (result.status !== 0) throw new ToolError(`zip failed: ${result.stderr}`, "command-failed");
  } else {
    const parent = input.source.endsWith("/") ? input.source : path.dirname(input.source);
    const base = path.basename(src);
    const result = spawnSync(
      "tar",
      ["-czf", dst, "-C", parent === "." ? input.cwd : path.resolve(input.cwd, parent), base],
      { encoding: "utf8" }
    );
    if (result.status !== 0) throw new ToolError(`tar failed: ${result.stderr}`, "command-failed");
  }

  const stat = statSync(dst);
  return { path: input.output, format: input.format, sizeBytes: stat.size, fileCount: -1 };
}

export function formatArchiveCreateResult(result: ArchiveCreateResult): string {
  return `Created ${result.path} (${result.format}, ${result.sizeBytes} bytes)`;
}
