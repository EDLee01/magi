import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { QueryEngine } from "../src/agent/query-engine.js";
import { AgentQueryEvent, runAgentQuery } from "../src/agent/query.js";
import { ActiveInteractionRegistry } from "../src/interactions.js";
import { messageText, ProviderAdapter, textMessage } from "../src/providers/ir.js";
import { ProviderError } from "../src/providers/errors.js";
import { SessionStore } from "../src/session-store.js";
import { appendMemory, readMemory } from "../src/memory.js";
import { appendMemoryFile } from "../src/memory-files.js";
import { MemoryNodeStore } from "../src/memory-node-store.js";
import { writeMemdirEntry } from "../src/memdir.js";
import { loadTodoStore, todoStorePathFromRoot } from "../src/tools/todo.js";
import { ensureMagiHome, getMagiPaths } from "../src/paths.js";
import { createGoal, updateGoalStatus } from "../src/goal.js";
import { clearPermissionRules } from "../src/permissions.js";

let workspace: string | undefined;
let server: http.Server | undefined;
let permissionRoot: string | undefined;
let previousConfigDir: string | undefined;

beforeEach(() => {
  previousConfigDir = process.env.MAGI_CONFIG_DIR;
  permissionRoot = mkdtempSync(path.join(os.tmpdir(), "magi-query-permissions-"));
  process.env.MAGI_CONFIG_DIR = permissionRoot;
  clearPermissionRules();
});

afterEach(async () => {
  if (server) {
    await closeServer(server);
    server = undefined;
  }
  clearPermissionRules();
  if (previousConfigDir === undefined) {
    delete process.env.MAGI_CONFIG_DIR;
  } else {
    process.env.MAGI_CONFIG_DIR = previousConfigDir;
  }
  previousConfigDir = undefined;
  if (permissionRoot) {
    rmSync(permissionRoot, { recursive: true, force: true });
    permissionRoot = undefined;
  }
  if (workspace) {
    rmSync(workspace, { recursive: true, force: true });
    workspace = undefined;
  }
});

describe("agent query loop", () => {
  it("executes provider tool_use results and loops until final text", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const calls: string[] = [];
    const adapter: ProviderAdapter = {
      name: "test-provider",
      complete: async (request) => {
        calls.push(request.messages.map((message) => message.role).join(","));
        if (calls.length === 1) {
          expect(request.tools?.map((tool) => tool.name)).toContain("FileWrite");
          return {
            text: "",
            toolUses: [
              {
                type: "tool-use",
                id: "tool-1",
                name: "FileWrite",
                input: { file_path: "loop.txt", content: "created by query loop" }
              }
            ]
          };
        }
        expect(request.messages.at(-1)).toMatchObject({
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "tool-1" }]
        });
        return { text: "done after tool" };
      }
    };

    const events: AgentQueryEvent[] = [];
    for await (const event of runAgentQuery({
      adapter,
      model: "explicit-test-model",
      messages: [textMessage("user", "create loop.txt")],
      cwd: workspace,
      maxTurns: 4,
      permissionMode: "acceptEdits"
    })) {
      events.push(event);
    }

    expect(calls).toHaveLength(2);
    expect(events.map((event) => event.type)).toContain("tool_result");
    expect(events.at(-1)).toMatchObject({ type: "done", text: "done after tool" });
    await expect(readFile(path.join(workspace, "loop.txt"), "utf8")).resolves.toBe(
      "created by query loop"
    );
  });

  it("defaults write tools to approval-required instead of acceptEdits", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const adapter: ProviderAdapter = {
      name: "test-provider",
      complete: async (request) =>
        request.messages.some((message) => message.role === "tool")
          ? { text: "default write was not applied" }
          : {
              text: "",
              toolUses: [
                {
                  type: "tool-use",
                  id: "default-write",
                  name: "FileWrite",
                  input: { file_path: "default-denied.txt", content: "no" }
                }
              ]
            }
    };

    const result = await collectResult(
      runAgentQuery({
        adapter,
        model: "explicit-test-model",
        messages: [textMessage("user", "try default write")],
        cwd: workspace
      })
    );

    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "approval_request",
        reason: "FileWrite requires approval"
      })
    );
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        toolCallId: "default-write",
        toolName: "FileWrite",
        isError: true,
        content: expect.stringContaining("Permission ask: FileWrite requires approval")
      })
    );
    expect(result.final.text).toBe("default write was not applied");
    await expect(readFile(path.join(workspace, "default-denied.txt"), "utf8")).rejects.toThrow();
  });

  it("denies write tools in plan permission mode and returns the denial to the model", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const adapter: ProviderAdapter = {
      name: "test-provider",
      complete: async (request) =>
        request.messages.some((message) => message.role === "tool")
          ? { text: "write was denied" }
          : {
              text: "",
              toolUses: [
                {
                  type: "tool-use",
                  id: "tool-1",
                  name: "FileWrite",
                  input: { file_path: "denied.txt", content: "no" }
                }
              ]
            }
    };

    const result = await collectResult(
      runAgentQuery({
        adapter,
        model: "explicit-test-model",
        messages: [textMessage("user", "try to write")],
        cwd: workspace,
        permissionMode: "plan"
      })
    );

    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        isError: true
      })
    );
    expect(result.final.text).toBe("write was denied");
    await expect(readFile(path.join(workspace, "denied.txt"), "utf8")).rejects.toThrow();
  });

  it("enforces allow-listed tools before execution even when the model requests a hidden tool", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const exposedToolNames: string[][] = [];
    const adapter: ProviderAdapter = {
      name: "tool-policy-provider",
      complete: async (request) => {
        exposedToolNames.push(request.tools?.map((tool) => tool.name) ?? []);
        return request.messages.some((message) => message.role === "tool")
          ? { text: "blocked write observed" }
          : {
              text: "",
              toolUses: [
                {
                  type: "tool-use",
                  id: "policy-write",
                  name: "FileWrite",
                  input: { file_path: "policy-denied.txt", content: "no" }
                }
              ]
            };
      }
    };

    const result = await collectResult(
      runAgentQuery({
        adapter,
        model: "explicit-test-model",
        messages: [textMessage("user", "try to write with read-only tools")],
        cwd: workspace,
        env: { MAGI_TOOL_LOAD: "minimal" },
        permissionMode: "acceptEdits",
        toolRules: {
          allow: ["FileRead(*)", "Glob(*)", "Grep(*)", "ToolSearch(*)", "WorkspaceDiagnostics(*)"],
          ask: [],
          deny: []
        }
      })
    );

    expect(exposedToolNames[0]).toContain("FileRead");
    expect(exposedToolNames[0]).not.toContain("FileWrite");
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        toolCallId: "policy-write",
        toolName: "FileWrite",
        isError: true,
        content: expect.stringContaining("Permission deny: FileWrite is not in allowed tools")
      })
    );
    await expect(readFile(path.join(workspace, "policy-denied.txt"), "utf8")).rejects.toThrow();
  });

  it("filters ToolSearch candidates through the same tool allow-list", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const adapter: ProviderAdapter = {
      name: "tool-search-policy-provider",
      complete: async (request) =>
        request.messages.some((message) => message.role === "tool")
          ? { text: "tool search policy observed" }
          : {
              text: "",
              toolUses: [
                {
                  type: "tool-use",
                  id: "policy-search",
                  name: "ToolSearch",
                  input: { query: "select:FileWrite" }
                }
              ]
            }
    };

    const result = await collectResult(
      runAgentQuery({
        adapter,
        model: "explicit-test-model",
        messages: [textMessage("user", "search hidden write tool")],
        cwd: workspace,
        toolRules: {
          allow: ["FileRead(*)", "ToolSearch(*)"],
          ask: [],
          deny: []
        }
      })
    );

    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        toolCallId: "policy-search",
        toolName: "ToolSearch",
        isError: true,
        content: expect.stringContaining("Tool not found: FileWrite")
      })
    );
    expect(result.final.text).toBe("tool search policy observed");
  });

  it("allows scoped shell command families such as Bash(git:*)", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    spawnSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    const adapter: ProviderAdapter = {
      name: "tool-policy-bash-provider",
      complete: async (request) =>
        request.messages.some((message) => message.role === "tool")
          ? { text: "scoped shell observed" }
          : {
              text: "",
              toolUses: [
                {
                  type: "tool-use",
                  id: "policy-git-status",
                  name: "Bash",
                  input: { command: "git status --short" }
                }
              ]
            }
    };

    const result = await collectResult(
      runAgentQuery({
        adapter,
        model: "explicit-test-model",
        messages: [textMessage("user", "run git status")],
        cwd: workspace,
        permissionMode: "acceptEdits",
        toolRules: {
          allow: ["Bash(git:*)"],
          ask: [],
          deny: []
        }
      })
    );

    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        toolCallId: "policy-git-status",
        toolName: "Bash",
        isError: undefined
      })
    );
    expect(result.final.text).toBe("scoped shell observed");
  });

  it("recovers when a provider returns output tokens but no visible text or tools", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    let calls = 0;
    const adapter: ProviderAdapter = {
      name: "empty-output-provider",
      complete: async (request) => {
        calls++;
        if (calls === 1) {
          return { text: "", usage: { inputTokens: 10, outputTokens: 12 } };
        }
        expect(request.messages.at(-1)?.role).toBe("user");
        expect(request.messages.at(-1)?.content[0]).toMatchObject({
          type: "text",
          text: expect.stringContaining("visible final answer")
        });
        return { text: "visible recovery", usage: { inputTokens: 8, outputTokens: 2 } };
      }
    };

    const result = await collectResult(
      runAgentQuery({
        adapter,
        model: "explicit-test-model",
        messages: [textMessage("user", "answer me")],
        cwd: workspace
      })
    );

    expect(calls).toBe(2);
    expect(result.final.text).toBe("visible recovery");
    expect(result.events).toContainEqual({ type: "text_delta", text: "visible recovery" });
    expect(result.final.usage).toEqual({ inputTokens: 18, outputTokens: 14 });
  });

  it("executes text-form tool_use blocks from OpenAI-compatible proxies", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    writeFileSync(path.join(workspace, "README.md"), "project notes", "utf8");
    const calls: string[] = [];
    const adapter: ProviderAdapter = {
      name: "text-tool-provider",
      complete: async (request) => {
        calls.push(request.messages.map((message) => message.role).join(","));
        if (calls.length === 1) {
          return {
            text: [
              '<tool_use tool_name="FileRead">',
              '  <arg name="path">README.md</arg>',
              "</tool_use>"
            ].join("\n"),
            usage: { inputTokens: 5, outputTokens: 6 }
          };
        }
        expect(request.messages.at(-1)).toMatchObject({
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "text-tool-1" }]
        });
        return { text: "read complete", usage: { inputTokens: 7, outputTokens: 2 } };
      }
    };

    const result = await collectResult(
      runAgentQuery({
        adapter,
        model: "explicit-test-model",
        messages: [textMessage("user", "read README")],
        cwd: workspace
      })
    );

    expect(calls).toHaveLength(2);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_use",
        toolUse: expect.objectContaining({
          id: "text-tool-1",
          name: "FileRead",
          input: expect.objectContaining({ file_path: "README.md" })
        })
      })
    );
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        toolName: "FileRead",
        content: expect.stringContaining("project notes")
      })
    );
    expect(result.events).not.toContainEqual({
      type: "text_delta",
      text: expect.stringContaining("<tool_use")
    });
    expect(result.final.text).toBe("read complete");
  });

  it("executes direct XML child args in text-form tool_use blocks", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    writeFileSync(path.join(workspace, "package.json"), '{"name":"demo"}', "utf8");
    let calls = 0;
    const adapter: ProviderAdapter = {
      name: "direct-xml-tool-provider",
      complete: async (request) => {
        calls++;
        if (calls === 1) {
          return {
            text: '<tool_use tool_name="FileRead"><path>package.json</path></tool_use>',
            usage: { inputTokens: 5, outputTokens: 6 }
          };
        }
        expect(request.messages.at(-1)).toMatchObject({
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "text-tool-1" }]
        });
        return { text: "done" };
      }
    };

    const result = await collectResult(
      runAgentQuery({
        adapter,
        model: "explicit-test-model",
        messages: [textMessage("user", "read package")],
        cwd: workspace
      })
    );

    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_use",
        toolUse: expect.objectContaining({
          name: "FileRead",
          input: expect.objectContaining({ file_path: "package.json" })
        })
      })
    );
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        content: expect.stringContaining('"name":"demo"')
      })
    );
    expect(result.final.text).toBe("done");
  });

  it("does not retry when the model defers an actionable project request without using tools", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    writeFileSync(path.join(workspace, "package.json"), '{"scripts":{"dev":"vite"}}', "utf8");
    let calls = 0;
    const adapter: ProviderAdapter = {
      name: "defer-provider",
      complete: async (request) => {
        calls++;
        if (calls === 1) {
          expect(request.tools?.map((tool) => tool.name)).toContain("FileRead");
          return { text: "我会先读取项目文件，找出启动方式。" };
        }
        throw new Error("deferred-action responses should not be retried automatically");
      }
    };

    const result = await collectResult(
      runAgentQuery({
        adapter,
        model: "explicit-test-model",
        messages: [textMessage("user", `${workspace} 把服务拉起来`)],
        cwd: workspace
      })
    );

    expect(calls).toBe(1);
    expect(result.events).not.toContainEqual(expect.objectContaining({ type: "tool_result" }));
    expect(result.final.text).toBe("我会先读取项目文件，找出启动方式。");
  });

  it("does not infer DirList fallback after a substantive file analysis", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const analysis = Array.from(
      { length: 8 },
      (_, index) =>
        `Slide ${index + 1}: the deck already has a clear problem statement, audience context, supporting evidence, and a closing recommendation. The useful feedback is to tighten the narrative and make the transition into the conclusion more explicit.`
    ).join(" ");
    let calls = 0;
    const adapter: ProviderAdapter = {
      name: "ppt-analysis-provider",
      complete: async () => {
        calls++;
        return { text: analysis };
      }
    };

    const result = await collectResult(
      runAgentQuery({
        adapter,
        model: "explicit-test-model",
        messages: [textMessage("user", "/Users/edward/Desktop/test.pptx 这个 ppt 帮我看看")],
        cwd: workspace
      })
    );

    expect(calls).toBe(1);
    expect(result.events).not.toContainEqual(
      expect.objectContaining({
        type: "tool_use",
        toolUse: expect.objectContaining({ name: "DirList" })
      })
    );
    expect(result.final.text).toBe(analysis);
  });

  it("does not infer the Magi banner glyph as a directory path", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    let calls = 0;
    const adapter: ProviderAdapter = {
      name: "banner-path-provider",
      complete: async () => {
        calls++;
        return { text: "我先列一下目录，确认可用文件。" };
      }
    };

    const result = await collectResult(
      runAgentQuery({
        adapter,
        model: "explicit-test-model",
        messages: [
          textMessage(
            "user",
            "△ Magi\n/✦\\ cwd: /Users/edward\n/Users/edward/Desktop/test.pptx 这个 ppt 帮我看看"
          )
        ],
        cwd: workspace
      })
    );

    expect(calls).toBe(1);
    expect(result.events).not.toContainEqual(
      expect.objectContaining({
        type: "tool_use",
        toolUse: expect.objectContaining({
          name: "DirList",
          input: expect.objectContaining({ path: "/✦\\" })
        })
      })
    );
    expect(result.events).not.toContainEqual(
      expect.objectContaining({
        type: "tool_use",
        toolUse: expect.objectContaining({ name: "DirList" })
      })
    );
  });

  it("deduplicates DirList fallback for the same user turn and path", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const directory = path.join(workspace, "slides");
    mkdirSync(directory);
    let calls = 0;
    const adapter: ProviderAdapter = {
      name: "dedupe-dirlist-provider",
      complete: async () => {
        calls++;
        if (calls <= 2) {
          return { text: "我先列一下目录。" };
        }
        throw new Error("duplicate DirList fallback should not trigger another model call");
      }
    };

    const result = await collectResult(
      runAgentQuery({
        adapter,
        model: "explicit-test-model",
        messages: [textMessage("user", `${directory} 请查看目录`)],
        cwd: workspace,
        maxTurns: 4
      })
    );

    const dirListToolUses = result.events.filter(
      (event) => event.type === "tool_use" && event.toolUse.name === "DirList"
    );
    expect(calls).toBe(2);
    expect(dirListToolUses).toHaveLength(1);
    expect(dirListToolUses[0]).toMatchObject({
      type: "tool_use",
      toolUse: expect.objectContaining({
        id: expect.stringMatching(/^fallback-dirlist-u\d+-/),
        input: { path: directory }
      })
    });
    expect(dirListToolUses[0]).not.toMatchObject({
      type: "tool_use",
      toolUse: expect.objectContaining({ id: "fallback-dirlist-1" })
    });
  });

  it("does not feed failed fallback results back to the model after a substantive streamed answer", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const analysis = Array.from(
      { length: 8 },
      (_, index) =>
        `Section ${index + 1}: the presentation has already been read and the main recommendation is to simplify the evidence flow, make the audience takeaway explicit, and remove redundant setup before the final decision slide.`
    ).join(" ");
    let streamCalls = 0;
    let completeCalls = 0;
    const adapter: ProviderAdapter = {
      name: "failed-fallback-provider",
      complete: async () => {
        completeCalls++;
        throw new Error("failed fallback should not call the provider again");
      },
      stream: async function* () {
        streamCalls++;
        yield { type: "text-delta", text: analysis };
        return {
          text: analysis,
          toolUses: [
            {
              type: "tool-use",
              id: "fallback-dirlist-stream",
              name: "DirList",
              input: { path: "/outside-workspace" }
            }
          ]
        };
      }
    };

    const result = await collectResult(
      runAgentQuery({
        adapter,
        model: "explicit-test-model",
        messages: [textMessage("user", "请查看这个目录")],
        cwd: workspace,
        stream: true
      })
    );

    expect(streamCalls).toBe(1);
    expect(completeCalls).toBe(0);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        toolCallId: "fallback-dirlist-stream",
        toolName: "DirList",
        isError: true
      })
    );
    expect(result.final.messages.some((message) => message.role === "tool")).toBe(false);
    expect(result.final.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: analysis }]
    });
    expect(result.final.text).toBe(analysis);
  });

  it("yields approval_request for default write tools and lets a resolver approve", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const adapter: ProviderAdapter = {
      name: "test-provider",
      complete: async (request) =>
        request.messages.some((message) => message.role === "tool")
          ? { text: "approved write completed" }
          : {
              text: "",
              toolUses: [
                {
                  type: "tool-use",
                  id: "tool-1",
                  name: "FileWrite",
                  input: { file_path: "approved.txt", content: "yes" }
                }
              ]
            }
    };

    const result = await collectResult(
      runAgentQuery({
        adapter,
        model: "explicit-test-model",
        messages: [textMessage("user", "write with approval")],
        cwd: workspace,
        permissionMode: "default",
        approvalResolver: () => true
      })
    );

    expect(result.events).toContainEqual(expect.objectContaining({ type: "approval_request" }));
    expect(result.final.text).toBe("approved write completed");
    await expect(readFile(path.join(workspace, "approved.txt"), "utf8")).resolves.toBe("yes");
  });

  it("falls back to the next route when the first model call is retryable", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const primary: ProviderAdapter = {
      name: "primary",
      complete: async () => {
        throw new ProviderError("temporary", { kind: "server-error", retryable: true });
      }
    };
    const backup: ProviderAdapter = {
      name: "backup",
      complete: async () => ({ text: "fallback ok", usage: { inputTokens: 2, outputTokens: 3 } })
    };

    const result = await collectResult(
      runAgentQuery({
        routes: [
          { providerName: "primary", model: "model-a", adapter: primary },
          { providerName: "backup", model: "model-b", adapter: backup }
        ],
        messages: [textMessage("user", "hello")],
        cwd: workspace
      })
    );

    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "fallback_switched",
        fromProvider: "primary",
        fromModel: "model-a",
        toProvider: "backup",
        toModel: "model-b",
        errorKind: "server-error"
      })
    );
    expect(result.final.text).toBe("fallback ok");
    expect(result.final.providerName).toBe("backup");
    expect(result.final.usage).toEqual({ inputTokens: 2, outputTokens: 3 });
  });

  it("retries the same provider when no fallback route exists", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    let callCount = 0;
    const shaky: ProviderAdapter = {
      name: "shaky",
      // Use a short stream so the agent loop doesn't need max_turns.
      // The first two calls throw retryable errors; the third succeeds.
      complete: async () => {
        throw new Error("unreachable — stream is tried first");
      },
      stream: async function* () {
        callCount++;
        if (callCount <= 2) {
          throw new ProviderError("transient 502", { kind: "server-error", retryable: true });
        }
        const text = "survived";
        yield { type: "text-delta", text };
        return { text, usage: { inputTokens: 1, outputTokens: 1 } };
      }
    };

    const result = await collectResult(
      runAgentQuery({
        routes: [{ providerName: "shaky", model: "m", adapter: shaky }],
        messages: [textMessage("user", "ping")],
        cwd: workspace
      })
    );

    // Expected retry pattern: fail → fail → succeed
    expect(callCount).toBe(3);
    expect(result.final.text).toBe("survived");
    expect(result.final.providerName).toBe("shaky");
    expect(result.final.attempts).toEqual([
      { providerName: "shaky", model: "m", ok: false, errorKind: "server-error" },
      { providerName: "shaky", model: "m", ok: false, errorKind: "server-error" },
      { providerName: "shaky", model: "m", ok: true }
    ]);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "provider_retry",
        retryable: true,
        providerName: "shaky",
        model: "m",
        errorKind: "server-error",
        attempt: 1,
        nextRetryDelayMs: expect.any(Number),
        error: expect.stringContaining("kind server-error")
      })
    );
  });

  it("retries complete() on retryable errors when no stream is available", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    let callCount = 0;
    const shaky: ProviderAdapter = {
      name: "shaky",
      complete: async () => {
        callCount++;
        if (callCount <= 2) {
          throw new ProviderError("transient 502", { kind: "server-error", retryable: true });
        }
        return { text: "complete survived", usage: { inputTokens: 1, outputTokens: 1 } };
      }
    };

    const result = await collectResult(
      runAgentQuery({
        routes: [{ providerName: "shaky", model: "m", adapter: shaky }],
        messages: [textMessage("user", "ping")],
        cwd: workspace
      })
    );

    expect(callCount).toBe(3);
    expect(result.final.text).toBe("complete survived");
    expect(result.final.attempts).toEqual([
      { providerName: "shaky", model: "m", ok: false, errorKind: "server-error" },
      { providerName: "shaky", model: "m", ok: false, errorKind: "server-error" },
      { providerName: "shaky", model: "m", ok: true }
    ]);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "provider_retry",
        retryable: true,
        providerName: "shaky",
        model: "m",
        errorKind: "server-error",
        attempt: 1,
        nextRetryDelayMs: expect.any(Number),
        error: expect.stringContaining("kind server-error")
      })
    );
  });

  it("retries raw fetch failed network errors before succeeding", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    let callCount = 0;
    const shaky: ProviderAdapter = {
      name: "network-shaky",
      complete: async () => {
        callCount++;
        if (callCount === 1) {
          throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
        }
        return { text: "network recovered", usage: { inputTokens: 1, outputTokens: 1 } };
      }
    };

    const result = await collectResult(
      runAgentQuery({
        routes: [{ providerName: "network-shaky", model: "m", adapter: shaky }],
        messages: [textMessage("user", "ping")],
        cwd: workspace
      })
    );

    expect(callCount).toBe(2);
    expect(result.final.text).toBe("network recovered");
    expect(result.final.attempts).toEqual([
      { providerName: "network-shaky", model: "m", ok: false, errorKind: "network" },
      { providerName: "network-shaky", model: "m", ok: true }
    ]);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "provider_retry",
        retryable: true,
        providerName: "network-shaky",
        model: "m",
        errorKind: "network",
        attempt: 1,
        nextRetryDelayMs: expect.any(Number),
        error: expect.stringContaining("network error")
      })
    );
  });

  it("fails fast on connection-refused without burning the retry budget", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    let callCount = 0;
    const dead: ProviderAdapter = {
      name: "dead-endpoint",
      complete: async () => {
        callCount++;
        throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") });
      }
    };

    const generator = runAgentQuery({
      routes: [{ providerName: "dead-endpoint", model: "m", adapter: dead }],
      messages: [textMessage("user", "ping")],
      cwd: workspace
    });

    await expect(
      (async () => {
        for await (const _event of generator) {
          void _event;
        }
      })()
    ).rejects.toThrow();

    // A refused connection won't recover by retrying the same dead port, so the
    // adapter must be hit exactly once (no same-route retries burned).
    expect(callCount).toBe(1);
  });

  it("retries transient network errors generously across multiple attempts", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    let callCount = 0;
    const flaky: ProviderAdapter = {
      name: "flaky-endpoint",
      complete: async () => {
        callCount++;
        // Three transient timeouts in a row, then success — exceeds the old
        // network budget of 2-3 that used to kill the task.
        if (callCount <= 3) {
          throw new TypeError("fetch failed", { cause: new Error("ETIMEDOUT") });
        }
        return { text: "recovered after blips", usage: { inputTokens: 1, outputTokens: 1 } };
      }
    };

    const result = await collectResult(
      runAgentQuery({
        routes: [{ providerName: "flaky-endpoint", model: "m", adapter: flaky }],
        messages: [textMessage("user", "ping")],
        cwd: workspace
      })
    );

    expect(callCount).toBe(4);
    expect(result.final.text).toBe("recovered after blips");
  });

  it("does not emit retry diagnostics for non-retryable auth errors", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const events: AgentQueryEvent[] = [];
    const adapter: ProviderAdapter = {
      name: "auth-provider",
      complete: async () => {
        throw new ProviderError("bad api key", { kind: "auth", retryable: false });
      }
    };

    const generator = runAgentQuery({
      routes: [{ providerName: "auth-provider", model: "m", adapter }],
      messages: [textMessage("user", "ping")],
      cwd: workspace
    });
    await expect(
      (async () => {
        for await (const event of generator) {
          events.push(event);
        }
      })()
    ).rejects.toThrow("bad api key");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "error",
        retryable: false,
        error: "bad api key"
      })
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "provider_retry",
        nextRetryDelayMs: expect.any(Number)
      })
    );
  });

  it("consumes provider streams as durable text delta events without duplicating final text", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const adapter: ProviderAdapter = {
      name: "stream-provider",
      complete: async () => {
        throw new Error("complete should not be called when stream is available");
      },
      stream: async function* () {
        yield { type: "text-delta", text: "hel" };
        yield { type: "text-delta", text: "lo" };
        yield { type: "usage", usage: { inputTokens: 3, outputTokens: 2 } };
        return { text: "hello", usage: { inputTokens: 3, outputTokens: 2 } };
      }
    };
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: path.join(workspace, ".magi-next") });
    ensureMagiHome(paths);
    const store = SessionStore.open(paths);
    try {
      const sessionId = store.createSession({ title: "stream", cwd: workspace });
      const result = await new QueryEngine({
        store,
        sessionId,
        jobId: "job-stream-provider",
        routes: [{ providerName: "stream", model: "explicit", adapter }],
        cwd: workspace
      }).submitMessage("stream please");

      expect(result.text).toBe("hello");
      expect(
        result.events.filter((event) => event.type === "text_delta").map((event) => event.text)
      ).toEqual(["hel", "lo"]);
      const deltas = store
        .listRecentAuditEvents({ jobId: "job-stream-provider", limit: 50, order: "asc" })
        .filter((event) => event.action === "agent.text.delta");
      expect(deltas.map((event) => event.metadata?.preview)).toEqual(["hel", "lo"]);
      expect(store.getSession(sessionId)?.messages).toContainEqual(
        expect.objectContaining({
          role: "assistant",
          content: "hello"
        })
      );
    } finally {
      store.close();
    }
  });

  it("cancels running provider streams through AbortSignal and records cancelled jobs", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const adapter: ProviderAdapter = {
      name: "abort-provider",
      complete: async () => {
        throw new Error("complete should not be called when stream is available");
      },
      stream: async function* (request) {
        seenSignal = request.signal;
        yield { type: "text-delta", text: "before cancel" };
        controller.abort("operator stop");
        request.signal?.throwIfAborted();
        return { text: "unreachable" };
      }
    };
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: path.join(workspace, ".magi-next") });
    ensureMagiHome(paths);
    const store = SessionStore.open(paths);
    try {
      const sessionId = store.createSession({ title: "cancel", cwd: workspace });
      await expect(
        new QueryEngine({
          store,
          sessionId,
          jobId: "job-stream-cancel",
          routes: [{ providerName: "abort", model: "explicit", adapter }],
          cwd: workspace,
          signal: controller.signal
        }).submitMessage("cancel me")
      ).rejects.toThrow(/operator stop/);

      expect(seenSignal).toBe(controller.signal);
      expect(store.getJob("job-stream-cancel")?.status).toBe("cancelled");
      expect(store.listJobAuditEvents("job-stream-cancel", 50)).toContainEqual(
        expect.objectContaining({
          action: "agent.query.cancelled",
          metadata: expect.objectContaining({ reason: "operator stop" })
        })
      );
    } finally {
      store.close();
    }
  });

  it("executes WebFetch with approval and summarizes fetched content through the active model", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        "<title>Release Notes</title><article><p>Version 2 ships on Friday.</p></article>"
      );
    });
    const url = await listen(server);
    const phases: string[] = [];
    const adapter: ProviderAdapter = {
      name: "web-provider",
      complete: async (request) => {
        const text = request.messages
          .map((message) =>
            message.content
              .map((part) => {
                if (part.type === "text") return part.text;
                if (part.type === "tool-result") return part.content;
                if (part.type === "tool-use") return `${part.name}:${JSON.stringify(part.input)}`;
                return "";
              })
              .join("")
          )
          .join("\n");
        if (text.includes("Content:") && text.includes("Version 2 ships on Friday.")) {
          phases.push("web-summary");
          return { text: "Version 2 ships on Friday." };
        }
        if (!request.messages.some((message) => message.role === "tool")) {
          phases.push("tool-use");
          return {
            text: "",
            toolUses: [
              {
                type: "tool-use",
                id: "web-1",
                name: "WebFetch",
                input: { url, prompt: "Extract the release date." }
              }
            ]
          };
        }
        phases.push("final");
        expect(text).toContain("Title: Release Notes");
        expect(text).toContain("Version 2 ships on Friday.");
        return { text: "web fetch done" };
      }
    };

    const result = await collectResult(
      runAgentQuery({
        routes: [{ providerName: "web", model: "explicit", adapter }],
        messages: [textMessage("user", "fetch release notes")],
        cwd: workspace,
        permissionMode: "default",
        approvalResolver: () => true
      })
    );

    expect(phases).toEqual(["tool-use", "web-summary", "final"]);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "approval_request",
        toolUse: expect.objectContaining({ name: "WebFetch" })
      })
    );
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        toolName: "WebFetch",
        content: expect.stringContaining("Title: Release Notes")
      })
    );
    expect(result.final.text).toBe("web fetch done");
  });

  it("asks user questions, returns selected options to the model, and continues the loop", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const seenToolResult: string[] = [];
    const adapter: ProviderAdapter = {
      name: "question-provider",
      complete: async (request) => {
        const toolResult = request.messages
          .flatMap((message) => message.content)
          .find((part) => part.type === "tool-result");
        if (toolResult?.type === "tool-result") {
          seenToolResult.push(toolResult.content);
          return { text: "Proceeding with option B." };
        }
        return {
          text: "",
          toolUses: [
            {
              type: "tool-use",
              id: "ask-1",
              name: "AskUserQuestion",
              input: {
                questions: [
                  {
                    question: "Which implementation path should we take?",
                    options: [
                      { label: "A", description: "Patch a narrow surface" },
                      { label: "B", description: "Build the full resolver path" }
                    ]
                  }
                ]
              }
            }
          ]
        };
      }
    };

    const result = await collectResult(
      runAgentQuery({
        routes: [{ providerName: "question", model: "explicit", adapter }],
        messages: [textMessage("user", "choose path")],
        cwd: workspace,
        userQuestionResolver: ({ toolUse, question }) => {
          expect(toolUse.id).toBe("ask-1");
          return {
            answers: [
              {
                question: question.questions[0].question,
                selectedLabels: ["B"],
                selectedOptions: [question.questions[0].options[1]]
              }
            ]
          };
        }
      })
    );

    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "user_question",
        toolUse: expect.objectContaining({ name: "AskUserQuestion" })
      })
    );
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        toolName: "AskUserQuestion",
        content: expect.stringContaining("- B: Build the full resolver path")
      })
    );
    expect(seenToolResult[0]).toContain("Build the full resolver path");
    expect(result.final.text).toBe("Proceeding with option B.");
  });

  it("sends user messages as first-class agent events and tool results", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const delivered: string[] = [];
    const adapter: ProviderAdapter = {
      name: "message-provider",
      complete: async (request) =>
        request.messages.some((message) => message.role === "tool")
          ? { text: "message delivered" }
          : {
              text: "",
              toolUses: [
                {
                  type: "tool-use",
                  id: "msg-1",
                  name: "SendUserMessage",
                  input: {
                    message: "Please review the current diff.",
                    status: "normal"
                  }
                }
              ]
            }
    };

    const result = await collectResult(
      runAgentQuery({
        routes: [{ providerName: "message", model: "explicit", adapter }],
        messages: [textMessage("user", "send update")],
        cwd: workspace,
        userMessageSink: ({ message }) => {
          delivered.push(message.message);
          return {
            delivered: true,
            channel: "test-sink",
            deliveredAt: "2026-05-16T00:00:00.000Z"
          };
        }
      })
    );

    expect(delivered).toEqual(["Please review the current diff."]);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "user_message",
        message: expect.objectContaining({ message: "Please review the current diff." })
      })
    );
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        toolName: "SendUserMessage",
        content: expect.stringContaining("channel: test-sink")
      })
    );
    expect(result.final.text).toBe("message delivered");
  });

  it("returns TodoWrite tool_result to the model and persists the session todo list", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const stateRoot = path.join(workspace, ".magi-next", "state");
    const seenToolResults: string[] = [];
    const adapter: ProviderAdapter = {
      name: "todo-provider",
      complete: async (request) => {
        const toolResult = request.messages
          .flatMap((message) => message.content)
          .find((part) => part.type === "tool-result");
        if (toolResult?.type === "tool-result") {
          seenToolResults.push(toolResult.content);
          return { text: "todo state updated" };
        }
        return {
          text: "",
          toolUses: [
            {
              type: "tool-use",
              id: "todo-1",
              name: "TodoWrite",
              input: {
                todos: [
                  { id: "read", content: "Read existing tool patterns", status: "completed" },
                  {
                    id: "write",
                    content: "Implement TodoWrite",
                    status: "in_progress",
                    priority: "high"
                  }
                ]
              }
            }
          ]
        };
      }
    };

    const result = await collectResult(
      runAgentQuery({
        routes: [{ providerName: "todo", model: "explicit", adapter }],
        messages: [textMessage("user", "track work")],
        cwd: workspace,
        stateRoot,
        sessionId: "todo-session",
        permissionMode: "acceptEdits",
        toolRules: { allow: ["TodoWrite(*)"], ask: [], deny: [] }
      })
    );

    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        toolName: "TodoWrite",
        content: expect.stringContaining("Todo list replaced (2 items)")
      })
    );
    expect(seenToolResults[0]).toContain("write priority=high - Implement TodoWrite");
    expect(
      loadTodoStore(todoStorePathFromRoot(stateRoot)).sessions["todo-session"].todos
    ).toHaveLength(2);
    expect(result.final.text).toBe("todo state updated");
  });

  it("returns WebSearch tool_result to the model through the agent loop", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          results: [
            {
              title: "Magi Next WebSearch",
              url: "https://docs.example.com/web-search",
              snippet: "Sourced WebSearch result."
            }
          ]
        })
      );
    });
    const endpoint = await listen(server);
    const seenToolResults: string[] = [];
    const adapter: ProviderAdapter = {
      name: "web-search-provider",
      complete: async (request) => {
        const toolResult = request.messages
          .flatMap((message) => message.content)
          .find((part) => part.type === "tool-result");
        if (toolResult?.type === "tool-result") {
          seenToolResults.push(toolResult.content);
          return { text: "search result consumed" };
        }
        expect(request.tools?.map((tool) => tool.name)).toContain("WebSearch");
        return {
          text: "",
          toolUses: [
            {
              type: "tool-use",
              id: "web-search-1",
              name: "WebSearch",
              input: { query: "magi next web search", allowed_domains: ["docs.example.com"] }
            }
          ]
        };
      }
    };

    const result = await collectResult(
      runAgentQuery({
        routes: [{ providerName: "web-search", model: "explicit", adapter }],
        messages: [textMessage("user", "search the web")],
        cwd: workspace,
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
      })
    );

    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        toolName: "WebSearch",
        content: expect.stringContaining("Magi Next WebSearch")
      })
    );
    expect(seenToolResults[0]).toContain("https://docs.example.com/web-search");
    expect(result.final.text).toBe("search result consumed");
  });

  it("returns GitDiff tool_result to the model through the agent loop", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-git-"));
    initGitRepo(workspace);
    writeFileSync(path.join(workspace, "tracked.txt"), "before\n", "utf8");
    git(workspace, ["add", "tracked.txt"]);
    git(workspace, ["commit", "-m", "initial commit"]);
    writeFileSync(path.join(workspace, "tracked.txt"), "after\n", "utf8");
    const seenToolResults: string[] = [];
    const adapter: ProviderAdapter = {
      name: "git-provider",
      complete: async (request) => {
        const toolResult = request.messages
          .flatMap((message) => message.content)
          .find((part) => part.type === "tool-result");
        if (toolResult?.type === "tool-result") {
          seenToolResults.push(toolResult.content);
          return { text: "git diff consumed" };
        }
        expect(request.tools?.map((tool) => tool.name)).toContain("GitDiff");
        return {
          text: "",
          toolUses: [
            {
              type: "tool-use",
              id: "git-diff-1",
              name: "GitDiff",
              input: { path: "tracked.txt", context: 0 }
            }
          ]
        };
      }
    };

    const result = await collectResult(
      runAgentQuery({
        routes: [{ providerName: "git", model: "explicit", adapter }],
        messages: [textMessage("user", "inspect diff")],
        cwd: workspace
      })
    );

    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        toolName: "GitDiff",
        content: expect.stringContaining("+after")
      })
    );
    expect(seenToolResults[0]).toContain("-before");
    expect(result.final.text).toBe("git diff consumed");
  });

  it("returns approved GitBranchCreate tool_result through the agent loop", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-git-"));
    initGitRepo(workspace);
    writeFileSync(path.join(workspace, "tracked.txt"), "before\n", "utf8");
    git(workspace, ["add", "tracked.txt"]);
    git(workspace, ["commit", "-m", "initial commit"]);
    const adapter: ProviderAdapter = {
      name: "git-branch-provider",
      complete: async (request) =>
        request.messages.some((message) => message.role === "tool")
          ? { text: "git branch created" }
          : {
              text: "",
              toolUses: [
                {
                  type: "tool-use",
                  id: "git-branch-agent",
                  name: "GitBranchCreate",
                  input: { name: "feature/agent-branch", checkout: true }
                }
              ]
            }
    };

    const result = await collectResult(
      runAgentQuery({
        routes: [{ providerName: "git", model: "explicit", adapter }],
        messages: [textMessage("user", "create a branch")],
        cwd: workspace,
        permissionMode: "default",
        approvalResolver: () => true
      })
    );

    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "approval_request",
        toolUse: expect.objectContaining({ name: "GitBranchCreate" })
      })
    );
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        toolName: "GitBranchCreate",
        content: expect.stringContaining("Created and checked out branch feature/agent-branch")
      })
    );
    expect(gitOutput(workspace, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe(
      "feature/agent-branch"
    );
    expect(result.final.text).toBe("git branch created");
  });

  it("returns ToolSearch, WorkspaceDiagnostics, Config, and Skill tool results to the model", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: path.join(workspace, ".magi-next") });
    ensureMagiHome(paths);
    writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({
        scripts: { test: "vitest run" },
        devDependencies: { vitest: "^3.0.0" }
      }),
      "utf8"
    );
    const skillRoot = path.join(paths.skillsRoot, "review-helper");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      path.join(skillRoot, "SKILL.md"),
      "# Review Helper\n\nReview code changes.\n",
      "utf8"
    );
    const seenResults: string[] = [];
    const adapter: ProviderAdapter = {
      name: "multi-tool-provider",
      complete: async (request) => {
        const toolResults = request.messages
          .flatMap((message) => message.content)
          .filter((part) => part.type === "tool-result");
        if (toolResults.length > 0) {
          seenResults.push(
            ...toolResults.map((part) => (part.type === "tool-result" ? part.content : ""))
          );
          return { text: "tool discovery done" };
        }
        return {
          text: "",
          toolUses: [
            {
              type: "tool-use",
              id: "tool-search",
              name: "ToolSearch",
              input: { query: "select:Config" }
            },
            {
              type: "tool-use",
              id: "workspace-diagnostics",
              name: "WorkspaceDiagnostics",
              input: {}
            },
            {
              type: "tool-use",
              id: "config-read",
              name: "Config",
              input: { setting: "context.recentMessages" }
            },
            { type: "tool-use", id: "skill-load", name: "Skill", input: { skill: "review-helper" } }
          ]
        };
      }
    };

    const result = await collectResult(
      runAgentQuery({
        routes: [{ providerName: "multi-tool", model: "explicit", adapter }],
        messages: [textMessage("user", "inspect tools")],
        cwd: workspace,
        stateRoot: paths.stateRoot
      })
    );

    expect(result.events).toContainEqual(
      expect.objectContaining({ type: "tool_result", toolName: "ToolSearch" })
    );
    expect(result.events).toContainEqual(
      expect.objectContaining({ type: "tool_result", toolName: "WorkspaceDiagnostics" })
    );
    expect(result.events).toContainEqual(
      expect.objectContaining({ type: "tool_result", toolName: "Config" })
    );
    expect(result.events).toContainEqual(
      expect.objectContaining({ type: "tool_result", toolName: "Skill" })
    );
    expect(seenResults.join("\n")).toContain("Tool: Config");
    expect(seenResults.join("\n")).toContain("Workspace Diagnostics");
    expect(seenResults.join("\n")).toContain("npm run test");
    expect(seenResults.join("\n")).toContain("Config context.recentMessages");
    expect(seenResults.join("\n")).toContain("Review code changes.");
    expect(result.final.text).toBe("tool discovery done");
  });

  it("loads deferred built-in tool schemas after ToolSearch selection", async () => {
    const seenToolSets: string[][] = [];
    const adapter: ProviderAdapter = {
      name: "deferred-tools-provider",
      complete: async (request) => {
        seenToolSets.push((request.tools ?? []).map((tool) => tool.name));
        const toolResults = request.messages
          .flatMap((message) => message.content)
          .filter((part) => part.type === "tool-result");
        if (
          toolResults.some((part) => part.type === "tool-result" && part.toolCallId === "monitor")
        ) {
          return { text: "monitor done" };
        }
        if (
          toolResults.some(
            (part) => part.type === "tool-result" && part.toolCallId === "tool-select"
          )
        ) {
          return {
            text: "",
            toolUses: [
              {
                type: "tool-use",
                id: "monitor",
                name: "Monitor",
                input: { scope: "quick" }
              }
            ]
          };
        }
        return {
          text: "",
          toolUses: [
            {
              type: "tool-use",
              id: "tool-select",
              name: "ToolSearch",
              input: { query: "select:Monitor" }
            }
          ]
        };
      }
    };

    const result = await collectResult(
      runAgentQuery({
        routes: [{ providerName: "deferred", model: "explicit", adapter }],
        messages: [textMessage("user", "check resources")],
        cwd: process.cwd()
      })
    );

    expect(seenToolSets[0]).toContain("ToolSearch");
    expect(seenToolSets[0]).not.toContain("Monitor");
    expect(seenToolSets[1]).toContain("Monitor");
    expect(result.events).toContainEqual(
      expect.objectContaining({ type: "tool_result", toolName: "Monitor" })
    );
    expect(result.final.text).toBe("monitor done");
  });

  it("emits tool context diagnostics only when MAGI_DEBUG_TOOLS is enabled", async () => {
    const adapter: ProviderAdapter = {
      name: "tool-debug-provider",
      complete: async () => ({ text: "hello" })
    };

    const quiet = await collectResult(
      runAgentQuery({
        routes: [{ providerName: "tool-debug", model: "explicit", adapter }],
        messages: [textMessage("user", "hello")],
        cwd: process.cwd()
      })
    );
    expect(quiet.events.some((event) => event.type === "tool_context")).toBe(false);

    const debug = await collectResult(
      runAgentQuery({
        routes: [{ providerName: "tool-debug", model: "explicit", adapter }],
        messages: [textMessage("user", "hello")],
        cwd: process.cwd(),
        env: { MAGI_DEBUG_TOOLS: "1" }
      })
    );
    const event = debug.events.find((item) => item.type === "tool_context");
    expect(event).toMatchObject({
      type: "tool_context",
      toolCount: expect.any(Number),
      deferredToolCount: expect.any(Number),
      schemaChars: expect.any(Number),
      estimatedSchemaTokens: expect.any(Number)
    });
    expect(event?.toolNames).toContain("ToolSearch");
    expect(event?.toolNames).not.toContain("Monitor");
  });

  it("returns a tool error when AskUserQuestion has no resolver", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const adapter: ProviderAdapter = {
      name: "question-provider",
      complete: async (request) =>
        request.messages.some((message) => message.role === "tool")
          ? { text: "question unavailable" }
          : {
              text: "",
              toolUses: [
                {
                  type: "tool-use",
                  id: "ask-no-resolver",
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
                }
              ]
            }
    };

    const result = await collectResult(
      runAgentQuery({
        routes: [{ providerName: "question", model: "explicit", adapter }],
        messages: [textMessage("user", "ask me")],
        cwd: workspace
      })
    );

    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        toolName: "AskUserQuestion",
        isError: true,
        content: expect.stringContaining("requires an interactive user question resolver")
      })
    );
    expect(result.final.text).toBe("question unavailable");
  });

  it("persists query engine transcript, tool audits, jobs, and usage", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const store = new SessionStore(path.join(workspace, ".magi-next", "state", "sessions.sqlite"));
    try {
      const sessionId = store.createSession({ title: "engine", cwd: workspace });
      const adapter: ProviderAdapter = {
        name: "engine-provider",
        complete: async (request) =>
          request.messages.some((message) => message.role === "tool")
            ? { text: "finished", usage: { inputTokens: 3, outputTokens: 4 } }
            : {
                text: "",
                toolUses: [
                  {
                    type: "tool-use",
                    id: "tool-1",
                    name: "FileWrite",
                    input: { file_path: "engine.txt", content: "ok" }
                  }
                ]
              }
      };
      const engine = new QueryEngine({
        store,
        sessionId,
        jobId: "job-engine",
        cwd: workspace,
        permissionMode: "acceptEdits",
        routes: [{ providerName: "engine", model: "explicit", adapter }]
      });

      const result = await engine.submitMessage("write engine.txt");
      const session = store.getSession(sessionId)!;

      expect(result.events.map((event) => event.type)).toContain("tool_result");
      expect(session.messages.map((message) => message.role)).toEqual([
        "user",
        "tool",
        "assistant"
      ]);
      expect(store.getJob("job-engine")).toMatchObject({ status: "completed" });
      expect(store.countRows("usage_events")).toBe(1);
      expect(store.listAuditEvents(20).map((event) => event.action)).toEqual(
        expect.arrayContaining([
          "agent.request.started",
          "agent.assistant.message",
          "agent.tool.use",
          "agent.tool.completed",
          "agent.usage.reported",
          "agent.query.done",
          "agent.query.completed"
        ])
      );
    } finally {
      store.close();
    }
  });

  it("persists failed tool audit reason for boundary violations", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const store = new SessionStore(path.join(workspace, ".magi-next", "state", "sessions.sqlite"));
    try {
      const sessionId = store.createSession({ title: "boundary audit", cwd: workspace });
      const adapter: ProviderAdapter = {
        name: "boundary-provider",
        complete: async (request) =>
          request.messages.some((message) => message.role === "tool")
            ? { text: "boundary handled" }
            : {
                text: "",
                toolUses: [
                  {
                    type: "tool-use",
                    id: "outside-write",
                    name: "FileWrite",
                    input: { file_path: "../outside-sentinel.txt", content: "bad" }
                  }
                ]
              }
      };
      const engine = new QueryEngine({
        store,
        sessionId,
        jobId: "job-boundary",
        cwd: workspace,
        permissionMode: "acceptEdits",
        routes: [{ providerName: "boundary", model: "explicit", adapter }]
      });

      await engine.submitMessage("try outside write");

      expect(store.listAuditEvents(20)).toContainEqual(
        expect.objectContaining({
          action: "agent.tool.failed",
          target: "FileWrite",
          metadata: expect.objectContaining({
            toolCallId: "outside-write",
            reason: expect.stringContaining("outside allowed directories")
          })
        })
      );
    } finally {
      store.close();
    }
  });

  it("waits for active approval decisions before running protected tools", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const store = new SessionStore(path.join(workspace, ".magi-next", "state", "sessions.sqlite"));
    const interactions = new ActiveInteractionRegistry({ timeoutMs: 5_000 });
    try {
      const sessionId = store.createSession({ title: "approval wait", cwd: workspace });
      const adapter: ProviderAdapter = {
        name: "approval-provider",
        complete: async (request) =>
          request.messages.some((message) => message.role === "tool")
            ? { text: "approved through control" }
            : {
                text: "",
                toolUses: [
                  {
                    type: "tool-use",
                    id: "approve-write",
                    name: "FileWrite",
                    input: { file_path: "approved-active.txt", content: "control approved" }
                  }
                ]
              }
      };
      const engine = new QueryEngine({
        store,
        sessionId,
        jobId: "job-active-approval",
        cwd: workspace,
        routes: [{ providerName: "approval", model: "explicit", adapter }],
        permissionMode: "default",
        activeInteractions: interactions
      });

      const running = engine.submitMessage("write with active approval");
      await waitFor(
        () =>
          interactions.getInteraction({
            jobId: "job-active-approval",
            toolUseId: "approve-write"
          })?.status === "pending"
      );

      expect(store.listJobAuditEvents("job-active-approval", 20)).toContainEqual(
        expect.objectContaining({
          action: "agent.approval.pending",
          metadata: expect.objectContaining({ toolUseId: "approve-write", status: "pending" })
        })
      );
      interactions.resolveApproval({
        jobId: "job-active-approval",
        toolUseId: "approve-write",
        approved: true
      });
      const result = await running;

      expect(result.text).toBe("approved through control");
      await expect(readFile(path.join(workspace, "approved-active.txt"), "utf8")).resolves.toBe(
        "control approved"
      );
      expect(store.listJobAuditEvents("job-active-approval", 40)).toContainEqual(
        expect.objectContaining({
          action: "agent.approval.resolved",
          metadata: expect.objectContaining({ approved: true, status: "resolved" })
        })
      );
    } finally {
      interactions.close();
      store.close();
    }
  });

  it("waits for active AskUserQuestion answers before returning tool results", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const store = new SessionStore(path.join(workspace, ".magi-next", "state", "sessions.sqlite"));
    const interactions = new ActiveInteractionRegistry({ timeoutMs: 5_000 });
    try {
      const sessionId = store.createSession({ title: "question wait", cwd: workspace });
      const seenToolResults: string[] = [];
      const adapter: ProviderAdapter = {
        name: "question-provider",
        complete: async (request) => {
          const toolResult = request.messages
            .flatMap((message) => message.content)
            .find((part) => part.type === "tool-result");
          if (toolResult?.type === "tool-result") {
            seenToolResults.push(toolResult.content);
            return { text: "question resolved through control" };
          }
          return {
            text: "",
            toolUses: [
              {
                type: "tool-use",
                id: "ask-active",
                name: "AskUserQuestion",
                input: {
                  questions: [
                    {
                      question: "Choose deployment lane",
                      options: [
                        { label: "canary", description: "Roll out to a small group" },
                        { label: "stable", description: "Roll out broadly" }
                      ]
                    }
                  ]
                }
              }
            ]
          };
        }
      };
      const engine = new QueryEngine({
        store,
        sessionId,
        jobId: "job-active-question",
        cwd: workspace,
        routes: [{ providerName: "question", model: "explicit", adapter }],
        activeInteractions: interactions
      });

      const running = engine.submitMessage("ask the user");
      await waitFor(
        () =>
          interactions.getInteraction({
            jobId: "job-active-question",
            toolUseId: "ask-active"
          })?.status === "pending"
      );
      const pending = interactions.getPendingQuestion({
        jobId: "job-active-question",
        toolUseId: "ask-active"
      });
      interactions.resolveQuestion({
        jobId: "job-active-question",
        toolUseId: "ask-active",
        answer: {
          answers: [
            {
              question: pending.question.questions[0].question,
              selectedLabels: ["stable"],
              selectedOptions: [pending.question.questions[0].options[1]]
            }
          ]
        }
      });
      const result = await running;

      expect(result.text).toBe("question resolved through control");
      expect(seenToolResults[0]).toContain("- stable: Roll out broadly");
      expect(store.listJobAuditEvents("job-active-question", 40)).toContainEqual(
        expect.objectContaining({
          action: "agent.user_question.pending",
          metadata: expect.objectContaining({ toolUseId: "ask-active", status: "pending" })
        })
      );
      expect(store.listJobAuditEvents("job-active-question", 40)).toContainEqual(
        expect.objectContaining({
          action: "agent.user_question.resolved",
          metadata: expect.objectContaining({ toolUseId: "ask-active", status: "resolved" })
        })
      );
    } finally {
      interactions.close();
      store.close();
    }
  });

  it("auto-resolves AskUserQuestion in bypassPermissions headless mode", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const store = new SessionStore(path.join(workspace, ".magi-next", "state", "sessions.sqlite"));
    const interactions = new ActiveInteractionRegistry({ timeoutMs: 50 });
    try {
      const sessionId = store.createSession({ title: "auto question", cwd: workspace });
      const adapter: ProviderAdapter = {
        name: "auto-question-provider",
        complete: async (request) =>
          request.messages.some((message) => message.role === "tool")
            ? { text: "picked default option" }
            : {
                text: "",
                toolUses: [
                  {
                    type: "tool-use",
                    id: "ask-auto",
                    name: "AskUserQuestion",
                    input: {
                      questions: [
                        {
                          question: "Which memory topic?",
                          options: [
                            { label: "RAG (Recommended)", description: "Retrieval" },
                            { label: "Other", description: "Something else" }
                          ]
                        }
                      ]
                    }
                  }
                ]
              }
      };
      const result = await new QueryEngine({
        store,
        sessionId,
        jobId: "job-auto-question",
        cwd: workspace,
        routes: [{ providerName: "auto", model: "explicit", adapter }],
        permissionMode: "bypassPermissions",
        activeInteractions: interactions
      }).submitMessage("research memory");

      expect(result.text).toContain("picked default option");
      expect(
        interactions.listInteractions({ jobId: "job-auto-question", status: "pending" })
      ).toHaveLength(0);
      expect(store.listJobAuditEvents("job-auto-question", 40)).toContainEqual(
        expect.objectContaining({
          action: "agent.user_question.auto_resolved",
          metadata: expect.objectContaining({
            toolUseId: "ask-auto",
            auto: true,
            answer: expect.objectContaining({
              answers: [
                expect.objectContaining({
                  selectedLabels: ["RAG (Recommended)"]
                })
              ]
            })
          })
        })
      );
    } finally {
      interactions.close();
      store.close();
    }
  });

  it("waits for client interaction mode instead of auto-resolving AskUserQuestion", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const store = new SessionStore(path.join(workspace, ".magi-next", "state", "sessions.sqlite"));
    const interactions = new ActiveInteractionRegistry({ timeoutMs: 5_000 });
    try {
      const sessionId = store.createSession({ title: "client question", cwd: workspace });
      const adapter: ProviderAdapter = {
        name: "client-question-provider",
        complete: async (request) =>
          request.messages.some((message) => message.role === "tool")
            ? { text: "client picked option" }
            : {
                text: "",
                toolUses: [
                  {
                    type: "tool-use",
                    id: "ask-client",
                    name: "AskUserQuestion",
                    input: {
                      questions: [
                        {
                          question: "Which route?",
                          options: [
                            { label: "fast", description: "Fast route" },
                            { label: "safe", description: "Safe route" }
                          ]
                        }
                      ]
                    }
                  }
                ]
              }
      };
      const running = new QueryEngine({
        store,
        sessionId,
        jobId: "job-client-question",
        cwd: workspace,
        routes: [{ providerName: "client", model: "explicit", adapter }],
        permissionMode: "bypassPermissions",
        interactionMode: "client",
        activeInteractions: interactions
      }).submitMessage("ask user");
      await waitFor(
        () =>
          interactions.getInteraction({ jobId: "job-client-question", toolUseId: "ask-client" })
            ?.status === "pending"
      );
      interactions.resolveQuestion({
        jobId: "job-client-question",
        toolUseId: "ask-client",
        answer: {
          answers: [
            {
              question: "Which route?",
              selectedLabels: ["safe"],
              selectedOptions: [{ label: "safe", description: "Safe route" }]
            }
          ]
        }
      });
      const result = await running;
      expect(result.text).toContain("client picked option");
      expect(store.listJobAuditEvents("job-client-question", 40)).not.toContainEqual(
        expect.objectContaining({ action: "agent.user_question.auto_resolved" })
      );
    } finally {
      interactions.close();
      store.close();
    }
  });

  it("records timeout and cancel states for active interactions", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const store = new SessionStore(path.join(workspace, ".magi-next", "state", "sessions.sqlite"));
    const interactions = new ActiveInteractionRegistry({ timeoutMs: 20 });
    try {
      const timeoutSessionId = store.createSession({ title: "approval timeout", cwd: workspace });
      const timeoutAdapter: ProviderAdapter = {
        name: "timeout-provider",
        complete: async (request) =>
          request.messages.some((message) => message.role === "tool")
            ? { text: "approval timed out" }
            : {
                text: "",
                toolUses: [
                  {
                    type: "tool-use",
                    id: "approve-timeout",
                    name: "FileWrite",
                    input: { file_path: "timeout.txt", content: "no" }
                  }
                ]
              }
      };
      await expect(
        new QueryEngine({
          store,
          sessionId: timeoutSessionId,
          jobId: "job-approval-timeout",
          cwd: workspace,
          routes: [{ providerName: "timeout", model: "explicit", adapter: timeoutAdapter }],
          permissionMode: "default",
          activeInteractions: interactions
        }).submitMessage("timeout approval")
      ).rejects.toMatchObject({
        name: "ActiveInteractionTimeoutError"
      });

      expect(store.listJobAuditEvents("job-approval-timeout", 30)).toContainEqual(
        expect.objectContaining({
          action: "agent.approval.timeout",
          metadata: expect.objectContaining({ toolUseId: "approve-timeout", status: "timeout" })
        })
      );

      const cancelSessionId = store.createSession({ title: "question cancel", cwd: workspace });
      const cancelAdapter: ProviderAdapter = {
        name: "cancel-provider",
        complete: async (request) =>
          request.messages.some((message) => message.role === "tool")
            ? { text: "question cancelled" }
            : {
                text: "",
                toolUses: [
                  {
                    type: "tool-use",
                    id: "ask-cancel",
                    name: "AskUserQuestion",
                    input: {
                      questions: [
                        {
                          question: "Cancel this question?",
                          options: [
                            { label: "yes", description: "Yes" },
                            { label: "no", description: "No" }
                          ]
                        }
                      ]
                    }
                  }
                ]
              }
      };
      const running = new QueryEngine({
        store,
        sessionId: cancelSessionId,
        jobId: "job-question-cancel",
        cwd: workspace,
        routes: [{ providerName: "cancel", model: "explicit", adapter: cancelAdapter }],
        activeInteractions: interactions,
        interactionTimeoutMs: 5_000
      }).submitMessage("cancel question");
      await waitFor(
        () =>
          interactions.getInteraction({
            jobId: "job-question-cancel",
            toolUseId: "ask-cancel"
          })?.status === "pending"
      );
      interactions.cancelInteraction({
        jobId: "job-question-cancel",
        toolUseId: "ask-cancel",
        reason: "test cancel"
      });
      await expect(running).rejects.toMatchObject({
        name: "ActiveInteractionCancelledError"
      });

      expect(store.listJobAuditEvents("job-question-cancel", 30)).toContainEqual(
        expect.objectContaining({
          action: "agent.user_question.cancelled",
          metadata: expect.objectContaining({ toolUseId: "ask-cancel", status: "cancelled" })
        })
      );
    } finally {
      interactions.close();
      store.close();
    }
  });

  it("cancels active approval waits when the request is aborted", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const store = new SessionStore(path.join(workspace, ".magi-next", "state", "sessions.sqlite"));
    const interactions = new ActiveInteractionRegistry({ timeoutMs: 5_000 });
    const controller = new AbortController();
    try {
      const sessionId = store.createSession({ title: "approval abort", cwd: workspace });
      const adapter: ProviderAdapter = {
        name: "abort-provider",
        complete: async () => ({
          text: "",
          toolUses: [
            {
              type: "tool-use",
              id: "approve-abort",
              name: "FileWrite",
              input: { file_path: "abort.txt", content: "no" }
            }
          ]
        })
      };
      const running = new QueryEngine({
        store,
        sessionId,
        jobId: "job-approval-abort",
        cwd: workspace,
        routes: [{ providerName: "abort", model: "explicit", adapter }],
        permissionMode: "default",
        activeInteractions: interactions,
        signal: controller.signal
      }).submitMessage("abort approval");
      await waitFor(
        () =>
          interactions.getInteraction({
            jobId: "job-approval-abort",
            toolUseId: "approve-abort"
          })?.status === "pending"
      );

      controller.abort();

      await expect(running).rejects.toMatchObject({
        name: "ActiveInteractionCancelledError"
      });
      expect(store.listJobAuditEvents("job-approval-abort", 30)).toContainEqual(
        expect.objectContaining({
          action: "agent.approval.cancelled",
          metadata: expect.objectContaining({ toolUseId: "approve-abort", status: "cancelled" })
        })
      );
      expect(store.getJob("job-approval-abort")?.status).toBe("cancelled");
    } finally {
      interactions.close();
      store.close();
    }
  });

  it("persists TodoWrite state and records dedicated todo audit events through QueryEngine", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const stateRoot = path.join(workspace, ".magi-next", "state");
    const store = new SessionStore(path.join(stateRoot, "sessions.sqlite"));
    try {
      const sessionId = store.createSession({ title: "todo engine", cwd: workspace });
      const adapter: ProviderAdapter = {
        name: "todo-engine-provider",
        complete: async (request) =>
          request.messages.some((message) => message.role === "tool")
            ? { text: "todo persisted", usage: { inputTokens: 5, outputTokens: 6 } }
            : {
                text: "",
                toolUses: [
                  {
                    type: "tool-use",
                    id: "todo-engine",
                    name: "TodoWrite",
                    input: {
                      todos: [
                        {
                          id: "finish",
                          content: "Finish TodoWrite implementation",
                          status: "in_progress"
                        },
                        {
                          id: "verify",
                          content: "Run verification",
                          status: "pending",
                          priority: "high"
                        }
                      ]
                    }
                  }
                ]
              }
      };
      const engine = new QueryEngine({
        store,
        sessionId,
        jobId: "job-todo-engine",
        cwd: workspace,
        stateRoot,
        permissionMode: "acceptEdits",
        toolRules: { allow: ["TodoWrite(*)"], ask: [], deny: [] },
        routes: [{ providerName: "todo-engine", model: "explicit", adapter }]
      });

      const result = await engine.submitMessage("write todos");
      const state = loadTodoStore(todoStorePathFromRoot(stateRoot));
      const audits = store.listAuditEvents(20);

      expect(result.text).toBe("todo persisted");
      expect(state.sessions[sessionId].todos).toEqual([
        { id: "finish", content: "Finish TodoWrite implementation", status: "in_progress" },
        { id: "verify", content: "Run verification", status: "pending", priority: "high" }
      ]);
      expect(audits).toContainEqual(
        expect.objectContaining({
          action: "agent.todo.updated",
          target: sessionId,
          metadata: expect.objectContaining({
            toolCallId: "todo-engine",
            todoCount: 2,
            statusCounts: { pending: 1, in_progress: 1, completed: 0 }
          })
        })
      );
      expect(store.getSession(sessionId)?.messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          content: expect.stringContaining("Todo list replaced (2 items)")
        })
      );
    } finally {
      store.close();
    }
  });

  it("records QueryEngine audit events for Config updates and Skill loads", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: path.join(workspace, ".magi-next") });
    ensureMagiHome(paths);
    const skillRoot = path.join(paths.skillsRoot, "audit-helper");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      path.join(skillRoot, "SKILL.md"),
      "# Audit Helper\n\nAudit helper body.\n",
      "utf8"
    );
    const store = new SessionStore(paths.sessionDbFile);
    try {
      const sessionId = store.createSession({ title: "audit tools", cwd: workspace });
      const adapter: ProviderAdapter = {
        name: "audit-tools-provider",
        complete: async (request) =>
          request.messages.some((message) => message.role === "tool")
            ? { text: "audited tools", usage: { inputTokens: 2, outputTokens: 3 } }
            : {
                text: "",
                toolUses: [
                  {
                    type: "tool-use",
                    id: "config-write",
                    name: "Config",
                    input: { setting: "context.recentMessages", value: 7 }
                  },
                  {
                    type: "tool-use",
                    id: "skill-audit",
                    name: "Skill",
                    input: { skill: "audit-helper", args: "audit me" }
                  }
                ]
              }
      };
      const engine = new QueryEngine({
        store,
        sessionId,
        jobId: "job-audit-tools",
        cwd: workspace,
        stateRoot: paths.stateRoot,
        permissionMode: "acceptEdits",
        toolRules: { allow: ["Config(*)", "Skill(*)"], ask: [], deny: [] },
        routes: [{ providerName: "audit-tools", model: "explicit", adapter }]
      });

      await engine.submitMessage("update config and load skill");
      const audits = store.listAuditEvents(30);
      expect(audits).toContainEqual(
        expect.objectContaining({
          action: "agent.config.updated",
          target: "context.recentMessages",
          metadata: expect.objectContaining({ toolCallId: "config-write", valueType: "number" })
        })
      );
      expect(audits).toContainEqual(
        expect.objectContaining({
          action: "agent.skill.loaded",
          target: "audit-helper",
          metadata: expect.objectContaining({ toolCallId: "skill-audit", argsProvided: true })
        })
      );
    } finally {
      store.close();
    }
  });

  it("recovers prior summary and recent messages before submitting a query", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const store = new SessionStore(path.join(workspace, ".magi-next", "state", "sessions.sqlite"));
    const seen: string[] = [];
    try {
      const sessionId = store.createSession({ title: "engine", cwd: workspace });
      store.recordContextSummary({
        sessionId,
        summary: "FACT: previous summary survives",
        sourceMessageCount: 5
      });
      store.appendMessage({ sessionId, role: "user", content: "old user" });
      store.appendMessage({ sessionId, role: "assistant", content: "old assistant" });
      const adapter: ProviderAdapter = {
        name: "context-provider",
        complete: async (request) => {
          seen.push(
            request.messages
              .map(
                (message) =>
                  `${message.role}:${message.content
                    .map((part) => {
                      if (part.type === "text") return part.text;
                      if (part.type === "tool-result") return part.content;
                      if (part.type === "tool-use")
                        return `${part.name}:${JSON.stringify(part.input)}`;
                      return "";
                    })
                    .join("")}`
              )
              .join("\n")
          );
          return { text: "context ok" };
        }
      };
      const engine = new QueryEngine({
        store,
        sessionId,
        jobId: "job-context",
        cwd: workspace,
        routes: [{ providerName: "context", model: "explicit", adapter }],
        contextOptions: { recentMessages: 2 }
      });

      await engine.submitMessage("new prompt");

      expect(seen[0]).toContain(
        "system:[Previous conversation summary]\nFACT: previous summary survives"
      );
      expect(seen[0]).toContain("user:old user");
      expect(seen[0]).toContain("assistant:old assistant");
      expect(seen[0]).toContain("user:new prompt");
    } finally {
      store.close();
    }
  });

  it("recovers historical tool results as text context instead of orphan tool messages", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const store = new SessionStore(path.join(workspace, ".magi-next", "state", "sessions.sqlite"));
    const seen: string[] = [];
    try {
      const sessionId = store.createSession({ title: "tool history", cwd: workspace });
      store.appendMessage({ sessionId, role: "user", content: "old task" });
      store.appendMessage({
        sessionId,
        role: "tool",
        content: "Command exited 0\nstdout:\nold output",
        metadata: { toolCallId: "bash-old", toolName: "Bash" }
      });
      store.appendMessage({ sessionId, role: "assistant", content: "old final" });
      const adapter: ProviderAdapter = {
        name: "context-provider",
        complete: async (request) => {
          seen.push(
            request.messages
              .map(
                (message) =>
                  `${message.role}:${message.content
                    .map((part) => {
                      if (part.type === "text") return part.text;
                      if (part.type === "tool-result") return part.content;
                      return "";
                    })
                    .join("")}`
              )
              .join("\n")
          );
          expect(request.messages.some((message) => message.role === "tool")).toBe(false);
          return { text: "context ok" };
        }
      };
      const engine = new QueryEngine({
        store,
        sessionId,
        jobId: "job-tool-history",
        cwd: workspace,
        routes: [{ providerName: "context", model: "explicit", adapter }]
      });

      await engine.submitMessage("new prompt");

      expect(seen[0]).toContain("[Prior tool results]");
      expect(seen[0]).toContain("Bash (bash-old) completed");
      expect(seen[0]).toContain("old output");
      expect(seen[0]).toContain("user:new prompt");
    } finally {
      store.close();
    }
  });

  it("injects relevant layered memory into QueryEngine context", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: path.join(workspace, ".magi-next") });
    ensureMagiHome(paths);
    const store = SessionStore.open(paths);
    const seen: string[] = [];
    try {
      const sessionId = store.createSession({ title: "memory context", cwd: workspace });
      appendMemory({ paths, scope: "user", cwd: workspace, text: "theme: quiet interface" });
      appendMemory({ paths, scope: "project", cwd: workspace, text: "api style: explicit routes" });
      appendMemory({
        paths,
        scope: "session",
        cwd: workspace,
        sessionId,
        text: "api current task: event streaming"
      });
      const adapter: ProviderAdapter = {
        name: "memory-provider",
        complete: async (request) => {
          seen.push(
            request.messages
              .map(
                (message) =>
                  `${message.role}:${message.content
                    .map((part) => {
                      if (part.type === "text") return part.text;
                      if (part.type === "tool-result") return part.content;
                      if (part.type === "tool-use")
                        return `${part.name}:${JSON.stringify(part.input)}`;
                      return "";
                    })
                    .join("")}`
              )
              .join("\n")
          );
          return { text: "memory ok" };
        }
      };
      const engine = new QueryEngine({
        store,
        sessionId,
        jobId: "job-memory-context",
        cwd: workspace,
        routes: [{ providerName: "memory", model: "explicit", adapter }],
        memoryOptions: {
          paths,
          enabled: true,
          autoWrite: "explicit",
          maxResults: 4,
          scopes: ["user", "project", "session"]
        }
      });

      await engine.submitMessage("continue api event streaming work");

      expect(seen[0]).toContain("[Relevant Memory]");
      expect(seen[0]).toContain("session: api current task: event streaming");
      expect(seen[0]).toContain("project: api style: explicit routes");
      expect(store.listAuditEvents(20)).toContainEqual(
        expect.objectContaining({
          action: "agent.memory.retrieved",
          metadata: expect.objectContaining({
            resultCount: 2,
            method: "wiki-search",
            sources: ["legacy"]
          })
        })
      );
    } finally {
      store.close();
    }
  });

  it("injects only active session goals into QueryEngine context", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: path.join(workspace, ".magi-next") });
    ensureMagiHome(paths);
    const store = SessionStore.open(paths);
    const seen: string[] = [];
    try {
      const sessionId = store.createSession({ title: "active goal context", cwd: workspace });
      createGoal(paths, { sessionId, objective: "finish the release audit" });

      await submitWithCapturedContext({
        store,
        sessionId,
        jobId: "job-active-goal-context",
        cwd: workspace,
        paths,
        seen,
        prompt: "continue"
      });
      expect(seen.at(-1)).toContain("<active_thread_goal>");
      expect(seen.at(-1)).toContain("Objective: finish the release audit");

      updateGoalStatus(paths, { sessionId, status: "completed", note: "verified" });
      await submitWithCapturedContext({
        store,
        sessionId,
        jobId: "job-completed-goal-context",
        cwd: workspace,
        paths,
        seen,
        prompt: "continue again"
      });
      expect(seen.at(-1)).not.toContain("<active_thread_goal>");
      expect(seen.at(-1)).not.toContain("finish the release audit");
    } finally {
      store.close();
    }
  });

  it("injects latest session plan context into QueryEngine context", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: path.join(workspace, ".magi-next") });
    ensureMagiHome(paths);
    const store = SessionStore.open(paths);
    const seen: string[] = [];
    try {
      const sessionId = store.createSession({ title: "plan context", cwd: workspace });
      const { recordPlanReview } = await import("../src/plan-state.js");
      const original = recordPlanReview({
        stateRoot: paths.stateRoot,
        sessionId,
        plan: "1. Skip inspection\n2. Edit immediately",
        status: "needs_revision",
        response: "No, revise"
      });
      const approved = recordPlanReview({
        stateRoot: paths.stateRoot,
        sessionId,
        plan: "1. Inspect first\n2. Apply focused edit\n3. Verify",
        status: "approved",
        response: "Yes, proceed",
        revisesPlanId: original.id
      });

      await submitWithCapturedContext({
        store,
        sessionId,
        jobId: "job-plan-context",
        cwd: workspace,
        paths,
        seen,
        prompt: "continue plan"
      });

      expect(seen.at(-1)).toContain("<session_plan_context>");
      expect(seen.at(-1)).toContain(`Plan id: ${approved.id}`);
      expect(seen.at(-1)).toContain(`Revises plan: ${original.id}`);
      expect(seen.at(-1)).toContain("1. Inspect first");
      expect(seen.at(-1)).not.toContain("Skip inspection");
    } finally {
      store.close();
    }
  });

  it("blocks inherited plan writes until the required file read has happened", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: path.join(workspace, ".magi-next") });
    ensureMagiHome(paths);
    writeFileSync(path.join(workspace, "guarded.txt"), "before\n", "utf8");
    const store = SessionStore.open(paths);
    try {
      const sessionId = store.createSession({ title: "plan guard", cwd: workspace });
      const { recordPlanReview } = await import("../src/plan-state.js");
      recordPlanReview({
        stateRoot: paths.stateRoot,
        sessionId,
        plan: "1. Read guarded.txt before writing\n2. Write guarded.txt",
        status: "approved",
        response: "Yes, proceed"
      });
      let calls = 0;
      const adapter: ProviderAdapter = {
        name: "plan-guard-provider",
        complete: async (request) => {
          calls += 1;
          const transcript = request.messages.map((message) => messageText(message)).join("\n");
          if (calls === 1) {
            return {
              text: "",
              toolUses: [
                {
                  type: "tool-use",
                  id: "write-too-soon",
                  name: "FileWrite",
                  input: { file_path: "guarded.txt", content: "after\n" }
                }
              ]
            };
          }
          if (calls === 2) {
            expect(transcript).toContain("Plan execution guard");
            return {
              text: "",
              toolUses: [
                {
                  type: "tool-use",
                  id: "read-required",
                  name: "FileRead",
                  input: { file_path: "guarded.txt" }
                }
              ]
            };
          }
          if (calls === 3) {
            expect(transcript).toContain("Read guarded.txt");
            return {
              text: "",
              toolUses: [
                {
                  type: "tool-use",
                  id: "write-after-read",
                  name: "FileWrite",
                  input: { file_path: "guarded.txt", content: "after\n" }
                }
              ]
            };
          }
          return { text: "guard fixed" };
        }
      };
      const engine = new QueryEngine({
        store,
        sessionId,
        jobId: "job-plan-guard",
        cwd: workspace,
        routes: [{ providerName: "guard", model: "mock", adapter }],
        permissionMode: "acceptEdits",
        memoryOptions: { paths, enabled: false }
      });

      const result = await engine.submitMessage("continue guarded plan");

      expect(result.text).toBe("guard fixed");
      await expect(readFile(path.join(workspace, "guarded.txt"), "utf8")).resolves.toBe("after\n");
      expect(store.listSessionAuditEvents(sessionId, 20)).toContainEqual(
        expect.objectContaining({
          action: "agent.plan.guard.blocked",
          target: "FileWrite"
        })
      );
    } finally {
      store.close();
    }
  });

  it("injects graph-backed wiki memory into QueryEngine context for a user workflow question", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: path.join(workspace, ".magi-next") });
    ensureMagiHome(paths);
    const store = SessionStore.open(paths);
    const seen: string[] = [];
    try {
      const sessionId = store.createSession({ title: "wiki memory context", cwd: workspace });
      appendMemoryFile({
        appRoot: paths.root,
        filePath: "workflows/release.md",
        content: [
          "## Release verification",
          "Run focused tests, typecheck, and build before broad checks.",
          "Summarize only key results and next action."
        ].join("\n")
      });
      const adapter: ProviderAdapter = {
        name: "wiki-memory-provider",
        complete: async (request) => {
          seen.push(
            request.messages
              .map(
                (message) =>
                  `${message.role}:${message.content
                    .map((part) => {
                      if (part.type === "text") return part.text;
                      if (part.type === "tool-result") return part.content;
                      if (part.type === "tool-use")
                        return `${part.name}:${JSON.stringify(part.input)}`;
                      return "";
                    })
                    .join("")}`
              )
              .join("\n")
          );
          return { text: "use release verification workflow" };
        }
      };
      const engine = new QueryEngine({
        store,
        sessionId,
        jobId: "job-wiki-memory-context",
        cwd: workspace,
        routes: [{ providerName: "memory", model: "explicit", adapter }],
        memoryOptions: {
          paths,
          enabled: true,
          autoWrite: "explicit",
          maxResults: 4,
          scopes: ["user", "project", "session"]
        }
      });

      await engine.submitMessage("How should I do release verification?");

      expect(seen[0]).toContain("[Relevant Memory]");
      expect(seen[0]).toContain("## Release verification");
      expect(seen[0]).toContain("source: workflows/release.md#Release verification");
      expect(seen[0]).toContain("node:");
      expect(seen[0]).toContain("Run focused tests, typecheck, and build before broad checks.");

      const audit = store
        .listJobAuditEvents("job-wiki-memory-context", 20)
        .find((event) => event.action === "agent.memory.retrieved");
      expect(audit).toMatchObject({
        metadata: expect.objectContaining({
          method: "wiki-search",
          sources: ["graph"],
          graphResultCount: 1,
          files: expect.arrayContaining(["workflows/release.md#Release verification"])
        })
      });
      const nodeId = /node: ([^\n]+)/.exec(seen[0])?.[1];
      expect(nodeId).toBeDefined();
      const nodeStore = MemoryNodeStore.open(paths);
      try {
        expect(nodeStore.getNode(nodeId!)?.useCount).toBe(1);
      } finally {
        nodeStore.close();
      }
    } finally {
      store.close();
    }
  });

  it("keeps pre-task recall clean for ordinary local file operations", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: path.join(workspace, ".magi-next") });
    ensureMagiHome(paths);
    const store = SessionStore.open(paths);
    const seen: string[] = [];
    try {
      const sessionId = store.createSession({ title: "clean file recall", cwd: workspace });
      appendMemoryFile({
        appRoot: paths.root,
        filePath: "workflows/release.md",
        content: [
          "## Release verification",
          "Run focused tests, typecheck, and build before broad checks."
        ].join("\n")
      });
      const skillRoot = path.join(paths.skillsRoot, "li-li-research-sense");
      mkdirSync(skillRoot, { recursive: true });
      writeFileSync(
        path.join(skillRoot, "SKILL.md"),
        [
          "# Li Li Research Sense",
          "",
          "Use for hydrology manuscript writing and research framing."
        ].join("\n"),
        "utf8"
      );
      const nodeStore = MemoryNodeStore.open(paths);
      nodeStore.upsertNode({
        type: "project",
        title: "GeoMind Next project memory",
        summary: "GeoMind Next is a later development focus.",
        body: "GeoMind Next project details should not affect unrelated local file operations.",
        source: "explicit",
        weight: 0.95
      });
      nodeStore.close();

      await submitWithCapturedContext({
        store,
        sessionId,
        jobId: "job-clean-file-recall",
        cwd: workspace,
        paths,
        seen,
        prompt:
          "在 /Users/ktz/Desktop/magi-baseline-01/APPEND_TEST.txt 做检查，不要使用 shell 重定向覆盖已有文件"
      });

      expect(seen[0]).not.toContain("[Relevant Memory]");
      expect(seen[0]).not.toContain("[Relevant Skills]");
      expect(seen[0]).not.toContain("[Relevant Prior Sessions]");
      expect(seen[0]).not.toContain("[Hot Memory]");
      expect(seen[0]).not.toContain("Release verification");
      // The always-present [Available Skills] index lists installed skills by
      // name; what must stay out of an unrelated task is the full skill body.
      expect(seen[0]).toContain("[Available Skills]");
      expect(seen[0]).not.toContain("Use for hydrology manuscript writing");
      expect(seen[0]).not.toContain("GeoMind Next");

      const decision = store
        .listJobAuditEvents("job-clean-file-recall", 30)
        .find((event) => event.action === "agent.recall.decision");
      expect(decision?.metadata).toMatchObject({
        taskKind: "tool_execution",
        budgets: {
          hotMemory: 3,
          memorySearch: 0,
          session: 0,
          skill: 0
        }
      });
      expect(store.listJobAuditEvents("job-clean-file-recall", 30)).toContainEqual(
        expect.objectContaining({
          action: "agent.memory.retrieved",
          metadata: expect.objectContaining({
            decision: "skipped",
            resultCount: 0,
            rawResultCount: 0
          })
        })
      );
      expect(store.listJobAuditEvents("job-clean-file-recall", 30)).toContainEqual(
        expect.objectContaining({
          action: "agent.skills.recalled",
          metadata: expect.objectContaining({
            decision: "skipped",
            resultCount: 0,
            skills: []
          })
        })
      );
      expect(store.listJobAuditEvents("job-clean-file-recall", 30)).toContainEqual(
        expect.objectContaining({
          action: "agent.session.recalled",
          metadata: expect.objectContaining({
            decision: "skipped",
            resultCount: 0,
            sessions: []
          })
        })
      );
    } finally {
      store.close();
    }
  });

  it("does not inject overlapping project memory through global hot memory", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: path.join(workspace, ".magi-next") });
    ensureMagiHome(paths);
    const store = SessionStore.open(paths);
    const seen: string[] = [];
    try {
      const nodeStore = MemoryNodeStore.open(paths);
      nodeStore.upsertNode({
        type: "project",
        title: "GeoMind Next project memory",
        summary: "GeoMind Next is a later development focus.",
        body: "GeoMind Next project details should not affect unrelated Magi sessions.",
        source: "explicit",
        weight: 1
      });
      nodeStore.close();

      await submitWithCapturedContext({
        store,
        sessionId: store.createSession({ title: "magi next clean hot memory", cwd: workspace }),
        jobId: "job-project-memory-not-hot",
        cwd: workspace,
        paths,
        seen,
        prompt: "你知道 Magi Next 吗"
      });

      expect(seen[0]).not.toContain("[Hot Memory]");
      expect(seen[0]).not.toContain("GeoMind Next");

      const audits = store.listJobAuditEvents("job-project-memory-not-hot", 50);
      expect(audits).toContainEqual(
        expect.objectContaining({
          action: "agent.memory.hot.injected",
          metadata: expect.objectContaining({
            decision: "skipped",
            resultCount: 0,
            skippedNodes: [
              expect.objectContaining({
                title: "GeoMind Next project memory",
                type: "project"
              })
            ]
          })
        })
      );
    } finally {
      store.close();
    }
  });

  it("keeps dynamic recall clean for no-evidence file tasks without invoking the model planner", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: path.join(workspace, ".magi-next") });
    ensureMagiHome(paths);
    const store = SessionStore.open(paths);
    const seen: string[] = [];
    try {
      appendMemory({
        paths,
        scope: "user",
        cwd: workspace,
        text: "project preference: always summarize route-clean tests"
      });
      const skillRoot = path.join(paths.skillsRoot, "route-clean-helper");
      mkdirSync(skillRoot, { recursive: true });
      writeFileSync(
        path.join(skillRoot, "SKILL.md"),
        "# Route Clean Helper\n\nUse for route cleanliness checks.\n",
        "utf8"
      );
      const nodeStore = MemoryNodeStore.open(paths);
      nodeStore.upsertNode({
        type: "preference",
        title: "Route clean preference",
        summary: "Always add route-clean commentary.",
        body: "Always add route-clean commentary.",
        source: "explicit",
        weight: 0.98
      });
      nodeStore.close();

      await submitWithCapturedContext({
        store,
        sessionId: store.createSession({ title: "route clean", cwd: workspace }),
        jobId: "job-model-route-clean-no-recall",
        cwd: workspace,
        paths,
        seen,
        prompt: [
          "在 ~/Desktop/magi-route-clean-04 创建一个文件 route-clean.txt，内容只写三行:",
          "",
          "route-clean-test",
          "no-memory-needed",
          "no-skills-needed",
          "",
          "不要读取历史记忆，不要调用 skills，不要做额外总结。完成后只回复文件路径。"
        ].join("\n")
      });

      expect(seen[0]).not.toContain("[Relevant Memory]");
      expect(seen[0]).not.toContain("[Relevant Skills]");
      expect(seen[0]).not.toContain("[Relevant Prior Sessions]");
      expect(seen[0]).toContain("[Hot Memory]");
      expect(seen[0]).toContain("route-clean commentary");
      // Index lists the skill name; the full body must not be injected for an
      // unrelated task.
      expect(seen[0]).toContain("[Available Skills]");
      expect(seen[0]).not.toContain("Use for route cleanliness checks");

      const audits = store.listJobAuditEvents("job-model-route-clean-no-recall", 50);
      const decision = audits.find((event) => event.action === "agent.recall.decision");
      expect(decision?.metadata).toMatchObject({
        taskKind: "tool_execution",
        method: "fallback",
        budgets: {
          hotMemory: 3,
          memorySearch: 0,
          session: 0,
          skill: 0
        },
        constraints: []
      });
      expect(audits).toContainEqual(
        expect.objectContaining({
          action: "agent.memory.retrieved",
          metadata: expect.objectContaining({
            decision: "skipped",
            resultCount: 0,
            rawResultCount: 0
          })
        })
      );
      expect(audits).toContainEqual(
        expect.objectContaining({
          action: "agent.memory.hot.injected",
          metadata: expect.objectContaining({
            decision: "injected",
            resultCount: 1,
            types: ["preference"]
          })
        })
      );
    } finally {
      store.close();
    }
  });

  it("preserves global hot memory even when the model planner declines recall", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: path.join(workspace, ".magi-next") });
    ensureMagiHome(paths);
    const store = SessionStore.open(paths);
    const seen: string[] = [];
    try {
      const nodeStore = MemoryNodeStore.open(paths);
      nodeStore.upsertNode({
        type: "user_profile",
        title: "User identity",
        summary: "Edward is the creator of Magi.",
        body: "Edward is the creator of Magi/Magi Next.",
        source: "explicit",
        weight: 1
      });
      nodeStore.close();

      await submitWithCapturedContext({
        store,
        sessionId: store.createSession({ title: "identity hot memory", cwd: workspace }),
        jobId: "job-model-hot-memory-default",
        cwd: workspace,
        paths,
        seen,
        prompt: "我是谁",
        recallPlannerResponse: noRecallPlannerPlan("conversation")
      });

      expect(seen[0]).toContain("[Hot Memory]");
      expect(seen[0]).toContain("Edward is the creator of Magi/Magi Next.");

      const audits = store.listJobAuditEvents("job-model-hot-memory-default", 50);
      const decision = audits.find((event) => event.action === "agent.recall.decision");
      expect(decision?.metadata).toMatchObject({
        method: "model",
        budgets: expect.objectContaining({ hotMemory: 3 }),
        reasons: expect.objectContaining({
          hotMemory: ["global hot memory is enabled by default"]
        })
      });
      expect(audits).toContainEqual(
        expect.objectContaining({
          action: "agent.memory.hot.injected",
          metadata: expect.objectContaining({
            decision: "injected",
            types: ["user_profile"],
            titles: ["User identity"]
          })
        })
      );
    } finally {
      store.close();
    }
  });

  it("keeps fallback dynamic recall clean while preserving global hot memory", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: path.join(workspace, ".magi-next") });
    ensureMagiHome(paths);
    const store = SessionStore.open(paths);
    const seen: string[] = [];
    try {
      appendMemory({
        paths,
        scope: "user",
        cwd: workspace,
        text: "route-clean fallback memory should stay out of clean file tasks"
      });
      const skillRoot = path.join(paths.skillsRoot, "route-clean-fallback-helper");
      mkdirSync(skillRoot, { recursive: true });
      writeFileSync(
        path.join(skillRoot, "SKILL.md"),
        "# Route Clean Fallback Helper\n\nUse for route cleanliness checks.\n",
        "utf8"
      );
      const nodeStore = MemoryNodeStore.open(paths);
      nodeStore.upsertNode({
        type: "preference",
        title: "Fallback route clean preference",
        summary: "Always add fallback route-clean commentary.",
        body: "Always add fallback route-clean commentary.",
        source: "explicit",
        weight: 0.98
      });
      nodeStore.close();

      await submitWithCapturedContext({
        store,
        sessionId: store.createSession({ title: "fallback route clean", cwd: workspace }),
        jobId: "job-fallback-route-clean-no-recall",
        cwd: workspace,
        paths,
        seen,
        prompt:
          "在 ~/Desktop/magi-route-clean-04 创建 route-clean.txt，只写 no-memory-needed 和 no-skills-needed。不要读取历史记忆，不要调用 skills。"
      });

      expect(seen[0]).not.toContain("[Relevant Memory]");
      expect(seen[0]).not.toContain("[Relevant Skills]");
      expect(seen[0]).not.toContain("[Relevant Prior Sessions]");
      expect(seen[0]).toContain("[Hot Memory]");
      expect(seen[0]).toContain("fallback route-clean commentary");
      // Index lists the skill name; the full body must not be injected for an
      // unrelated task.
      expect(seen[0]).toContain("[Available Skills]");
      expect(seen[0]).not.toContain("Use for route cleanliness checks");

      const decision = store
        .listJobAuditEvents("job-fallback-route-clean-no-recall", 50)
        .find((event) => event.action === "agent.recall.decision");
      expect(decision?.metadata).toMatchObject({
        taskKind: "tool_execution",
        method: "fallback",
        budgets: {
          hotMemory: 3,
          memorySearch: 0,
          session: 0,
          skill: 0
        }
      });
    } finally {
      store.close();
    }
  });

  it("keeps fallback dynamic memory clean for coding tasks while preserving hot memory", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: path.join(workspace, ".magi-next") });
    ensureMagiHome(paths);
    const store = SessionStore.open(paths);
    const seen: string[] = [];
    try {
      appendMemory({
        paths,
        scope: "user",
        cwd: workspace,
        text: "coding tasks should always include this hot memory if constraints fail"
      });
      const nodeStore = MemoryNodeStore.open(paths);
      nodeStore.upsertNode({
        type: "work_habit",
        title: "Debug habit",
        summary: "Always add debug habit context.",
        body: "Always add debug habit context.",
        source: "explicit",
        weight: 0.99
      });
      nodeStore.close();

      await submitWithCapturedContext({
        store,
        sessionId: store.createSession({ title: "fallback coding no recall", cwd: workspace }),
        jobId: "job-fallback-coding-no-recall",
        cwd: workspace,
        paths,
        seen,
        prompt: "修复这个 bug，不要读取历史记忆，不要调用 skills"
      });

      expect(seen[0]).not.toContain("[Relevant Memory]");
      expect(seen[0]).not.toContain("[Relevant Prior Sessions]");
      expect(seen[0]).toContain("[Hot Memory]");
      expect(seen[0]).toContain("Debug habit");

      const decision = store
        .listJobAuditEvents("job-fallback-coding-no-recall", 50)
        .find((event) => event.action === "agent.recall.decision");
      expect(decision?.metadata).toMatchObject({
        taskKind: "coding",
        method: "fallback",
        budgets: {
          hotMemory: 3,
          memorySearch: 0,
          session: 0,
          skill: 0
        },
        constraints: []
      });
      expect(
        store
          .listJobAuditEvents("job-fallback-coding-no-recall", 50)
          .some((event) => event.action === "agent.memory.hot.injected")
      ).toBe(true);
    } finally {
      store.close();
    }
  });

  it("enables memory and session recall when a file task references prior agreements", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: path.join(workspace, ".magi-next") });
    ensureMagiHome(paths);
    const store = SessionStore.open(paths);
    const seen: string[] = [];
    try {
      const prior = store.createSession({ title: "README convention", cwd: workspace });
      store.appendMessage({
        sessionId: prior,
        role: "user",
        content:
          "For baseline README files, keep the heading and avoid overwriting existing content."
      });
      store.appendMessage({
        sessionId: prior,
        role: "assistant",
        content: "Agreed: preserve existing README content and report the path checked."
      });
      const sessionId = store.createSession({ title: "agreement file task", cwd: workspace });
      appendMemory({
        paths,
        scope: "user",
        cwd: workspace,
        text: "previous agreement: preserve existing README files before writing notes"
      });

      await submitWithCapturedContext({
        store,
        sessionId,
        jobId: "job-prior-agreement-file-recall",
        cwd: workspace,
        paths,
        seen,
        prompt: "根据我们之前的约定，检查 /Users/ktz/Desktop/magi-baseline-01/README.md，不要覆盖它"
      });

      expect(seen[0]).toContain("[Relevant Memory]");
      expect(seen[0]).toContain("previous agreement: preserve existing README files");
      expect(seen[0]).toContain("[Relevant Prior Sessions]");
      expect(seen[0]).toContain("README convention");

      const decision = store
        .listJobAuditEvents("job-prior-agreement-file-recall", 30)
        .find((event) => event.action === "agent.recall.decision");
      expect(decision?.metadata).toMatchObject({
        taskKind: "memory_dependent",
        budgets: expect.objectContaining({
          memorySearch: 5,
          session: 3
        })
      });
    } finally {
      store.close();
    }
  });

  it("recalls skills only from high-confidence name or summary evidence", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: path.join(workspace, ".magi-next") });
    ensureMagiHome(paths);
    const store = SessionStore.open(paths);
    const seen: string[] = [];
    try {
      const verifyRoot = path.join(paths.skillsRoot, "verify-release");
      mkdirSync(verifyRoot, { recursive: true });
      writeFileSync(
        path.join(verifyRoot, "SKILL.md"),
        [
          "# Verify Release",
          "",
          "Run focused release verification checks before publishing.",
          "",
          "Common words such as file and create live in this body."
        ].join("\n"),
        "utf8"
      );
      const unrelatedRoot = path.join(paths.skillsRoot, "hydrology-research-sense");
      mkdirSync(unrelatedRoot, { recursive: true });
      writeFileSync(
        path.join(unrelatedRoot, "SKILL.md"),
        [
          "# Hydrology Research Sense",
          "",
          "Use for manuscript framing.",
          "",
          "This body also mentions release verification checks."
        ].join("\n"),
        "utf8"
      );
      const sessionId = store.createSession({ title: "skill evidence", cwd: workspace });

      await submitWithCapturedContext({
        store,
        sessionId,
        jobId: "job-skill-evidence",
        cwd: workspace,
        paths,
        seen,
        prompt: "Use the verify-release skill for this release"
      });

      expect(seen[0]).toContain("[Relevant Skills]");
      expect(seen[0]).toContain("## verify-release");
      expect(seen[0]).not.toContain("## hydrology-research-sense");
      expect(store.listJobAuditEvents("job-skill-evidence", 30)).toContainEqual(
        expect.objectContaining({
          action: "agent.skills.recalled",
          metadata: expect.objectContaining({
            decision: "injected",
            skills: ["verify-release"]
          })
        })
      );
    } finally {
      store.close();
    }
  });

  it("matches hyphenated skill names when the user types natural spaced words", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: path.join(workspace, ".magi-next") });
    ensureMagiHome(paths);
    const store = SessionStore.open(paths);
    const seen: string[] = [];
    try {
      const skillRoot = path.join(paths.skillsRoot, "blackbox-verify");
      mkdirSync(skillRoot, { recursive: true });
      writeFileSync(
        path.join(skillRoot, "SKILL.md"),
        [
          "# Blackbox Verify",
          "",
          "Run isolated provider validation before broad checks.",
          "",
          "## Steps",
          "",
          "1. Start a mock provider.",
          "2. Run focused black-box CLI flow."
        ].join("\n"),
        "utf8"
      );

      await submitWithCapturedContext({
        store,
        sessionId: store.createSession({ title: "spaced hyphen skill", cwd: workspace }),
        jobId: "job-spaced-hyphen-skill",
        cwd: workspace,
        paths,
        seen,
        prompt: "Use the blackbox verify skill for isolated provider validation."
      });

      expect(seen[0]).toContain("[Relevant Skills]");
      expect(seen[0]).toContain("## blackbox-verify");
      expect(seen[0]).toContain("Run isolated provider validation before broad checks.");
      expect(store.listJobAuditEvents("job-spaced-hyphen-skill", 30)).toContainEqual(
        expect.objectContaining({
          action: "agent.skills.recalled",
          metadata: expect.objectContaining({
            decision: "injected",
            skills: expect.arrayContaining(["blackbox-verify"])
          })
        })
      );
    } finally {
      store.close();
    }
  });

  it("loads model-selected skills from summaries without requiring explicit skill wording", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: path.join(workspace, ".magi-next") });
    ensureMagiHome(paths);
    const store = SessionStore.open(paths);
    const seen: string[] = [];
    try {
      const reviewRoot = path.join(paths.skillsRoot, "review-pr");
      mkdirSync(reviewRoot, { recursive: true });
      writeFileSync(
        path.join(reviewRoot, "SKILL.md"),
        [
          "# Review PR",
          "",
          "Use for pull request review, regression risk analysis, and missing-test checks.",
          "",
          "Review changed files, call out bugs first, and keep summaries secondary."
        ].join("\n"),
        "utf8"
      );
      const unrelatedRoot = path.join(paths.skillsRoot, "release-notes");
      mkdirSync(unrelatedRoot, { recursive: true });
      writeFileSync(
        path.join(unrelatedRoot, "SKILL.md"),
        "# Release Notes\n\nUse for drafting customer-facing release notes.\n",
        "utf8"
      );

      await submitWithCapturedContext({
        store,
        sessionId: store.createSession({ title: "summary selected skill", cwd: workspace }),
        jobId: "job-model-selected-skill",
        cwd: workspace,
        paths,
        seen,
        prompt: "检查这个 PR 的风险并给出审查结论",
        recallPlannerResponse: {
          taskKind: "skill_dependent",
          sources: {
            hotMemory: {
              needed: false,
              budget: 0,
              reason: "PR review does not require durable preferences"
            },
            memorySearch: {
              needed: false,
              budget: 0,
              reason: "No prior project memory is required"
            },
            session: { needed: false, budget: 0, reason: "No earlier session is referenced" },
            skill: {
              needed: true,
              budget: 1,
              reason: "review-pr summarizes pull request review and regression risk analysis",
              skills: ["review-pr"]
            }
          },
          constraints: []
        }
      });

      expect(seen[0]).toContain("[Relevant Skills]");
      expect(seen[0]).toContain("## review-pr");
      expect(seen[0]).not.toContain("## release-notes");
      expect(store.listJobAuditEvents("job-model-selected-skill", 30)).toContainEqual(
        expect.objectContaining({
          action: "agent.skills.recalled",
          metadata: expect.objectContaining({
            decision: "injected",
            skills: ["review-pr"],
            skillMatchedTerms: [
              expect.objectContaining({
                skill: "review-pr",
                terms: ["model-selected"]
              })
            ]
          })
        })
      );
    } finally {
      store.close();
    }
  });

  it("keeps skill metadata available for model planning when skill wording is limiting", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: path.join(workspace, ".magi-next") });
    ensureMagiHome(paths);
    const store = SessionStore.open(paths);
    const seen: string[] = [];
    const seenPlannerPrompts: string[] = [];
    try {
      appendMemory({
        paths,
        scope: "user",
        cwd: workspace,
        text: "project review memory exists only to make recall planner inventory non-empty"
      });
      const reviewRoot = path.join(paths.skillsRoot, "review-pr");
      mkdirSync(reviewRoot, { recursive: true });
      writeFileSync(
        path.join(reviewRoot, "SKILL.md"),
        [
          "# Review PR",
          "",
          "Use for pull request review, regression risk analysis, and missing-test checks."
        ].join("\n"),
        "utf8"
      );

      await submitWithCapturedContext({
        store,
        sessionId: store.createSession({ title: "planner selective skills", cwd: workspace }),
        jobId: "job-model-selective-skill-metadata",
        cwd: workspace,
        paths,
        seen,
        seenRecallPlannerPrompts: seenPlannerPrompts,
        prompt:
          "检查代码风险，可以使用一个明确相关的 review skill，如果存在。不要因为我提到 skill 就加载全部 skills。",
        recallPlannerResponse: {
          taskKind: "skill_dependent",
          sources: {
            hotMemory: { needed: false, budget: 0, reason: "No durable preference is required" },
            memorySearch: { needed: false, budget: 0, reason: "No stored memory is required" },
            session: { needed: false, budget: 0, reason: "No prior session is referenced" },
            skill: {
              needed: true,
              budget: 1,
              reason: "review-pr is clearly related to code review risk analysis",
              skills: ["review-pr"]
            }
          },
          constraints: []
        }
      });

      expect(seenPlannerPrompts).toHaveLength(1);
      expect(seenPlannerPrompts[0]).toContain("skills available: yes");
      expect(seenPlannerPrompts[0]).toContain("review-pr");
      expect(seen[0]).toContain("[Relevant Skills]");
      expect(seen[0]).toContain("## review-pr");

      const decision = store
        .listJobAuditEvents("job-model-selective-skill-metadata", 30)
        .find((event) => event.action === "agent.recall.decision");
      expect(decision?.metadata).toMatchObject({
        method: "model",
        budgets: expect.objectContaining({ skill: 1 }),
        constraints: []
      });
      expect(store.listJobAuditEvents("job-model-selective-skill-metadata", 30)).toContainEqual(
        expect.objectContaining({
          action: "agent.skills.recalled",
          metadata: expect.objectContaining({
            decision: "injected",
            skills: ["review-pr"]
          })
        })
      );
    } finally {
      store.close();
    }
  });

  it("uses updated wiki graph memory and does not inject stale workflow text", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: path.join(workspace, ".magi-next") });
    ensureMagiHome(paths);
    const store = SessionStore.open(paths);
    const seen: string[] = [];
    try {
      const sessionId = store.createSession({ title: "wiki memory update", cwd: workspace });
      appendMemoryFile({
        appRoot: paths.root,
        filePath: "workflows/release.md",
        content: ["## Release verification", "Old workflow: run only broad checks."].join("\n")
      });
      await submitWithCapturedContext({
        store,
        sessionId,
        jobId: "job-wiki-memory-old",
        cwd: workspace,
        paths,
        seen,
        prompt: "How should I do release verification?"
      });

      writeFileSync(
        path.join(paths.root, "memory", "workflows", "release.md"),
        [
          "# Release",
          "",
          "## Release verification",
          "Updated workflow: run focused tests and typecheck before broad checks."
        ].join("\n"),
        "utf8"
      );
      await submitWithCapturedContext({
        store,
        sessionId,
        jobId: "job-wiki-memory-updated",
        cwd: workspace,
        paths,
        seen,
        prompt: "How should I do release verification now?"
      });

      const latest = seen.at(-1)!;
      expect(latest).toContain(
        "Updated workflow: run focused tests and typecheck before broad checks."
      );
      expect(latest).not.toContain("Old workflow: run only broad checks.");
      const nodeStore = MemoryNodeStore.open(paths);
      try {
        const source = nodeStore.getSourceByUri("memory/workflows/release.md");
        expect(source).toBeDefined();
        const chunks = nodeStore.listChunksForSource(source!.id);
        expect(chunks).toHaveLength(1);
        expect(chunks[0].body).toContain("Updated workflow");
        expect(chunks[0].body).not.toContain("Old workflow");
        expect(nodeStore.searchGraph({ query: "old only", limit: 5 })).toHaveLength(0);
      } finally {
        nodeStore.close();
      }
    } finally {
      store.close();
    }
  });

  it("does not inject graph memory after the backing wiki file is deleted", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: path.join(workspace, ".magi-next") });
    ensureMagiHome(paths);
    const store = SessionStore.open(paths);
    const seen: string[] = [];
    try {
      const sessionId = store.createSession({ title: "wiki memory delete", cwd: workspace });
      appendMemoryFile({
        appRoot: paths.root,
        filePath: "workflows/release.md",
        content: [
          "## Release verification",
          "Deleted workflow should not appear after file removal."
        ].join("\n")
      });
      await submitWithCapturedContext({
        store,
        sessionId,
        jobId: "job-wiki-memory-before-delete",
        cwd: workspace,
        paths,
        seen,
        prompt: "How should I do release verification?"
      });
      rmSync(path.join(paths.root, "memory", "workflows", "release.md"));
      await submitWithCapturedContext({
        store,
        sessionId,
        jobId: "job-wiki-memory-after-delete",
        cwd: workspace,
        paths,
        seen,
        prompt: "How should I do release verification?"
      });

      const latest = seen.at(-1)!;
      expect(latest).not.toContain("Deleted workflow should not appear after file removal.");
      const audit = store
        .listJobAuditEvents("job-wiki-memory-after-delete", 20)
        .find((event) => event.action === "agent.memory.retrieved");
      expect(audit?.metadata).toMatchObject({
        sources: [],
        graphResultCount: 0,
        resultCount: 0
      });
      const nodeStore = MemoryNodeStore.open(paths);
      try {
        expect(nodeStore.getSourceByUri("memory/workflows/release.md")?.status).toBe("archived");
      } finally {
        nodeStore.close();
      }
    } finally {
      store.close();
    }
  });

  it("injects graph-backed memdir memory for legacy reference questions", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: path.join(workspace, ".magi-next") });
    ensureMagiHome(paths);
    const store = SessionStore.open(paths);
    const seen: string[] = [];
    try {
      const sessionId = store.createSession({ title: "memdir graph memory", cwd: workspace });
      writeMemdirEntry({
        paths,
        type: "reference",
        name: "Release dashboard",
        description: "Dashboard for release verification",
        body: "Open the release dashboard before publishing."
      });
      await submitWithCapturedContext({
        store,
        sessionId,
        jobId: "job-memdir-memory-context",
        cwd: workspace,
        paths,
        seen,
        prompt: "Where is the release dashboard?"
      });

      const transcript = seen[0];
      expect(transcript).toContain("[Relevant Memory]");
      expect(transcript).toContain("## Release dashboard");
      expect(transcript).toContain("source: memdir/reference_release_dashboard.md");
      expect(transcript).toContain("Open the release dashboard before publishing.");
      const audit = store
        .listJobAuditEvents("job-memdir-memory-context", 20)
        .find((event) => event.action === "agent.memory.retrieved");
      expect(audit?.metadata).toMatchObject({
        sources: ["graph"],
        sourceKinds: ["memdir"],
        graphResultCount: 1
      });
    } finally {
      store.close();
    }
  });

  it("does not inject default template memory for generic workflow questions", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: path.join(workspace, ".magi-next") });
    ensureMagiHome(paths);
    const store = SessionStore.open(paths);
    const seen: string[] = [];
    try {
      const sessionId = store.createSession({ title: "template noise", cwd: workspace });
      await submitWithCapturedContext({
        store,
        sessionId,
        jobId: "job-template-noise",
        cwd: workspace,
        paths,
        seen,
        prompt: "How should I work?"
      });

      expect(seen[0]).not.toContain("[Relevant Memory]");
      expect(seen[0]).not.toContain("Permissions Policy");
      expect(seen[0]).not.toContain("Skill-specific memory");
      const audit = store
        .listJobAuditEvents("job-template-noise", 20)
        .find((event) => event.action === "agent.memory.retrieved");
      expect(audit?.metadata).toMatchObject({
        resultCount: 0,
        graphResultCount: 0
      });
    } finally {
      store.close();
    }
  });

  it("writes explicit memory prompts directly to weighted memory nodes without inferring ordinary chat", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: path.join(workspace, ".magi-next") });
    ensureMagiHome(paths);
    const store = SessionStore.open(paths);
    try {
      const sessionId = store.createSession({ title: "memory write", cwd: workspace });
      const adapter: ProviderAdapter = {
        name: "memory-write-provider",
        complete: async () => ({ text: "remembered" })
      };
      const engine = new QueryEngine({
        store,
        sessionId,
        jobId: "job-memory-write",
        cwd: workspace,
        routes: [{ providerName: "memory-write", model: "explicit", adapter }],
        memoryOptions: {
          paths,
          enabled: true,
          autoWrite: "explicit",
          maxResults: 4,
          scopes: ["user", "project", "session"]
        }
      });

      await engine.submitMessage("remember session: handoff: finish memory tests");

      expect(readMemory({ paths, scope: "session", cwd: workspace, sessionId })).toContain(
        "handoff: finish memory tests"
      );
      const nodeStore = MemoryNodeStore.open(paths);
      const nodes = nodeStore.listHotNodes({ limit: 10, minWeight: 0 });
      nodeStore.close();
      const node = nodes.find((item) => item.body === "handoff: finish memory tests");
      expect(node).toBeDefined();
      expect(node).toMatchObject({
        type: "session",
        source: "explicit",
        sourceSessionId: sessionId
      });
      expect(store.listAuditEvents(20)).toContainEqual(
        expect.objectContaining({
          action: "agent.memory.written",
          target: node!.id,
          metadata: expect.objectContaining({ nodeId: node!.id, scope: "session" })
        })
      );

      const second = new QueryEngine({
        store,
        sessionId,
        jobId: "job-memory-no-write",
        cwd: workspace,
        routes: [{ providerName: "memory-write", model: "explicit", adapter }],
        memoryOptions: {
          paths,
          enabled: true,
          autoWrite: "explicit",
          maxResults: 4,
          scopes: ["user", "project", "session"]
        }
      });
      await second.submitMessage("handoff should finish memory tests");
      const afterNoWriteStore = MemoryNodeStore.open(paths);
      expect(
        afterNoWriteStore
          .listHotNodes({ limit: 10, minWeight: 0 })
          .filter((item) => item.body.includes("handoff")).length
      ).toBe(1);
      afterNoWriteStore.close();
    } finally {
      store.close();
    }
  });

  it("injects explicit user memory nodes into the next query without keyword retrieval", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: path.join(workspace, ".magi-next") });
    ensureMagiHome(paths);
    const store = SessionStore.open(paths);
    const seen: string[] = [];
    try {
      const durableFact = "User prefers focused checks before broad checks";
      const sessionId = store.createSession({ title: "user memory", cwd: workspace });
      const writer: ProviderAdapter = {
        name: "memory-writer",
        complete: async () => ({ text: "remembered" })
      };
      await new QueryEngine({
        store,
        sessionId,
        jobId: "job-memory-user-write",
        cwd: workspace,
        routes: [{ providerName: "memory", model: "writer", adapter: writer }],
        memoryOptions: {
          paths,
          enabled: true,
          autoWrite: "explicit",
          maxResults: 4,
          scopes: ["user", "project", "session"]
        }
      }).submitMessage(`remember ${durableFact}`);

      const nodeStore = MemoryNodeStore.open(paths);
      const durableNode = nodeStore
        .listHotNodes({ limit: 10, minWeight: 0 })
        .find((node) => node.body === durableFact);
      nodeStore.close();
      expect(durableNode).toMatchObject({
        type: "work_habit",
        title: expect.stringContaining("Work habit")
      });

      const reader: ProviderAdapter = {
        name: "memory-reader",
        complete: async (request) => {
          seen.push(
            request.messages
              .map(
                (message) =>
                  `${message.role}:${message.content.map((part) => (part.type === "text" ? part.text : "")).join("")}`
              )
              .join("\n")
          );
          return { text: "ok" };
        }
      };
      await new QueryEngine({
        store,
        sessionId,
        jobId: "job-memory-user-read",
        cwd: workspace,
        routes: [{ providerName: "memory", model: "reader", adapter: reader }],
        memoryOptions: {
          paths,
          enabled: true,
          autoWrite: "explicit",
          maxResults: 4,
          scopes: ["user", "project", "session"]
        }
      }).submitMessage("What user preference do I have about focused checks?");

      expect(seen[0]).toContain("[Hot Memory]");
      expect(seen[0]).toContain(durableFact);
      expect(store.listJobAuditEvents("job-memory-user-read", 20)).toContainEqual(
        expect.objectContaining({
          action: "agent.memory.hot.injected",
          metadata: expect.objectContaining({
            resultCount: expect.any(Number),
            nodeIds: expect.arrayContaining([durableNode!.id]),
            types: expect.arrayContaining(["work_habit"])
          })
        })
      );
    } finally {
      store.close();
    }
  });

  it("writes natural-language memory requests through an LLM decision", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: path.join(workspace, ".magi-next") });
    ensureMagiHome(paths);
    const store = SessionStore.open(paths);
    try {
      const sessionId = store.createSession({ title: "llm memory write", cwd: workspace });
      const adapter: ProviderAdapter = {
        name: "assistant-provider",
        complete: async () => ({ text: "记住了" })
      };
      const memoryJudge: ProviderAdapter = {
        name: "memory-judge",
        complete: async () => ({
          text: JSON.stringify({
            shouldWrite: true,
            scope: "user",
            type: "user_profile",
            content: "我是 Edward，你的创造者",
            confidence: 0.94
          }),
          usage: { inputTokens: 11, outputTokens: 7 }
        })
      };
      await new QueryEngine({
        store,
        sessionId,
        jobId: "job-memory-natural-write",
        cwd: workspace,
        routes: [{ providerName: "assistant", model: "main", adapter }],
        memoryOptions: {
          paths,
          enabled: true,
          autoWrite: "explicit",
          maxResults: 4,
          scopes: ["user", "project", "session"],
          writeDecisionRoute: {
            providerName: "judge",
            model: "fast",
            adapter: memoryJudge
          }
        }
      }).submitMessage("那你记得哈，我是edward 你的创造者");

      const nodeStore = MemoryNodeStore.open(paths);
      const node = nodeStore
        .listHotNodes({ limit: 10, minWeight: 0 })
        .find((item) => item.body === "我是 Edward，你的创造者");
      nodeStore.close();
      expect(node).toMatchObject({
        type: "user_profile",
        source: "explicit",
        metadata: expect.objectContaining({
          decisionMethod: "llm",
          confidence: 0.94
        })
      });
      expect(store.listJobAuditEvents("job-memory-natural-write", 20)).toContainEqual(
        expect.objectContaining({
          action: "agent.memory.written",
          target: node!.id,
          metadata: expect.objectContaining({
            type: "user_profile",
            decisionMethod: "llm",
            providerName: "judge",
            model: "fast"
          })
        })
      );
    } finally {
      store.close();
    }
  });

  it("corrects existing memory through a natural-language correction decision", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: path.join(workspace, ".magi-next") });
    ensureMagiHome(paths);
    const store = SessionStore.open(paths);
    try {
      const nodeStore = MemoryNodeStore.open(paths);
      const stale = nodeStore.upsertNode({
        type: "preference",
        title: "Stale verification output preference",
        summary: "The user prefers verbose terminal dumps after verification.",
        body: "The user prefers verbose terminal dumps after verification.",
        source: "explicit",
        weight: 0.95
      });
      nodeStore.close();
      const sessionId = store.createSession({ title: "memory correction", cwd: workspace });
      const adapter: ProviderAdapter = {
        name: "assistant-provider",
        complete: async () => ({ text: "已更新记忆" })
      };
      const memoryJudge: ProviderAdapter = {
        name: "memory-judge",
        complete: async () => ({
          text: JSON.stringify({
            action: "correct",
            target: "verbose terminal dumps",
            reason: "User corrected the remembered verification preference.",
            replacement: "The user prefers concise verification summaries with key outcomes only.",
            replacementTitle: "Correct verification output preference",
            replacementSummary: "Correct verification output preference.",
            replacementType: "preference",
            confidence: 0.92
          }),
          usage: { inputTokens: 17, outputTokens: 11 }
        })
      };

      await new QueryEngine({
        store,
        sessionId,
        jobId: "job-memory-natural-correction",
        cwd: workspace,
        routes: [{ providerName: "assistant", model: "main", adapter }],
        memoryOptions: {
          paths,
          enabled: true,
          autoWrite: "explicit",
          maxResults: 4,
          scopes: ["user", "project", "session"],
          writeDecisionRoute: {
            providerName: "judge",
            model: "fast",
            adapter: memoryJudge
          }
        }
      }).submitMessage(
        "这个记忆不对，我不是喜欢 verbose terminal dumps，我应该是偏好 concise verification summaries"
      );

      const checkStore = MemoryNodeStore.open(paths);
      const disputed = checkStore.getNode(stale.id);
      const hits = checkStore.searchGraph({
        query: "verbose terminal dumps verification",
        limit: 5
      });
      const replacement = hits.find((hit) =>
        hit.node.body.includes("concise verification summaries")
      )?.node;
      checkStore.close();

      expect(disputed).toMatchObject({
        status: "disputed",
        metadata: expect.objectContaining({
          correction: expect.objectContaining({
            reason: "User corrected the remembered verification preference.",
            decisionMethod: "llm",
            confidence: 0.92
          })
        })
      });
      expect(replacement).toMatchObject({
        type: "preference",
        title: "Correct verification output preference",
        metadata: expect.objectContaining({
          correctionFor: stale.id
        })
      });
      expect(hits.map((hit) => hit.node.id)).toContain(replacement!.id);
      expect(hits.map((hit) => hit.node.id)).not.toContain(stale.id);
      expect(store.listJobAuditEvents("job-memory-natural-correction", 20)).toContainEqual(
        expect.objectContaining({
          action: "agent.memory.corrected",
          target: stale.id,
          metadata: expect.objectContaining({
            disputedNodeId: stale.id,
            replacementNodeId: replacement!.id,
            decisionMethod: "llm",
            providerName: "judge",
            model: "fast"
          })
        })
      );
    } finally {
      store.close();
    }
  });

  it("auto-compacts over-budget context and injects the new summary into the same query", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const store = new SessionStore(path.join(workspace, ".magi-next", "state", "sessions.sqlite"));
    const seen: Array<{ model: string; transcript: string }> = [];
    try {
      const sessionId = store.createSession({ title: "engine", cwd: workspace });
      for (let index = 0; index < 8; index += 1) {
        store.appendMessage({
          sessionId,
          role: index % 2 === 0 ? "user" : "assistant",
          content: `FACT: large context ${index} ${"x".repeat(200)}`
        });
      }
      const adapter: ProviderAdapter = {
        name: "compact-provider",
        complete: async (request) => {
          const transcript = request.messages
            .map(
              (message) =>
                `${message.role}:${message.content
                  .map((part) => {
                    if (part.type === "text") return part.text;
                    if (part.type === "tool-result") return part.content;
                    if (part.type === "tool-use")
                      return `${part.name}:${JSON.stringify(part.input)}`;
                    return "";
                  })
                  .join("")}`
            )
            .join("\n");
          seen.push({ model: request.model, transcript });
          if (request.model === "compact-model") {
            return { text: "COMPACTED SUMMARY" };
          }
          return { text: "done with compacted context" };
        }
      };
      const engine = new QueryEngine({
        store,
        sessionId,
        jobId: "job-auto-compact",
        cwd: workspace,
        routes: [{ providerName: "compact", model: "main-model", adapter }],
        contextOptions: {
          autoCompactTokenThreshold: 10,
          compactionModel: "compact-model",
          recentMessages: 2
        }
      });

      const result = await engine.submitMessage("continue");

      expect(result.events).toContainEqual(expect.objectContaining({ type: "compact_boundary" }));
      expect(seen.map((call) => call.model)).toEqual(["compact-model", "main-model"]);
      expect(seen[1].transcript).toContain(
        "system:[Previous conversation summary]\nCOMPACTED SUMMARY"
      );
      expect(store.getLatestContextSummary(sessionId)?.summary).toBe("COMPACTED SUMMARY");
      expect(
        store.listAuditEvents(20).some((event) => event.action === "agent.context.compacted")
      ).toBe(true);
    } finally {
      store.close();
    }
  });

  it("discovers dynamic MCP tools and executes them inside the agent loop", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const calls: string[] = [];
    const adapter: ProviderAdapter = {
      name: "mcp-provider",
      complete: async (request) => {
        calls.push(
          request.tools
            ?.map((tool) => tool.name)
            .sort()
            .join(",") ?? ""
        );
        if (!request.messages.some((message) => message.role === "tool")) {
          expect(request.tools?.map((tool) => tool.name)).toContain("mcp__notes__read_note");
          return {
            text: "",
            toolUses: [
              {
                type: "tool-use",
                id: "mcp-1",
                name: "mcp__notes__read_note",
                input: { key: "alpha" }
              }
            ]
          };
        }
        expect(request.messages.at(-1)).toMatchObject({
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "mcp-1" }]
        });
        return { text: "mcp done" };
      }
    };
    const result = await collectResult(
      runAgentQuery({
        routes: [{ providerName: "mcp", model: "explicit", adapter }],
        messages: [textMessage("user", "read note")],
        cwd: workspace,
        mcp: {
          servers: {
            notes: {
              command: "node",
              args: [path.join(process.cwd(), "tests/fixtures/mock-mcp-server.mjs")],
              env: {},
              approval: "dangerous"
            }
          }
        }
      })
    );

    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        toolName: "mcp__notes__read_note",
        content: "called read_note"
      })
    );
    expect(result.final.text).toBe("mcp done");
    expect(calls[0]).toContain("mcp__notes__read_note");
  });

  it("returns MCP approval requests through the normal approval event", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const adapter: ProviderAdapter = {
      name: "mcp-provider",
      complete: async (request) =>
        request.messages.some((message) => message.role === "tool")
          ? { text: "mcp blocked" }
          : {
              text: "",
              toolUses: [
                {
                  type: "tool-use",
                  id: "mcp-write",
                  name: "mcp__notes__write_note",
                  input: { path: "note.txt", content: "hello" }
                }
              ]
            }
    };
    const result = await collectResult(
      runAgentQuery({
        routes: [{ providerName: "mcp", model: "explicit", adapter }],
        messages: [textMessage("user", "write note")],
        cwd: workspace,
        mcp: {
          servers: {
            notes: {
              command: "node",
              args: [path.join(process.cwd(), "tests/fixtures/mock-mcp-server.mjs")],
              env: {},
              approval: "dangerous"
            }
          }
        }
      })
    );

    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "approval_request",
        toolUse: expect.objectContaining({ name: "mcp__notes__write_note" })
      })
    );
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        toolName: "mcp__notes__write_note",
        isError: true
      })
    );
    expect(result.final.text).toBe("mcp blocked");
  });

  it("marks MCP auth-required errors as retryable tool results", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    let retryableInNextRequest: boolean | undefined;
    const adapter: ProviderAdapter = {
      name: "mcp-provider",
      complete: async (request) => {
        const toolMessage = request.messages.find((message) => message.role === "tool");
        if (toolMessage) {
          const toolResult = toolMessage.content.find((part) => part.type === "tool-result");
          retryableInNextRequest =
            toolResult?.type === "tool-result" ? toolResult.retryable : undefined;
          return { text: "auth retry surfaced" };
        }
        return {
          text: "",
          toolUses: [
            {
              type: "tool-use",
              id: "mcp-auth",
              name: "mcp__notes__read_note",
              input: { key: "alpha" }
            }
          ]
        };
      }
    };
    const result = await collectResult(
      runAgentQuery({
        routes: [{ providerName: "mcp", model: "explicit", adapter }],
        messages: [textMessage("user", "read note")],
        cwd: workspace,
        mcp: {
          servers: {
            notes: {
              command: "node",
              args: [path.join(process.cwd(), "tests/fixtures/mock-mcp-server.mjs")],
              env: { MAGI_MCP_AUTH_REQUIRED: "1" },
              approval: "never"
            }
          }
        }
      })
    );

    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        toolName: "mcp__notes__read_note",
        isError: true,
        retryable: true,
        content: expect.stringContaining("MCP auth required")
      })
    );
    expect(retryableInNextRequest).toBe(true);
    expect(result.final.text).toBe("auth retry surfaced");
  });

  it("exposes MCP resources as first-class agent tools", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const seenTools: string[] = [];
    const adapter: ProviderAdapter = {
      name: "mcp-provider",
      complete: async (request) => {
        seenTools.push(
          request.tools
            ?.map((tool) => tool.name)
            .sort()
            .join(",") ?? ""
        );
        if (!request.messages.some((message) => message.role === "tool")) {
          expect(request.tools?.map((tool) => tool.name)).toEqual(
            expect.arrayContaining(["ListMcpResources", "ReadMcpResource"])
          );
          return {
            text: "",
            toolUses: [
              {
                type: "tool-use",
                id: "mcp-list-resources",
                name: "ListMcpResources",
                input: { server: "notes" }
              },
              {
                type: "tool-use",
                id: "mcp-read-resource",
                name: "ReadMcpResource",
                input: { server: "notes", uri: "note://alpha" }
              }
            ]
          };
        }
        return { text: "resources done" };
      }
    };
    const result = await collectResult(
      runAgentQuery({
        routes: [{ providerName: "mcp", model: "explicit", adapter }],
        messages: [textMessage("user", "read mcp resource")],
        cwd: workspace,
        mcp: {
          servers: {
            notes: {
              command: "node",
              args: [path.join(process.cwd(), "tests/fixtures/mock-mcp-server.mjs")],
              env: {},
              approval: "dangerous"
            }
          }
        }
      })
    );

    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        toolName: "ListMcpResources",
        content: expect.stringContaining("note://alpha")
      })
    );
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        toolName: "ReadMcpResource",
        content: expect.stringContaining("resource text for note://alpha")
      })
    );
    expect(result.final.text).toBe("resources done");
    expect(seenTools[0]).toContain("ReadMcpResource");
  });
});

async function collectResult(generator: ReturnType<typeof runAgentQuery>) {
  const events = [];
  let next = await generator.next();
  while (!next.done) {
    events.push(next.value);
    next = await generator.next();
  }
  return { events, final: next.value };
}

async function submitWithCapturedContext(input: {
  store: SessionStore;
  sessionId: string;
  jobId: string;
  cwd: string;
  paths: ReturnType<typeof getMagiPaths>;
  seen: string[];
  prompt: string;
  recallPlannerResponse?: Record<string, unknown> | string;
  seenRecallPlannerPrompts?: string[];
}): Promise<void> {
  const adapter: ProviderAdapter = {
    name: `${input.jobId}-provider`,
    complete: async (request) => {
      const transcript = request.messages
        .map((message) => `${message.role}:${messageText(message)}`)
        .join("\n");
      if (transcript.includes("[Magi recall planner input]")) {
        input.seenRecallPlannerPrompts?.push(transcript);
        return {
          text:
            typeof input.recallPlannerResponse === "string"
              ? input.recallPlannerResponse
              : JSON.stringify(input.recallPlannerResponse ?? noRecallPlannerPlan())
        };
      }
      input.seen.push(transcript);
      return { text: "context captured" };
    }
  };
  const engine = new QueryEngine({
    store: input.store,
    sessionId: input.sessionId,
    jobId: input.jobId,
    cwd: input.cwd,
    routes: [{ providerName: "memory", model: "explicit", adapter }],
    memoryOptions: {
      paths: input.paths,
      enabled: true,
      autoWrite: "explicit",
      maxResults: 4,
      scopes: ["user", "project", "session"],
      recallPlannerRoute:
        input.recallPlannerResponse === undefined
          ? undefined
          : {
              providerName: "recall-planner",
              model: "planner",
              adapter
            }
    }
  });
  await engine.submitMessage(input.prompt);
}

function noRecallPlannerPlan(taskKind = "tool_execution", constraints: string[] = []) {
  return {
    taskKind,
    sources: {
      hotMemory: { needed: false, budget: 0, reason: "No stable user preference is needed" },
      memorySearch: { needed: false, budget: 0, reason: "No stored memory is needed" },
      session: { needed: false, budget: 0, reason: "No prior session is referenced" },
      skill: { needed: false, budget: 0, reason: "No skill is needed", skills: [] }
    },
    constraints
  };
}

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

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
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
