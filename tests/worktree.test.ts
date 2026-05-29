import { afterEach, describe, expect, it } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { executeEnterWorktree, executeExitWorktree, WorktreeState } from "../src/tools/worktree.js";

describe("worktree lifecycle", () => {
  let repoDir: string | undefined;
  afterEach(() => {
    if (repoDir) {
      try {
        rmSync(repoDir, { recursive: true, force: true });
      } catch {}
      repoDir = undefined;
    }
  });

  function makeRepo(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "magi-worktree-test-"));
    execSync("git init -q", { cwd: dir });
    execSync("git config user.email test@example.com", { cwd: dir });
    execSync("git config user.name Test", { cwd: dir });
    writeFileSync(path.join(dir, "README.md"), "# test\n");
    execSync("git add README.md && git commit -q -m initial", { cwd: dir });
    return dir;
  }

  it("creates an isolated worktree on a new branch and exits cleanly", () => {
    repoDir = makeRepo();
    const state = executeEnterWorktree({ cwd: repoDir, name: "feature-x" });
    expect(state.active).toBe(true);
    expect(state.worktreePath).toBeDefined();
    expect(state.branchName).toContain("magi/worktree/feature-x");
    expect(existsSync(state.worktreePath!)).toBe(true);
    // The new worktree contains the original README
    expect(readFileSync(path.join(state.worktreePath!, "README.md"), "utf8")).toContain("test");

    // Modify a file in the worktree — does not touch the main tree
    writeFileSync(path.join(state.worktreePath!, "feature.txt"), "feature work\n");
    execSync(
      `git -C "${state.worktreePath}" add feature.txt && git -C "${state.worktreePath}" commit -q -m feature`,
      { shell: "/bin/sh" }
    );

    // Main tree still unchanged
    expect(existsSync(path.join(repoDir, "feature.txt"))).toBe(false);

    // Exit with keep — worktree dir survives
    const keepResult = executeExitWorktree({
      cwd: repoDir,
      state,
      action: "keep"
    });
    expect(keepResult.removed).toBe(false);
    expect(existsSync(state.worktreePath!)).toBe(true);
  });

  it("removes the worktree when action is 'remove'", () => {
    repoDir = makeRepo();
    const state = executeEnterWorktree({ cwd: repoDir, name: "tempwork" });
    expect(existsSync(state.worktreePath!)).toBe(true);
    const result = executeExitWorktree({
      cwd: repoDir,
      state,
      action: "remove",
      discardChanges: true
    });
    expect(result.removed).toBe(true);
    expect(existsSync(state.worktreePath!)).toBe(false);
  });

  it("refuses to enter twice with the same name", () => {
    repoDir = makeRepo();
    const dir = repoDir;
    executeEnterWorktree({ cwd: dir, name: "dup" });
    expect(() => executeEnterWorktree({ cwd: dir, name: "dup" })).toThrow(/already exists/);
  });

  it("refuses to enter outside a git repo", () => {
    const nonRepo = mkdtempSync(path.join(os.tmpdir(), "magi-non-repo-"));
    try {
      expect(() => executeEnterWorktree({ cwd: nonRepo, name: "x" })).toThrow(/git repository/);
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  it("returns no-op when state is inactive", () => {
    const state: WorktreeState = { active: false };
    const result = executeExitWorktree({
      cwd: process.cwd(),
      state,
      action: "remove"
    });
    expect(result.removed).toBe(false);
  });
});
