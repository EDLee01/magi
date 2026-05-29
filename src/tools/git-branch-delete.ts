import { spawnSync } from "node:child_process";
import { ToolError } from "./errors.js";

export interface GitBranchDeleteResult {
  branch: string;
  force: boolean;
}
export const GitBranchDeleteInputSchema = {
  type: "object",
  properties: { branch: { type: "string" }, force: { type: "boolean" } },
  required: ["branch"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseGitBranchDeleteInput(input: Record<string, unknown>): {
  branch: string;
  force: boolean;
} {
  const branch = typeof input.branch === "string" ? input.branch : "";
  if (!branch) throw new ToolError("branch is required", "bad-input");
  return { branch, force: input.force === true };
}

export function executeGitBranchDelete(input: {
  branch: string;
  force: boolean;
  cwd: string;
}): GitBranchDeleteResult {
  const currentBranch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: input.cwd,
    encoding: "utf8"
  });
  const current = currentBranch.stdout?.trim();
  if (current === input.branch)
    throw new ToolError(`Cannot delete current branch: ${input.branch}`, "command-failed");

  const args = input.force ? ["branch", "-D"] : ["branch", "-d"];
  args.push(input.branch);
  const result = spawnSync("git", args, { cwd: input.cwd, encoding: "utf8" });
  if (result.status !== 0)
    throw new ToolError(`git branch delete failed: ${result.stderr?.trim()}`, "command-failed");
  return { branch: input.branch, force: input.force };
}

export function formatGitBranchDeleteResult(result: GitBranchDeleteResult): string {
  return `Deleted branch: ${result.branch}`;
}
