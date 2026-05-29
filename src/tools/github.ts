/**
 * GitHub tools using the gh CLI.
 *
 * Read-only operations first: issue view, PR view, PR list, PR diff.
 */

import { spawnSync } from "node:child_process";

export const GitHubIssueViewInputSchema = {
  type: "object",
  properties: {
    issue: { type: "string", description: "Issue number or URL (e.g. '123' or 'owner/repo#123')" }
  },
  required: ["issue"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export const GitHubPRViewInputSchema = {
  type: "object",
  properties: {
    pr: { type: "string", description: "PR number or URL (e.g. '456' or 'owner/repo#456')" }
  },
  required: ["pr"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export const GitHubPRListInputSchema = {
  type: "object",
  properties: {
    state: { type: "string", enum: ["open", "closed", "merged", "all"] },
    limit: { type: "number", description: "Max results (default 10)" },
    author: { type: "string" },
    label: { type: "string" }
  },
  required: [],
  additionalProperties: false
} satisfies Record<string, unknown>;

export const GitHubPRDiffInputSchema = {
  type: "object",
  properties: {
    pr: { type: "string", description: "PR number or URL" }
  },
  required: ["pr"],
  additionalProperties: false
} satisfies Record<string, unknown>;

// --- Execution ---

export function ghIssueView(cwd: string, issue: string): string {
  return runGh(cwd, ["issue", "view", issue]);
}

export function ghPRView(cwd: string, pr: string): string {
  return runGh(cwd, ["pr", "view", pr]);
}

export function ghPRList(
  cwd: string,
  input: {
    state?: string;
    limit?: number;
    author?: string;
    label?: string;
  }
): string {
  const args = ["pr", "list"];
  if (input.state) args.push("--state", input.state);
  args.push("--limit", String(input.limit ?? 10));
  if (input.author) args.push("--author", input.author);
  if (input.label) args.push("--label", input.label);
  return runGh(cwd, args);
}

export function ghPRDiff(cwd: string, pr: string): string {
  return runGh(cwd, ["pr", "diff", pr]);
}

// --- Helpers ---

function runGh(cwd: string, args: string[]): string {
  const result = spawnSync("gh", args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    const err =
      result.stderr?.trim() ||
      `gh ${args[0]} ${args[1] ?? ""} failed with exit code ${result.status}`;
    throw new Error(err);
  }
  return result.stdout?.trim() || "(no output)";
}
