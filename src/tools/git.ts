import { spawnSync } from "node:child_process";

import { resolveWorkspacePath } from "./workspace.js";

export interface GitSummary {
  gitAvailable: boolean;
  isRepository: boolean;
  branch?: string;
  status?: string;
  diffStat?: string;
  reason?: string;
}

export interface GitStatusOptions {
  porcelain?: boolean;
  branch?: boolean;
  untracked?: "all" | "normal" | "none";
  path?: string;
}

export interface GitDiffOptions {
  staged?: boolean;
  stat?: boolean;
  nameOnly?: boolean;
  context?: number;
  path?: string;
}

export interface GitLogOptions {
  maxCount?: number;
  oneline?: boolean;
  path?: string;
}

export interface GitShowOptions {
  rev?: string;
  stat?: boolean;
  nameOnly?: boolean;
  maxBytes?: number;
}

export interface GitBranchListOptions {
  all?: boolean;
}

export interface GitBranchCreateOptions {
  name: string;
  startPoint?: string;
  checkout?: boolean;
}

export interface GitCheckoutOptions {
  branch: string;
  create?: boolean;
  startPoint?: string;
}

export interface GitStageOptions {
  paths: string[];
  mode?: "stage" | "unstage";
}

export function getGitSummary(cwd: string): GitSummary {
  const readiness = ensureGitRepository(cwd);
  if (!readiness.ok) {
    return {
      gitAvailable: readiness.gitAvailable,
      isRepository: readiness.isRepository,
      reason: readiness.reason
    };
  }

  const branch = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = runGit(cwd, ["status", "--short"]);
  const diffStat = runGit(cwd, ["diff", "--stat"]);

  return {
    gitAvailable: true,
    isRepository: true,
    branch: branch.stdout.trim(),
    status: status.stdout.trim(),
    diffStat: diffStat.stdout.trim()
  };
}

export function getGitStatus(cwd: string, options: GitStatusOptions = {}): string {
  requireGitRepository(cwd);
  const args = ["status"];
  if (options.porcelain ?? true) {
    args.push("--short");
  }
  if (options.branch) {
    args.push("--branch");
  }
  args.push(`--untracked-files=${options.untracked ?? "all"}`);
  appendPathspec(cwd, args, options.path);
  const result = runGitOrThrow(cwd, args);
  return result.stdout.trim() || "status: clean";
}

export function getGitDiff(cwd: string, options: GitDiffOptions = {}): string {
  requireGitRepository(cwd);
  const args = ["diff"];
  if (options.staged) {
    args.push("--staged");
  }
  if (options.stat) {
    args.push("--stat");
  }
  if (options.nameOnly) {
    args.push("--name-only");
  }
  if (options.context !== undefined) {
    if (!Number.isInteger(options.context) || options.context < 0 || options.context > 100) {
      throw new Error("GitDiff context must be an integer from 0 to 100");
    }
    args.push(`--unified=${options.context}`);
  }
  appendPathspec(cwd, args, options.path);
  const result = runGitOrThrow(cwd, args);
  return result.stdout.trimEnd() || "No diff";
}

export function getGitLog(cwd: string, options: GitLogOptions = {}): string {
  requireGitRepository(cwd);
  const maxCount = options.maxCount ?? 10;
  if (!Number.isInteger(maxCount) || maxCount < 1 || maxCount > 100) {
    throw new Error("GitLog max_count must be an integer from 1 to 100");
  }
  const args = ["log", `--max-count=${maxCount}`];
  if (options.oneline ?? true) {
    args.push("--oneline", "--decorate=short");
  } else {
    args.push("--date=iso-strict", "--pretty=fuller");
  }
  appendPathspec(cwd, args, options.path);
  const result = runGitOrThrow(cwd, args);
  return result.stdout.trimEnd() || "No commits";
}

export function getGitShow(cwd: string, options: GitShowOptions = {}): string {
  requireGitRepository(cwd);
  const rev = options.rev ?? "HEAD";
  validateRevision(rev);
  const args = ["show", "--no-ext-diff"];
  if (options.stat) {
    args.push("--stat");
  }
  if (options.nameOnly) {
    args.push("--name-only");
  }
  args.push(rev);
  const result = runGitOrThrow(cwd, args);
  const output = result.stdout.trimEnd() || "No output";
  const maxBytes = options.maxBytes ?? 200_000;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_000_000) {
    throw new Error("GitShow max_bytes must be an integer from 1 to 1000000");
  }
  const bytes = Buffer.byteLength(output, "utf8");
  if (bytes > maxBytes) {
    throw new Error(`GitShow output is ${bytes} bytes, above the ${maxBytes} byte limit`);
  }
  return output;
}

export function listGitBranches(cwd: string, options: GitBranchListOptions = {}): string {
  requireGitRepository(cwd);
  const args = ["branch", "--list", "--verbose", "--no-abbrev"];
  if (options.all) {
    args.splice(2, 0, "--all");
  }
  const result = runGitOrThrow(cwd, args);
  return result.stdout.trimEnd() || "No branches";
}

export function createGitBranch(cwd: string, options: GitBranchCreateOptions): string {
  requireGitRepository(cwd);
  const branch = validateBranchName(options.name);
  const args = options.checkout ? ["checkout", "-b", branch] : ["branch", branch];
  if (options.startPoint !== undefined) {
    args.push(validateStartPoint(options.startPoint));
  }
  const result = runGitOrThrow(cwd, args);
  return [
    options.checkout ? `Created and checked out branch ${branch}` : `Created branch ${branch}`,
    result.stdout.trim(),
    result.stderr.trim()
  ]
    .filter(Boolean)
    .join("\n");
}

export function checkoutGitBranch(cwd: string, options: GitCheckoutOptions): string {
  requireGitRepository(cwd);
  const branch = validateBranchName(options.branch);
  const args = options.create ? ["checkout", "-b", branch] : ["checkout", branch];
  if (options.startPoint !== undefined) {
    args.push(validateStartPoint(options.startPoint));
  }
  const result = runGitOrThrow(cwd, args);
  return [
    options.create ? `Created and checked out branch ${branch}` : `Checked out branch ${branch}`,
    result.stdout.trim(),
    result.stderr.trim()
  ]
    .filter(Boolean)
    .join("\n");
}

export function stageGitPaths(cwd: string, options: GitStageOptions): string {
  requireGitRepository(cwd);
  if (!Array.isArray(options.paths) || options.paths.length < 1 || options.paths.length > 100) {
    throw new Error("GitStage paths must contain 1 to 100 paths");
  }
  const paths = options.paths.map(
    (requestedPath) => resolveWorkspacePath(cwd, requestedPath).relativePath
  );
  const uniquePaths = [...new Set(paths)];
  const mode = options.mode ?? "stage";
  const args = mode === "unstage" ? ["restore", "--staged", "--"] : ["add", "--"];
  const result = runGitOrThrow(cwd, [...args, ...uniquePaths]);
  return [
    mode === "unstage"
      ? `Unstaged ${uniquePaths.length} path${uniquePaths.length === 1 ? "" : "s"}`
      : `Staged ${uniquePaths.length} path${uniquePaths.length === 1 ? "" : "s"}`,
    ...uniquePaths.map((item) => `- ${item}`),
    result.stdout.trim(),
    result.stderr.trim()
  ]
    .filter(Boolean)
    .join("\n");
}

function requireGitRepository(cwd: string): void {
  const readiness = ensureGitRepository(cwd);
  if (!readiness.ok) {
    throw new Error(readiness.reason);
  }
}

function ensureGitRepository(cwd: string): GitReadiness {
  const version = runGit(cwd, ["--version"]);
  if (version.error) {
    return {
      ok: false,
      gitAvailable: false,
      isRepository: false,
      reason: "git executable is not available"
    };
  }

  const repo = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (repo.status !== 0 || repo.stdout.trim() !== "true") {
    return {
      ok: false,
      gitAvailable: true,
      isRepository: false,
      reason: "current directory is not a git repository"
    };
  }
  return { ok: true, gitAvailable: true, isRepository: true };
}

function appendPathspec(cwd: string, args: string[], requestedPath: string | undefined): void {
  if (requestedPath === undefined) {
    return;
  }
  const resolved = resolveWorkspacePath(cwd, requestedPath);
  args.push("--", resolved.relativePath);
}

function validateRevision(value: string): void {
  if (!value.trim()) {
    throw new Error("GitShow rev must be a non-empty string");
  }
  if (
    value.startsWith("-") ||
    value.includes("\0") ||
    value.includes("..") ||
    value.includes(":")
  ) {
    throw new Error("GitShow rev must be a simple revision name, tag, or commit id");
  }
}

function validateStartPoint(value: string): string {
  const startPoint = value.trim();
  if (!startPoint) {
    throw new Error("Git start_point must be a non-empty string");
  }
  if (
    startPoint.startsWith("-") ||
    startPoint.includes("\0") ||
    startPoint.includes("..") ||
    startPoint.includes(":")
  ) {
    throw new Error("Git start_point must be a simple branch, tag, or commit id");
  }
  return startPoint;
}

function validateBranchName(value: string): string {
  const branch = value.trim();
  if (!branch) {
    throw new Error("Git branch name must be a non-empty string");
  }
  if (branch.length > 200) {
    throw new Error("Git branch name must be 200 characters or fewer");
  }
  if (
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("\\") ||
    branch.includes("\0") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.includes("@{") ||
    branch.includes(":") ||
    branch.includes(" ") ||
    branch.includes("~") ||
    branch.includes("^") ||
    branch.includes("?") ||
    branch.includes("*") ||
    branch.includes("[") ||
    branch.includes("]")
  ) {
    throw new Error("Git branch name contains unsafe characters");
  }
  const result = spawnSync("git", ["check-ref-format", "--branch", branch], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 128 * 1024
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Git branch name is invalid");
  }
  return branch;
}

function runGitOrThrow(cwd: string, args: string[]): GitCommandResult {
  const result = runGit(cwd, args);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} exited ${result.status}`);
  }
  return result;
}

function runGit(cwd: string, args: string[]): GitCommandResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error
  };
}

interface GitReadiness {
  ok: boolean;
  gitAvailable: boolean;
  isRepository: boolean;
  reason?: string;
}

interface GitCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export async function createWorktree(input: {
  cwd: string;
  path: string;
  branch?: string;
  hooks?: import("../config.js").HookDefinition[];
  sessionId?: string;
}): Promise<{ path: string; branch: string }> {
  const args = ["worktree", "add"];
  if (input.branch) {
    args.push("-b", input.branch);
  }
  args.push(input.path);

  const result = runGitOrThrow(input.cwd, args);

  if (input.hooks) {
    const { triggerHook } = await import("../hooks/trigger.js");
    void triggerHook({
      event: "worktree_create",
      hooks: input.hooks,
      context: {
        sessionId: input.sessionId,
        cwd: input.cwd,
        worktreePath: input.path,
        action: "create"
      }
    });
  }

  return { path: input.path, branch: input.branch ?? "HEAD" };
}

export async function removeWorktree(input: {
  cwd: string;
  path: string;
  force?: boolean;
  hooks?: import("../config.js").HookDefinition[];
  sessionId?: string;
}): Promise<{ path: string }> {
  const args = ["worktree", "remove"];
  if (input.force) {
    args.push("--force");
  }
  args.push(input.path);

  const result = runGitOrThrow(input.cwd, args);

  if (input.hooks) {
    const { triggerHook } = await import("../hooks/trigger.js");
    void triggerHook({
      event: "worktree_remove",
      hooks: input.hooks,
      context: {
        sessionId: input.sessionId,
        cwd: input.cwd,
        worktreePath: input.path,
        action: "remove"
      }
    });
  }

  return { path: input.path };
}
