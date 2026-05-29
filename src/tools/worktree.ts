/**
 * Worktree isolation tools: EnterWorktree and ExitWorktree.
 *
 * EnterWorktree creates a temporary git worktree so the agent works on
 * an isolated copy of the repository. ExitWorktree cleans up or keeps
 * the worktree based on user preference.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface WorktreeState {
  active: boolean;
  originalCwd?: string;
  worktreePath?: string;
  branchName?: string;
  createdAt?: string;
}

export const EnterWorktreeInputSchema = {
  type: "object",
  properties: {
    name: { type: "string", description: "Optional name for the worktree. Random if omitted." }
  },
  required: [],
  additionalProperties: false
} satisfies Record<string, unknown>;

export const ExitWorktreeInputSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["keep", "remove"],
      description: "keep leaves worktree on disk; remove deletes it."
    },
    discard_changes: {
      type: "boolean",
      description: "Required true to remove a worktree with uncommitted changes."
    }
  },
  required: ["action"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export interface EnterWorktreeInput {
  name?: string;
}

export interface ExitWorktreeInput {
  action: "keep" | "remove";
  discardChanges?: boolean;
}

// --- Parsing ---

export function parseEnterWorktreeInput(input: Record<string, unknown>): EnterWorktreeInput {
  return {
    name: typeof input.name === "string" ? input.name.trim() || undefined : undefined
  };
}

export function parseExitWorktreeInput(input: Record<string, unknown>): ExitWorktreeInput {
  const action = input.action;
  if (action !== "keep" && action !== "remove") {
    throw new Error("ExitWorktree action must be 'keep' or 'remove'");
  }
  return {
    action,
    discardChanges: typeof input.discard_changes === "boolean" ? input.discard_changes : undefined
  };
}

// --- Execution ---

export function executeEnterWorktree(input: { cwd: string; name?: string }): WorktreeState {
  // Verify we're in a git repo
  const check = spawnSync("git", ["rev-parse", "--git-dir"], {
    cwd: input.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (check.status !== 0) {
    throw new Error("Not a git repository. Worktree isolation requires git.");
  }

  const worktreeBase = path.join(input.cwd, ".magi", "worktrees");
  mkdirSync(worktreeBase, { recursive: true });

  const name = sanitizeWorktreeName(input.name) || `magi-${randomUUID().slice(0, 8)}`;
  const branchName = `magi/worktree/${name}`;
  const worktreePath = path.join(worktreeBase, name);

  if (existsSync(worktreePath)) {
    throw new Error(`Worktree already exists at ${worktreePath}`);
  }

  // Create worktree with new branch based on HEAD
  const result = spawnSync("git", ["worktree", "add", "-b", branchName, worktreePath], {
    cwd: input.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    const err = result.stderr?.trim() || "git worktree add failed";
    throw new Error(err);
  }

  return {
    active: true,
    originalCwd: input.cwd,
    worktreePath,
    branchName,
    createdAt: new Date().toISOString()
  };
}

export function executeExitWorktree(input: {
  cwd: string;
  state: WorktreeState;
  action: "keep" | "remove";
  discardChanges?: boolean;
}): { removed: boolean; worktreePath?: string; branchName?: string } {
  if (!input.state.active || !input.state.worktreePath) {
    return { removed: false };
  }

  if (input.action === "keep") {
    return {
      removed: false,
      worktreePath: input.state.worktreePath,
      branchName: input.state.branchName
    };
  }

  // Check for uncommitted changes
  if (!input.discardChanges) {
    const status = spawnSync("git", ["status", "--porcelain"], {
      cwd: input.state.worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    if (status.stdout?.trim()) {
      throw new Error(
        `Worktree has uncommitted changes. Set discard_changes: true to force removal.\n` +
          `Changes:\n${status.stdout.trim()}`
      );
    }
  }

  // Remove worktree
  const remove = spawnSync("git", ["worktree", "remove", "--force", input.state.worktreePath], {
    cwd: input.state.originalCwd ?? input.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  // Delete branch if worktree was removed
  if (remove.status === 0 && input.state.branchName) {
    spawnSync("git", ["branch", "-D", input.state.branchName], {
      cwd: input.state.originalCwd ?? input.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
  }

  return { removed: remove.status === 0 };
}

// --- Formatting ---

export function formatEnterWorktreeResult(state: WorktreeState): string {
  return [
    `Worktree created.`,
    `  path: ${state.worktreePath}`,
    `  branch: ${state.branchName}`,
    ``,
    `Agent execution is now isolated. Changes here do not affect the main working tree.`,
    `Call ExitWorktree when done.`
  ].join("\n");
}

export function formatExitWorktreeResult(result: {
  removed: boolean;
  worktreePath?: string;
  branchName?: string;
}): string {
  if (result.removed) {
    return "Worktree removed. Returned to original working directory.";
  }
  return [
    "Worktree kept on disk.",
    result.worktreePath ? `  path: ${result.worktreePath}` : "",
    result.branchName ? `  branch: ${result.branchName}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

// --- Helpers ---

function sanitizeWorktreeName(name?: string): string | undefined {
  if (!name) return undefined;
  // Only allow letters, digits, dots, underscores, dashes, slashes
  const sanitized = name.replace(/[^a-zA-Z0-9._\-/]/g, "-").slice(0, 64);
  return sanitized || undefined;
}
