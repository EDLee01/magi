import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { runCli } from "../src/cli.js";
import { registry } from "../src/commands/registry.js";
import {
  formatModelPicker,
  formatSessionSearch,
  formatSlashSuggestions,
  parseSlashCommand,
  runSlashCommand
} from "../src/slash.js";
import {
  buildTuiTranscriptState,
  buildModelPickerItems,
  buildPermissionModePickerItems,
  buildSessionPickerItems,
  colorizeDiffLine,
  createTerminalUserQuestionResolver,
  formatTuiStartupBanner,
  formatSessionResume,
  formatTuiTranscriptStatus,
  formatTuiLiveEvent,
  MAGI_TEXT_HAT,
  initialTuiPermissionMode,
  pickInteractiveSession,
  startInteractiveGoalCommand,
  installRunningInterruptKeys,
  startTuiLiveEventWriter
} from "../src/tui.js";
import { ActiveInteractionRegistry } from "../src/interactions.js";
import { getMagiPaths } from "../src/paths.js";
import { SessionStore } from "../src/session-store.js";
import { MagiConfig } from "../src/config.js";
import {
  addPermissionRule,
  clearPermissionRules,
  isToolAlwaysAllowed
} from "../src/permissions.js";
import { getGoal } from "../src/goal.js";
import { parsePermissionMode } from "../src/commands/permissions.js";
import { shellDisplayName } from "../src/platform/shell.js";

function stripAnsi(str: string | undefined): string | undefined {
  if (str === undefined) return undefined;
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function createTtyInput(): NodeJS.ReadStream {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = (mode: boolean) => {
    stdin.isRaw = mode;
    return stdin;
  };
  return stdin;
}
import { toEventView } from "../src/events.js";
import { makeTempRoot, TempRoot } from "./helpers.js";

let temp: TempRoot | undefined;
let workspace: string | undefined;

const WEB_SEARCH_CONFIG = {
  locale: "zh-CN",
  market: "CN",
  mainlandBoost: true,
  queryParam: "q",
  resultsPath: "results",
  titlePath: "title",
  urlPath: "url",
  snippetPath: "snippet",
  maxResults: 10
};

afterEach(() => {
  clearPermissionRules();
  temp?.cleanup();
  temp = undefined;
  if (workspace) {
    rmSync(workspace, { recursive: true, force: true });
    workspace = undefined;
  }
});

describe("TUI, slash commands, and session resume", () => {
  it("parses slash commands", () => {
    expect(parseSlashCommand("/help")).toEqual({ type: "help" });
    expect(parseSlashCommand("/model fast")).toEqual({ type: "model", alias: "fast" });
    expect(parseSlashCommand("/resume abc")).toEqual({ type: "resume", sessionId: "abc" });
    expect(parseSlashCommand("/review")).toEqual({ type: "review" });
    expect(parseSlashCommand("plain text")).toBeUndefined();
  });

  it("formats text hat and slash suggestions", () => {
    expect(MAGI_TEXT_HAT).toContain("△");
    expect(MAGI_TEXT_HAT).toContain("✦");
    expect(formatSlashSuggestions("/res")).toContain("/resume");
    expect(formatSlashSuggestions("/res")).toContain("Search and resume");
    expect(formatSlashSuggestions("/missing-command")).toContain("No slash commands match");
  });

  it("formats startup banner with version, cwd, and model", () => {
    const banner =
      stripAnsi(
        formatTuiStartupBanner({
          cwd: "/repo",
          modelDisplay: "openai:gpt-5.5",
          version: "1.2.3"
        })
      ) ?? "";

    expect(banner).toContain("Magi v1.2.3");
    expect(banner).not.toContain("tools");
    expect(banner).toContain("cwd: /repo");
    expect(banner).toContain("model: openai:gpt-5.5");
  });

  it("runs slash status and session commands", () => {
    temp = makeTempRoot();
    const store = SessionStore.open(getMagiPaths(temp.env));
    try {
      store.createSession({ id: "session-1", title: "one", cwd: process.cwd() });
      store.recordAudit({
        sessionId: "session-1",
        action: "agent.tool.completed",
        target: "GitStatus",
        metadata: { toolCallId: "git-status-tui" }
      });
      store.recordAudit({
        sessionId: "session-1",
        jobId: "job-pending-tui",
        action: "agent.approval.pending",
        target: "FileWrite",
        metadata: {
          status: "pending",
          interactionKind: "approval",
          toolUseId: "approval-tui"
        }
      });
      const config: MagiConfig = {
        version: "0.1",
        control: { bind: "127.0.0.1", port: 8765 },
        providers: {},
        models: { aliases: { fast: "main:gpt-fast" }, fallbacks: {} },
        mcp: { servers: {} },
        hooks: [],
        context: { recentMessages: 6 },
        memory: {
          enabled: true,
          autoWrite: "explicit" as const,
          maxResults: 8,
          scopes: ["user" as const, "project" as const, "session" as const],
          dream: { enabled: false, intervalMs: 86400000 }
        },
        webSearch: WEB_SEARCH_CONFIG
      };

      expect(
        runSlashCommand({ command: { type: "status" }, config, store, cwd: "/repo" })
      ).toContain("aliases: fast");
      expect(
        runSlashCommand({
          command: { type: "status" },
          config,
          store,
          cwd: "/repo",
          sessionId: "session-1",
          currentModel: "fast"
        })
      ).toContain("model: fast (main:gpt-fast)");
      expect(
        runSlashCommand({ command: { type: "status" }, config, store, cwd: "/repo" })
      ).toContain("tool completed git-status-tui");
      expect(
        runSlashCommand({ command: { type: "status" }, config, store, cwd: "/repo" })
      ).toContain("Pending interactions:");
      expect(
        runSlashCommand({ command: { type: "status" }, config, store, cwd: "/repo" })
      ).toContain("approval approval-tui");
      expect(
        runSlashCommand({ command: { type: "sessions" }, config, store, cwd: "/repo" })
      ).toContain("session-1");
      expect(
        runSlashCommand({ command: { type: "model", alias: "fast" }, config, store, cwd: "/repo" })
      ).toContain("Selected model fast: main:gpt-fast");
      expect(
        runSlashCommand({ command: { type: "model", alias: "1" }, config, store, cwd: "/repo" })
      ).toContain("Selected model fast");
      expect(
        runSlashCommand({
          command: { type: "model" },
          config,
          store,
          cwd: "/repo",
          currentModel: "fast"
        })
      ).toContain("Model picker:");
      expect(
        runSlashCommand({ command: { type: "review" }, config, store, cwd: "/repo" })
      ).toContain("Review route");
      expect(
        runSlashCommand({ command: { type: "resume" }, config, store, cwd: "/repo" })
      ).toContain("Resume sessions:");
      expect(
        runSlashCommand({
          command: { type: "resume", sessionId: "1" },
          config,
          store,
          cwd: "/repo"
        })
      ).toContain("Resumed session-1");
      expect(
        runSlashCommand({
          command: { type: "unknown", name: "context" },
          config,
          store,
          cwd: "/repo",
          sessionId: "session-1"
        })
      ).toContain("estimatedTokens:");
      expect(
        registry.dispatch("permissions", [], {
          cwd: "/repo",
          config,
          store,
          permissionMode: "bypassPermissions"
        })
      ).toContain("Permission mode: Full Access");
      expect(
        registry.dispatch("permissions", ["mode"], {
          cwd: "/repo",
          config,
          store,
          permissionMode: "acceptEdits"
        })
      ).toContain("> Accept Edits");
      expect(
        registry.dispatch("permissions", ["mode", "plan"], {
          cwd: "/repo",
          config,
          store,
          permissionMode: "default"
        })
      ).toContain("Permissions updated to Plan");
      expect(
        registry.dispatch("permissions", ["mode", "Full", "Access"], {
          cwd: "/repo",
          config,
          store,
          permissionMode: "default"
        })
      ).toBe("Permissions updated to Full Access");
      expect(formatSessionSearch(store, "one")).toContain("session-");
      expect(formatSessionResume(store, "session-1")).toContain("approval approval-tui");
      expect(formatSessionResume(store, "session-1")).toContain("Transcript:");
      expect(formatModelPicker(config, "fast")).toContain(">  1 fast");
    } finally {
      store.close();
    }
  });

  it("builds interactive picker items for models and sessions", () => {
    temp = makeTempRoot();
    const store = SessionStore.open(getMagiPaths(temp.env));
    try {
      store.createSession({ id: "session-newer", title: "newer", cwd: "/repo/new" });
      store.createSession({ id: "session-older", title: "older", cwd: "/repo/old" });
      const config: MagiConfig = {
        version: "0.1",
        control: { bind: "127.0.0.1", port: 8765 },
        providers: {},
        models: {
          aliases: { fast: "main:gpt-fast", main: "main:gpt-main" },
          fallbacks: {},
          router: {
            coding: {
              family: "gpt",
              contextWindow: 128000,
              supportsVision: false,
              specialty: "coding",
              priority: 1
            }
          }
        },
        mcp: { servers: {} },
        hooks: [],
        context: { recentMessages: 6 },
        memory: {
          enabled: true,
          autoWrite: "explicit" as const,
          maxResults: 8,
          scopes: ["user" as const, "project" as const, "session" as const],
          dream: { enabled: false, intervalMs: 86400000 }
        },
        webSearch: WEB_SEARCH_CONFIG
      };

      expect(buildModelPickerItems(config, "fast")).toMatchObject([
        { label: "auto", value: "auto", description: "smart routing" },
        { label: "fast", value: "fast", description: "main:gpt-fast", detail: "current" },
        { label: "main", value: "main", description: "main:gpt-main" }
      ]);
      const sessionItems = buildSessionPickerItems(store);
      expect(sessionItems.map((item) => item.value)).toEqual(
        expect.arrayContaining(["session-newer", "session-older"])
      );
      expect(sessionItems.find((item) => item.value === "session-newer")?.detail).toContain(
        "/repo/new"
      );
      expect(buildPermissionModePickerItems("bypassPermissions")).toContainEqual(
        expect.objectContaining({
          label: "Full Access",
          value: "bypassPermissions",
          description: `skip prompts; dangerous ${shellDisplayName()} needs explicit env approval`,
          detail: "current · bypassPermissions"
        })
      );
      expect(buildPermissionModePickerItems("bypassPermissions")).toContainEqual(
        expect.objectContaining({
          label: "Don't Ask",
          value: "dontAsk",
          description: "deny non-read-only tools instead of asking",
          detail: "dontAsk"
        })
      );
    } finally {
      store.close();
    }
  });

  it("accepts user-facing aliases for full access permission mode", () => {
    expect(parsePermissionMode("Full Access")).toBe("bypassPermissions");
    expect(parsePermissionMode("fullAccess")).toBe("bypassPermissions");
    expect(parsePermissionMode("yolo")).toBe("bypassPermissions");
  });

  it("initializes interactive TUI permission mode from CLI input", () => {
    expect(initialTuiPermissionMode("bypassPermissions")).toBe("bypassPermissions");
    expect(initialTuiPermissionMode("acceptEdits")).toBe("acceptEdits");
    expect(initialTuiPermissionMode()).toBe("default");
  });

  it("opens the interactive resume picker with an initial search query", async () => {
    temp = makeTempRoot();
    const store = SessionStore.open(getMagiPaths(temp.env));
    try {
      store.createSession({ id: "session-parser", title: "fix parser", cwd: "/repo/parser" });
      store.createSession({ id: "session-auth", title: "review auth target", cwd: "/repo/auth" });
      const input = createTtyInput();
      const chunks: string[] = [];
      const output = new PassThrough() as unknown as NodeJS.WriteStream;
      output.isTTY = true;
      output.columns = 80;
      output.write = ((chunk: string | Uint8Array) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
        return true;
      }) as NodeJS.WriteStream["write"];

      const picker = pickInteractiveSession({
        input,
        output,
        store,
        initialFilter: "auth"
      });
      input.write("\r");

      await expect(picker).resolves.toBe("session-auth");
      expect(stripAnsi(chunks.join(""))).toContain("matching auth");
      expect(stripAnsi(chunks.join(""))).toContain("review auth target");
    } finally {
      store.close();
    }
  });

  it("discovers and runs extended slash command coverage", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "magi-slash-coverage-"));
    workspace = workspaceRoot;
    writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "slash coverage rules\n", "utf8");
    const pluginRoot = path.join(paths.pluginsRoot, "demo.plugin");
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(
      path.join(pluginRoot, "plugin.json"),
      JSON.stringify({
        schemaVersion: "0.1",
        name: "demo.plugin",
        version: "0.1.0",
        permissions: ["files.read"]
      }),
      "utf8"
    );
    const skillRoot = path.join(paths.skillsRoot, "review-helper");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(path.join(skillRoot, "SKILL.md"), "# Review Helper\n\nUse for review.\n", "utf8");
    const store = SessionStore.open(paths);
    try {
      const config: MagiConfig = {
        version: "0.1",
        control: { bind: "127.0.0.1", port: 8765 },
        providers: {},
        models: { aliases: { main: "openai:gpt-test" }, fallbacks: {} },
        mcp: { servers: {} },
        hooks: [],
        context: { recentMessages: 6 },
        memory: {
          enabled: true,
          autoWrite: "explicit" as const,
          maxResults: 8,
          scopes: ["user" as const, "project" as const, "session" as const],
          dream: { enabled: false, intervalMs: 86400000 }
        },
        webSearch: WEB_SEARCH_CONFIG
      };

      const required = [
        "resume",
        "sessions",
        "status",
        "model",
        "context",
        "compact",
        "memory",
        "rules",
        "review",
        "run",
        "diff",
        "mcp",
        "plugins",
        "skill",
        "agents",
        "help"
      ];
      for (const name of required) {
        expect(registry.get(name), name).toBeDefined();
      }
      expect(registry.get("skills")?.name).toBe("skill");
      expect(registry.get("runner")?.name).toBe("run");

      const help = registry.dispatch("help", [], {
        cwd: workspaceRoot,
        config,
        store,
        paths
      }) as string;
      expect(help).toContain("Context:");
      expect(help).toContain("/context");
      expect(help).toContain("Extensions:");
      expect(help).toContain("/plugins");
      expect(help).toContain("Agents:");
      expect(help).toContain("/agents");
      expect(help).toContain("Tools:");
      expect(help).toContain("/run");

      expect(
        registry.dispatch("rules", [], {
          cwd: workspaceRoot,
          config,
          store,
          paths
        })
      ).toContain("slash coverage rules");
      expect(
        registry.dispatch("plugins", [], {
          cwd: workspaceRoot,
          config,
          store,
          paths
        })
      ).toContain("demo.plugin");
      expect(
        registry.dispatch("skills", [], {
          cwd: workspaceRoot,
          config,
          store,
          paths
        })
      ).toContain("review-helper");
      expect(
        registry.dispatch("run", [], {
          cwd: workspaceRoot,
          config,
          store,
          paths
        })
      ).toContain("magi runner run");
    } finally {
      store.close();
    }
  });

  it("starts an interactive goal and returns the objective as the next prompt", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    const store = SessionStore.open(paths);
    try {
      const first = startInteractiveGoalCommand({
        paths,
        store,
        sessionId: undefined,
        cwd: "/repo",
        args: ["finish", "goal", "business", "tests"]
      });

      expect(first.message).toBe("Goal started: finish goal business tests");
      expect(first.prompt).toBe("finish goal business tests");
      expect(first.sessionId).toBeTruthy();
      expect(getGoal(paths, first.sessionId!)?.objective).toBe("finish goal business tests");

      const second = startInteractiveGoalCommand({
        paths,
        store,
        sessionId: first.sessionId,
        cwd: "/repo",
        args: ["finish", "the", "next", "goal"]
      });

      expect(second.sessionId).toBe(first.sessionId);
      expect(second.prompt).toBe("finish the next goal");
      expect(getGoal(paths, first.sessionId!)?.objective).toBe("finish the next goal");
    } finally {
      store.close();
    }
  });

  it("formats live TUI events for visible agent activity", () => {
    temp = makeTempRoot();
    const store = SessionStore.open(getMagiPaths(temp.env));
    try {
      const sessionId = store.createSession({
        id: "live-format-session",
        title: "live",
        cwd: process.cwd()
      });
      const toolUse = store.recordAudit({
        sessionId,
        jobId: "job-live-format",
        action: "agent.tool.use",
        target: "FileRead",
        metadata: { id: "read-live" }
      });
      const approval = store.recordAudit({
        sessionId,
        jobId: "job-live-format",
        action: "agent.approval.pending",
        target: "FileWrite",
        metadata: { toolUseId: "write-live" }
      });
      const fallback = store.recordAudit({
        sessionId,
        jobId: "job-live-format",
        action: "agent.provider.fallback",
        target: "backup",
        metadata: { fromProvider: "main", toProvider: "backup" }
      });
      const retry = store.recordAudit({
        sessionId,
        jobId: "job-live-format",
        action: "agent.provider.retry",
        target: "main",
        metadata: {
          providerName: "main",
          model: "mock-main",
          errorKind: "server-error",
          attempt: 1,
          maxAttempts: 3,
          nextRetryDelayMs: 1000
        }
      });
      const toolContext = store.recordAudit({
        sessionId,
        jobId: "job-live-format",
        action: "agent.tool_context.reported",
        target: "tools",
        metadata: { toolCount: 18, deferredToolCount: 64, estimatedSchemaTokens: 2100 }
      });
      const localTool = store.recordAudit({
        sessionId,
        jobId: "job-live-format",
        action: "tool.shell.run",
        target: "pwd",
        metadata: { exitCode: 0 }
      });
      const textDelta = store.recordAudit({
        sessionId,
        jobId: "job-live-format",
        action: "agent.text.delta",
        target: "main",
        metadata: { length: 3, preview: "abc" }
      });

      expect(formatTuiLiveEvent(toEventView(toolUse))).toBeUndefined();
      expect(stripAnsi(formatTuiLiveEvent(toEventView(toolUse), { showToolTrace: true }))).toBe(
        "· [tool] FileRead requested (read-live)"
      );
      expect(stripAnsi(formatTuiLiveEvent(toEventView(approval)))).toBe(
        "⏳ [approval] waiting for FileWrite (write-live)"
      );
      expect(stripAnsi(formatTuiLiveEvent(toEventView(fallback)))).toBe(
        "· [fallback] main -> backup"
      );
      expect(formatTuiLiveEvent(toEventView(retry))).toBeUndefined();
      expect(stripAnsi(formatTuiLiveEvent(toEventView(retry), { showToolTrace: true }))).toBe(
        "· [fallback] retry main/mock-main - attempt 1/3, next 1000ms, error: server-error"
      );
      expect(stripAnsi(formatTuiLiveEvent(toEventView(toolContext)))).toBe(
        "· [tools] 18 exposed - ~2100 schema tokens, 64 deferred"
      );
      expect(formatTuiLiveEvent(toEventView(localTool))).toBeUndefined();
      expect(stripAnsi(formatTuiLiveEvent(toEventView(localTool), { showToolTrace: true }))).toBe(
        "· [tool] Bash completed exit=0"
      );
      expect(formatTuiLiveEvent(toEventView(textDelta))).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("builds a transcript/status view from durable audit events", () => {
    temp = makeTempRoot();
    const store = SessionStore.open(getMagiPaths(temp.env));
    try {
      const sessionId = store.createSession({
        id: "transcript-session",
        title: "transcript",
        cwd: process.cwd()
      });
      store.recordAudit({
        sessionId,
        jobId: "job-transcript",
        action: "agent.query.started",
        target: "main",
        metadata: {}
      });
      store.recordAudit({
        sessionId,
        jobId: "job-transcript",
        action: "agent.approval.pending",
        target: "FileWrite",
        metadata: {
          status: "pending",
          interactionKind: "approval",
          toolUseId: "approval-transcript",
          reason: "FileWrite requires approval"
        }
      });
      store.recordAudit({
        sessionId,
        jobId: "job-transcript",
        action: "agent.tool.completed",
        target: "GitStatus",
        metadata: { toolCallId: "git-transcript" }
      });
      store.recordAudit({
        sessionId,
        jobId: "job-transcript-cancel",
        action: "agent.query.cancelled",
        target: "main",
        metadata: { reason: "operator stop" }
      });

      const state = buildTuiTranscriptState(
        store.listSessionAuditEvents(sessionId, 20).map(toEventView),
        {
          sessionId,
          limit: 10
        }
      );
      const formatted = formatTuiTranscriptStatus(state);

      expect(state.pending).toHaveLength(1);
      expect(formatted).toContain("Transcript:");
      expect(formatted).toContain("pending: 1");
      expect(formatted).toContain("approval approval-transcript");
      expect(formatted).toContain("GitStatus completed");
      expect(formatted).toContain("query     cancelled");
    } finally {
      store.close();
    }
  });

  it("streams live TUI events for the active session and stops cleanly", () => {
    temp = makeTempRoot();
    const store = SessionStore.open(getMagiPaths(temp.env));
    const output: string[] = [];
    try {
      const firstSession = store.createSession({
        id: "live-session-1",
        title: "one",
        cwd: process.cwd()
      });
      const secondSession = store.createSession({
        id: "live-session-2",
        title: "two",
        cwd: process.cwd()
      });
      const writer = startTuiLiveEventWriter({
        store,
        sessionId: firstSession,
        output: {
          write: (chunk: unknown) => {
            output.push(String(chunk));
            return true;
          }
        }
      });

      store.recordAudit({
        sessionId: secondSession,
        jobId: "job-other",
        action: "agent.tool.completed",
        target: "GitStatus",
        metadata: { toolCallId: "other-tool" }
      });
      store.recordAudit({
        sessionId: firstSession,
        jobId: "job-current",
        action: "agent.tool.completed",
        target: "GitDiff",
        metadata: { toolCallId: "current-tool" }
      });
      writer.stop();
      store.recordAudit({
        sessionId: firstSession,
        jobId: "job-current",
        action: "agent.todo.updated",
        target: firstSession,
        metadata: { todoCount: 1 }
      });

      expect(writer.getSessionId()).toBe(firstSession);
      expect(output.join("")).not.toContain("[tool]");
      expect(output.join("")).not.toContain("GitStatus");
      expect(output.join("")).not.toContain("[todo]");
    } finally {
      store.close();
    }
  });

  it("shows live tool trace events when tool debug mode is enabled", () => {
    temp = makeTempRoot();
    const store = SessionStore.open(getMagiPaths(temp.env));
    const output: string[] = [];
    try {
      const sessionId = store.createSession({
        id: "live-debug-session",
        title: "debug",
        cwd: process.cwd()
      });
      const writer = startTuiLiveEventWriter({
        store,
        env: { MAGI_DEBUG_TOOLS: "1" },
        sessionId,
        output: {
          write: (chunk: unknown) => {
            output.push(String(chunk));
            return true;
          }
        }
      });

      store.recordAudit({
        sessionId,
        jobId: "job-live-debug",
        action: "agent.tool.completed",
        target: "GitDiff",
        metadata: { toolCallId: "debug-tool" }
      });
      writer.stop();

      expect(stripAnsi(output.join(""))).toContain("[tool] GitDiff completed (debug-tool)");
    } finally {
      store.close();
    }
  });

  it("resolves pending approvals through the live TUI interaction path", async () => {
    temp = makeTempRoot();
    const store = SessionStore.open(getMagiPaths(temp.env));
    const interactions = new ActiveInteractionRegistry({ timeoutMs: 5_000 });
    const output: string[] = [];
    const prompts: string[] = [];
    try {
      const sessionId = store.createSession({
        id: "approval-tui-session",
        title: "approval",
        cwd: process.cwd()
      });
      const wait = interactions.waitForApproval({
        sessionId,
        jobId: "job-approval-tui",
        toolUse: {
          type: "tool-use",
          id: "approve-terminal",
          name: "ApprovalTestTool",
          input: { file_path: "x.txt", content: "x" }
        },
        reason: "ApprovalTestTool requires approval"
      });
      const writer = startTuiLiveEventWriter({
        store,
        sessionId,
        interactions,
        rl: {
          question: async (prompt: string) => {
            prompts.push(prompt);
            return "yes";
          }
        },
        output: {
          write: (chunk: unknown) => {
            output.push(String(chunk));
            return true;
          }
        }
      });

      store.recordAudit({
        sessionId,
        jobId: "job-approval-tui",
        action: "agent.approval.pending",
        target: "ApprovalTestTool",
        metadata: {
          status: "pending",
          interactionKind: "approval",
          toolUseId: "approve-terminal",
          toolUse: { id: "approve-terminal", name: "ApprovalTestTool" },
          reason: "ApprovalTestTool requires approval"
        }
      });

      await expect(wait).resolves.toBe(true);
      writer.stop();

      expect(stripAnsi(output.join(""))).toContain(
        "[approval] waiting for ApprovalTestTool (approve-terminal)"
      );
      expect(output.join("")).toContain("Approval required");
      expect(prompts).toEqual(["approve? [y/n/a] "]);
    } finally {
      interactions.close();
      store.close();
    }
  });

  it("shows Bash approval details without honoring a global always-allow action", async () => {
    temp = makeTempRoot();
    clearPermissionRules();
    addPermissionRule("Bash", "stale global Bash allow");
    const store = SessionStore.open(getMagiPaths(temp.env));
    const interactions = new ActiveInteractionRegistry({ timeoutMs: 5_000 });
    const output: string[] = [];
    const prompts: string[] = [];
    try {
      const sessionId = store.createSession({
        id: "bash-approval-session",
        title: "bash approval",
        cwd: "/repo"
      });
      const wait = interactions.waitForApproval({
        sessionId,
        jobId: "job-bash-approval",
        toolUse: {
          type: "tool-use",
          id: "bash-approval",
          name: "Bash",
          input: { command: "npm test", timeout_ms: 12_000 }
        },
        reason: "Bash requires approval"
      });
      const writer = startTuiLiveEventWriter({
        store,
        sessionId,
        interactions,
        rl: {
          question: async (prompt: string) => {
            prompts.push(prompt);
            return "n";
          }
        },
        output: {
          write: (chunk: unknown) => {
            output.push(String(chunk));
            return true;
          }
        }
      });

      store.recordAudit({
        sessionId,
        jobId: "job-bash-approval",
        action: "agent.approval.pending",
        target: "Bash",
        metadata: {
          status: "pending",
          interactionKind: "approval",
          toolUseId: "bash-approval",
          toolUse: {
            type: "tool-use",
            id: "bash-approval",
            name: "Bash",
            input: { command: "npm test", timeout_ms: 12_000 }
          },
          reason: "Bash requires approval",
          cwd: "/repo"
        }
      });

      await expect(wait).resolves.toBe(false);
      writer.stop();

      const visible = stripAnsi(output.join("")) ?? "";
      expect(visible).toContain("Approval required");
      expect(visible).toContain("tool: Bash");
      expect(visible).toContain("command: npm test");
      expect(visible).toContain("cwd: /repo");
      expect(visible).toContain("timeout_ms: 12000");
      expect(visible).toContain("Choose: [y]es / [n]o");
      expect(visible).not.toContain("always allow");
      expect(visible).not.toContain("Always allow");
      expect(prompts).toEqual(["approve? [y/n] "]);
    } finally {
      interactions.close();
      store.close();
    }
  });

  it("resolves pending approvals through the TUI approval picker hotkeys", async () => {
    temp = makeTempRoot();
    clearPermissionRules();
    const store = SessionStore.open(getMagiPaths(temp.env));
    const interactions = new ActiveInteractionRegistry({ timeoutMs: 5_000 });
    const output: string[] = [];
    const stdin = createTtyInput();
    try {
      const sessionId = store.createSession({
        id: "approval-picker-session",
        title: "approval picker",
        cwd: process.cwd()
      });
      const wait = interactions.waitForApproval({
        sessionId,
        jobId: "job-approval-picker",
        toolUse: {
          type: "tool-use",
          id: "approve-picker",
          name: "ApprovalPickerTool",
          input: { file_path: "x.txt", content: "x" }
        },
        reason: "ApprovalPickerTool requires approval"
      });
      const writer = startTuiLiveEventWriter({
        store,
        sessionId,
        interactions,
        stdin,
        rl: {
          question: async () => {
            throw new Error("approval picker should not use readline question");
          }
        },
        output: {
          write: (chunk: unknown) => {
            output.push(String(chunk));
            return true;
          }
        }
      });

      store.recordAudit({
        sessionId,
        jobId: "job-approval-picker",
        action: "agent.approval.pending",
        target: "ApprovalPickerTool",
        metadata: {
          status: "pending",
          interactionKind: "approval",
          toolUseId: "approve-picker",
          reason: "ApprovalPickerTool requires approval",
          diff: "--- a/x.txt\n+++ b/x.txt\n@@\n-old\n+new"
        }
      });
      stdin.write("y");

      await expect(wait).resolves.toBe(true);
      writer.stop();

      const visible = stripAnsi(output.join("")) ?? "";
      expect(visible).toContain("Approval required");
      expect(visible).toContain("Diff preview:");
      expect(visible).toContain("approval required");
      expect(visible).toContain("Allow");
      expect(visible).toContain("Deny");
      expect(visible).not.toContain("approve? [y/n/a]");
    } finally {
      interactions.close();
      store.close();
    }
  });

  it("denies approval picker requests on Escape", async () => {
    temp = makeTempRoot();
    clearPermissionRules();
    const store = SessionStore.open(getMagiPaths(temp.env));
    const interactions = new ActiveInteractionRegistry({ timeoutMs: 5_000 });
    const stdin = createTtyInput();
    try {
      const sessionId = store.createSession({
        id: "approval-picker-deny-session",
        title: "approval picker deny",
        cwd: process.cwd()
      });
      const wait = interactions.waitForApproval({
        sessionId,
        jobId: "job-approval-picker-deny",
        toolUse: {
          type: "tool-use",
          id: "approve-picker-deny",
          name: "ApprovalPickerDenyTool",
          input: {}
        },
        reason: "ApprovalPickerDenyTool requires approval"
      });
      const writer = startTuiLiveEventWriter({
        store,
        sessionId,
        interactions,
        stdin,
        rl: {
          question: async () => {
            throw new Error("approval picker should not use readline question");
          }
        },
        output: {
          write: () => true
        }
      });

      store.recordAudit({
        sessionId,
        jobId: "job-approval-picker-deny",
        action: "agent.approval.pending",
        target: "ApprovalPickerDenyTool",
        metadata: {
          status: "pending",
          interactionKind: "approval",
          toolUseId: "approve-picker-deny"
        }
      });
      stdin.write("\x1b");

      await expect(wait).resolves.toBe(false);
      writer.stop();
    } finally {
      interactions.close();
      store.close();
    }
  });

  it("adds persistent permission rules from the approval picker", async () => {
    temp = makeTempRoot();
    clearPermissionRules();
    const store = SessionStore.open(getMagiPaths(temp.env));
    const interactions = new ActiveInteractionRegistry({ timeoutMs: 5_000 });
    const stdin = createTtyInput();
    try {
      const sessionId = store.createSession({
        id: "approval-picker-always-session",
        title: "approval picker always",
        cwd: process.cwd()
      });
      const wait = interactions.waitForApproval({
        sessionId,
        jobId: "job-approval-picker-always",
        toolUse: {
          type: "tool-use",
          id: "approve-picker-always",
          name: "ApprovalPickerAlwaysTool",
          input: {}
        },
        reason: "ApprovalPickerAlwaysTool requires approval"
      });
      const writer = startTuiLiveEventWriter({
        store,
        sessionId,
        interactions,
        stdin,
        rl: {
          question: async () => {
            throw new Error("approval picker should not use readline question");
          }
        },
        output: {
          write: () => true
        }
      });

      store.recordAudit({
        sessionId,
        jobId: "job-approval-picker-always",
        action: "agent.approval.pending",
        target: "ApprovalPickerAlwaysTool",
        metadata: {
          status: "pending",
          interactionKind: "approval",
          toolUseId: "approve-picker-always"
        }
      });
      stdin.write("a");

      await expect(wait).resolves.toBe(true);
      expect(isToolAlwaysAllowed("ApprovalPickerAlwaysTool")).toBe(true);
      writer.stop();
    } finally {
      interactions.close();
      store.close();
    }
  });

  it("does not treat approval Escape as a global running interrupt", async () => {
    const stdin = createTtyInput();
    const output: string[] = [];
    const controller = new AbortController();
    const interactions = new ActiveInteractionRegistry({ timeoutMs: 5_000 });
    interactions.registerJob({ sessionId: "session-esc", jobId: "job-esc" });
    const wait = interactions.waitForApproval({
      sessionId: "session-esc",
      jobId: "job-esc",
      toolUse: {
        type: "tool-use",
        id: "approve-esc",
        name: "FileWrite",
        input: {}
      },
      reason: "FileWrite requires approval"
    });
    const stop = installRunningInterruptKeys(
      controller,
      stdin,
      {
        write: (chunk: unknown) => {
          output.push(String(chunk));
          return true;
        }
      } as NodeJS.WriteStream,
      { activeInteractions: interactions }
    );

    stdin.write("\x1b");

    expect(controller.signal.aborted).toBe(false);
    interactions.resolveApproval({ jobId: "job-esc", toolUseId: "approve-esc", approved: false });
    await expect(wait).resolves.toBe(false);
    stop();
    interactions.close();
    expect(output.join("")).not.toContain("Interrupting");
  });

  it("still treats Ctrl+C as a global running interrupt during approval", () => {
    const stdin = createTtyInput();
    const controller = new AbortController();
    const interactions = new ActiveInteractionRegistry({ timeoutMs: 5_000 });
    interactions.registerJob({ sessionId: "session-ctrl-c", jobId: "job-ctrl-c" });
    void interactions
      .waitForApproval({
        sessionId: "session-ctrl-c",
        jobId: "job-ctrl-c",
        toolUse: {
          type: "tool-use",
          id: "approve-ctrl-c",
          name: "FileWrite",
          input: {}
        },
        reason: "FileWrite requires approval"
      })
      .catch(() => undefined);
    const stop = installRunningInterruptKeys(
      controller,
      stdin,
      { write: () => true } as unknown as NodeJS.WriteStream,
      { activeInteractions: interactions }
    );

    stdin.write("\x03");

    expect(controller.signal.aborted).toBe(true);
    stop();
    interactions.close();
  });

  it("resolves pending questions through the live TUI interaction path", async () => {
    temp = makeTempRoot();
    const store = SessionStore.open(getMagiPaths(temp.env));
    const interactions = new ActiveInteractionRegistry({ timeoutMs: 5_000 });
    const output: string[] = [];
    const prompts: string[] = [];
    try {
      const sessionId = store.createSession({
        id: "question-tui-session",
        title: "question",
        cwd: process.cwd()
      });
      const question = {
        questions: [
          {
            question: "Choose lane",
            preview: "Review this rollout plan before choosing.",
            options: [
              { label: "canary", description: "Small rollout" },
              { label: "stable", description: "Broad rollout" }
            ]
          }
        ]
      };
      const wait = interactions.waitForQuestion({
        sessionId,
        jobId: "job-question-tui",
        toolUse: {
          type: "tool-use",
          id: "ask-terminal",
          name: "AskUserQuestion",
          input: { questions: question.questions }
        },
        question
      });
      const writer = startTuiLiveEventWriter({
        store,
        sessionId,
        interactions,
        rl: {
          question: async (prompt: string) => {
            prompts.push(prompt);
            return "2";
          }
        },
        output: {
          write: (chunk: unknown) => {
            output.push(String(chunk));
            return true;
          }
        }
      });

      store.recordAudit({
        sessionId,
        jobId: "job-question-tui",
        action: "agent.user_question.pending",
        target: "AskUserQuestion",
        metadata: {
          status: "pending",
          interactionKind: "question",
          toolUseId: "ask-terminal",
          questionCount: 1,
          question
        }
      });

      await expect(wait).resolves.toMatchObject({
        answers: [
          {
            selectedLabels: ["stable"]
          }
        ]
      });
      writer.stop();

      expect(stripAnsi(output.join(""))).toContain(
        "[question] waiting for answer (1) (ask-terminal)"
      );
      expect(output.join("")).toContain("Choose lane");
      expect(output.join("")).toContain("Review this rollout plan before choosing.");
      expect(prompts).toEqual(["? "]);
    } finally {
      interactions.close();
      store.close();
    }
  });

  it("locks live TUI events to the first new session when no session is active", () => {
    temp = makeTempRoot();
    const store = SessionStore.open(getMagiPaths(temp.env));
    const output: string[] = [];
    try {
      const firstSession = store.createSession({
        id: "live-new-1",
        title: "one",
        cwd: process.cwd()
      });
      const secondSession = store.createSession({
        id: "live-new-2",
        title: "two",
        cwd: process.cwd()
      });
      const writer = startTuiLiveEventWriter({
        store,
        output: {
          write: (chunk: unknown) => {
            output.push(String(chunk));
            return true;
          }
        }
      });

      store.recordAudit({
        sessionId: firstSession,
        jobId: "job-new",
        action: "agent.tool.completed",
        target: "Bash",
        metadata: { toolCallId: "bash-123" }
      });
      store.recordAudit({
        sessionId: secondSession,
        jobId: "job-other",
        action: "agent.tool.completed",
        target: "GitShow",
        metadata: { toolCallId: "wrong-session" }
      });
      writer.stop();

      expect(writer.getSessionId()).toBe(firstSession);
      expect(output.join("")).not.toContain("[tool]");
      expect(output.join("")).not.toContain("GitShow");
    } finally {
      store.close();
    }
  });

  it("reads memory through slash command using configured paths", () => {
    temp = makeTempRoot();
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-tui-memory-"));
    const store = SessionStore.open(getMagiPaths(temp.env));
    try {
      const config = {
        version: "0.1",
        control: { bind: "127.0.0.1", port: 8765 },
        providers: {},
        models: { aliases: {}, fallbacks: {} },
        mcp: { servers: {} },
        hooks: [],
        context: { recentMessages: 6 },
        memory: {
          enabled: true,
          autoWrite: "explicit" as const,
          maxResults: 8,
          scopes: ["user" as const, "project" as const, "session" as const],
          dream: { enabled: false, intervalMs: 86400000 }
        },
        webSearch: WEB_SEARCH_CONFIG
      };
      const output = runSlashCommand({
        command: { type: "memory", scope: "project" },
        config,
        store,
        cwd: workspace,
        paths: getMagiPaths(temp.env)
      });
      expect(output).toContain("No project memory");
    } finally {
      store.close();
    }
  });

  it("lists and resumes sessions from CLI", async () => {
    temp = makeTempRoot();
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-tui-session-"));
    const create = await runCli(
      ["--verbose", "-p", 'create file "note.txt" with content "session text"'],
      temp.env,
      workspace
    );
    expect(create.exitCode).toBe(0);
    const id = /sessionId: ([^\n]+)/.exec(create.stdout)?.[1];
    expect(id).toBeTruthy();

    const list = await runCli(["sessions"], temp.env, process.cwd());
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain(id!);

    const resume = await runCli(["resume", id!], temp.env, process.cwd());
    expect(resume.exitCode).toBe(0);
    expect(resume.stdout).toContain(`sessionId: ${id}`);
    expect(resume.stdout).toContain("user:");
    expect(resume.stdout).toContain("assistant:");
  });

  it("reports non-TTY interactive usage clearly", async () => {
    temp = makeTempRoot();
    const result = await runCli([], temp.env, process.cwd());
    expect(result.exitCode).toBe(2);
  });

  it("resolves AskUserQuestion selections from terminal input", async () => {
    const prompts: string[] = [];
    const output: string[] = [];
    const answers = ["9", "1,2"];
    const resolver = createTerminalUserQuestionResolver(
      {
        question: async (prompt: string) => {
          prompts.push(prompt);
          return answers.shift() ?? "";
        }
      },
      {
        write: (chunk: unknown) => {
          output.push(String(chunk));
          return true;
        }
      }
    );

    const result = await resolver({
      toolUse: {
        type: "tool-use",
        id: "ask-terminal",
        name: "AskUserQuestion",
        input: {}
      },
      question: {
        questions: [
          {
            header: "Scope",
            question: "Which scopes should run?",
            multiSelect: true,
            options: [
              { label: "type", description: "Run type check" },
              { label: "test", description: "Run tests" }
            ]
          }
        ]
      }
    });

    expect(prompts).toEqual(["? ", "? "]);
    expect(output.join("")).toContain("Option must be a number from 1 to 2");
    expect(result.answers[0].selectedLabels).toEqual(["type", "test"]);
  });
});

it("colorizeDiffLine applies ANSI colors to diff lines", () => {
  expect(colorizeDiffLine("--- a/foo.ts")).toContain("\x1b[36m");
  expect(colorizeDiffLine("+++ b/foo.ts")).toContain("\x1b[36m");
  expect(colorizeDiffLine("+added line")).toContain("\x1b[32m");
  expect(colorizeDiffLine("-removed line")).toContain("\x1b[31m");
  expect(colorizeDiffLine("@@ -1,3 +1,4 @@")).toContain("\x1b[90m");
  expect(colorizeDiffLine(" context line")).toBe(" context line");
});

it("generates diff preview for FileWrite approval in registry", async () => {
  workspace = mkdtempSync(path.join(os.tmpdir(), "magi-diff-approval-"));
  const existingFile = path.join(workspace, "hello.ts");
  writeFileSync(existingFile, "const x = 1;\n", "utf8");

  const { checkToolPermission } = await import("../src/tools/registry.js");
  const permission = checkToolPermission({
    toolUse: {
      type: "tool-use",
      id: "fw-1",
      name: "FileWrite",
      input: { file_path: "hello.ts", content: "const x = 2;\n" }
    },
    mode: "default",
    env: {}
  });

  expect(permission.decision).toBe("ask");
  // diff is generated in executeRegisteredTool, not checkToolPermission
  // so we test the full execution path
  const { executeRegisteredTool } = await import("../src/tools/registry.js");
  let capturedDiff: string | undefined;
  await executeRegisteredTool({
    cwd: workspace,
    toolUse: {
      type: "tool-use",
      id: "fw-2",
      name: "FileWrite",
      input: { file_path: "hello.ts", content: "const x = 2;\n" }
    },
    permissionMode: "default",
    approvalResolver: async ({ permission }) => {
      capturedDiff = permission.diff;
      return true;
    }
  });

  expect(capturedDiff).toBeDefined();
  expect(capturedDiff).toContain("-const x = 1;");
  expect(capturedDiff).toContain("+const x = 2;");
});

it("generates diff preview for FileEdit approval in registry", async () => {
  workspace = mkdtempSync(path.join(os.tmpdir(), "magi-diff-edit-"));
  const existingFile = path.join(workspace, "edit.ts");
  writeFileSync(existingFile, "const a = 1;\nconst b = 2;\n", "utf8");

  const { executeRegisteredTool } = await import("../src/tools/registry.js");
  let capturedDiff: string | undefined;
  await executeRegisteredTool({
    cwd: workspace,
    toolUse: {
      type: "tool-use",
      id: "fe-1",
      name: "FileEdit",
      input: { file_path: "edit.ts", old_string: "const a = 1;", new_string: "const a = 99;" }
    },
    permissionMode: "default",
    approvalResolver: async ({ permission }) => {
      capturedDiff = permission.diff;
      return true;
    }
  });

  expect(capturedDiff).toBeDefined();
  expect(capturedDiff).toContain("-const a = 1;");
  expect(capturedDiff).toContain("+const a = 99;");
});

it("generates diff preview for FilePatch approval in registry", async () => {
  workspace = mkdtempSync(path.join(os.tmpdir(), "magi-diff-patch-"));
  const existingFile = path.join(workspace, "patch.ts");
  writeFileSync(existingFile, "const a = 1;\nconst b = 2;\n", "utf8");

  const { executeRegisteredTool } = await import("../src/tools/registry.js");
  let capturedDiff: string | undefined;
  await executeRegisteredTool({
    cwd: workspace,
    toolUse: {
      type: "tool-use",
      id: "fp-1",
      name: "FilePatch",
      input: {
        file_path: "patch.ts",
        patch: ["@@", " const a = 1;", "-const b = 2;", "+const b = 22;"].join("\n")
      }
    },
    permissionMode: "default",
    approvalResolver: async ({ permission }) => {
      capturedDiff = permission.diff;
      return true;
    }
  });

  expect(capturedDiff).toBeDefined();
  expect(capturedDiff).toContain("-const b = 2;");
  expect(capturedDiff).toContain("+const b = 22;");
});

it("passes diff through approval chain to audit metadata", async () => {
  workspace = mkdtempSync(path.join(os.tmpdir(), "magi-diff-chain-"));
  writeFileSync(path.join(workspace, "chain.ts"), "old content\n", "utf8");

  const { SessionStore } = await import("../src/session-store.js");
  const { QueryEngine } = await import("../src/agent/query-engine.js");
  const { textMessage } = await import("../src/providers/ir.js");
  const store = new SessionStore(path.join(workspace, "sessions.sqlite"));
  try {
    const sessionId = store.createSession({ title: "diff chain", cwd: workspace });
    let callCount = 0;
    const adapter = {
      name: "diff-chain",
      complete: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            text: "",
            toolUses: [
              {
                type: "tool-use" as const,
                id: "fw-chain",
                name: "FileWrite",
                input: { file_path: "chain.ts", content: "new content\n" }
              }
            ]
          };
        }
        return { text: "done" };
      }
    };
    const engine = new QueryEngine({
      store,
      sessionId,
      cwd: workspace,
      routes: [{ providerName: "p", model: "m", adapter }],
      permissionMode: "default"
    });

    await engine.submitMessage("update file");

    const audits = store.listAuditEvents(50);
    const approvalRequested = audits.find((e) => e.action === "agent.approval.requested");
    expect(approvalRequested).toBeDefined();
    expect(approvalRequested?.target).toBe("FileWrite");
  } finally {
    store.close();
  }
});
