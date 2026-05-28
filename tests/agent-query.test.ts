import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { QueryEngine } from "../src/agent/query-engine.js";
import { runAgentQuery } from "../src/agent/query.js";
import { ActiveInteractionRegistry } from "../src/interactions.js";
import { ProviderAdapter, textMessage } from "../src/providers/ir.js";
import { ProviderError } from "../src/providers/errors.js";
import { SessionStore } from "../src/session-store.js";
import { appendMemory, readMemory } from "../src/memory.js";
import { listDrafts, showDraft } from "../src/memory-draft.js";
import { loadTodoStore, todoStorePathFromRoot } from "../src/tools/todo.js";
import { ensureMagiHome, getMagiPaths } from "../src/paths.js";

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
            toolUses: [{
              type: "tool-use",
              id: "tool-1",
              name: "FileWrite",
              input: { file_path: "loop.txt", content: "created by query loop" }
            }]
          };
        }
        expect(request.messages.at(-1)).toMatchObject({
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "tool-1" }]
        });
        return { text: "done after tool" };
      }
    };

    const events = [];
    for await (const event of runAgentQuery({
      adapter,
      model: "explicit-test-model",
      messages: [textMessage("user", "create loop.txt")],
      cwd: workspace,
      maxTurns: 4
    })) {
      events.push(event);
    }

    expect(calls).toHaveLength(2);
    expect(events.map((event) => event.type)).toContain("tool_result");
    expect(events.at(-1)).toMatchObject({ type: "done", text: "done after tool" });
    await expect(readFile(path.join(workspace, "loop.txt"), "utf8")).resolves.toBe("created by query loop");
  });

  it("denies write tools in plan permission mode and returns the denial to the model", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const adapter: ProviderAdapter = {
      name: "test-provider",
      complete: async (request) => request.messages.some((message) => message.role === "tool")
        ? { text: "write was denied" }
        : {
          text: "",
          toolUses: [{
            type: "tool-use",
            id: "tool-1",
            name: "FileWrite",
            input: { file_path: "denied.txt", content: "no" }
          }]
        }
    };

    const result = await collectResult(runAgentQuery({
      adapter,
      model: "explicit-test-model",
      messages: [textMessage("user", "try to write")],
      cwd: workspace,
      permissionMode: "plan"
    }));

    expect(result.events).toContainEqual(expect.objectContaining({
      type: "tool_result",
      isError: true
    }));
    expect(result.final.text).toBe("write was denied");
    await expect(readFile(path.join(workspace, "denied.txt"), "utf8")).rejects.toThrow();
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

    const result = await collectResult(runAgentQuery({
      adapter,
      model: "explicit-test-model",
      messages: [textMessage("user", "answer me")],
      cwd: workspace
    }));

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
              "<tool_use tool_name=\"FileRead\">",
              "  <arg name=\"path\">README.md</arg>",
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

    const result = await collectResult(runAgentQuery({
      adapter,
      model: "explicit-test-model",
      messages: [textMessage("user", "read README")],
      cwd: workspace
    }));

    expect(calls).toHaveLength(2);
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "tool_use",
      toolUse: expect.objectContaining({
        id: "text-tool-1",
        name: "FileRead",
        input: expect.objectContaining({ file_path: "README.md" })
      })
    }));
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "tool_result",
      toolName: "FileRead",
      content: expect.stringContaining("project notes")
    }));
    expect(result.events).not.toContainEqual({ type: "text_delta", text: expect.stringContaining("<tool_use") });
    expect(result.final.text).toBe("read complete");
  });

  it("executes direct XML child args in text-form tool_use blocks", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    writeFileSync(path.join(workspace, "package.json"), "{\"name\":\"demo\"}", "utf8");
    let calls = 0;
    const adapter: ProviderAdapter = {
      name: "direct-xml-tool-provider",
      complete: async (request) => {
        calls++;
        if (calls === 1) {
          return {
            text: "<tool_use tool_name=\"FileRead\"><path>package.json</path></tool_use>",
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

    const result = await collectResult(runAgentQuery({
      adapter,
      model: "explicit-test-model",
      messages: [textMessage("user", "read package")],
      cwd: workspace
    }));

    expect(result.events).toContainEqual(expect.objectContaining({
      type: "tool_use",
      toolUse: expect.objectContaining({
        name: "FileRead",
        input: expect.objectContaining({ file_path: "package.json" })
      })
    }));
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "tool_result",
      content: expect.stringContaining("\"name\":\"demo\"")
    }));
    expect(result.final.text).toBe("done");
  });

  it("does not retry when the model defers an actionable project request without using tools", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    writeFileSync(path.join(workspace, "package.json"), "{\"scripts\":{\"dev\":\"vite\"}}", "utf8");
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

    const result = await collectResult(runAgentQuery({
      adapter,
      model: "explicit-test-model",
      messages: [textMessage("user", `${workspace} 把服务拉起来`)],
      cwd: workspace
    }));

    expect(calls).toBe(1);
    expect(result.events).not.toContainEqual(expect.objectContaining({ type: "tool_result" }));
    expect(result.final.text).toBe("我会先读取项目文件，找出启动方式。");
  });

  it("yields approval_request for default write tools and lets a resolver approve", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const adapter: ProviderAdapter = {
      name: "test-provider",
      complete: async (request) => request.messages.some((message) => message.role === "tool")
        ? { text: "approved write completed" }
        : {
          text: "",
          toolUses: [{
            type: "tool-use",
            id: "tool-1",
            name: "FileWrite",
            input: { file_path: "approved.txt", content: "yes" }
          }]
        }
    };

    const result = await collectResult(runAgentQuery({
      adapter,
      model: "explicit-test-model",
      messages: [textMessage("user", "write with approval")],
      cwd: workspace,
      permissionMode: "default",
      approvalResolver: () => true
    }));

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

    const result = await collectResult(runAgentQuery({
      routes: [
        { providerName: "primary", model: "model-a", adapter: primary },
        { providerName: "backup", model: "model-b", adapter: backup }
      ],
      messages: [textMessage("user", "hello")],
      cwd: workspace
    }));

    expect(result.events).toContainEqual(expect.objectContaining({
      type: "fallback_switched",
      fromProvider: "primary",
      toProvider: "backup"
    }));
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

    const result = await collectResult(runAgentQuery({
      routes: [{ providerName: "shaky", model: "m", adapter: shaky }],
      messages: [textMessage("user", "ping")],
      cwd: workspace
    }));

    // Expected retry pattern: fail → fail → succeed
    expect(callCount).toBe(3);
    expect(result.final.text).toBe("survived");
    expect(result.final.providerName).toBe("shaky");
    expect(result.final.attempts).toEqual([
      { providerName: "shaky", model: "m", ok: false, errorKind: "server-error" },
      { providerName: "shaky", model: "m", ok: false, errorKind: "server-error" },
      { providerName: "shaky", model: "m", ok: true }
    ]);
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

    const result = await collectResult(runAgentQuery({
      routes: [{ providerName: "shaky", model: "m", adapter: shaky }],
      messages: [textMessage("user", "ping")],
      cwd: workspace
    }));

    expect(callCount).toBe(3);
    expect(result.final.text).toBe("complete survived");
    expect(result.final.attempts).toEqual([
      { providerName: "shaky", model: "m", ok: false, errorKind: "server-error" },
      { providerName: "shaky", model: "m", ok: false, errorKind: "server-error" },
      { providerName: "shaky", model: "m", ok: true }
    ]);
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
      expect(result.events.filter((event) => event.type === "text_delta").map((event) => event.text)).toEqual(["hel", "lo"]);
      const deltas = store.listRecentAuditEvents({ jobId: "job-stream-provider", limit: 50, order: "asc" })
        .filter((event) => event.action === "agent.text.delta");
      expect(deltas.map((event) => event.metadata?.preview)).toEqual(["hel", "lo"]);
      expect(store.getSession(sessionId)?.messages).toContainEqual(expect.objectContaining({
        role: "assistant",
        content: "hello"
      }));
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
      await expect(new QueryEngine({
        store,
        sessionId,
        jobId: "job-stream-cancel",
        routes: [{ providerName: "abort", model: "explicit", adapter }],
        cwd: workspace,
        signal: controller.signal
      }).submitMessage("cancel me")).rejects.toThrow(/operator stop/);

      expect(seenSignal).toBe(controller.signal);
      expect(store.getJob("job-stream-cancel")?.status).toBe("cancelled");
      expect(store.listJobAuditEvents("job-stream-cancel", 50)).toContainEqual(expect.objectContaining({
        action: "agent.query.cancelled",
        metadata: expect.objectContaining({ reason: "operator stop" })
      }));
    } finally {
      store.close();
    }
  });

  it("executes WebFetch with approval and summarizes fetched content through the active model", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<title>Release Notes</title><article><p>Version 2 ships on Friday.</p></article>");
    });
    const url = await listen(server);
    const phases: string[] = [];
    const adapter: ProviderAdapter = {
      name: "web-provider",
      complete: async (request) => {
        const text = request.messages.map((message) => message.content.map((part) => {
          if (part.type === "text") return part.text;
          if (part.type === "tool-result") return part.content;
          if (part.type === "tool-use") return `${part.name}:${JSON.stringify(part.input)}`;
          return "";
        }).join("")).join("\n");
        if (text.includes("Content:") && text.includes("Version 2 ships on Friday.")) {
          phases.push("web-summary");
          return { text: "Version 2 ships on Friday." };
        }
        if (!request.messages.some((message) => message.role === "tool")) {
          phases.push("tool-use");
          return {
            text: "",
            toolUses: [{
              type: "tool-use",
              id: "web-1",
              name: "WebFetch",
              input: { url, prompt: "Extract the release date." }
            }]
          };
        }
        phases.push("final");
        expect(text).toContain("Title: Release Notes");
        expect(text).toContain("Version 2 ships on Friday.");
        return { text: "web fetch done" };
      }
    };

    const result = await collectResult(runAgentQuery({
      routes: [{ providerName: "web", model: "explicit", adapter }],
      messages: [textMessage("user", "fetch release notes")],
      cwd: workspace,
      permissionMode: "default",
      approvalResolver: () => true
    }));

    expect(phases).toEqual(["tool-use", "web-summary", "final"]);
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "approval_request",
      toolUse: expect.objectContaining({ name: "WebFetch" })
    }));
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "tool_result",
      toolName: "WebFetch",
      content: expect.stringContaining("Title: Release Notes")
    }));
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
          toolUses: [{
            type: "tool-use",
            id: "ask-1",
            name: "AskUserQuestion",
            input: {
              questions: [{
                question: "Which implementation path should we take?",
                options: [
                  { label: "A", description: "Patch a narrow surface" },
                  { label: "B", description: "Build the full resolver path" }
                ]
              }]
            }
          }]
        };
      }
    };

    const result = await collectResult(runAgentQuery({
      routes: [{ providerName: "question", model: "explicit", adapter }],
      messages: [textMessage("user", "choose path")],
      cwd: workspace,
      userQuestionResolver: ({ toolUse, question }) => {
        expect(toolUse.id).toBe("ask-1");
        return {
          answers: [{
            question: question.questions[0].question,
            selectedLabels: ["B"],
            selectedOptions: [question.questions[0].options[1]]
          }]
        };
      }
    }));

    expect(result.events).toContainEqual(expect.objectContaining({
      type: "user_question",
      toolUse: expect.objectContaining({ name: "AskUserQuestion" })
    }));
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "tool_result",
      toolName: "AskUserQuestion",
      content: expect.stringContaining("- B: Build the full resolver path")
    }));
    expect(seenToolResult[0]).toContain("Build the full resolver path");
    expect(result.final.text).toBe("Proceeding with option B.");
  });

  it("sends user messages as first-class agent events and tool results", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const delivered: string[] = [];
    const adapter: ProviderAdapter = {
      name: "message-provider",
      complete: async (request) => request.messages.some((message) => message.role === "tool")
        ? { text: "message delivered" }
        : {
          text: "",
          toolUses: [{
            type: "tool-use",
            id: "msg-1",
            name: "SendUserMessage",
            input: {
              message: "Please review the current diff.",
              status: "normal"
            }
          }]
        }
    };

    const result = await collectResult(runAgentQuery({
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
    }));

    expect(delivered).toEqual(["Please review the current diff."]);
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "user_message",
      message: expect.objectContaining({ message: "Please review the current diff." })
    }));
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "tool_result",
      toolName: "SendUserMessage",
      content: expect.stringContaining("channel: test-sink")
    }));
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
          toolUses: [{
            type: "tool-use",
            id: "todo-1",
            name: "TodoWrite",
            input: {
              todos: [
                { id: "read", content: "Read existing tool patterns", status: "completed" },
                { id: "write", content: "Implement TodoWrite", status: "in_progress", priority: "high" }
              ]
            }
          }]
        };
      }
    };

    const result = await collectResult(runAgentQuery({
      routes: [{ providerName: "todo", model: "explicit", adapter }],
      messages: [textMessage("user", "track work")],
      cwd: workspace,
      stateRoot,
      sessionId: "todo-session",
      permissionMode: "acceptEdits"
    }));

    expect(result.events).toContainEqual(expect.objectContaining({
      type: "tool_result",
      toolName: "TodoWrite",
      content: expect.stringContaining("Todo list replaced (2 items)")
    }));
    expect(seenToolResults[0]).toContain("write priority=high - Implement TodoWrite");
    expect(loadTodoStore(todoStorePathFromRoot(stateRoot)).sessions["todo-session"].todos).toHaveLength(2);
    expect(result.final.text).toBe("todo state updated");
  });

  it("returns WebSearch tool_result to the model through the agent loop", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        results: [{
          title: "Magi Next WebSearch",
          url: "https://docs.example.com/web-search",
          snippet: "Sourced WebSearch result."
        }]
      }));
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
          toolUses: [{
            type: "tool-use",
            id: "web-search-1",
            name: "WebSearch",
            input: { query: "magi next web search", allowed_domains: ["docs.example.com"] }
          }]
        };
      }
    };

    const result = await collectResult(runAgentQuery({
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
    }));

    expect(result.events).toContainEqual(expect.objectContaining({
      type: "tool_result",
      toolName: "WebSearch",
      content: expect.stringContaining("Magi Next WebSearch")
    }));
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
          toolUses: [{
            type: "tool-use",
            id: "git-diff-1",
            name: "GitDiff",
            input: { path: "tracked.txt", context: 0 }
          }]
        };
      }
    };

    const result = await collectResult(runAgentQuery({
      routes: [{ providerName: "git", model: "explicit", adapter }],
      messages: [textMessage("user", "inspect diff")],
      cwd: workspace
    }));

    expect(result.events).toContainEqual(expect.objectContaining({
      type: "tool_result",
      toolName: "GitDiff",
      content: expect.stringContaining("+after")
    }));
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
      complete: async (request) => request.messages.some((message) => message.role === "tool")
        ? { text: "git branch created" }
        : {
          text: "",
          toolUses: [{
            type: "tool-use",
            id: "git-branch-agent",
            name: "GitBranchCreate",
            input: { name: "feature/agent-branch", checkout: true }
          }]
        }
    };

    const result = await collectResult(runAgentQuery({
      routes: [{ providerName: "git", model: "explicit", adapter }],
      messages: [textMessage("user", "create a branch")],
      cwd: workspace,
      permissionMode: "default",
      approvalResolver: () => true
    }));

    expect(result.events).toContainEqual(expect.objectContaining({
      type: "approval_request",
      toolUse: expect.objectContaining({ name: "GitBranchCreate" })
    }));
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "tool_result",
      toolName: "GitBranchCreate",
      content: expect.stringContaining("Created and checked out branch feature/agent-branch")
    }));
    expect(gitOutput(workspace, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("feature/agent-branch");
    expect(result.final.text).toBe("git branch created");
  });

  it("returns ToolSearch, WorkspaceDiagnostics, Config, and Skill tool results to the model", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: path.join(workspace, ".magi-next") });
    ensureMagiHome(paths);
    writeFileSync(path.join(workspace, "package.json"), JSON.stringify({
      scripts: { test: "vitest run" },
      devDependencies: { vitest: "^3.0.0" }
    }), "utf8");
    const skillRoot = path.join(paths.skillsRoot, "review-helper");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(path.join(skillRoot, "SKILL.md"), "# Review Helper\n\nReview code changes.\n", "utf8");
    const seenResults: string[] = [];
    const adapter: ProviderAdapter = {
      name: "multi-tool-provider",
      complete: async (request) => {
        const toolResults = request.messages.flatMap((message) => message.content).filter((part) => part.type === "tool-result");
        if (toolResults.length > 0) {
          seenResults.push(...toolResults.map((part) => part.type === "tool-result" ? part.content : ""));
          return { text: "tool discovery done" };
        }
        return {
          text: "",
          toolUses: [
            { type: "tool-use", id: "tool-search", name: "ToolSearch", input: { query: "select:Config" } },
            { type: "tool-use", id: "workspace-diagnostics", name: "WorkspaceDiagnostics", input: {} },
            { type: "tool-use", id: "config-read", name: "Config", input: { setting: "context.recentMessages" } },
            { type: "tool-use", id: "skill-load", name: "Skill", input: { skill: "review-helper" } }
          ]
        };
      }
    };

    const result = await collectResult(runAgentQuery({
      routes: [{ providerName: "multi-tool", model: "explicit", adapter }],
      messages: [textMessage("user", "inspect tools")],
      cwd: workspace,
      stateRoot: paths.stateRoot
    }));

    expect(result.events).toContainEqual(expect.objectContaining({ type: "tool_result", toolName: "ToolSearch" }));
    expect(result.events).toContainEqual(expect.objectContaining({ type: "tool_result", toolName: "WorkspaceDiagnostics" }));
    expect(result.events).toContainEqual(expect.objectContaining({ type: "tool_result", toolName: "Config" }));
    expect(result.events).toContainEqual(expect.objectContaining({ type: "tool_result", toolName: "Skill" }));
    expect(seenResults.join("\n")).toContain("Tool: Config");
    expect(seenResults.join("\n")).toContain("Workspace Diagnostics");
    expect(seenResults.join("\n")).toContain("npm run test");
    expect(seenResults.join("\n")).toContain("Config context.recentMessages");
    expect(seenResults.join("\n")).toContain("Review code changes.");
    expect(result.final.text).toBe("tool discovery done");
  });

  it("returns a tool error when AskUserQuestion has no resolver", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const adapter: ProviderAdapter = {
      name: "question-provider",
      complete: async (request) => request.messages.some((message) => message.role === "tool")
        ? { text: "question unavailable" }
        : {
          text: "",
          toolUses: [{
            type: "tool-use",
            id: "ask-no-resolver",
            name: "AskUserQuestion",
            input: {
              questions: [{
                question: "Pick one",
                options: [
                  { label: "A", description: "Alpha" },
                  { label: "B", description: "Beta" }
                ]
              }]
            }
          }]
        }
    };

    const result = await collectResult(runAgentQuery({
      routes: [{ providerName: "question", model: "explicit", adapter }],
      messages: [textMessage("user", "ask me")],
      cwd: workspace
    }));

    expect(result.events).toContainEqual(expect.objectContaining({
      type: "tool_result",
      toolName: "AskUserQuestion",
      isError: true,
      content: expect.stringContaining("requires an interactive user question resolver")
    }));
    expect(result.final.text).toBe("question unavailable");
  });

  it("persists query engine transcript, tool audits, jobs, and usage", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const store = new SessionStore(path.join(workspace, ".magi-next", "state", "sessions.sqlite"));
    try {
      const sessionId = store.createSession({ title: "engine", cwd: workspace });
      const adapter: ProviderAdapter = {
        name: "engine-provider",
        complete: async (request) => request.messages.some((message) => message.role === "tool")
          ? { text: "finished", usage: { inputTokens: 3, outputTokens: 4 } }
          : {
            text: "",
            toolUses: [{
              type: "tool-use",
              id: "tool-1",
              name: "FileWrite",
              input: { file_path: "engine.txt", content: "ok" }
            }]
          }
      };
      const engine = new QueryEngine({
        store,
        sessionId,
        jobId: "job-engine",
        cwd: workspace,
        routes: [{ providerName: "engine", model: "explicit", adapter }]
      });

      const result = await engine.submitMessage("write engine.txt");
      const session = store.getSession(sessionId)!;

      expect(result.events.map((event) => event.type)).toContain("tool_result");
      expect(session.messages.map((message) => message.role)).toEqual(["user", "tool", "assistant"]);
      expect(store.getJob("job-engine")).toMatchObject({ status: "completed" });
      expect(store.countRows("usage_events")).toBe(1);
      expect(store.listAuditEvents(20).map((event) => event.action)).toEqual(expect.arrayContaining([
        "agent.request.started",
        "agent.assistant.message",
        "agent.tool.use",
        "agent.tool.completed",
        "agent.usage.reported",
        "agent.query.done",
        "agent.query.completed"
      ]));
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
        complete: async (request) => request.messages.some((message) => message.role === "tool")
          ? { text: "approved through control" }
          : {
            text: "",
            toolUses: [{
              type: "tool-use",
              id: "approve-write",
              name: "FileWrite",
              input: { file_path: "approved-active.txt", content: "control approved" }
            }]
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
      await waitFor(() => interactions.getInteraction({
        jobId: "job-active-approval",
        toolUseId: "approve-write"
      })?.status === "pending");

      expect(store.listJobAuditEvents("job-active-approval", 20)).toContainEqual(expect.objectContaining({
        action: "agent.approval.pending",
        metadata: expect.objectContaining({ toolUseId: "approve-write", status: "pending" })
      }));
      interactions.resolveApproval({ jobId: "job-active-approval", toolUseId: "approve-write", approved: true });
      const result = await running;

      expect(result.text).toBe("approved through control");
      await expect(readFile(path.join(workspace, "approved-active.txt"), "utf8")).resolves.toBe("control approved");
      expect(store.listJobAuditEvents("job-active-approval", 40)).toContainEqual(expect.objectContaining({
        action: "agent.approval.resolved",
        metadata: expect.objectContaining({ approved: true, status: "resolved" })
      }));
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
            toolUses: [{
              type: "tool-use",
              id: "ask-active",
              name: "AskUserQuestion",
              input: {
                questions: [{
                  question: "Choose deployment lane",
                  options: [
                    { label: "canary", description: "Roll out to a small group" },
                    { label: "stable", description: "Roll out broadly" }
                  ]
                }]
              }
            }]
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
      await waitFor(() => interactions.getInteraction({
        jobId: "job-active-question",
        toolUseId: "ask-active"
      })?.status === "pending");
      const pending = interactions.getPendingQuestion({ jobId: "job-active-question", toolUseId: "ask-active" });
      interactions.resolveQuestion({
        jobId: "job-active-question",
        toolUseId: "ask-active",
        answer: {
          answers: [{
            question: pending.question.questions[0].question,
            selectedLabels: ["stable"],
            selectedOptions: [pending.question.questions[0].options[1]]
          }]
        }
      });
      const result = await running;

      expect(result.text).toBe("question resolved through control");
      expect(seenToolResults[0]).toContain("- stable: Roll out broadly");
      expect(store.listJobAuditEvents("job-active-question", 40)).toContainEqual(expect.objectContaining({
        action: "agent.user_question.pending",
        metadata: expect.objectContaining({ toolUseId: "ask-active", status: "pending" })
      }));
      expect(store.listJobAuditEvents("job-active-question", 40)).toContainEqual(expect.objectContaining({
        action: "agent.user_question.resolved",
        metadata: expect.objectContaining({ toolUseId: "ask-active", status: "resolved" })
      }));
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
        complete: async (request) => request.messages.some((message) => message.role === "tool")
          ? { text: "approval timed out" }
          : {
            text: "",
            toolUses: [{
              type: "tool-use",
              id: "approve-timeout",
              name: "FileWrite",
              input: { file_path: "timeout.txt", content: "no" }
            }]
          }
      };
      await expect(new QueryEngine({
        store,
        sessionId: timeoutSessionId,
        jobId: "job-approval-timeout",
        cwd: workspace,
        routes: [{ providerName: "timeout", model: "explicit", adapter: timeoutAdapter }],
        permissionMode: "default",
        activeInteractions: interactions
      }).submitMessage("timeout approval")).rejects.toMatchObject({
        name: "ActiveInteractionTimeoutError"
      });

      expect(store.listJobAuditEvents("job-approval-timeout", 30)).toContainEqual(expect.objectContaining({
        action: "agent.approval.timeout",
        metadata: expect.objectContaining({ toolUseId: "approve-timeout", status: "timeout" })
      }));

      const cancelSessionId = store.createSession({ title: "question cancel", cwd: workspace });
      const cancelAdapter: ProviderAdapter = {
        name: "cancel-provider",
        complete: async (request) => request.messages.some((message) => message.role === "tool")
          ? { text: "question cancelled" }
          : {
            text: "",
            toolUses: [{
              type: "tool-use",
              id: "ask-cancel",
              name: "AskUserQuestion",
              input: {
                questions: [{
                  question: "Cancel this question?",
                  options: [
                    { label: "yes", description: "Yes" },
                    { label: "no", description: "No" }
                  ]
                }]
              }
            }]
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
      await waitFor(() => interactions.getInteraction({
        jobId: "job-question-cancel",
        toolUseId: "ask-cancel"
      })?.status === "pending");
      interactions.cancelInteraction({ jobId: "job-question-cancel", toolUseId: "ask-cancel", reason: "test cancel" });
      await expect(running).rejects.toMatchObject({
        name: "ActiveInteractionCancelledError"
      });

      expect(store.listJobAuditEvents("job-question-cancel", 30)).toContainEqual(expect.objectContaining({
        action: "agent.user_question.cancelled",
        metadata: expect.objectContaining({ toolUseId: "ask-cancel", status: "cancelled" })
      }));
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
          toolUses: [{
            type: "tool-use",
            id: "approve-abort",
            name: "FileWrite",
            input: { file_path: "abort.txt", content: "no" }
          }]
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
      await waitFor(() => interactions.getInteraction({
        jobId: "job-approval-abort",
        toolUseId: "approve-abort"
      })?.status === "pending");

      controller.abort();

      await expect(running).rejects.toMatchObject({
        name: "ActiveInteractionCancelledError"
      });
      expect(store.listJobAuditEvents("job-approval-abort", 30)).toContainEqual(expect.objectContaining({
        action: "agent.approval.cancelled",
        metadata: expect.objectContaining({ toolUseId: "approve-abort", status: "cancelled" })
      }));
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
        complete: async (request) => request.messages.some((message) => message.role === "tool")
          ? { text: "todo persisted", usage: { inputTokens: 5, outputTokens: 6 } }
          : {
            text: "",
            toolUses: [{
              type: "tool-use",
              id: "todo-engine",
              name: "TodoWrite",
              input: {
                todos: [
                  { id: "finish", content: "Finish TodoWrite implementation", status: "in_progress" },
                  { id: "verify", content: "Run verification", status: "pending", priority: "high" }
                ]
              }
            }]
          }
      };
      const engine = new QueryEngine({
        store,
        sessionId,
        jobId: "job-todo-engine",
        cwd: workspace,
        stateRoot,
        permissionMode: "acceptEdits",
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
      expect(audits).toContainEqual(expect.objectContaining({
        action: "agent.todo.updated",
        target: sessionId,
        metadata: expect.objectContaining({
          toolCallId: "todo-engine",
          todoCount: 2,
          statusCounts: { pending: 1, in_progress: 1, completed: 0 }
        })
      }));
      expect(store.getSession(sessionId)?.messages).toContainEqual(expect.objectContaining({
        role: "tool",
        content: expect.stringContaining("Todo list replaced (2 items)")
      }));
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
    writeFileSync(path.join(skillRoot, "SKILL.md"), "# Audit Helper\n\nAudit helper body.\n", "utf8");
    const store = new SessionStore(paths.sessionDbFile);
    try {
      const sessionId = store.createSession({ title: "audit tools", cwd: workspace });
      const adapter: ProviderAdapter = {
        name: "audit-tools-provider",
        complete: async (request) => request.messages.some((message) => message.role === "tool")
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
        routes: [{ providerName: "audit-tools", model: "explicit", adapter }]
      });

      await engine.submitMessage("update config and load skill");
      const audits = store.listAuditEvents(30);
      expect(audits).toContainEqual(expect.objectContaining({
        action: "agent.config.updated",
        target: "context.recentMessages",
        metadata: expect.objectContaining({ toolCallId: "config-write", valueType: "number" })
      }));
      expect(audits).toContainEqual(expect.objectContaining({
        action: "agent.skill.loaded",
        target: "audit-helper",
        metadata: expect.objectContaining({ toolCallId: "skill-audit", argsProvided: true })
      }));
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
          seen.push(request.messages.map((message) => `${message.role}:${message.content.map((part) => {
            if (part.type === "text") return part.text;
            if (part.type === "tool-result") return part.content;
            if (part.type === "tool-use") return `${part.name}:${JSON.stringify(part.input)}`;
            return "";
          }).join("")}`).join("\n"));
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

      expect(seen[0]).toContain("system:[Previous conversation summary]\nFACT: previous summary survives");
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
          seen.push(request.messages.map((message) => `${message.role}:${message.content.map((part) => {
            if (part.type === "text") return part.text;
            if (part.type === "tool-result") return part.content;
            return "";
          }).join("")}`).join("\n"));
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
      appendMemory({ paths, scope: "session", cwd: workspace, sessionId, text: "api current task: event streaming" });
      const adapter: ProviderAdapter = {
        name: "memory-provider",
        complete: async (request) => {
          seen.push(request.messages.map((message) => `${message.role}:${message.content.map((part) => {
            if (part.type === "text") return part.text;
            if (part.type === "tool-result") return part.content;
            if (part.type === "tool-use") return `${part.name}:${JSON.stringify(part.input)}`;
            return "";
          }).join("")}`).join("\n"));
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
      expect(store.listAuditEvents(20)).toContainEqual(expect.objectContaining({
        action: "agent.memory.retrieved",
        metadata: expect.objectContaining({
          resultCount: 2,
          method: "wiki-search",
          sources: ["legacy"]
        })
      }));
    } finally {
      store.close();
    }
  });

  it("creates memory drafts for explicit memory prompts without inferring ordinary chat", async () => {
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

      expect(readMemory({ paths, scope: "session", cwd: workspace, sessionId })).not.toContain("handoff: finish memory tests");
      const drafts = listDrafts({ appRoot: paths.root });
      expect(drafts).toHaveLength(1);
      const draft = showDraft({ appRoot: paths.root, id: drafts[0].id });
      expect(draft).toMatchObject({
        status: "pending",
        targetFile: "sessions/README.md",
        content: "handoff: finish memory tests"
      });
      expect(store.listAuditEvents(20)).toContainEqual(expect.objectContaining({
        action: "agent.memory.draft.created",
        target: "sessions/README.md",
        metadata: expect.objectContaining({ draftId: draft.id })
      }));

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
      expect(listDrafts({ appRoot: paths.root })).toHaveLength(1);
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
          const transcript = request.messages.map((message) => `${message.role}:${message.content.map((part) => {
            if (part.type === "text") return part.text;
            if (part.type === "tool-result") return part.content;
            if (part.type === "tool-use") return `${part.name}:${JSON.stringify(part.input)}`;
            return "";
          }).join("")}`).join("\n");
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
      expect(seen[1].transcript).toContain("system:[Previous conversation summary]\nCOMPACTED SUMMARY");
      expect(store.getLatestContextSummary(sessionId)?.summary).toBe("COMPACTED SUMMARY");
      expect(store.listAuditEvents(20).some((event) => event.action === "agent.context.compacted")).toBe(true);
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
        calls.push(request.tools?.map((tool) => tool.name).sort().join(",") ?? "");
        if (!request.messages.some((message) => message.role === "tool")) {
          expect(request.tools?.map((tool) => tool.name)).toContain("mcp__notes__read_note");
          return {
            text: "",
            toolUses: [{
              type: "tool-use",
              id: "mcp-1",
              name: "mcp__notes__read_note",
              input: { key: "alpha" }
            }]
          };
        }
        expect(request.messages.at(-1)).toMatchObject({
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "mcp-1" }]
        });
        return { text: "mcp done" };
      }
    };
    const result = await collectResult(runAgentQuery({
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
    }));

    expect(result.events).toContainEqual(expect.objectContaining({
      type: "tool_result",
      toolName: "mcp__notes__read_note",
      content: "called read_note"
    }));
    expect(result.final.text).toBe("mcp done");
    expect(calls[0]).toContain("mcp__notes__read_note");
  });

  it("returns MCP approval requests through the normal approval event", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const adapter: ProviderAdapter = {
      name: "mcp-provider",
      complete: async (request) => request.messages.some((message) => message.role === "tool")
        ? { text: "mcp blocked" }
        : {
          text: "",
          toolUses: [{
            type: "tool-use",
            id: "mcp-write",
            name: "mcp__notes__write_note",
            input: { path: "note.txt", content: "hello" }
          }]
        }
    };
    const result = await collectResult(runAgentQuery({
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
    }));

    expect(result.events).toContainEqual(expect.objectContaining({
      type: "approval_request",
      toolUse: expect.objectContaining({ name: "mcp__notes__write_note" })
    }));
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "tool_result",
      toolName: "mcp__notes__write_note",
      isError: true
    }));
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
          retryableInNextRequest = toolResult?.type === "tool-result" ? toolResult.retryable : undefined;
          return { text: "auth retry surfaced" };
        }
        return {
          text: "",
          toolUses: [{
            type: "tool-use",
            id: "mcp-auth",
            name: "mcp__notes__read_note",
            input: { key: "alpha" }
          }]
        };
      }
    };
    const result = await collectResult(runAgentQuery({
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
    }));

    expect(result.events).toContainEqual(expect.objectContaining({
      type: "tool_result",
      toolName: "mcp__notes__read_note",
      isError: true,
      retryable: true,
      content: expect.stringContaining("MCP auth required")
    }));
    expect(retryableInNextRequest).toBe(true);
    expect(result.final.text).toBe("auth retry surfaced");
  });

  it("exposes MCP resources as first-class agent tools", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-query-"));
    const seenTools: string[] = [];
    const adapter: ProviderAdapter = {
      name: "mcp-provider",
      complete: async (request) => {
        seenTools.push(request.tools?.map((tool) => tool.name).sort().join(",") ?? "");
        if (!request.messages.some((message) => message.role === "tool")) {
          expect(request.tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining([
            "ListMcpResources",
            "ReadMcpResource"
          ]));
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
    const result = await collectResult(runAgentQuery({
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
    }));

    expect(result.events).toContainEqual(expect.objectContaining({
      type: "tool_result",
      toolName: "ListMcpResources",
      content: expect.stringContaining("note://alpha")
    }));
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "tool_result",
      toolName: "ReadMcpResource",
      content: expect.stringContaining("resource text for note://alpha")
    }));
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

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
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
