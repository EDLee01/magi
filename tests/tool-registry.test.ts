import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  executeRegisteredTool,
  executeRegisteredTools,
  formatToolResult,
  getBuiltinToolDefinitions,
  getBuiltinToolRegistry,
  getCoreToolDefinitions,
  getDeferredToolDefinitions,
  checkToolPermission,
  classifyToolRisk
} from "../src/tools/registry.js";
import { cronStorePathFromRoot } from "../src/tools/cron.js";
import { loadTodoStore, todoStorePathFromRoot } from "../src/tools/todo.js";
import { ensureMagiHome, getMagiPaths } from "../src/paths.js";
import { SessionStore } from "../src/session-store.js";
import { MemoryNodeStore } from "../src/memory-node-store.js";
import {
  loadToolUsageStats,
  recordToolUsage,
  toolUsageStatsPath
} from "../src/tool-usage-stats.js";
import { addPermissionRule, clearPermissionRules } from "../src/permissions.js";
import { shellDisplayName } from "../src/platform/shell.js";

let workspace: string | undefined;
let server: http.Server | undefined;

afterEach(async () => {
  if (server) {
    await closeServer(server);
    server = undefined;
  }
  if (workspace) {
    rmSync(workspace, { recursive: true, force: true });
    workspace = undefined;
  }
});

describe("tool registry", () => {
  it("exposes schema-backed built-in tool definitions", () => {
    const names = getBuiltinToolDefinitions().map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "FileRead",
        "FileWrite",
        "FileEdit",
        "FilePatch",
        "Glob",
        "Grep",
        "Bash",
        "WebFetch",
        "WebSearch",
        "GitStatus",
        "GitDiff",
        "GitLog",
        "GitShow",
        "GitBranchList",
        "GitBranchCreate",
        "GitCheckout",
        "GitStage",
        "AskUserQuestion",
        "SendUserMessage",
        "Brief",
        "CronCreate",
        "CronUpdate",
        "CronDelete",
        "CronList",
        "TodoWrite",
        "ToolSearch",
        "WorkspaceDiagnostics",
        "Config",
        "Skill",
        "SkillManage",
        "LearningDraft",
        "SessionSearch",
        "LSP"
      ])
    );
    expect(getBuiltinToolRegistry().get("FileRead")?.isConcurrencySafe({})).toBe(true);
    expect(getBuiltinToolRegistry().get("FileWrite")?.isReadOnly({})).toBe(false);
  });

  it("splits core and deferred tool definitions for compact agent context", () => {
    const core = getCoreToolDefinitions().map((tool) => tool.name);
    const deferred = getDeferredToolDefinitions().map((tool) => tool.name);

    expect(core).toEqual(
      expect.arrayContaining([
        "FileRead",
        "FileWrite",
        "FileEdit",
        "FilePatch",
        "Glob",
        "Grep",
        "Bash",
        "WebSearch",
        "WebFetch",
        "ToolSearch",
        "WorkspaceDiagnostics",
        "EnterPlanMode",
        "ExitPlanMode",
        "Skill",
        "DiscoverSkills"
      ])
    );
    expect(deferred).toEqual(
      expect.arrayContaining([
        "Agent",
        "Browser",
        "Config",
        "LearningDraft",
        "GitBranchCreate",
        "LSP",
        "Monitor",
        "SessionSearch",
        "SkillManage"
      ])
    );
    expect(core).not.toContain("Agent");
    expect(core).not.toContain("Browser");
    expect(core).not.toContain("Config");
    expect(core).not.toContain("GitBranchCreate");
    expect(deferred).not.toContain("Skill");
    expect(deferred).not.toContain("DiscoverSkills");
    expect(new Set([...core, ...deferred]).size).toBe(getBuiltinToolDefinitions().length);
  });

  it("discovers installed skills with executable Skill tool guidance", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-registry-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: workspace });
    ensureMagiHome(paths);
    const skillRoot = path.join(paths.skillsRoot, "frontmatter-skill");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      path.join(skillRoot, "SKILL.md"),
      [
        "---",
        "description: Use frontmatter summaries for skill discovery.",
        "---",
        "",
        "# Frontmatter Skill",
        "",
        "Follow the frontmatter workflow."
      ].join("\n"),
      "utf8"
    );

    const result = await executeRegisteredTool({
      cwd: workspace,
      stateRoot: paths.stateRoot,
      toolUse: {
        type: "tool-use",
        id: "discover-skills",
        name: "DiscoverSkills",
        input: {}
      }
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("/frontmatter-skill");
    expect(result.content).toContain("Use frontmatter summaries for skill discovery.");
    expect(result.content).toContain('Skill({skill: "..."})');
    expect(result.content).not.toContain("Skill({name");
  });

  it("searches prior sessions with SessionSearch", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-registry-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: workspace });
    ensureMagiHome(paths);
    const store = SessionStore.open(paths);
    let prior: string;
    let current: string;
    try {
      prior = store.createSession({ title: "pixel snake review", cwd: workspace });
      store.appendMessage({
        sessionId: prior,
        role: "user",
        content: "Review the pixel snake canvas collision bug"
      });
      store.appendMessage({
        sessionId: prior,
        role: "assistant",
        content: "The fix was to keep food off the snake body."
      });
      current = store.createSession({ title: "current", cwd: workspace });
      store.appendMessage({ sessionId: current, role: "user", content: "current-only content" });
    } finally {
      store.close();
    }

    const search = await executeRegisteredTool({
      cwd: workspace,
      stateRoot: paths.stateRoot,
      sessionId: current!,
      toolUse: {
        type: "tool-use",
        id: "session-search",
        name: "SessionSearch",
        input: { query: "pixel snake food", limit: 5 }
      }
    });
    expect(search.isError).toBeUndefined();
    expect(search.content).toContain("pixel snake review");
    expect(search.content).toContain(prior!);
    expect(search.content).not.toContain("current-only content");

    const windowResult = await executeRegisteredTool({
      cwd: workspace,
      stateRoot: paths.stateRoot,
      toolUse: {
        type: "tool-use",
        id: "session-window",
        name: "SessionSearch",
        input: { session_id: prior!, window: 2 }
      }
    });
    expect(windowResult.content).toContain("The fix was to keep food off the snake body.");
  });

  it("creates reviewable LearningDrafts and applies memory drafts only on apply", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-registry-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: workspace });
    ensureMagiHome(paths);

    const proposed = await executeRegisteredTool({
      cwd: workspace,
      stateRoot: paths.stateRoot,
      sessionId: "session-1",
      permissionMode: "bypassPermissions",
      toolUse: {
        type: "tool-use",
        id: "learning-propose",
        name: "LearningDraft",
        input: {
          action: "propose",
          kind: "memory",
          target: "workflows/README.md",
          content: "## Test workflow\n\nUse rg before broad file reads.",
          reason: "Stable workflow learned in test",
          evidence: ["test evidence"],
          confidence: 0.8
        }
      }
    });
    expect(proposed.isError).toBeUndefined();
    const id = /Created LearningDraft: ([^ ]+)/.exec(proposed.content)?.[1];
    expect(id).toBeTruthy();
    expect(
      readFileSync(path.join(paths.root, "memory", "workflows", "README.md"), "utf8")
    ).not.toContain("Use rg before broad file reads.");

    const show = await executeRegisteredTool({
      cwd: workspace,
      stateRoot: paths.stateRoot,
      toolUse: {
        type: "tool-use",
        id: "learning-show",
        name: "LearningDraft",
        input: { action: "show", id }
      }
    });
    expect(show.content).toContain("Stable workflow learned in test");

    const applied = await executeRegisteredTool({
      cwd: workspace,
      stateRoot: paths.stateRoot,
      permissionMode: "bypassPermissions",
      toolUse: {
        type: "tool-use",
        id: "learning-apply",
        name: "LearningDraft",
        input: { action: "apply", id }
      }
    });
    expect(applied.isError).toBeUndefined();
    expect(
      readFileSync(path.join(paths.root, "memory", "workflows", "README.md"), "utf8")
    ).toContain("Use rg before broad file reads.");
    expect(
      readFileSync(path.join(paths.root, "memory", "workflows", "README.md"), "utf8")
    ).toContain(`<!-- LearningDraft ${id} -->`);

    const skillDraft = await executeRegisteredTool({
      cwd: workspace,
      stateRoot: paths.stateRoot,
      sessionId: "session-1",
      permissionMode: "bypassPermissions",
      toolUse: {
        type: "tool-use",
        id: "learning-skill-propose",
        name: "LearningDraft",
        input: {
          action: "propose",
          kind: "skill_create",
          target: "skills/learned-debug/SKILL.md",
          content: "# Learned Debug\n\nRun focused tests before full suites.",
          reason: "Reusable skill learned in test"
        }
      }
    });
    const skillDraftId = /Created LearningDraft: ([^ ]+)/.exec(skillDraft.content)?.[1];
    expect(skillDraftId).toBeTruthy();

    const skillApplied = await executeRegisteredTool({
      cwd: workspace,
      stateRoot: paths.stateRoot,
      permissionMode: "bypassPermissions",
      toolUse: {
        type: "tool-use",
        id: "learning-skill-apply",
        name: "LearningDraft",
        input: { action: "apply", id: skillDraftId }
      }
    });
    expect(skillApplied.isError).toBeUndefined();
    expect(
      readFileSync(path.join(paths.skillsRoot, "learned-debug", "SKILL.md"), "utf8")
    ).toContain("Run focused tests before full suites.");

    const skillPatchDraft = await executeRegisteredTool({
      cwd: workspace,
      stateRoot: paths.stateRoot,
      sessionId: "session-1",
      permissionMode: "bypassPermissions",
      toolUse: {
        type: "tool-use",
        id: "learning-skill-patch-propose",
        name: "LearningDraft",
        input: {
          action: "propose",
          kind: "skill_patch",
          target: "skills/learned-debug/SKILL.md",
          content: [
            "old_string:",
            "```",
            "Run focused tests before full suites.",
            "```",
            "new_string:",
            "```",
            "Run isolated provider checks before full suites.",
            "```"
          ].join("\n"),
          reason: "Correct stale learned skill guidance"
        }
      }
    });
    const skillPatchDraftId = /Created LearningDraft: ([^ ]+)/.exec(skillPatchDraft.content)?.[1];
    expect(skillPatchDraftId).toBeTruthy();

    const skillPatchApplied = await executeRegisteredTool({
      cwd: workspace,
      stateRoot: paths.stateRoot,
      permissionMode: "bypassPermissions",
      toolUse: {
        type: "tool-use",
        id: "learning-skill-patch-apply",
        name: "LearningDraft",
        input: { action: "apply", id: skillPatchDraftId }
      }
    });
    expect(skillPatchApplied.isError).toBeUndefined();
    const skillContent = readFileSync(
      path.join(paths.skillsRoot, "learned-debug", "SKILL.md"),
      "utf8"
    );
    expect(skillContent).toContain("Run isolated provider checks before full suites.");
    expect(skillContent).not.toContain("Run focused tests before full suites.");
  });

  it("writes Memorize tool calls directly to the memory graph", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-registry-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: workspace });
    ensureMagiHome(paths);

    const result = await executeRegisteredTool({
      cwd: workspace,
      stateRoot: paths.stateRoot,
      sessionId: "session-1",
      permissionMode: "bypassPermissions",
      toolUse: {
        type: "tool-use",
        id: "memorize",
        name: "Memorize",
        input: {
          type: "work_habit",
          name: "Focused checks first",
          description: "User prefers focused checks before broad checks.",
          body: "For coding tasks, run focused checks before broad checks unless the user asks otherwise.",
          weight: 0.7
        }
      }
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Wrote Memory node");

    const store = MemoryNodeStore.open(paths);
    const nodes = store.listHotNodes({ limit: 10, minWeight: 0 });
    store.close();
    expect(nodes).toContainEqual(
      expect.objectContaining({
        type: "work_habit",
        title: "Focused checks first",
        summary: "User prefers focused checks before broad checks.",
        body: "For coding tasks, run focused checks before broad checks unless the user asks otherwise.",
        weight: 0.7,
        source: "agent",
        sourceSessionId: "session-1"
      })
    );
  });

  it("corrects durable memory graph nodes through MemoryCorrect", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-registry-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: workspace });
    ensureMagiHome(paths);
    const store = MemoryNodeStore.open(paths);
    const wrong = store.upsertNode({
      type: "preference",
      title: "Output preference",
      summary: "Incorrect output preference.",
      body: "User prefers verbose terminal dumps.",
      source: "explicit",
      weight: 0.95
    });
    store.close();

    const result = await executeRegisteredTool({
      cwd: workspace,
      stateRoot: paths.stateRoot,
      sessionId: "session-1",
      permissionMode: "bypassPermissions",
      toolUse: {
        type: "tool-use",
        id: "correct-memory",
        name: "MemoryCorrect",
        input: {
          target: wrong.id,
          reason: "User said this memory is wrong.",
          replacement: "User prefers concise verification summaries.",
          replacement_title: "Output preference",
          replacement_summary: "Correct output preference.",
          replacement_type: "preference"
        }
      }
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Corrected Memory node");
    expect(result.content).toContain("replacement:");

    const after = MemoryNodeStore.open(paths);
    try {
      expect(after.getNode(wrong.id)?.status).toBe("disputed");
      const hits = after.searchGraph({ query: "verbose terminal dumps", limit: 5 });
      expect(hits.map((hit) => hit.node.body)).toContain(
        "User prefers concise verification summaries."
      );
      expect(hits.map((hit) => hit.node.id)).not.toContain(wrong.id);
    } finally {
      after.close();
    }
  });

  it("creates and patches skills with SkillManage path limits", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-registry-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: workspace });
    ensureMagiHome(paths);

    const created = await executeRegisteredTool({
      cwd: workspace,
      stateRoot: paths.stateRoot,
      permissionMode: "bypassPermissions",
      toolUse: {
        type: "tool-use",
        id: "skill-create",
        name: "SkillManage",
        input: {
          action: "create",
          name: "debug-api",
          content: "# Debug API\n\nUse logs first.\n"
        }
      }
    });
    expect(created.isError).toBeUndefined();
    const skillFile = path.join(paths.skillsRoot, "debug-api", "SKILL.md");
    expect(readFileSync(skillFile, "utf8")).toContain("Use logs first.");

    const patched = await executeRegisteredTool({
      cwd: workspace,
      stateRoot: paths.stateRoot,
      permissionMode: "bypassPermissions",
      toolUse: {
        type: "tool-use",
        id: "skill-patch",
        name: "SkillManage",
        input: {
          action: "patch",
          name: "debug-api",
          old_string: "Use logs first.",
          new_string: "Use request logs and failing tests first."
        }
      }
    });
    expect(patched.isError).toBeUndefined();
    expect(readFileSync(skillFile, "utf8")).toContain("Use request logs and failing tests first.");

    const escape = await executeRegisteredTool({
      cwd: workspace,
      stateRoot: paths.stateRoot,
      permissionMode: "bypassPermissions",
      toolUse: {
        type: "tool-use",
        id: "skill-escape",
        name: "SkillManage",
        input: {
          action: "write_file",
          name: "debug-api",
          file_path: "../outside.md",
          content: "bad"
        }
      }
    });
    expect(escape.isError).toBe(true);
    expect(escape.content).toContain("escapes skill root");
  });

  it("edits files with old_string uniqueness checks", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-registry-"));
    writeFileSync(path.join(workspace, "note.txt"), "one\ntwo\n", "utf8");

    const result = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "edit-1",
        name: "FileEdit",
        input: { file_path: "note.txt", old_string: "two", new_string: "three" }
      },
      permissionMode: "bypassPermissions"
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Wrote note.txt");
    await expect(readFile(path.join(workspace, "note.txt"), "utf8")).resolves.toBe("one\nthree\n");
  });

  it("applies unified diff hunks with FilePatch context checks", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-registry-"));
    writeFileSync(
      path.join(workspace, "note.txt"),
      ["one", "two", "three", "four", ""].join("\n"),
      "utf8"
    );

    const result = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "patch-1",
        name: "FilePatch",
        input: {
          file_path: "note.txt",
          patch: ["@@", " one", "-two", "+TWO", " three"].join("\n")
        }
      },
      permissionMode: "bypassPermissions"
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Patched note.txt (1 hunk)");
    await expect(readFile(path.join(workspace, "note.txt"), "utf8")).resolves.toBe(
      "one\nTWO\nthree\nfour\n"
    );

    const failed = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "patch-miss",
        name: "FilePatch",
        input: {
          file_path: "note.txt",
          patch: ["@@", " missing", "-value", "+new"].join("\n")
        }
      },
      permissionMode: "bypassPermissions"
    });
    expect(failed.isError).toBe(true);
    expect(failed.content).toContain("Patch context did not match file");
    expect(failed.content).toContain("Recovery guidance:");
    expect(failed.content).toContain("Patch tried to match:");
    expect(failed.content).toContain("Current file snippet:");
    expect(failed.content).toContain("one");
    expect(failed.content).toContain("TWO");
  });

  it("supports glob and grep options", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-registry-"));
    writeFileSync(path.join(workspace, "a.ts"), "const alpha = 1;\n", "utf8");
    writeFileSync(path.join(workspace, "b.txt"), "alpha\n", "utf8");
    mkdirSync(path.join(workspace, "nested"));
    writeFileSync(
      path.join(workspace, "nested", "c.ts"),
      ["before", "const beta = 42;", "after"].join("\n"),
      "utf8"
    );
    writeFileSync(path.join(workspace, "nested", "d.py"), "beta = 42\n", "utf8");

    const glob = await executeRegisteredTool({
      cwd: workspace,
      toolUse: { type: "tool-use", id: "glob-1", name: "Glob", input: { pattern: "*.ts" } }
    });
    expect(glob.content).toContain("a.ts");
    expect(glob.content).not.toContain("b.txt");

    const grep = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "grep-1",
        name: "Grep",
        input: { pattern: "alpha", glob: "*.txt", output_mode: "files_with_matches" }
      }
    });
    expect(grep.content.trim()).toBe("b.txt");

    const regex = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "grep-regex",
        name: "Grep",
        input: {
          pattern: "beta\\s*=\\s*42",
          path: "nested",
          type: "ts",
          context: 1,
          head_limit: 1
        }
      }
    });
    expect(regex.content).toContain("Search: beta\\s*=\\s*42 -> 1 files, 1 matches");
    expect(regex.content).toContain("nested/c.ts-1-before");
    expect(regex.content).toContain("nested/c.ts:2:const beta = 42;");
    expect(regex.content).toContain("nested/c.ts-3-after");
    expect(regex.content).not.toContain("nested/d.py");

    const noLineNumbers = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "grep-no-lines",
        name: "Grep",
        input: { pattern: "alpha", glob: "*.txt", line_numbers: false }
      }
    });
    expect(noLineNumbers.content).toContain("b.txt:alpha");
    expect(noLineNumbers.content).not.toContain("b.txt:1:alpha");

    const outside = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "grep-outside",
        name: "Grep",
        input: { pattern: "alpha", path: "../outside" }
      }
    });
    expect(outside).toMatchObject({ isError: true });
    expect(outside.content).toContain("outside allowed directories");
  });

  it("applies permission mode and rule priority", () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-tool-permissions-"));
    const previousConfigDir = process.env.MAGI_CONFIG_DIR;
    process.env.MAGI_CONFIG_DIR = workspace;
    try {
      clearPermissionRules();
      const writeCall = {
        type: "tool-use" as const,
        id: "write-1",
        name: "FileWrite",
        input: { file_path: "x.txt", content: "x" }
      };
      const patchCall = {
        type: "tool-use" as const,
        id: "patch-1",
        name: "FilePatch",
        input: { file_path: "x.txt", patch: "@@\n-old\n+new" }
      };
      expect(checkToolPermission({ toolUse: writeCall, mode: "plan" })).toMatchObject({
        decision: "deny"
      });
      expect(checkToolPermission({ toolUse: patchCall, mode: "plan" })).toMatchObject({
        decision: "deny"
      });
      expect(checkToolPermission({ toolUse: patchCall, mode: "default" })).toMatchObject({
        decision: "ask"
      });
      expect(checkToolPermission({ toolUse: patchCall, mode: "dontAsk" })).toMatchObject({
        decision: "deny",
        reason: "FilePatch is not allowed in dontAsk mode"
      });
      expect(checkToolPermission({ toolUse: patchCall, mode: "acceptEdits" })).toMatchObject({
        decision: "allow",
        reason: "acceptEdits workspace edit"
      });
      expect(
        checkToolPermission({
          toolUse: writeCall,
          mode: "default",
          rules: {
            allow: ["FileWrite(*)"],
            deny: ["FileWrite(x.txt)"],
            ask: []
          }
        })
      ).toMatchObject({ decision: "deny" });
    } finally {
      clearPermissionRules();
      if (previousConfigDir === undefined) {
        delete process.env.MAGI_CONFIG_DIR;
      } else {
        process.env.MAGI_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  it("honors persistent permission rules for default non-Bash tools", () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-tool-permissions-"));
    const previousConfigDir = process.env.MAGI_CONFIG_DIR;
    process.env.MAGI_CONFIG_DIR = workspace;
    try {
      clearPermissionRules();
      addPermissionRule("FileWrite", "Always allow FileWrite");
      addPermissionRule("Bash", "stale Bash allow");
      const writeCall = {
        type: "tool-use" as const,
        id: "write-persistent",
        name: "FileWrite",
        input: { file_path: "x.txt", content: "x" }
      };
      const bashCall = {
        type: "tool-use" as const,
        id: "bash-persistent",
        name: "Bash",
        input: { command: "npm test" }
      };
      expect(checkToolPermission({ toolUse: writeCall, mode: "default" })).toMatchObject({
        decision: "allow",
        reason: "persistent permission rule"
      });
      expect(checkToolPermission({ toolUse: writeCall, mode: "dontAsk" })).toMatchObject({
        decision: "deny"
      });
      expect(checkToolPermission({ toolUse: bashCall, mode: "default" })).toMatchObject({
        decision: "ask"
      });
    } finally {
      clearPermissionRules();
      if (previousConfigDir === undefined) {
        delete process.env.MAGI_CONFIG_DIR;
      } else {
        process.env.MAGI_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  it("allows conservative read-only Bash commands without approving mutating shell commands", () => {
    const readOnlyBashCall = {
      type: "tool-use" as const,
      id: "bash-status",
      name: "Bash",
      input: { command: "git status --short" }
    };
    const mutatingBashCall = {
      type: "tool-use" as const,
      id: "bash-write",
      name: "Bash",
      input: { command: "printf hi > out.txt" }
    };
    const testBashCall = {
      type: "tool-use" as const,
      id: "bash-test",
      name: "Bash",
      input: { command: "npm test" }
    };
    const dangerousBashCall = {
      type: "tool-use" as const,
      id: "bash-danger",
      name: "Bash",
      input: { command: "rm -rf build" }
    };

    expect(checkToolPermission({ toolUse: readOnlyBashCall, mode: "default" })).toEqual({
      decision: "allow",
      reason: "read-only tool"
    });
    expect(checkToolPermission({ toolUse: readOnlyBashCall, mode: "plan" })).toEqual({
      decision: "allow",
      reason: "read-only tool"
    });
    expect(checkToolPermission({ toolUse: mutatingBashCall, mode: "default" })).toMatchObject({
      decision: "ask"
    });
    expect(checkToolPermission({ toolUse: mutatingBashCall, mode: "plan" })).toMatchObject({
      decision: "deny"
    });
    expect(checkToolPermission({ toolUse: mutatingBashCall, mode: "dontAsk" })).toMatchObject({
      decision: "deny",
      reason: "Bash is not allowed in dontAsk mode"
    });
    expect(checkToolPermission({ toolUse: testBashCall, mode: "default" })).toMatchObject({
      decision: "ask"
    });
    expect(checkToolPermission({ toolUse: testBashCall, mode: "acceptEdits" })).toMatchObject({
      decision: "ask",
      reason: "Bash requires approval in acceptEdits mode (command)"
    });
    expect(checkToolPermission({ toolUse: dangerousBashCall, mode: "acceptEdits" })).toMatchObject({
      decision: "deny",
      reason: `dangerous ${shellDisplayName()} command requires bypassPermissions mode and explicit dangerous approval`
    });
    expect(
      checkToolPermission({
        toolUse: dangerousBashCall,
        mode: "bypassPermissions"
      })
    ).toMatchObject({
      decision: "deny",
      reason: `dangerous ${shellDisplayName()} command requires MAGI_APPROVE_DANGEROUS_COMMANDS=1`
    });
    expect(
      checkToolPermission({
        toolUse: dangerousBashCall,
        mode: "bypassPermissions",
        env: { MAGI_APPROVE_DANGEROUS_COMMANDS: "1" }
      })
    ).toMatchObject({
      decision: "allow",
      reason: "bypassPermissions mode"
    });
  });

  it("classifies acceptEdits risks and only auto-allows workspace edits", () => {
    const calls = {
      read: {
        type: "tool-use" as const,
        id: "read",
        name: "FileRead",
        input: { file_path: "README.md" }
      },
      edit: {
        type: "tool-use" as const,
        id: "edit",
        name: "FileWrite",
        input: { file_path: "x.txt", content: "x" }
      },
      destructive: {
        type: "tool-use" as const,
        id: "destructive",
        name: "FileDelete",
        input: { path: "x.txt" }
      },
      network: {
        type: "tool-use" as const,
        id: "network",
        name: "HttpRequest",
        input: { url: "https://example.com", method: "GET" }
      },
      remote: {
        type: "tool-use" as const,
        id: "remote",
        name: "SshFileWrite",
        input: { host: "example", path: "/tmp/x", content: "x" }
      },
      state: {
        type: "tool-use" as const,
        id: "state",
        name: "Memorize",
        input: { scope: "user", text: "remember this" }
      }
    };

    expect(classifyToolRisk(calls.read)).toBe("read");
    expect(classifyToolRisk(calls.edit)).toBe("workspace-edit");
    expect(classifyToolRisk(calls.destructive)).toBe("destructive");
    expect(classifyToolRisk(calls.network)).toBe("network");
    expect(classifyToolRisk(calls.remote)).toBe("remote");
    expect(classifyToolRisk(calls.state)).toBe("state-change");

    expect(checkToolPermission({ toolUse: calls.read, mode: "acceptEdits" })).toMatchObject({
      decision: "allow"
    });
    expect(checkToolPermission({ toolUse: calls.edit, mode: "acceptEdits" })).toMatchObject({
      decision: "allow"
    });
    expect(checkToolPermission({ toolUse: calls.destructive, mode: "acceptEdits" })).toMatchObject({
      decision: "ask"
    });
    expect(checkToolPermission({ toolUse: calls.network, mode: "acceptEdits" })).toMatchObject({
      decision: "ask"
    });
    expect(checkToolPermission({ toolUse: calls.remote, mode: "acceptEdits" })).toMatchObject({
      decision: "ask"
    });
    expect(checkToolPermission({ toolUse: calls.state, mode: "acceptEdits" })).toMatchObject({
      decision: "ask"
    });
  });

  it("persists large tool output with a preview", () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-registry-"));
    const formatted = formatToolResult({
      content: "x".repeat(31000),
      outputRoot: path.join(workspace, ".magi-next", "state", "tool-output"),
      maxChars: 30000,
      previewChars: 80
    });

    expect(formatted).toContain("Full output saved to:");
    const saved = /Full output saved to: (.+)$/.exec(formatted)?.[1];
    expect(saved).toBeTruthy();
    expect(existsSync(saved!)).toBe(true);
  });

  it("returns rich git status, diff, log, and show output", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-registry-git-"));
    initGitRepo(workspace);
    writeFileSync(path.join(workspace, "tracked.txt"), "alpha\nbeta\n", "utf8");
    git(workspace, ["add", "tracked.txt"]);
    git(workspace, ["commit", "-m", "initial commit"]);
    writeFileSync(path.join(workspace, "tracked.txt"), "alpha\nbeta changed\n", "utf8");
    writeFileSync(path.join(workspace, "new.txt"), "new file\n", "utf8");
    git(workspace, ["add", "new.txt"]);

    const status = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "git-status",
        name: "GitStatus",
        input: { branch: true }
      }
    });
    expect(status.isError).toBeUndefined();
    expect(status.content).toContain("##");
    expect(status.content).toContain(" M tracked.txt");
    expect(status.content).toContain("A  new.txt");

    const diff = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "git-diff",
        name: "GitDiff",
        input: { path: "tracked.txt", context: 0 }
      }
    });
    expect(diff.isError).toBeUndefined();
    expect(diff.content).toContain("diff --git");
    expect(diff.content).toContain("-beta");
    expect(diff.content).toContain("+beta changed");

    const staged = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "git-diff-staged",
        name: "GitDiff",
        input: { staged: true, name_only: true }
      }
    });
    expect(staged.content.trim()).toBe("new.txt");

    const log = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "git-log",
        name: "GitLog",
        input: { max_count: 1 }
      }
    });
    expect(log.isError).toBeUndefined();
    expect(log.content).toContain("initial commit");

    const show = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "git-show",
        name: "GitShow",
        input: { rev: "HEAD", stat: true }
      }
    });
    expect(show.isError).toBeUndefined();
    expect(show.content).toContain("initial commit");
    expect(show.content).toContain("tracked.txt");
  });

  it("creates, lists, checks out, stages, and unstages git branches and paths", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-registry-git-"));
    initGitRepo(workspace);
    writeFileSync(path.join(workspace, "tracked.txt"), "alpha\n", "utf8");
    git(workspace, ["add", "tracked.txt"]);
    git(workspace, ["commit", "-m", "initial commit"]);

    const created = await executeRegisteredTool({
      cwd: workspace,
      permissionMode: "bypassPermissions",
      toolUse: {
        type: "tool-use",
        id: "git-branch-create",
        name: "GitBranchCreate",
        input: { name: "feature/test-branch" }
      }
    });
    expect(created.isError).toBeUndefined();
    expect(created.content).toContain("Created branch feature/test-branch");

    const branches = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "git-branch-list",
        name: "GitBranchList",
        input: {}
      }
    });
    expect(branches.isError).toBeUndefined();
    expect(branches.content).toContain("feature/test-branch");

    const checkout = await executeRegisteredTool({
      cwd: workspace,
      permissionMode: "bypassPermissions",
      toolUse: {
        type: "tool-use",
        id: "git-checkout",
        name: "GitCheckout",
        input: { branch: "feature/test-branch" }
      }
    });
    expect(checkout.isError).toBeUndefined();
    expect(checkout.content).toContain("Checked out branch feature/test-branch");
    expect(gitOutput(workspace, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe(
      "feature/test-branch"
    );

    writeFileSync(path.join(workspace, "tracked.txt"), "alpha\nbeta\n", "utf8");
    writeFileSync(path.join(workspace, "new.txt"), "new\n", "utf8");
    const staged = await executeRegisteredTool({
      cwd: workspace,
      permissionMode: "bypassPermissions",
      toolUse: {
        type: "tool-use",
        id: "git-stage",
        name: "GitStage",
        input: { paths: ["tracked.txt", "new.txt"] }
      }
    });
    expect(staged.isError).toBeUndefined();
    expect(staged.content).toContain("Staged 2 paths");
    expect(gitOutput(workspace, ["diff", "--staged", "--name-only"])).toContain("tracked.txt");
    expect(gitOutput(workspace, ["diff", "--staged", "--name-only"])).toContain("new.txt");

    const unstaged = await executeRegisteredTool({
      cwd: workspace,
      permissionMode: "bypassPermissions",
      toolUse: {
        type: "tool-use",
        id: "git-unstage",
        name: "GitStage",
        input: { paths: ["new.txt"], mode: "unstage" }
      }
    });
    expect(unstaged.isError).toBeUndefined();
    expect(unstaged.content).toContain("Unstaged 1 path");
    expect(gitOutput(workspace, ["diff", "--staged", "--name-only"])).toContain("tracked.txt");
    expect(gitOutput(workspace, ["diff", "--staged", "--name-only"])).not.toContain("new.txt");
  });

  it("requires approval for git branch and staging mutations in default mode", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-registry-git-"));
    initGitRepo(workspace);
    writeFileSync(path.join(workspace, "tracked.txt"), "alpha\n", "utf8");

    const deniedBranch = await executeRegisteredTool({
      cwd: workspace,
      permissionMode: "default",
      toolUse: {
        type: "tool-use",
        id: "git-branch-denied",
        name: "GitBranchCreate",
        input: { name: "feature/needs-approval" }
      }
    });
    expect(deniedBranch).toMatchObject({
      isError: true,
      permission: { decision: "ask" }
    });
    expect(deniedBranch.content).toContain("Permission ask");

    const approvedStage = await executeRegisteredTool({
      cwd: workspace,
      permissionMode: "default",
      approvalResolver: () => true,
      toolUse: {
        type: "tool-use",
        id: "git-stage-approved",
        name: "GitStage",
        input: { paths: ["tracked.txt"] }
      }
    });
    expect(approvedStage.isError).toBeUndefined();
    expect(approvedStage.permission).toMatchObject({ decision: "ask" });
    expect(approvedStage.content).toContain("Staged 1 path");
  });

  it("handles git tool non-repository and path safety errors", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-registry-git-"));

    const nonRepo = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "git-status-nonrepo",
        name: "GitStatus",
        input: {}
      }
    });
    expect(nonRepo).toMatchObject({ isError: true });
    expect(nonRepo.content).toContain("not a git repository");

    initGitRepo(workspace);
    const outside = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "git-diff-outside",
        name: "GitDiff",
        input: { path: "../outside.txt" }
      }
    });
    expect(outside).toMatchObject({ isError: true });
    expect(outside.content).toContain("outside allowed directories");

    const badRev = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "git-show-bad-rev",
        name: "GitShow",
        input: { rev: "--help" }
      }
    });
    expect(badRev).toMatchObject({ isError: true });
    expect(badRev.content).toContain("simple revision");

    const badBranch = await executeRegisteredTool({
      cwd: workspace,
      permissionMode: "bypassPermissions",
      toolUse: {
        type: "tool-use",
        id: "git-branch-bad",
        name: "GitBranchCreate",
        input: { name: "../bad" }
      }
    });
    expect(badBranch).toMatchObject({ isError: true });
    expect(badBranch.content).toContain("unsafe characters");

    const stageOutside = await executeRegisteredTool({
      cwd: workspace,
      permissionMode: "bypassPermissions",
      toolUse: {
        type: "tool-use",
        id: "git-stage-outside",
        name: "GitStage",
        input: { paths: ["../outside.txt"] }
      }
    });
    expect(stageOutside).toMatchObject({ isError: true });
    expect(stageOutside.content).toContain("outside allowed directories");
  });

  it("executes read-only tools concurrently while preserving result order", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-registry-"));
    writeFileSync(path.join(workspace, "a.txt"), "alpha\n", "utf8");
    writeFileSync(path.join(workspace, "b.txt"), "beta\n", "utf8");

    const results = await executeRegisteredTools({
      cwd: workspace,
      toolUses: [
        { type: "tool-use", id: "read-a", name: "FileRead", input: { file_path: "a.txt" } },
        { type: "tool-use", id: "read-b", name: "FileRead", input: { file_path: "b.txt" } }
      ]
    });

    expect(results.map((result) => result.toolCallId)).toEqual(["read-a", "read-b"]);
    expect(results[0].content).toContain("alpha");
    expect(results[1].content).toContain("beta");
  });

  it("asks for approval before fetching non-allowlisted URLs", async () => {
    const result = await executeRegisteredTool({
      cwd: process.cwd(),
      toolUse: {
        type: "tool-use",
        id: "web-denied",
        name: "WebFetch",
        input: { url: "https://example.com", prompt: "summarize" }
      },
      permissionMode: "default",
      promptModel: async () => ({ text: "unused" })
    });

    expect(result).toMatchObject({
      isError: true,
      permission: { decision: "ask" }
    });
    expect(result.content).toContain("Permission ask");
  });

  it("fetches allowlisted web pages and summarizes them with the active model", async () => {
    const seenPrompts: string[] = [];
    server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        [
          "<!doctype html>",
          "<title>Alpha Status</title>",
          "<main>",
          "<h1>Alpha launch</h1>",
          "<p>The launch window is 09:30 UTC.</p>",
          "<script>ignore me</script>",
          "</main>"
        ].join("")
      );
    });
    const url = await listen(server);

    const result = await executeRegisteredTool({
      cwd: process.cwd(),
      toolUse: {
        type: "tool-use",
        id: "web-ok",
        name: "WebFetch",
        input: { url, prompt: "Extract the launch window." }
      },
      permissionMode: "default",
      env: { MAGI_WEBFETCH_ALLOWLIST: "127.0.0.1" },
      promptModel: async ({ messages }) => {
        seenPrompts.push(
          messages
            .map((message) =>
              message.content
                .map((part) => {
                  if (part.type === "text") return part.text;
                  if (part.type === "tool-result") return part.content;
                  if (part.type === "tool-use") return part.name;
                  return "";
                })
                .join("")
            )
            .join("\n")
        );
        return { text: "The launch window is 09:30 UTC." };
      }
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Title: Alpha Status");
    expect(result.content).toContain("The launch window is 09:30 UTC.");
    expect(seenPrompts[0]).toContain("Extract the launch window.");
    expect(seenPrompts[0]).toContain("Alpha launch");
    expect(seenPrompts[0]).not.toContain("ignore me");
  });

  it("searches configured HTTP JSON web search providers with domain filters", async () => {
    const seenRequests: string[] = [];
    server = http.createServer((request, response) => {
      seenRequests.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          results: [
            {
              title: "Global result",
              url: "https://global.example.com/magi-next/tools",
              snippet: "Global Tool documentation for Magi Next."
            },
            {
              title: "Magi Next tools",
              url: "https://docs.example.cn/magi-next/tools",
              snippet: "Magi Next 工具文档。"
            },
            {
              title: "Blocked result",
              url: "https://blocked.example.com/secret",
              snippet: "This should be filtered."
            },
            {
              title: "Other domain",
              url: "https://other.example.net/magi",
              snippet: "This should be filtered by allowed domains."
            }
          ]
        })
      );
    });
    const endpoint = await listen(server);

    const result = await executeRegisteredTool({
      cwd: process.cwd(),
      toolUse: {
        type: "tool-use",
        id: "web-search-ok",
        name: "WebSearch",
        input: {
          query: "magi next",
          allowed_domains: ["docs.example.cn", "global.example.com"],
          blocked_domains: ["blocked.example.com"],
          max_results: 5
        }
      },
      webSearchConfig: {
        provider: "http-json",
        endpoint,
        locale: "zh-CN",
        market: "CN",
        mainlandBoost: true,
        queryParam: "q",
        resultsPath: "results",
        titlePath: "title",
        urlPath: "url",
        snippetPath: "snippet",
        maxResults: 10
      }
    });

    expect(result.isError).toBeUndefined();
    expect(seenRequests[0]).toContain("q=magi+next");
    expect(seenRequests[0]).toContain("count=5");
    expect(seenRequests[0]).toContain("locale=zh-CN");
    expect(seenRequests[0]).toContain("market=CN");
    expect(result.content).toContain('WebSearch results for "magi next" (2)');
    expect(result.content).toContain("1. Magi Next tools");
    expect(result.content).toContain("https://docs.example.cn/magi-next/tools");
    expect(result.content).toContain("2. Global result");
    expect(result.content).not.toContain("blocked.example.com");
    expect(result.content).not.toContain("other.example.net");
  });

  it("rejects invalid WebSearch inputs and missing provider config", async () => {
    const invalidQuery = await executeRegisteredTool({
      cwd: process.cwd(),
      toolUse: {
        type: "tool-use",
        id: "web-search-short",
        name: "WebSearch",
        input: { query: "x" }
      },
      webSearchConfig: {
        provider: "http-json",
        endpoint: "https://search.example.invalid",
        locale: "zh-CN",
        market: "CN",
        mainlandBoost: true,
        queryParam: "q",
        resultsPath: "results",
        titlePath: "title",
        urlPath: "url",
        snippetPath: "snippet",
        maxResults: 10
      }
    });
    expect(invalidQuery).toMatchObject({ isError: true });
    expect(invalidQuery.content).toContain("query must be at least 2 characters");

    const invalidDomain = await executeRegisteredTool({
      cwd: process.cwd(),
      toolUse: {
        type: "tool-use",
        id: "web-search-domain",
        name: "WebSearch",
        input: { query: "magi next", allowed_domains: ["../bad"] }
      },
      webSearchConfig: {
        provider: "http-json",
        endpoint: "https://search.example.invalid",
        locale: "zh-CN",
        market: "CN",
        mainlandBoost: true,
        queryParam: "q",
        resultsPath: "results",
        titlePath: "title",
        urlPath: "url",
        snippetPath: "snippet",
        maxResults: 10
      }
    });
    expect(invalidDomain).toMatchObject({ isError: true });
    expect(invalidDomain.content).toContain(
      "allowed_domains.0 must be a domain or wildcard domain"
    );

    // When no config is provided, WebSearch silently falls back to WebBrowser (DuckDuckGo HTML).
    // The fallback may succeed or fail depending on network availability — we don't assert
    // on its outcome here, just that it returns a result (no thrown exception).
    const missingConfig = await executeRegisteredTool({
      cwd: process.cwd(),
      toolUse: {
        type: "tool-use",
        id: "web-search-missing-config",
        name: "WebSearch",
        input: { query: "magi next" }
      }
    });
    expect(missingConfig).toMatchObject({ toolName: "WebSearch" });
  });

  it("asks structured user questions through a resolver", async () => {
    const result = await executeRegisteredTool({
      cwd: process.cwd(),
      toolUse: {
        type: "tool-use",
        id: "ask-1",
        name: "AskUserQuestion",
        input: {
          questions: [
            {
              header: "Implementation path",
              question: "Which path should be used?",
              options: [
                { label: "A", description: "Use the direct implementation" },
                {
                  label: "B",
                  description: "Split into follow-up tasks",
                  preview: "Slower, more review points"
                }
              ]
            }
          ]
        }
      },
      userQuestionResolver: ({ toolUse, question }) => {
        expect(toolUse.id).toBe("ask-1");
        expect(question.questions[0].question).toBe("Which path should be used?");
        return {
          answers: [
            {
              question: question.questions[0].question,
              selectedLabels: ["A"],
              selectedOptions: [question.questions[0].options[0]]
            }
          ]
        };
      }
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("User answered AskUserQuestion");
    expect(result.content).toContain("- A: Use the direct implementation");
    expect(result.content).toContain('"selectedLabels"');
  });

  it("shows ExitPlanMode plans in the approval question before selection", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-plan-review-"));
    const stateRoot = path.join(workspace, ".magi-next", "state");
    const plan =
      "1. Inspect the current plan UI\n2. Show this plan before approval\n3. Verify with tests";
    const result = await executeRegisteredTool({
      cwd: workspace,
      stateRoot,
      sessionId: "session-plan-review",
      toolUse: {
        type: "tool-use",
        id: "exit-plan-1",
        name: "ExitPlanMode",
        input: { plan }
      },
      userQuestionResolver: ({ toolUse, question }) => {
        expect(toolUse.id).toBe("exit-plan-1");
        expect(question.questions[0].header).toBe("Plan review");
        expect(question.questions[0].preview).toContain("Implementation plan:");
        expect(question.questions[0].preview).toContain(plan);
        return {
          answers: [
            {
              question: question.questions[0].question,
              selectedLabels: ["Yes, proceed"],
              selectedOptions: [question.questions[0].options[0]]
            }
          ]
        };
      }
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Plan approved. Proceeding with implementation.");
    expect(result.content).toContain("Plan id:");
    expect(result.content).toContain(plan);

    const { listPlanReviews } = await import("../src/plan-state.js");
    expect(listPlanReviews(stateRoot, "session-plan-review")).toEqual([
      expect.objectContaining({
        status: "approved",
        toolUseId: "exit-plan-1",
        plan
      })
    ]);
  });

  it("persists ExitPlanMode revision feedback and a later approved revised plan", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-plan-revision-"));
    const stateRoot = path.join(workspace, ".magi-next", "state");
    const firstPlan = "1. Edit immediately\n2. Verify later";
    const revisedPlan = "1. Inspect first\n2. Apply the minimal edit\n3. Verify before final";

    const revision = await executeRegisteredTool({
      cwd: workspace,
      stateRoot,
      sessionId: "session-plan-revision",
      toolUse: {
        type: "tool-use",
        id: "exit-plan-revise",
        name: "ExitPlanMode",
        input: { plan: firstPlan }
      },
      userQuestionResolver: ({ question }) => ({
        answers: [
          {
            question: question.questions[0].question,
            selectedLabels: ["No, revise"],
            selectedOptions: [question.questions[0].options[1]]
          }
        ]
      })
    });
    expect(revision.isError).toBeUndefined();
    expect(revision.content).toContain("Plan not approved.");
    expect(revision.content).toContain("Stay in plan mode.");

    const approved = await executeRegisteredTool({
      cwd: workspace,
      stateRoot,
      sessionId: "session-plan-revision",
      toolUse: {
        type: "tool-use",
        id: "exit-plan-approved",
        name: "ExitPlanMode",
        input: { plan: revisedPlan }
      },
      userQuestionResolver: ({ question }) => ({
        answers: [
          {
            question: question.questions[0].question,
            selectedLabels: ["Yes, proceed"],
            selectedOptions: [question.questions[0].options[0]]
          }
        ]
      })
    });
    expect(approved.isError).toBeUndefined();
    expect(approved.content).toContain("Plan approved. Proceeding with implementation.");
    expect(approved.content).toContain(revisedPlan);

    const { listPlanReviews } = await import("../src/plan-state.js");
    expect(listPlanReviews(stateRoot, "session-plan-revision")).toEqual([
      expect.objectContaining({
        status: "approved",
        toolUseId: "exit-plan-approved",
        plan: revisedPlan,
        response: "Yes, proceed",
        revisesPlanId: expect.any(String),
        rootPlanId: expect.any(String)
      }),
      expect.objectContaining({
        status: "needs_revision",
        toolUseId: "exit-plan-revise",
        plan: firstPlan,
        response: "No, revise",
        revisedByPlanId: expect.any(String)
      })
    ]);
    const [approvedRecord, revisionRecord] = listPlanReviews(stateRoot, "session-plan-revision");
    expect(approvedRecord.revisesPlanId).toBe(revisionRecord.id);
    expect(approvedRecord.rootPlanId).toBe(revisionRecord.id);
    expect(revisionRecord.revisedByPlanId).toBe(approvedRecord.id);
  });

  it("rejects invalid AskUserQuestion shapes and answers", async () => {
    const invalidQuestion = await executeRegisteredTool({
      cwd: process.cwd(),
      toolUse: {
        type: "tool-use",
        id: "ask-invalid-shape",
        name: "AskUserQuestion",
        input: { questions: [] }
      },
      userQuestionResolver: () => ({ answers: [] })
    });
    expect(invalidQuestion).toMatchObject({ isError: true });
    expect(invalidQuestion.content).toContain("requires 1 to 4 questions");

    const invalidAnswer = await executeRegisteredTool({
      cwd: process.cwd(),
      toolUse: {
        type: "tool-use",
        id: "ask-invalid-answer",
        name: "AskUserQuestion",
        input: {
          questions: [
            {
              question: "Pick one",
              options: [
                { label: "A", description: "Alpha" },
                { label: "B", description: "Beta" }
              ]
            }
          ]
        }
      },
      userQuestionResolver: ({ question }) => ({
        answers: [
          {
            question: question.questions[0].question,
            selectedLabels: ["missing"],
            selectedOptions: []
          }
        ]
      })
    });
    expect(invalidAnswer).toMatchObject({ isError: true });
    expect(invalidAnswer.content).toContain("selected unknown option");
  });

  it("sends user messages through a sink and supports the Brief alias", async () => {
    const delivered: string[] = [];
    const result = await executeRegisteredTool({
      cwd: process.cwd(),
      toolUse: {
        type: "tool-use",
        id: "brief-1",
        name: "Brief",
        input: {
          message: "I need a decision before continuing.",
          attachments: ["notes.md"],
          status: "proactive"
        }
      },
      userMessageSink: ({ toolUse, message }) => {
        delivered.push(`${toolUse.name}:${message.status}:${message.message}`);
        return {
          delivered: true,
          channel: "test",
          deliveredAt: "2026-05-16T00:00:00.000Z"
        };
      }
    });

    expect(result.isError).toBeUndefined();
    expect(delivered).toEqual(["Brief:proactive:I need a decision before continuing."]);
    expect(result.content).toContain("channel: test");
    expect(result.content).toContain("attachments:\n- notes.md");
  });

  it("creates, lists, updates, and deletes durable cron jobs under the Magi state root", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-registry-"));
    const stateRoot = path.join(workspace, ".magi-next", "state");

    const created = await executeRegisteredTool({
      cwd: workspace,
      stateRoot,
      permissionMode: "bypassPermissions",
      toolUse: {
        type: "tool-use",
        id: "cron-create",
        name: "CronCreate",
        input: { cron: "*/15 * * * *", prompt: "run status", recurring: false, durable: true }
      }
    });
    expect(created.isError).toBeUndefined();
    expect(created.content).toContain("Created cron job");
    expect(created.content).toContain("cron: */15 * * * *");
    const cronFile = cronStorePathFromRoot(stateRoot);
    expect(existsSync(cronFile)).toBe(true);
    expect(cronFile).toContain(".magi-next");

    const id = /id: ([^\n]+)/.exec(created.content)?.[1];
    expect(id).toBeTruthy();

    const listed = await executeRegisteredTool({
      cwd: workspace,
      stateRoot,
      toolUse: { type: "tool-use", id: "cron-list", name: "CronList", input: {} }
    });
    expect(listed.content).toContain("prompt: run status");

    const updated = await executeRegisteredTool({
      cwd: workspace,
      stateRoot,
      permissionMode: "bypassPermissions",
      toolUse: {
        type: "tool-use",
        id: "cron-update",
        name: "CronUpdate",
        input: { id, cron: "30 9 * * 1", prompt: "weekly status", enabled: true }
      }
    });
    expect(updated.content).toContain("Updated cron job");
    expect(updated.content).toContain("prompt: weekly status");

    const deleted = await executeRegisteredTool({
      cwd: workspace,
      stateRoot,
      permissionMode: "bypassPermissions",
      toolUse: {
        type: "tool-use",
        id: "cron-delete",
        name: "CronDelete",
        input: { id }
      }
    });
    expect(deleted.content).toContain("Deleted cron job");

    const empty = await executeRegisteredTool({
      cwd: workspace,
      stateRoot,
      toolUse: { type: "tool-use", id: "cron-empty", name: "CronList", input: {} }
    });
    expect(empty.content).toBe("No cron jobs");
  });

  it("replaces validated session todos under the Magi state root", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-registry-"));
    const stateRoot = path.join(workspace, ".magi-next", "state");
    const sessionId = "todo-session";

    const first = await executeRegisteredTool({
      cwd: workspace,
      stateRoot,
      sessionId,
      permissionMode: "bypassPermissions",
      toolUse: {
        type: "tool-use",
        id: "todo-first",
        name: "TodoWrite",
        input: {
          todos: [
            {
              id: "inspect",
              content: "Inspect current tool patterns",
              status: "completed",
              priority: "high"
            },
            { id: "implement", content: "Implement TodoWrite state", status: "in_progress" }
          ]
        }
      }
    });

    expect(first.isError).toBeUndefined();
    expect(first.content).toContain("Todo list replaced (2 items)");
    expect(first.content).toContain("status: pending: 0, in_progress: 1, completed: 1");
    expect(first.content).toContain(
      "1. [completed] inspect priority=high - Inspect current tool patterns"
    );
    const stateFile = todoStorePathFromRoot(stateRoot);
    expect(existsSync(stateFile)).toBe(true);
    expect(stateFile).toContain(".magi-next");
    expect(loadTodoStore(stateFile).sessions[sessionId].todos).toHaveLength(2);

    const second = await executeRegisteredTool({
      cwd: workspace,
      stateRoot,
      sessionId,
      permissionMode: "bypassPermissions",
      toolUse: {
        type: "tool-use",
        id: "todo-second",
        name: "TodoWrite",
        input: {
          todos: [
            {
              id: "ship",
              content: "Ship TodoWrite with tests",
              status: "pending",
              priority: "medium"
            }
          ]
        }
      }
    });

    expect(second.content).toContain("changes: +1 ~0 -2");
    expect(loadTodoStore(stateFile).sessions[sessionId].todos).toEqual([
      { id: "ship", content: "Ship TodoWrite with tests", status: "pending", priority: "medium" }
    ]);
  });

  it("rejects invalid TodoWrite shapes and statuses", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-registry-"));
    const base = {
      cwd: workspace,
      stateRoot: path.join(workspace, ".magi-next", "state"),
      sessionId: "todo-session",
      permissionMode: "bypassPermissions" as const
    };

    const missingTodos = await executeRegisteredTool({
      ...base,
      toolUse: { type: "tool-use", id: "todo-missing", name: "TodoWrite", input: {} }
    });
    expect(missingTodos).toMatchObject({ isError: true });
    expect(missingTodos.content).toContain("Tool input todos must be an array");

    const badStatus = await executeRegisteredTool({
      ...base,
      toolUse: {
        type: "tool-use",
        id: "todo-bad-status",
        name: "TodoWrite",
        input: { todos: [{ id: "bad", content: "Bad state", status: "started" }] }
      }
    });
    expect(badStatus).toMatchObject({ isError: true });
    expect(badStatus.content).toContain("status must be pending, in_progress, or completed");

    const duplicateId = await executeRegisteredTool({
      ...base,
      toolUse: {
        type: "tool-use",
        id: "todo-duplicate",
        name: "TodoWrite",
        input: {
          todos: [
            { id: "same", content: "First", status: "pending" },
            { id: "same", content: "Second", status: "completed" }
          ]
        }
      }
    });
    expect(duplicateId).toMatchObject({ isError: true });
    expect(duplicateId.content).toContain("Todo id must be unique: same");

    const unknownField = await executeRegisteredTool({
      ...base,
      toolUse: {
        type: "tool-use",
        id: "todo-unknown-field",
        name: "TodoWrite",
        input: {
          todos: [{ id: "extra", content: "Extra field", status: "pending", owner: "agent" }]
        }
      }
    });
    expect(unknownField).toMatchObject({ isError: true });
    expect(unknownField.content).toContain("unknown field: owner");
  });

  it("searches and selects built-in tool documentation", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-registry-"));

    const search = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "tool-search",
        name: "ToolSearch",
        input: { query: "search workspace", max_results: 2 }
      }
    });
    expect(search.isError).toBeUndefined();
    expect(search.content).toContain("ToolSearch results");
    expect(search.content).toContain("Grep");
    expect(search.content).toContain("schema:");

    const selected = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "tool-select",
        name: "ToolSearch",
        input: { query: "select:FileRead" }
      }
    });
    expect(selected.content).toContain("Tool: FileRead");
    expect(selected.content).toContain('"file_path"');

    const missing = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "tool-missing",
        name: "ToolSearch",
        input: { query: "select:Nope" }
      }
    });
    expect(missing).toMatchObject({ isError: true });
    expect(missing.content).toContain("Tool not found: Nope");
  });

  it("lists deferred tools when ToolSearch query is capabilities", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-registry-"));

    const catalog = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "tool-capabilities",
        name: "ToolSearch",
        input: { query: "capabilities" }
      }
    });

    expect(catalog.isError).toBeUndefined();
    expect(catalog.content).toContain("Deferred tools discoverable via ToolSearch");
    expect(catalog.content).toContain("Browser");
    expect(catalog.content).not.toContain("WebFetch");
    expect(catalog.content).not.toMatch(/\bFileRead\b/);
  });

  it("ranks capability questions toward web and browser tools", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-registry-"));

    const result = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "tool-capability-search",
        name: "ToolSearch",
        input: { query: "can you search the web online", max_results: 3 }
      }
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("capability-inquiry");
    expect(["WebSearch", "WebBrowser"]).toContain(firstToolSearchResult(result.content));
  });

  it("ranks ToolSearch results by task intent", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-registry-"));
    const cases = [
      {
        query: "apply a multi-line patch to a file",
        top: "FilePatch",
        contains: ["FilePatch", "FileEdit"]
      },
      {
        query: "edit adjacent blocks with multiple hunks",
        top: "FilePatch",
        contains: ["FilePatch", "FileEdit"]
      },
      {
        query: "find TypeScript symbol references",
        top: "LSP",
        contains: ["LSP"]
      },
      {
        query: "remember this workflow for future sessions",
        top: "Memorize",
        contains: ["Memorize", "LearningDraft"]
      },
      {
        query: "automate browser click and screenshot",
        top: "Browser",
        contains: ["Browser"]
      },
      {
        query: "run focused verification tests",
        top: "VerifyPlanExecution",
        contains: ["VerifyPlanExecution"]
      }
    ];

    for (const item of cases) {
      const result = await executeRegisteredTool({
        cwd: workspace,
        toolUse: {
          type: "tool-use",
          id: `tool-rank-${item.top}`,
          name: "ToolSearch",
          input: { query: item.query, max_results: 5 }
        }
      });
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("intent:");
      expect(firstToolSearchResult(result.content)).toBe(item.top);
      for (const toolName of item.contains) {
        expect(result.content).toContain(toolName);
      }
    }
  });

  it("uses persisted tool feedback to refine ToolSearch ranking", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-registry-"));
    const stateRoot = path.join(workspace, ".magi-next", "state");

    for (let index = 0; index < 4; index += 1) {
      const failedGrep = await executeRegisteredTool({
        cwd: workspace,
        stateRoot,
        toolUse: {
          type: "tool-use",
          id: `grep-failure-${index}`,
          name: "Grep",
          input: { pattern: "needle", path: "../outside" }
        }
      });
      expect(failedGrep.isError).toBe(true);

      const globSuccess = await executeRegisteredTool({
        cwd: workspace,
        stateRoot,
        toolUse: {
          type: "tool-use",
          id: `glob-success-${index}`,
          name: "Glob",
          input: { pattern: "**/*.ts" }
        }
      });
      expect(globSuccess.isError).toBeUndefined();
    }

    const stats = loadToolUsageStats(stateRoot);
    expect(stats.tools.Grep).toMatchObject({
      attempts: 4,
      failures: 4,
      consecutiveFailures: 4,
      failureKinds: { path: 4 }
    });
    expect(stats.tools.Glob).toMatchObject({
      attempts: 4,
      successes: 4,
      consecutiveFailures: 0
    });
    expect(existsSync(toolUsageStatsPath(stateRoot))).toBe(true);

    const search = await executeRegisteredTool({
      cwd: workspace,
      stateRoot,
      toolUse: {
        type: "tool-use",
        id: "tool-search-feedback",
        name: "ToolSearch",
        input: { query: "search workspace files", max_results: 5 }
      }
    });
    expect(search.isError).toBeUndefined();
    expect(firstToolSearchResult(search.content)).toBe("Glob");
    expect(search.content).toContain("usage:+");
    expect(search.content).toContain("usage:-");
    expect(search.content).toContain("failure:path");
    expect(search.content).toContain(
      "recovery:path=use Glob for broad search or pass a workspace-relative path"
    );
  });

  it("uses task-intent tool feedback without letting unrelated usage dominate ranking", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-registry-"));
    const stateRoot = path.join(workspace, ".magi-next", "state");

    for (let index = 0; index < 8; index += 1) {
      recordToolUsage({
        stateRoot,
        toolName: "Grep",
        success: true,
        intents: ["web-research"]
      });
      recordToolUsage({
        stateRoot,
        toolName: "Glob",
        success: false,
        intents: ["web-research"]
      });
    }
    for (let index = 0; index < 4; index += 1) {
      recordToolUsage({
        stateRoot,
        toolName: "Grep",
        success: false,
        intents: ["workspace-search"],
        failureKind: "path"
      });
      recordToolUsage({
        stateRoot,
        toolName: "Glob",
        success: true,
        intents: ["workspace-search"]
      });
    }

    const stats = loadToolUsageStats(stateRoot);
    expect(stats.tools.Grep.intents["workspace-search"]).toMatchObject({
      failures: 4,
      consecutiveFailures: 4
    });
    expect(stats.tools.Grep.intents["web-research"]).toMatchObject({
      successes: 8,
      consecutiveFailures: 0
    });

    const search = await executeRegisteredTool({
      cwd: workspace,
      stateRoot,
      toolUse: {
        type: "tool-use",
        id: "tool-search-intent-feedback",
        name: "ToolSearch",
        input: { query: "search workspace files", max_results: 5 }
      }
    });

    expect(search.isError).toBeUndefined();
    expect(firstToolSearchResult(search.content)).toBe("Glob");
    expect(search.content).toContain("usage:+");
    expect(search.content).toContain("intent:workspace-search");
    expect(search.content).toContain("failure:path");
    expect(search.content).toContain(
      "recovery:path=use Glob for broad search or pass a workspace-relative path"
    );
  });

  it("diagnoses workspace manifests, scripts, languages, commands, and git state without executing commands", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-registry-diagnostics-"));
    initGitRepo(workspace);
    writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify(
        {
          name: "diagnostic-app",
          scripts: {
            test: "vitest run",
            build: "tsc -p tsconfig.json",
            verify: "npm run test && npm run build"
          },
          dependencies: { react: "^19.0.0" },
          devDependencies: { typescript: "^5.0.0", vitest: "^3.0.0" }
        },
        null,
        2
      ),
      "utf8"
    );
    writeFileSync(path.join(workspace, "package-lock.json"), "{}", "utf8");
    writeFileSync(path.join(workspace, "tsconfig.json"), "{}", "utf8");
    writeFileSync(path.join(workspace, "README.md"), "# Diagnostic App\n", "utf8");
    writeFileSync(path.join(workspace, "src.ts"), "export const value: number = 1;\n", "utf8");
    git(workspace, [
      "add",
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "README.md",
      "src.ts"
    ]);
    git(workspace, ["commit", "-m", "initial"]);
    writeFileSync(path.join(workspace, "src.ts"), "export const value: number = 2;\n", "utf8");

    const result = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "workspace-diagnostics",
        name: "WorkspaceDiagnostics",
        input: {}
      }
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Workspace Diagnostics");
    expect(result.content).toContain("package manager: npm");
    expect(result.content).toContain(
      "manifests: package.json, package-lock.json, tsconfig.json, README.md"
    );
    expect(result.content).toContain("languages: TypeScript (1)");
    expect(result.content).toContain("frameworks: React, TypeScript, Vitest");
    expect(result.content).toContain("- verify: npm run test && npm run build");
    expect(result.content).toContain("- npm run verify");
    expect(result.content).toContain("status:");
    expect(result.content).toContain("src.ts");
    expect(result.content).toContain("suggested commands were not executed");

    const json = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "workspace-diagnostics-json",
        name: "WorkspaceDiagnostics",
        input: { format: "json" }
      }
    });
    const parsed = JSON.parse(json.content) as {
      packageManager: string;
      suggestedCommands: string[];
    };
    expect(parsed.packageManager).toBe("npm");
    expect(parsed.suggestedCommands).toContain("npm run verify");
  });

  it("reads and updates allowlisted Magi Next config settings", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-registry-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: path.join(workspace, ".magi-next") });
    ensureMagiHome(paths);

    const read = await executeRegisteredTool({
      cwd: workspace,
      stateRoot: paths.stateRoot,
      toolUse: {
        type: "tool-use",
        id: "config-read",
        name: "Config",
        input: { setting: "context.recentMessages" }
      }
    });
    expect(read.content).toContain("Config context.recentMessages");
    expect(read.content).toContain("value: 6");

    const updated = await executeRegisteredTool({
      cwd: workspace,
      stateRoot: paths.stateRoot,
      permissionMode: "bypassPermissions",
      toolUse: {
        type: "tool-use",
        id: "config-update",
        name: "Config",
        input: { setting: "context.recentMessages", value: 9 }
      }
    });
    expect(updated.isError).toBeUndefined();
    expect(updated.content).toContain("Updated config context.recentMessages");

    const reread = await executeRegisteredTool({
      cwd: workspace,
      stateRoot: paths.stateRoot,
      toolUse: {
        type: "tool-use",
        id: "config-reread",
        name: "Config",
        input: { setting: "context.recentMessages" }
      }
    });
    expect(reread.content).toContain("value: 9");

    const invalid = await executeRegisteredTool({
      cwd: workspace,
      stateRoot: paths.stateRoot,
      permissionMode: "bypassPermissions",
      toolUse: {
        type: "tool-use",
        id: "config-invalid",
        name: "Config",
        input: { setting: "providers.main.apiKeyEnv", value: "MAGI_TOKEN" }
      }
    });
    expect(invalid).toMatchObject({ isError: true });
    expect(invalid.content).toContain("Unsupported config setting");
  });

  it("lists and loads skills from the Magi Next skills root", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-registry-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: path.join(workspace, ".magi-next") });
    ensureMagiHome(paths);
    const skillRoot = path.join(paths.skillsRoot, "commit-helper");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      path.join(skillRoot, "SKILL.md"),
      "# Commit Helper\n\nUse concise commit summaries.\n",
      "utf8"
    );

    const list = await executeRegisteredTool({
      cwd: workspace,
      stateRoot: paths.stateRoot,
      toolUse: {
        type: "tool-use",
        id: "skill-list",
        name: "Skill",
        input: {}
      }
    });
    expect(list.content).toContain("commit-helper");
    expect(list.content).toContain("Commit Helper");

    const selected = await executeRegisteredTool({
      cwd: workspace,
      stateRoot: paths.stateRoot,
      toolUse: {
        type: "tool-use",
        id: "skill-select",
        name: "Skill",
        input: { skill: "commit-helper", args: "staged changes" }
      }
    });
    expect(selected.content).toContain("Skill: commit-helper");
    expect(selected.content).toContain("Args: staged changes");
    expect(selected.content).toContain("Use concise commit summaries.");

    const traversal = await executeRegisteredTool({
      cwd: workspace,
      stateRoot: paths.stateRoot,
      toolUse: {
        type: "tool-use",
        id: "skill-traversal",
        name: "Skill",
        input: { skill: "../outside" }
      }
    });
    expect(traversal).toMatchObject({ isError: true });
    expect(traversal.content).toContain("Skill not found");
  });

  it("answers TypeScript LSP definition, reference, hover, and symbol queries", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-registry-"));
    writeFileSync(
      path.join(workspace, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true
        }
      }),
      "utf8"
    );
    mkdirSync(path.join(workspace, "src"));
    writeFileSync(
      path.join(workspace, "src", "math.ts"),
      [
        "export function addValue(left: number, right: number): number {",
        "  return left + right;",
        "}",
        "",
        "export const scaleFactor = 2;",
        "",
        "export interface Calculator {",
        "  compute(value: number): number;",
        "}",
        "",
        "export class Doubler implements Calculator {",
        "  compute(value: number): number {",
        "    return addValue(value, value);",
        "  }",
        "}",
        "",
        "export function runPipeline(input: number): number {",
        "  const calculator = new Doubler();",
        "  return calculator.compute(input);",
        "}"
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      path.join(workspace, "src", "use.ts"),
      [
        "import { addValue, runPipeline, scaleFactor } from './math.js';",
        "",
        "export const total = addValue(scaleFactor, 3);",
        "export function consumePipeline(): number {",
        "  return runPipeline(total);",
        "}"
      ].join("\n"),
      "utf8"
    );

    const definition = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "lsp-definition",
        name: "LSP",
        input: { action: "goToDefinition", filePath: "src/use.ts", line: 3, character: 31 }
      }
    });
    expect(definition.isError).toBeUndefined();
    expect(definition.content).toContain("Definitions: 1 result");
    expect(definition.content).toContain("src/math.ts:5:14");
    expect(definition.content).toContain("export const scaleFactor = 2;");

    const references = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "lsp-references",
        name: "LSP",
        input: { action: "findReferences", file_path: "src/use.ts", line: 3, character: 31 }
      }
    });
    expect(references.content).toContain("References:");
    expect(references.content).toContain("src/math.ts:5:14");
    expect(references.content).toContain("src/use.ts:1:33");
    expect(references.content).toContain("src/use.ts:3:31");

    const hover = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "lsp-hover",
        name: "LSP",
        input: { action: "hover", filePath: "src/use.ts", line: 3, character: 31 }
      }
    });
    expect(hover.content).toContain("const scaleFactor: 2");

    const documentSymbol = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "lsp-doc-symbol",
        name: "LSP",
        input: { action: "documentSymbol", filePath: "src/math.ts" }
      }
    });
    expect(documentSymbol.content).toContain("function addValue");
    expect(documentSymbol.content).toContain("const scaleFactor");
    expect(documentSymbol.content).toContain("class Doubler");

    const workspaceSymbol = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "lsp-workspace-symbol",
        name: "LSP",
        input: { action: "workspaceSymbol", query: "total", max_results: 10 }
      }
    });
    expect(workspaceSymbol.content).toContain("src/use.ts:3:14 const total");

    const implementation = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "lsp-implementation",
        name: "LSP",
        input: { action: "goToImplementation", filePath: "src/math.ts", line: 8, character: 3 }
      }
    });
    expect(implementation.isError).toBeUndefined();
    expect(implementation.content).toContain("Implementations: 1 result");
    expect(implementation.content).toContain("src/math.ts:12:3");
    expect(implementation.content).toContain("compute(value: number): number {");

    const prepared = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "lsp-call-prepare",
        name: "LSP",
        input: { action: "prepareCallHierarchy", filePath: "src/math.ts", line: 17, character: 17 }
      }
    });
    expect(prepared.content).toContain("Call hierarchy items: 1 result");
    expect(prepared.content).toContain("src/math.ts:17:17 function runPipeline");

    const incoming = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "lsp-incoming",
        name: "LSP",
        input: { action: "incomingCalls", filePath: "src/math.ts", line: 17, character: 17 }
      }
    });
    expect(incoming.content).toContain("Incoming calls: 1 result");
    expect(incoming.content).toContain("from src/use.ts:4:17 function consumePipeline");
    expect(incoming.content).toContain("at src/use.ts:5:10");

    const outgoing = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "lsp-outgoing",
        name: "LSP",
        input: { action: "outgoingCalls", filePath: "src/math.ts", line: 17, character: 17 }
      }
    });
    expect(outgoing.content).toContain("Outgoing calls:");
    expect(outgoing.content).toContain("to src/math.ts:11:14 class Doubler");
    expect(outgoing.content).toContain("to src/math.ts:12:3 method compute");
    expect(outgoing.content).toContain("from src/math.ts:18:26");
    expect(outgoing.content).toContain("from src/math.ts:19:10");

    const outside = await executeRegisteredTool({
      cwd: workspace,
      toolUse: {
        type: "tool-use",
        id: "lsp-outside",
        name: "LSP",
        input: { action: "documentSymbol", filePath: "../outside.ts" }
      }
    });
    expect(outside).toMatchObject({ isError: true });
    expect(outside.content).toContain("outside allowed directories");
  }, 30_000);
});

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
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

function gitOutput(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10_000
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function firstToolSearchResult(output: string): string | undefined {
  return output.match(/^1\. (\S+)/m)?.[1];
}
