import { spawnSync, execSync } from "node:child_process";

import { SlashCommandInput } from "./registry.js";

export const command = {
  name: "commit",
  description: "Commit staged git changes",
  usage: "/commit [-m <message>]",
  group: "Git",
  handler: (args: string[], input: SlashCommandInput): string => {
    if (args.length > 0 && args[0] === "-m" && args.length >= 2) {
      const message = args.slice(1).join(" ");
      const result = spawnSync("git", ["commit", "-m", message], {
        cwd: input.cwd,
        encoding: "utf8"
      });
      if (result.status === 0) {
        return `Committed: ${result.stdout?.trim() || "ok"}`;
      }
      return `Commit failed:\n${result.stderr?.trim() || "unknown error"}`;
    }
    // Without -m, show staged changes and prompt for message
    try {
      const staged = execSync("git diff --cached --stat", {
        cwd: input.cwd,
        encoding: "utf8",
        stdio: "pipe"
      });
      const status = execSync("git status --short", {
        cwd: input.cwd,
        encoding: "utf8",
        stdio: "pipe"
      });
      return [
        "Staged changes:",
        staged.trim() || "  (none)",
        "",
        'To commit, use: /commit -m "your message"',
        "",
        "Working tree status:",
        status.trim() || "  (clean)"
      ].join("\n");
    } catch {
      return "Not a git repository or git is not available.";
    }
  }
};
