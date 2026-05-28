import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { readWorkspaceFile, writeWorkspaceFile } from "../src/tools/files.js";
import { getGitSummary } from "../src/tools/git.js";
import { searchWorkspace } from "../src/tools/search.js";
import { isDangerousShellCommand, isLongRunningCommand, runShellCommand } from "../src/tools/shell.js";
import { ToolError } from "../src/tools/errors.js";
import { makeTempRoot, TempRoot } from "./helpers.js";

let workspace: string | undefined;
let configRoot: TempRoot | undefined;

afterEach(() => {
  if (workspace) {
    rmSync(workspace, { recursive: true, force: true });
    workspace = undefined;
  }
  configRoot?.cleanup();
  configRoot = undefined;
});

describe("local tools", () => {
  it("reads workspace files with size and binary protections", () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-tools-"));
    writeFileSync(path.join(workspace, "small.txt"), "hello\n", "utf8");
    writeFileSync(path.join(workspace, "big.txt"), "x".repeat(20), "utf8");
    writeFileSync(path.join(workspace, "binary.bin"), Buffer.from([1, 0, 2]));

    expect(readWorkspaceFile({ cwd: workspace, filePath: "small.txt" })).toMatchObject({
      path: "small.txt",
      content: "hello\n"
    });
    expect(() => readWorkspaceFile({ cwd: workspace!, filePath: "big.txt", maxBytes: 4 })).toThrow(/above/);
    expect(() => readWorkspaceFile({ cwd: workspace!, filePath: "binary.bin" })).toThrow(/binary/);
  });

  it("blocks file access outside the workspace", () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-tools-"));
    expect(() => readWorkspaceFile({ cwd: workspace!, filePath: "../outside.txt" })).toThrow(/outside/);
  });

  it("requires approval before writing files and records a diff", () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-tools-"));
    expect(() => writeWorkspaceFile({
      cwd: workspace!,
      filePath: "note.txt",
      content: "hello",
      approved: false
    })).toThrow(/requires diff approval/);

    const result = writeWorkspaceFile({
      cwd: workspace,
      filePath: "note.txt",
      content: "hello",
      approved: true
    });

    expect(result.approved).toBe(true);
    expect(result.diff).toContain("+++ b/note.txt");
    expect(readFileSync(path.join(workspace, "note.txt"), "utf8")).toBe("hello");
  });

  it("searches workspace text", () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-tools-"));
    mkdirSync(path.join(workspace, "src"));
    writeFileSync(path.join(workspace, "src", "a.txt"), "alpha\nbeta\n", "utf8");

    const matches = searchWorkspace({ cwd: workspace, query: "beta" });
    expect(matches).toContainEqual({ path: "src/a.txt", line: 2, text: "beta" });
  });

  it("blocks dangerous shell commands unless explicitly approved", async () => {
    expect(isDangerousShellCommand("rm -rf /tmp/something")).toBe(true);
    await expect(runShellCommand({
      cwd: process.cwd(),
      command: "rm -rf /tmp/something"
    })).rejects.toMatchObject({ kind: "approval-required" } satisfies Partial<ToolError>);
  });

  it("runs safe shell commands", async () => {
    const result = await runShellCommand({
      cwd: process.cwd(),
      command: "printf hello"
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
  });

  it("does not auto-background commands that already background a long-running segment", () => {
    expect(isLongRunningCommand("cd app && npm run dev")).toBe(true);
    expect(isLongRunningCommand("cd app && npm run dev > app.log 2>&1 &\necho \"PID: $!\"")).toBe(false);
    expect(isLongRunningCommand("nohup bash -c 'npm run dev' > app.log 2>&1 < /dev/null & disown; echo BG_PID=$!")).toBe(false);
  });

  it("auto-backgrounds long-running commands only once", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-tools-"));
    const binDir = path.join(workspace, "bin");
    mkdirSync(binDir);
    const fakeNpm = path.join(binDir, "npm");
    writeFileSync(fakeNpm, "#!/usr/bin/env bash\nprintf 'fake npm %s' \"$*\"\n", "utf8");
    chmodSync(fakeNpm, 0o755);

    const result = await runShellCommand({
      cwd: workspace,
      command: `PATH=${binDir}:$PATH npm run dev`,
      timeoutMs: 2_000
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[Auto-backgrounded]");
    expect(result.stdout).toContain("BG_PID=");
    expect(result.stdout).toMatch(/To stop: kill \d+/);
  });

  it("resolves when the shell exits even if a background child inherits stdio", async () => {
    const startedAt = Date.now();
    const result = await runShellCommand({
      cwd: process.cwd(),
      command: "node -e 'setTimeout(()=>{}, 5000)' & echo \"PID=$!\"",
      timeoutMs: 2_000
    });

    const pid = Number(/PID=(\d+)/.exec(result.stdout)?.[1]);
    if (Number.isFinite(pid)) {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PID=");
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });

  it("handles git unavailable or non-repository directories gracefully", () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-tools-"));
    const summary = getGitSummary(workspace);
    expect(summary.gitAvailable).toBe(true);
    expect(summary.isRepository).toBe(false);
    expect(summary.reason).toContain("not a git repository");
  });

  it("lets magi -p complete a simple local file task", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-tools-"));
    configRoot = makeTempRoot();

    const result = await runCli(
      ["-p", 'create file "hello.txt" with content "hello from magi"'],
      configRoot.env,
      workspace
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Wrote hello.txt");
    expect(existsSync(path.join(workspace, "hello.txt"))).toBe(true);
    expect(readFileSync(path.join(workspace, "hello.txt"), "utf8")).toBe("hello from magi");
  });
});
