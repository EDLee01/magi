import { spawnSync } from "node:child_process";
import { ToolError } from "./errors.js";

export interface GitResetResult {
  files: string[];
  output: string;
}
export const GitResetInputSchema = {
  type: "object",
  properties: { files: { type: "array", items: { type: "string" } }, hard: { type: "boolean" } },
  required: [],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseGitResetInput(input: Record<string, unknown>): {
  files: string[];
  hard: boolean;
} {
  return {
    files: Array.isArray(input.files) ? input.files.filter((f) => typeof f === "string") : [],
    hard: input.hard === true
  };
}

export function executeGitReset(input: {
  files: string[];
  hard: boolean;
  cwd: string;
}): GitResetResult {
  if (input.hard) {
    const result = spawnSync("git", ["reset", "--hard"], { cwd: input.cwd, encoding: "utf8" });
    if (result.status !== 0)
      throw new ToolError(`git reset --hard failed: ${result.stderr}`, "command-failed");
    return { files: ["--hard"], output: result.stdout?.trim() || "HEAD reset" };
  }
  if (input.files.length === 0) {
    const result = spawnSync("git", ["reset"], { cwd: input.cwd, encoding: "utf8" });
    if (result.status !== 0)
      throw new ToolError(`git reset failed: ${result.stderr}`, "command-failed");
    return { files: ["(all)"], output: result.stdout?.trim() || "Unstaged all files" };
  }
  const result = spawnSync("git", ["reset", "--", ...input.files], {
    cwd: input.cwd,
    encoding: "utf8"
  });
  if (result.status !== 0)
    throw new ToolError(`git reset failed: ${result.stderr}`, "command-failed");
  return {
    files: input.files,
    output: result.stdout?.trim() || `Unstaged ${input.files.length} files`
  };
}

export function formatGitResetResult(result: GitResetResult): string {
  return result.output;
}
