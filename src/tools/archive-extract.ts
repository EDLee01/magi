import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { resolveWorkspacePath } from "./workspace.js";
import { ToolError } from "./errors.js";

export interface ArchiveExtractResult {
  path: string;
  outputDir: string;
  succeeded: boolean;
}
export const ArchiveExtractInputSchema = {
  type: "object",
  properties: { archive: { type: "string" }, output: { type: "string" } },
  required: ["archive"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseArchiveExtractInput(input: Record<string, unknown>): {
  archive: string;
  output?: string;
} {
  return {
    archive: typeof input.archive === "string" ? input.archive : "",
    output: typeof input.output === "string" ? input.output : undefined
  };
}

export function executeArchiveExtract(input: {
  archive: string;
  output?: string;
  cwd: string;
}): ArchiveExtractResult {
  const arcPath = resolveWorkspacePath(input.cwd, input.archive).absolutePath;
  if (!existsSync(arcPath)) throw new ToolError(`Archive not found: ${input.archive}`, "not-found");
  const outDir = input.output
    ? resolveWorkspacePath(input.cwd, input.output).absolutePath
    : path.dirname(arcPath);
  mkdirSync(outDir, { recursive: true });

  const isZip = input.archive.endsWith(".zip");
  const cmd = isZip ? "unzip" : "tar";

  // For zip: use -d to extract to directory, -o to overwrite
  // For tar: use -C to extract to directory
  // Both commands will respect the output directory and prevent path traversal
  // by default when using -d/-C flags
  const args = isZip ? ["-o", arcPath, "-d", outDir] : ["-xzf", arcPath, "-C", outDir];

  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.status !== 0) throw new ToolError(`${cmd} failed: ${result.stderr}`, "command-failed");
  return {
    path: input.archive,
    outputDir: input.output ?? path.dirname(input.archive),
    succeeded: true
  };
}

export function formatArchiveExtractResult(result: ArchiveExtractResult): string {
  return `Extracted ${result.path} → ${result.outputDir}`;
}
