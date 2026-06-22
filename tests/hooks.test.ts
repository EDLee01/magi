import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HookDefinition, loadConfig } from "../src/config.js";
import { executeHooks, matchesHookCondition } from "../src/hooks/runner.js";
import { ensureMagiHome, getMagiPaths } from "../src/paths.js";
import { QueryEngine } from "../src/agent/query-engine.js";
import { runAgentQuery } from "../src/agent/query.js";
import { ProviderAdapter, textMessage } from "../src/providers/ir.js";
import { SessionStore } from "../src/session-store.js";

let workspace: string | undefined;

afterEach(() => {
  if (workspace) {
    rmSync(workspace, { recursive: true, force: true });
    workspace = undefined;
  }
});

describe("hooks", () => {
  it("accepts expanded hook events and stronger matcher conditions", () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-hooks-"));
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: path.join(workspace, ".magi-next") });
    ensureMagiHome(paths);
    writeFileSync(
      paths.configFile,
      [
        "hooks:",
        "  - event: user_prompt_submit",
        "    type: command",
        "    command: printf prompt",
        "  - event: permission_request",
        "    type: command",
        "    if: FileWrite(*)",
        "    command: printf permission",
        "  - event: permission_denied",
        "    type: command",
        "    command: printf denied",
        "  - event: subagent_start",
        "    type: command",
        "    if: agentType:worker",
        "    command: printf start",
        "  - event: subagent_stop",
        "    type: command",
        "    command: printf stop",
        "  - event: task_created",
        "    type: command",
        "    command: printf created",
        "  - event: task_completed",
        "    type: command",
        "    command: printf completed",
        "  - event: config_change",
        "    type: command",
        "    command: printf config",
        "  - event: setup",
        "    type: command",
        "    command: printf setup",
        "  - event: stop_failure",
        "    type: command",
        "    command: printf stop-failure",
        ""
      ].join("\n"),
      "utf8"
    );

    const config = loadConfig(paths, { MAGI_CONFIG_DIR: paths.root });
    expect(config.hooks.map((hook) => hook.event)).toEqual([
      "user_prompt_submit",
      "permission_request",
      "permission_denied",
      "subagent_start",
      "subagent_stop",
      "task_created",
      "task_completed",
      "config_change",
      "setup",
      "stop_failure"
    ]);
    expect(
      matchesHookCondition("agentType:worker", {
        sessionId: "s1",
        cwd: workspace,
        agentType: "worker"
      })
    ).toBe(true);
    expect(
      matchesHookCondition("*.ts", {
        sessionId: "s1",
        cwd: workspace,
        filePath: "src/main.ts"
      })
    ).toBe(true);
    expect(
      matchesHookCondition("Config(context.*)", {
        sessionId: "s1",
        cwd: workspace,
        toolName: "Config",
        toolInput: { setting: "context.recentMessages" }
      })
    ).toBe(true);
  });

  it("blocks pre_tool_use when a command hook exits 2", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-hooks-"));
    const results = await executeHooks({
      event: "pre_tool_use",
      hooks: [
        {
          event: "pre_tool_use",
          type: "command",
          if: "FileWrite(*)",
          command: "printf blocked && exit 2"
        }
      ],
      context: {
        sessionId: "s1",
        cwd: workspace,
        toolName: "FileWrite",
        toolInput: { file_path: "x.txt" },
        toolUseId: "tool-1"
      }
    });

    expect(results).toMatchObject([{ blocked: true, output: "blocked" }]);
  });

  it("injects post_tool_use hook output into the next model call", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-hooks-"));
    const seen: string[] = [];
    const adapter: ProviderAdapter = {
      name: "hook-provider",
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
        if (seen.length === 1) {
          return {
            text: "",
            toolUses: [
              {
                type: "tool-use",
                id: "tool-1",
                name: "FileWrite",
                input: { file_path: "hook.txt", content: "ok" }
              }
            ]
          };
        }
        return { text: "done" };
      }
    };

    const result = await collectResult(
      runAgentQuery({
        adapter,
        model: "explicit",
        messages: [textMessage("user", "write")],
        cwd: workspace,
        permissionMode: "acceptEdits",
        hooks: [
          {
            event: "post_tool_use",
            type: "command",
            if: "FileWrite(*)",
            command: "printf hook-output"
          }
        ]
      })
    );

    expect(result.final.text).toBe("done");
    expect(seen[1]).toContain("system:Hook output: hook-output");
    await expect(readFile(path.join(workspace, "hook.txt"), "utf8")).resolves.toBe("ok");
  });

  it("returns a blocked pre_tool_use result without executing the tool", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-hooks-"));
    const seen: string[] = [];
    const adapter: ProviderAdapter = {
      name: "hook-provider",
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
        if (seen.length === 1) {
          return {
            text: "",
            toolUses: [
              {
                type: "tool-use",
                id: "tool-blocked",
                name: "FileWrite",
                input: { file_path: "blocked.txt", content: "should not exist" }
              }
            ]
          };
        }
        return { text: "blocked acknowledged" };
      }
    };

    const result = await collectResult(
      runAgentQuery({
        adapter,
        model: "explicit",
        messages: [textMessage("user", "write")],
        cwd: workspace,
        hooks: [
          {
            event: "pre_tool_use",
            type: "command",
            if: "FileWrite(blocked.txt)",
            command: "printf policy-denied && exit 2"
          }
        ]
      })
    );

    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        toolCallId: "tool-blocked",
        toolName: "FileWrite",
        content: "Blocked by hook: policy-denied",
        isError: true
      })
    );
    expect(result.final.text).toBe("blocked acknowledged");
    expect(seen[1]).toContain("tool:Blocked by hook: policy-denied");
    await expect(readFile(path.join(workspace, "blocked.txt"), "utf8")).rejects.toThrow();
  });

  it("records session lifecycle hooks and hook_result events through QueryEngine", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-hooks-"));
    const store = new SessionStore(path.join(workspace, ".magi-next", "state", "sessions.sqlite"));
    try {
      const sessionId = store.createSession({ title: "hooks", cwd: workspace });
      const adapter: ProviderAdapter = {
        name: "hook-provider",
        complete: async () => ({ text: "done" })
      };
      const engine = new QueryEngine({
        store,
        sessionId,
        jobId: "job-hooks",
        cwd: workspace,
        routes: [{ providerName: "provider", model: "explicit", adapter }],
        hooks: [
          {
            event: "session_start",
            type: "command",
            command: "printf start:$ARGUMENTS"
          },
          {
            event: "session_end",
            type: "command",
            command: "printf end:$ARGUMENTS"
          }
        ]
      });

      const result = await engine.submitMessage("hello");
      const hookEvents = result.events.filter((event) => event.type === "hook_result");
      const audits = store
        .listAuditEvents(20)
        .filter((event) => event.action === "agent.hook.completed");

      expect(hookEvents.map((event) => event.event)).toEqual(["session_start", "session_end"]);
      expect(hookEvents[0].result.output).toContain('"source":"query"');
      expect(hookEvents[1].result.output).toContain('"lastAssistantMessage":"done"');
      expect(audits.map((event) => event.target)).toEqual([
        "session_end:command",
        "session_start:command"
      ]);
    } finally {
      store.close();
    }
  });

  it("runs user prompt and permission-denied hooks through QueryEngine", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-hooks-"));
    const stateRoot = path.join(workspace, ".magi-next", "state");
    const store = new SessionStore(path.join(stateRoot, "sessions.sqlite"));
    try {
      const sessionId = store.createSession({ title: "expanded hooks", cwd: workspace });
      const adapter: ProviderAdapter = {
        name: "expanded-hook-provider",
        complete: async (request) =>
          request.messages.some((message) => message.role === "tool")
            ? { text: "done" }
            : {
                text: "",
                toolUses: [
                  {
                    type: "tool-use",
                    id: "denied-hook",
                    name: "FileWrite",
                    input: { file_path: "denied.txt", content: "no" }
                  }
                ]
              }
      };
      const engine = new QueryEngine({
        store,
        sessionId,
        jobId: "job-expanded-hooks",
        cwd: workspace,
        stateRoot,
        permissionMode: "plan",
        routes: [{ providerName: "expanded", model: "explicit", adapter }],
        hooks: [
          {
            event: "user_prompt_submit",
            type: "command",
            command: "node -e 'process.stdout.write(process.env.ARGUMENTS)'"
          },
          {
            event: "permission_denied",
            type: "command",
            if: "FileWrite(*)",
            command: "node -e 'process.stdout.write(process.env.ARGUMENTS)'"
          }
        ]
      });

      const result = await engine.submitMessage("please update config");
      const hookEvents = result.events.filter((event) => event.type === "hook_result");
      expect(hookEvents.map((event) => event.event)).toEqual(
        expect.arrayContaining(["user_prompt_submit", "permission_denied"])
      );
      expect(
        hookEvents.some(
          (event) =>
            event.type === "hook_result" && event.result.output.includes("please update config")
        )
      ).toBe(true);
      expect(store.listAuditEvents(30).map((event) => event.action)).toEqual(
        expect.arrayContaining(["agent.permission.denied", "agent.hook.completed"])
      );
    } finally {
      store.close();
    }
  });

  it("runs config-change hooks for approved Config updates through QueryEngine", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-hooks-"));
    const root = path.join(workspace, ".magi-next");
    const paths = getMagiPaths({ MAGI_CONFIG_DIR: root });
    ensureMagiHome(paths);
    const store = new SessionStore(paths.sessionDbFile);
    try {
      const sessionId = store.createSession({ title: "config hook", cwd: workspace });
      const adapter: ProviderAdapter = {
        name: "config-hook-provider",
        complete: async (request) =>
          request.messages.some((message) => message.role === "tool")
            ? { text: "config done" }
            : {
                text: "",
                toolUses: [
                  {
                    type: "tool-use",
                    id: "config-hook",
                    name: "Config",
                    input: { setting: "context.recentMessages", value: 8 }
                  }
                ]
              }
      };
      const engine = new QueryEngine({
        store,
        sessionId,
        jobId: "job-config-hook",
        cwd: workspace,
        stateRoot: paths.stateRoot,
        permissionMode: "acceptEdits",
        toolRules: {
          allow: ["Config(*)"],
          ask: [],
          deny: []
        },
        routes: [{ providerName: "config-hook", model: "explicit", adapter }],
        hooks: [
          {
            event: "config_change",
            type: "command",
            if: "Config(context.*)",
            command: "printf config:$ARGUMENTS"
          }
        ]
      });

      const result = await engine.submitMessage("update config");
      expect(result.events).toContainEqual(
        expect.objectContaining({
          type: "hook_result",
          event: "config_change",
          result: expect.objectContaining({
            output: expect.stringContaining("context.recentMessages")
          })
        })
      );
      expect(store.listAuditEvents(30).map((event) => event.action)).toContain(
        "agent.config.updated"
      );
    } finally {
      store.close();
    }
  });

  it("reports command hook timeout as a hook result", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-hooks-"));
    const results = await executeHooks({
      event: "session_start",
      hooks: [
        {
          event: "session_start",
          type: "command",
          command: "sleep 1",
          timeoutMs: 10
        }
      ],
      context: {
        sessionId: "s1",
        cwd: workspace,
        source: "query"
      }
    });

    expect(results[0]).toMatchObject({
      timedOut: true,
      output: "Hook timed out after 10ms"
    });
  });

  it("runs prompt hooks through an explicit model runner", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-hooks-"));
    const seen: Array<{ model: string; text: string }> = [];
    const results = await executeHooks({
      event: "session_end",
      hooks: [
        {
          event: "session_end",
          type: "prompt",
          prompt: "summarize $ARGUMENTS",
          model: "provider:haiku"
        }
      ],
      context: {
        sessionId: "s1",
        cwd: workspace,
        source: "query",
        lastAssistantMessage: "done"
      },
      promptModel: async ({ model, messages }) => {
        seen.push({
          model,
          text: messages[0].content[0].type === "text" ? messages[0].content[0].text : ""
        });
        return { text: "prompt-hook-output" };
      }
    });

    expect(results[0]).toMatchObject({
      output: "prompt-hook-output",
      exitCode: 0,
      blocked: false
    });
    expect(seen).toEqual([
      expect.objectContaining({
        model: "provider:haiku",
        text: expect.stringContaining('"lastAssistantMessage":"done"')
      })
    ]);
  });

  it("reports prompt hooks without a model runner instead of faking a response", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-hooks-"));
    const results = await executeHooks({
      event: "session_end",
      hooks: [
        {
          event: "session_end",
          type: "prompt",
          prompt: "summarize",
          model: "provider:haiku"
        }
      ],
      context: {
        sessionId: "s1",
        cwd: workspace,
        source: "query"
      }
    });

    expect(results[0]).toMatchObject({
      exitCode: null,
      blocked: false,
      error: "Prompt hook requires a model runner"
    });
  });

  it("posts hook context to an HTTP hook with explicit header interpolation", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-hooks-"));
    const received: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
    const server = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        received.push({ headers: request.headers, body });
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("accepted");
      });
    });
    const url = await listen(server);
    try {
      const results = await executeHooks({
        event: "session_start",
        hooks: [
          {
            event: "session_start",
            type: "http",
            url,
            headers: {
              authorization: "Bearer $HOOK_TOKEN",
              "x-hidden": "$UNLISTED_SECRET"
            },
            allowedEnvVars: ["HOOK_TOKEN"],
            timeoutMs: 1000
          }
        ],
        env: {
          HOOK_TOKEN: "token-1",
          UNLISTED_SECRET: "do-not-send"
        },
        context: {
          sessionId: "s1",
          cwd: workspace,
          source: "query",
          model: "explicit"
        }
      });

      expect(results[0]).toMatchObject({
        output: "accepted",
        exitCode: 0,
        status: 200,
        blocked: false
      });
      expect(received).toHaveLength(1);
      expect(received[0].headers.authorization).toBe("Bearer token-1");
      expect(received[0].headers["x-hidden"]).toBe("");
      expect(JSON.parse(received[0].body)).toMatchObject({
        sessionId: "s1",
        source: "query",
        model: "explicit"
      });
    } finally {
      await closeServer(server);
    }
  });

  it("treats HTTP 403 hook responses as blocking", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-hooks-"));
    const server = http.createServer((_request, response) => {
      response.writeHead(403, { "content-type": "text/plain" });
      response.end("policy denied");
    });
    const url = await listen(server);
    try {
      const results = await executeHooks({
        event: "pre_tool_use",
        hooks: [
          {
            event: "pre_tool_use",
            type: "http",
            if: "FileWrite(*)",
            url
          }
        ],
        context: {
          sessionId: "s1",
          cwd: workspace,
          toolName: "FileWrite",
          toolInput: { file_path: "x.txt" },
          toolUseId: "tool-1"
        }
      });

      expect(results[0]).toMatchObject({
        output: "policy denied",
        exitCode: 1,
        status: 403,
        blocked: true
      });
    } finally {
      await closeServer(server);
    }
  });

  it("runs prompt hooks from QueryEngine session lifecycle hooks", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-hooks-"));
    const store = new SessionStore(path.join(workspace, ".magi-next", "state", "sessions.sqlite"));
    const calls: Array<{ model: string; prompt: string }> = [];
    try {
      const sessionId = store.createSession({ title: "prompt hooks", cwd: workspace });
      const adapter: ProviderAdapter = {
        name: "prompt-provider",
        complete: async (request) => {
          const text =
            request.messages[0].content[0].type === "text"
              ? request.messages[0].content[0].text
              : "";
          calls.push({ model: request.model, prompt: text });
          if (request.model === "hook-model") {
            return { text: "hook-summary" };
          }
          return { text: "main-done" };
        }
      };
      const engine = new QueryEngine({
        store,
        sessionId,
        jobId: "job-prompt-hook",
        cwd: workspace,
        routes: [{ providerName: "provider", model: "main-model", adapter }],
        hooks: [
          {
            event: "session_end",
            type: "prompt",
            prompt: "summarize $ARGUMENTS",
            model: "hook-model"
          }
        ]
      });

      const result = await engine.submitMessage("hello");
      const hookEvent = result.events.find(
        (event) => event.type === "hook_result" && event.event === "session_end"
      );

      expect(result.text).toBe("main-done");
      expect(hookEvent).toMatchObject({
        type: "hook_result",
        result: { output: "hook-summary", exitCode: 0 }
      });
      expect(calls.map((call) => call.model)).toEqual(["main-model", "hook-model"]);
      expect(calls[1].prompt).toContain('"lastAssistantMessage":"main-done"');
    } finally {
      store.close();
    }
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
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP test server did not bind to a TCP port");
  }
  return `http://127.0.0.1:${address.port}/hook`;
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

it("triggers file_changed hook when files are written", async () => {
  workspace = mkdtempSync(path.join(os.tmpdir(), "magi-file-hooks-"));
  const hooks: HookDefinition[] = [
    {
      event: "file_changed",
      type: "command",
      command: "printf file-changed"
    }
  ];

  const { writeWorkspaceFile } = await import("../src/tools/files.js");
  const result = writeWorkspaceFile({
    cwd: workspace,
    filePath: "test.txt",
    content: "hello",
    approved: true,
    hooks,
    sessionId: "test-session"
  });

  expect(result.path).toBe("test.txt");
  expect(result.approved).toBe(true);
});

it("triggers task_created and task_completed hooks", async () => {
  workspace = mkdtempSync(path.join(os.tmpdir(), "magi-task-hooks-"));
  const hooks: HookDefinition[] = [
    {
      event: "task_created",
      type: "command",
      command: "printf task-created"
    }
  ];

  const { replaceTodoList } = await import("../src/tools/todo.js");
  const result = await replaceTodoList({
    stateRoot: workspace,
    sessionId: "test-session",
    todos: [{ id: "1", content: "Task 1", status: "pending" }],
    hooks,
    cwd: workspace
  });

  expect(result.todos).toHaveLength(1);
  expect(result.todos[0].content).toBe("Task 1");
});

it("triggers config_change hook when config is updated", async () => {
  workspace = mkdtempSync(path.join(os.tmpdir(), "magi-config-hooks-"));
  const configFile = path.join(workspace, "config.yaml");
  writeFileSync(configFile, "version: '0.1'\n", "utf8");

  const hooks: HookDefinition[] = [
    {
      event: "config_change",
      type: "command",
      command: "printf config-changed"
    }
  ];

  const { executeConfigTool } = await import("../src/tools/config-tool.js");
  const result = await executeConfigTool({
    request: { setting: "control.port", value: 9000 },
    configFile,
    hooks,
    sessionId: "test-session",
    cwd: workspace
  });

  expect(result).toContain("Updated config");
});

it("triggers elicitation hooks for user questions", async () => {
  const { triggerElicitationHooks } = await import("../src/tools/user-question.js");
  const hooks: HookDefinition[] = [
    {
      event: "elicitation",
      type: "command",
      command: "printf elicitation"
    }
  ];

  const question = {
    questions: [
      {
        question: "Choose one",
        options: [
          { label: "A", description: "Option A" },
          { label: "B", description: "Option B" }
        ]
      }
    ]
  };

  await triggerElicitationHooks({
    hooks,
    sessionId: "test-session",
    cwd: workspace,
    question
  });
});

it("triggers worktree hooks for git operations", async () => {
  workspace = mkdtempSync(path.join(os.tmpdir(), "magi-worktree-hook-"));
  const { createWorktree, removeWorktree } = await import("../src/tools/git.js");
  const hooks: HookDefinition[] = [
    {
      event: "worktree_create",
      type: "command",
      command: "printf worktree-created"
    }
  ];

  // These will fail without a git repo, but we're just testing the hook trigger
  try {
    await createWorktree({
      cwd: workspace!,
      path: "test-worktree",
      hooks,
      sessionId: "test-session"
    });
  } catch {
    // Expected to fail without git repo
  }
});

it("triggers cwd_changed hook", async () => {
  const { changeCwd } = await import("../src/tools/workspace.js");
  const hooks: HookDefinition[] = [
    {
      event: "cwd_changed",
      type: "command",
      command: "printf cwd-changed"
    }
  ];

  const result = await changeCwd({
    cwd: workspace!,
    newCwd: "/tmp",
    hooks,
    sessionId: "test-session"
  });

  expect(result.oldCwd).toBe(workspace);
  expect(result.newCwd).toBe("/tmp");
});

it("triggers instructions_loaded hook", async () => {
  workspace = mkdtempSync(path.join(os.tmpdir(), "magi-instructions-"));
  writeFileSync(path.join(workspace, "AGENTS.md"), "# Agents\n", "utf8");

  const { loadAgentInstructionsWithHooks } = await import("../src/rules/agents-loader.js");
  const hooks: HookDefinition[] = [
    {
      event: "instructions_loaded",
      type: "command",
      command: "printf instructions-loaded"
    }
  ];

  const files = await loadAgentInstructionsWithHooks({
    cwd: workspace,
    hooks,
    sessionId: "test-session"
  });

  expect(files).toHaveLength(1);
  expect(files[0].content).toContain("# Agents");
});
