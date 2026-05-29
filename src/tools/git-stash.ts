import { spawnSync } from "node:child_process";
import { ToolError } from "./errors.js";

export interface GitStashResult {
  action: string;
  output: string;
}
export const GitStashInputSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["push", "pop", "list", "drop", "apply"] },
    message: { type: "string" }
  },
  required: ["action"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseGitStashInput(input: Record<string, unknown>): {
  action: string;
  message?: string;
} {
  const action = typeof input.action === "string" ? input.action : "";
  if (!["push", "pop", "list", "drop", "apply"].includes(action))
    throw new ToolError("action must be push/pop/list/drop/apply", "bad-input");
  return { action, message: typeof input.message === "string" ? input.message : undefined };
}

export function executeGitStash(input: {
  action: string;
  message?: string;
  cwd: string;
}): GitStashResult {
  const args = ["stash", input.action];
  if (input.action === "push" && input.message) args.push("-m", input.message);
  if (input.action === "drop" || input.action === "apply") args.push("0");
  const result = spawnSync("git", args, { cwd: input.cwd, encoding: "utf8" });
  if (result.status !== 0 && input.action !== "list")
    throw new ToolError(
      `git stash ${input.action} failed: ${result.stderr?.trim()}`,
      "command-failed"
    );
  return { action: input.action, output: result.stdout?.trim() || result.stderr?.trim() || "ok" };
}

export function formatGitStashResult(result: GitStashResult): string {
  return `git stash ${result.action}: ${result.output}`;
}
