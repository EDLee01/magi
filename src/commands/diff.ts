import { spawnSync } from "node:child_process";

import { SlashCommandInput } from "./registry.js";

export const command = {
  name: "diff",
  description: "Show git diff (unstaged and staged changes)",
  usage: "/diff [path]",
  group: "Git",
  handler: (args: string[], input: SlashCommandInput): string => {
    const gitArgs = args.length > 0 ? ["diff", "--", args[0]] : ["diff"];
    const stagedArgs = args.length > 0 ? ["diff", "--cached", "--", args[0]] : ["diff", "--cached"];

    const diff = spawnSync("git", gitArgs, { cwd: input.cwd, encoding: "utf8" });
    const staged = spawnSync("git", stagedArgs, { cwd: input.cwd, encoding: "utf8" });

    if (diff.error || staged.error) {
      return "Not a git repository or git is not available.";
    }

    const results: string[] = [];
    if (diff.stdout.trim()) {
      results.push("Unstaged changes:");
      results.push(truncateDiff(diff.stdout.trim()));
    }
    if (staged.stdout.trim()) {
      if (results.length > 0) results.push("");
      results.push("Staged changes:");
      results.push(truncateDiff(staged.stdout.trim()));
    }
    if (results.length === 0) {
      return "No changes.";
    }
    return results.join("\n");
  }
};

function truncateDiff(diff: string): string {
  const lines = diff.split("\n");
  if (lines.length <= 100) return diff;
  return lines.slice(0, 100).join("\n") + `\n... (${lines.length - 100} more lines)`;
}
