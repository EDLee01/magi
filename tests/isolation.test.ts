import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { ActiveInteractionRegistry } from "../src/interactions.js";
import { appendMemory, sessionMemoryFile } from "../src/memory.js";
import { executeRegisteredTool } from "../src/tools/registry.js";
import { todoStorePathFromRoot } from "../src/tools/todo.js";
import {
  DEFAULT_CONTROL_BIND,
  DEFAULT_CONTROL_PORT,
  DEVELOPMENT_ROOT_NAME,
  MAGI_ENV_PREFIX,
  ensureMagiHome,
  getMagiPaths,
  getRuntimeSettings
} from "../src/paths.js";
import { makeTempRoot, TempRoot } from "./helpers.js";

let temp: TempRoot | undefined;

afterEach(() => {
  temp?.cleanup();
  temp = undefined;
});

describe("isolation", () => {
  it("defaults to creating and using ~/.magi-next", () => {
    const home = path.join(process.cwd(), ".tmp-home-for-path-test");
    const paths = getMagiPaths({}, home);
    expect(paths.root).toBe(path.join(home, DEVELOPMENT_ROOT_NAME));
  });

  it("does not read or write legacy directories when using default commands", async () => {
    temp = makeTempRoot();
    const legacyRoot = path.join(temp.path, ".claude");
    const legacyMagi = path.join(legacyRoot, "magi");
    mkdirSync(legacyMagi, { recursive: true });
    const before = snapshotTree(legacyRoot);

    const result = await runCli(
      ["doctor"],
      { ...temp.env, CLAUDE_CONFIG_DIR: legacyRoot },
      process.cwd()
    );

    expect(result.exitCode).toBe(0);
    expect(snapshotTree(legacyRoot)).toEqual(before);
    expect(result.stdout).toContain(`configRoot: ${temp.path}`);
  });

  it("does not write legacy session cache plugin skill or log roots", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    await runCli(["-p", "isolation check"], temp.env, process.cwd());

    for (const forbidden of [
      "legacy-sessions",
      "legacy-cache",
      "legacy-plugins",
      "legacy-skills",
      "legacy-logs"
    ]) {
      expect(existsSync(path.join(temp.path, forbidden))).toBe(false);
    }
    expect(existsSync(paths.root)).toBe(true);
    expect(existsSync(paths.stateRoot)).toBe(true);
    expect(existsSync(paths.cacheRoot)).toBe(true);
    expect(existsSync(paths.pluginsRoot)).toBe(true);
    expect(existsSync(paths.skillsRoot)).toBe(true);
    expect(existsSync(paths.logsRoot)).toBe(true);
  });

  it("uses MAGI_* as the primary configuration prefix", () => {
    expect(MAGI_ENV_PREFIX).toBe("MAGI_");
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: "/tmp/magi-config-test" });
    expect(paths.root).toBe("/tmp/magi-config-test");
  });

  it("does not use CLAUDE_* as primary configuration", () => {
    const paths = getMagiPaths(
      { CLAUDE_CONFIG_DIR: "/tmp/forbidden-config-test" },
      "/tmp/home-test"
    );
    expect(paths.root).toBe("/tmp/home-test/.magi-next");
  });

  it("defaults the Control API to 127.0.0.1:8765", () => {
    expect(getRuntimeSettings({})).toEqual({
      controlBind: DEFAULT_CONTROL_BIND,
      controlPort: DEFAULT_CONTROL_PORT
    });
  });

  it("allows MAGI_CONTROL_PORT to configure the Control API port", () => {
    expect(getRuntimeSettings({ MAGI_CONTROL_PORT: "9876" }).controlPort).toBe(9876);
  });

  it("creates only Magi Next directories under the configured root", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    expect(readdirSync(temp.path).sort()).toEqual([
      "cache",
      "config.yaml",
      "devices",
      "logs",
      "plugins",
      "sessions",
      "skills",
      "state"
    ]);
  });

  it("stores cron jobs only under the Magi Next state root", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    const legacyRoot = path.join(temp.path, ".claude");
    mkdirSync(legacyRoot, { recursive: true });
    const before = snapshotTree(legacyRoot);

    const result = await executeRegisteredTool({
      cwd: temp.path,
      stateRoot: paths.stateRoot,
      permissionMode: "bypassPermissions",
      toolUse: {
        type: "tool-use",
        id: "cron-isolation",
        name: "CronCreate",
        input: { cron: "0 9 * * 1", prompt: "weekly status", durable: true }
      }
    });

    expect(result.isError).toBeUndefined();
    expect(existsSync(path.join(paths.stateRoot, "cron-jobs.json"))).toBe(true);
    expect(snapshotTree(legacyRoot)).toEqual(before);
  });

  it("stores TodoWrite state only under the Magi Next state root", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    const legacyRoot = path.join(temp.path, ".claude");
    mkdirSync(legacyRoot, { recursive: true });
    const before = snapshotTree(legacyRoot);

    const result = await executeRegisteredTool({
      cwd: temp.path,
      stateRoot: paths.stateRoot,
      sessionId: "todo-isolation-session",
      permissionMode: "bypassPermissions",
      toolUse: {
        type: "tool-use",
        id: "todo-isolation",
        name: "TodoWrite",
        input: {
          todos: [{ id: "isolate", content: "Keep todo state in Magi Next", status: "pending" }]
        }
      }
    });

    expect(result.isError).toBeUndefined();
    expect(existsSync(todoStorePathFromRoot(paths.stateRoot))).toBe(true);
    expect(snapshotTree(legacyRoot)).toEqual(before);
  });

  it("stores layered memory only under Magi Next roots", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    const legacyRoot = path.join(temp.path, ".claude");
    mkdirSync(legacyRoot, { recursive: true });
    const before = snapshotTree(legacyRoot);

    appendMemory({ paths, scope: "user", cwd: temp.path, text: "theme: quiet interface" });
    appendMemory({ paths, scope: "project", cwd: temp.path, text: "api style: explicit routes" });
    appendMemory({
      paths,
      scope: "session",
      cwd: temp.path,
      sessionId: "memory-isolation",
      text: "handoff: memory isolation"
    });

    expect(existsSync(path.join(paths.root, "memory.md"))).toBe(true);
    expect(existsSync(path.join(paths.stateRoot, "project-memory"))).toBe(true);
    expect(existsSync(sessionMemoryFile(paths, "memory-isolation"))).toBe(true);
    expect(snapshotTree(legacyRoot)).toEqual(before);
  });

  it("uses Config and Skill tools only under Magi Next roots", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    const legacyRoot = path.join(temp.path, ".claude");
    mkdirSync(legacyRoot, { recursive: true });
    const skillRoot = path.join(paths.skillsRoot, "isolation-helper");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      path.join(skillRoot, "SKILL.md"),
      "# Isolation Helper\n\nStay isolated.\n",
      "utf8"
    );
    const before = snapshotTree(legacyRoot);

    const config = await executeRegisteredTool({
      cwd: temp.path,
      stateRoot: paths.stateRoot,
      permissionMode: "bypassPermissions",
      toolUse: {
        type: "tool-use",
        id: "config-isolation",
        name: "Config",
        input: { setting: "context.recentMessages", value: 8 }
      }
    });
    expect(config.isError).toBeUndefined();
    expect(readFileSync(paths.configFile, "utf8")).toContain("recentMessages: 8");

    const skill = await executeRegisteredTool({
      cwd: temp.path,
      stateRoot: paths.stateRoot,
      toolUse: {
        type: "tool-use",
        id: "skill-isolation",
        name: "Skill",
        input: { skill: "isolation-helper" }
      }
    });
    expect(skill.isError).toBeUndefined();
    expect(skill.content).toContain("Stay isolated.");
    expect(snapshotTree(legacyRoot)).toEqual(before);
  });

  it("runs Git tools without touching legacy roots", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    initGitRepo(temp.path);
    writeFileSync(path.join(temp.path, "tracked.txt"), "before\n", "utf8");
    git(temp.path, ["add", "tracked.txt"]);
    git(temp.path, ["commit", "-m", "initial commit"]);
    writeFileSync(path.join(temp.path, "tracked.txt"), "after\n", "utf8");
    const legacyRoot = path.join(temp.path, ".claude");
    mkdirSync(legacyRoot, { recursive: true });
    const before = snapshotTree(legacyRoot);

    const status = await executeRegisteredTool({
      cwd: temp.path,
      stateRoot: paths.stateRoot,
      toolUse: {
        type: "tool-use",
        id: "git-status-isolation",
        name: "GitStatus",
        input: {}
      }
    });
    const diff = await executeRegisteredTool({
      cwd: temp.path,
      stateRoot: paths.stateRoot,
      toolUse: {
        type: "tool-use",
        id: "git-diff-isolation",
        name: "GitDiff",
        input: { path: "tracked.txt" }
      }
    });
    const branch = await executeRegisteredTool({
      cwd: temp.path,
      stateRoot: paths.stateRoot,
      permissionMode: "bypassPermissions",
      toolUse: {
        type: "tool-use",
        id: "git-branch-isolation",
        name: "GitBranchCreate",
        input: { name: "feature/isolation" }
      }
    });
    const stage = await executeRegisteredTool({
      cwd: temp.path,
      stateRoot: paths.stateRoot,
      permissionMode: "bypassPermissions",
      toolUse: {
        type: "tool-use",
        id: "git-stage-isolation",
        name: "GitStage",
        input: { paths: ["tracked.txt"] }
      }
    });

    expect(status.isError).toBeUndefined();
    expect(status.content).toContain("tracked.txt");
    expect(diff.isError).toBeUndefined();
    expect(diff.content).toContain("+after");
    expect(branch.isError).toBeUndefined();
    expect(branch.content).toContain("Created branch feature/isolation");
    expect(stage.isError).toBeUndefined();
    expect(stage.content).toContain("Staged 1 path");
    expect(snapshotTree(legacyRoot)).toEqual(before);
  });

  it("runs WorkspaceDiagnostics without touching legacy roots", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(
      path.join(temp.path, "package.json"),
      JSON.stringify({
        scripts: { test: "vitest run" },
        devDependencies: { vitest: "^3.0.0" }
      }),
      "utf8"
    );
    writeFileSync(path.join(temp.path, "index.ts"), "export const isolated = true;\n", "utf8");
    const legacyRoot = path.join(temp.path, ".claude");
    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(path.join(legacyRoot, "secret.txt"), "legacy secret\n", "utf8");
    const before = snapshotTree(legacyRoot);

    const result = await executeRegisteredTool({
      cwd: temp.path,
      stateRoot: paths.stateRoot,
      toolUse: {
        type: "tool-use",
        id: "workspace-diagnostics-isolation",
        name: "WorkspaceDiagnostics",
        input: { format: "json" }
      }
    });
    const diagnostics = JSON.parse(result.content) as { scan: { sampledFiles: string[] } };

    expect(result.isError).toBeUndefined();
    expect(diagnostics.scan.sampledFiles).toContain("index.ts");
    expect(diagnostics.scan.sampledFiles).not.toContain(".claude/secret.txt");
    expect(snapshotTree(legacyRoot)).toEqual(before);
  });

  it("keeps active interaction registry in memory and uses only MAGI timeout env", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    const legacyRoot = path.join(temp.path, ".claude");
    mkdirSync(legacyRoot, { recursive: true });
    const before = snapshotTree(legacyRoot);
    const registry = new ActiveInteractionRegistry({ timeoutMs: 5_000 });
    try {
      registry.registerJob({
        sessionId: "interaction-isolation-session",
        jobId: "interaction-isolation-job"
      });
      const pending = registry.waitForApproval({
        sessionId: "interaction-isolation-session",
        jobId: "interaction-isolation-job",
        toolUse: {
          type: "tool-use",
          id: "interaction-isolation",
          name: "FileWrite",
          input: { file_path: "x.txt", content: "x" }
        },
        reason: "isolation check"
      });
      registry.resolveApproval({
        jobId: "interaction-isolation-job",
        toolUseId: "interaction-isolation",
        approved: false
      });
      await expect(pending).resolves.toBe(false);
      expect(snapshotTree(legacyRoot)).toEqual(before);
      expect(
        getRuntimeSettings({ ...temp.env, MAGI_INTERACTION_TIMEOUT_MS: "10" }).controlPort
      ).toBe(DEFAULT_CONTROL_PORT);
      expect(
        getRuntimeSettings({ ...temp.env, CLAUDE_INTERACTION_TIMEOUT_MS: "10" }).controlPort
      ).toBe(DEFAULT_CONTROL_PORT);
    } finally {
      registry.close();
    }
  });
});

function snapshotTree(root: string): Record<string, { kind: string; text?: string }> {
  const result: Record<string, { kind: string; text?: string }> = {};
  walk(root);
  return result;

  function walk(current: string): void {
    const stat = statSync(current);
    const rel = path.relative(root, current) || ".";
    if (stat.isDirectory()) {
      result[rel] = { kind: "dir" };
      for (const child of readdirSync(current)) {
        walk(path.join(current, child));
      }
      return;
    }
    result[rel] = { kind: "file", text: readFileSync(current, "utf8") };
  }
}

function initGitRepo(cwd: string): void {
  git(cwd, ["init"]);
  git(cwd, ["config", "user.email", "magi-next@example.invalid"]);
  git(cwd, ["config", "user.name", "Magi Next Tests"]);
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10_000
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
}
