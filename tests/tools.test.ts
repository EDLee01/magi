import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { createShellInvocation, shellDisplayName } from "../src/platform/shell.js";
import { readWorkspaceFile, writeWorkspaceFile } from "../src/tools/files.js";
import { getGitSummary } from "../src/tools/git.js";
import { globToRegExp, normalizeMatchPath, searchWorkspace } from "../src/tools/search.js";
import { executeTreeView } from "../src/tools/tree-view.js";
import {
  isDangerousShellCommand,
  isLongRunningCommand,
  isReadOnlyShellCommand,
  resolveDefaultShellTimeoutMs,
  runShellCommand
} from "../src/tools/shell.js";
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
    expect(() => readWorkspaceFile({ cwd: workspace!, filePath: "big.txt", maxBytes: 4 })).toThrow(
      /above/
    );
    expect(() => readWorkspaceFile({ cwd: workspace!, filePath: "binary.bin" })).toThrow(/binary/);
  });

  it("blocks file access outside the workspace", () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-tools-"));
    expect(() => readWorkspaceFile({ cwd: workspace!, filePath: "../outside.txt" })).toThrow(
      /outside/
    );
  });

  it("requires approval before writing files and records a diff", () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-tools-"));
    expect(() =>
      writeWorkspaceFile({
        cwd: workspace!,
        filePath: "note.txt",
        content: "hello",
        approved: false
      })
    ).toThrow(/requires diff approval/);

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

  it("normalizes Windows-style search paths and globs", () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-tools-"));
    mkdirSync(path.join(workspace, "src", "nested"), { recursive: true });
    writeFileSync(path.join(workspace, "src", "nested", "a.txt"), "needle\n", "utf8");
    writeFileSync(path.join(workspace, "other.txt"), "needle\n", "utf8");

    const matches = searchWorkspace({
      cwd: workspace,
      query: "needle",
      glob: "src\\**\\*.txt",
      fixedStrings: true
    });

    expect(matches.map((match) => match.path)).toEqual(["src/nested/a.txt"]);
    expect(normalizeMatchPath(".\\src\\nested\\a.txt")).toBe("src/nested/a.txt");
    expect(globToRegExp("src\\**\\*.txt").test("src/nested/a.txt")).toBe(true);
  });

  it("renders tree output for paths with spaces and dot directories", () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-tools-"));
    mkdirSync(path.join(workspace, ".magi-next"), { recursive: true });
    mkdirSync(path.join(workspace, "space dir"), { recursive: true });
    writeFileSync(path.join(workspace, "space dir", "a.txt"), "hello\n", "utf8");

    const result = executeTreeView({
      cwd: workspace,
      path: ".",
      depth: 2,
      showFiles: true
    });

    expect(result.path).toBe(".");
    expect(result.tree).toContain(".magi-next");
    expect(result.tree).toContain("space dir");
    expect(result.tree).toContain("a.txt");
  });

  it("blocks dangerous shell commands unless explicitly approved", async () => {
    expect(isDangerousShellCommand("rm -rf /tmp/something")).toBe(true);
    expect(isDangerousShellCommand("rm -rf build")).toBe(true);
    await expect(
      runShellCommand({
        cwd: process.cwd(),
        command: "rm -rf /tmp/something"
      })
    ).rejects.toMatchObject({ kind: "approval-required" } satisfies Partial<ToolError>);
  });

  it("classifies only conservative shell commands as read-only", () => {
    expect(isReadOnlyShellCommand("pwd")).toBe(true);
    expect(isReadOnlyShellCommand("ls -la src")).toBe(true);
    expect(isReadOnlyShellCommand("cat package.json")).toBe(true);
    expect(isReadOnlyShellCommand("head -n 20 src/tools/shell.ts")).toBe(true);
    expect(isReadOnlyShellCommand("sed -n '1,20p' src/tools/shell.ts")).toBe(true);
    expect(isReadOnlyShellCommand("git status --short")).toBe(true);
    expect(isReadOnlyShellCommand("git diff -- src/tools/shell.ts")).toBe(true);

    expect(isReadOnlyShellCommand("npm test")).toBe(false);
    expect(isReadOnlyShellCommand("python script.py")).toBe(false);
    expect(isReadOnlyShellCommand("cat package.json > out.txt")).toBe(false);
    expect(isReadOnlyShellCommand("ls /tmp")).toBe(false);
    expect(isReadOnlyShellCommand("tail -f app.log")).toBe(false);
    expect(isReadOnlyShellCommand("sed -n -i '1,20p' src/tools/shell.ts")).toBe(false);
    expect(isReadOnlyShellCommand("git diff --output=patch.txt")).toBe(false);
  });

  it("resolves the default shell timeout from env with a 2-minute fallback", () => {
    expect(resolveDefaultShellTimeoutMs({})).toBe(120_000);
    expect(resolveDefaultShellTimeoutMs({ MAGI_BASH_TIMEOUT_MS: "300000" })).toBe(300_000);
    // Invalid / non-positive values fall back to the default.
    expect(resolveDefaultShellTimeoutMs({ MAGI_BASH_TIMEOUT_MS: "0" })).toBe(120_000);
    expect(resolveDefaultShellTimeoutMs({ MAGI_BASH_TIMEOUT_MS: "abc" })).toBe(120_000);
  });

  it("runs safe shell commands", async () => {
    const result = await runShellCommand({
      cwd: process.cwd(),
      command: "printf hello"
    });
    expect(result.shell).toBe(shellDisplayName());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
  });

  it("uses PowerShell on Windows and bash elsewhere", () => {
    expect(createShellInvocation("Write-Output hello", "win32")).toEqual({
      executable: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Write-Output hello"],
      displayName: "PowerShell"
    });
    expect(createShellInvocation("printf hello", "darwin")).toEqual({
      executable: "bash",
      args: ["-lc", "printf hello"],
      displayName: "Bash"
    });
    expect(shellDisplayName("win32")).toBe("PowerShell");
  });

  it("does not auto-background commands that already background a long-running segment", () => {
    expect(isLongRunningCommand("cd app && npm run dev")).toBe(true);
    expect(isLongRunningCommand('cd app && npm run dev > app.log 2>&1 &\necho "PID: $!"')).toBe(
      false
    );
    expect(
      isLongRunningCommand(
        "nohup bash -c 'npm run dev' > app.log 2>&1 < /dev/null & disown; echo BG_PID=$!"
      )
    ).toBe(false);
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
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
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
