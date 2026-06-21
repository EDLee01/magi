import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { runCli } from "../src/cli.js";
import { ProviderError } from "../src/providers/errors.js";
import { messageText, ProviderAdapter, textMessage } from "../src/providers/ir.js";
import { MessagesCompatibleAdapter } from "../src/providers/messages-compatible.js";
import { OpenAiAdapter, parseOpenAiStream } from "../src/providers/openai.js";
import { resolveFallbackChain, resolveModelAlias } from "../src/routing/model-alias.js";
import { routeProviderRequest } from "../src/routing/router.js";
import { ensureMagiHome, getMagiPaths } from "../src/paths.js";
import { makeTempRoot, TempRoot } from "./helpers.js";

let temp: TempRoot | undefined;

afterEach(() => {
  temp?.cleanup();
  temp = undefined;
});

describe("provider routing", () => {
  it("uses provider-independent message IR", () => {
    const message = textMessage("user", "hello");
    expect(message).toEqual({ role: "user", content: [{ type: "text", text: "hello" }] });
    expect(messageText(message)).toBe("hello");
  });

  it("calls OpenAI chat completions with the shared IR", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const adapter = new OpenAiAdapter({
      name: "main",
      config: { type: "openai", apiKeyEnv: "MAGI_OPENAI_API_KEY", endpoint: "chat" },
      env: { MAGI_OPENAI_API_KEY: "test-key" },
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return jsonResponse({
          choices: [{ message: { content: "chat ok" } }],
          usage: { prompt_tokens: 3, completion_tokens: 2 }
        });
      }
    });

    const result = await adapter.complete({
      model: "gpt-test",
      messages: [textMessage("user", "hello")],
      maxOutputTokens: 123
    });

    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0].body).toMatchObject({
      model: "gpt-test",
      messages: [{ role: "user", content: "hello" }],
      max_completion_tokens: 123
    });
    expect(result.text).toBe("chat ok");
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
  });

  it("sets OpenAI tool auto-selection when tools are available", async () => {
    const calls: Array<{ body: unknown }> = [];
    const adapter = new OpenAiAdapter({
      name: "main",
      config: { type: "openai", apiKeyEnv: "MAGI_OPENAI_API_KEY", endpoint: "chat" },
      env: { MAGI_OPENAI_API_KEY: "test-key" },
      fetchImpl: async (_url, init) => {
        calls.push({ body: JSON.parse(String(init?.body)) });
        return jsonResponse({
          choices: [{ message: { content: "chat ok" } }],
          usage: { prompt_tokens: 3, completion_tokens: 2 }
        });
      }
    });

    await adapter.complete({
      model: "gpt-test",
      messages: [textMessage("user", "inspect repo")],
      tools: [
        {
          name: "FileRead",
          description: "Read a file",
          inputSchema: { type: "object", properties: { file_path: { type: "string" } } }
        }
      ]
    });

    expect(calls[0].body).toMatchObject({
      tool_choice: "auto",
      parallel_tool_calls: true,
      tools: [
        {
          type: "function",
          function: {
            name: "FileRead",
            description: "Read a file",
            parameters: { type: "object", properties: { file_path: { type: "string" } } }
          }
        }
      ]
    });
  });

  it("serializes assistant tool uses as OpenAI tool_calls", async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    const adapter = new OpenAiAdapter({
      name: "main",
      config: { type: "openai", apiKeyEnv: "MAGI_OPENAI_API_KEY", endpoint: "chat" },
      env: { MAGI_OPENAI_API_KEY: "test-key" },
      fetchImpl: async (_url, init) => {
        calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return jsonResponse({
          choices: [{ message: { content: "chat ok" } }],
          usage: { prompt_tokens: 3, completion_tokens: 2 }
        });
      }
    });

    await adapter.complete({
      model: "gpt-test",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-use",
              id: "call-1",
              name: "FileRead",
              input: { file_path: "README.md" }
            }
          ]
        }
      ]
    });

    expect(calls[0].body).toMatchObject({
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "FileRead",
                arguments: '{"file_path":"README.md"}'
              }
            }
          ]
        }
      ]
    });
  });

  it("calls OpenAI Responses and parses output_text", async () => {
    const adapter = new OpenAiAdapter({
      name: "main",
      config: { type: "openai", apiKeyEnv: "MAGI_OPENAI_API_KEY", endpoint: "responses" },
      env: { MAGI_OPENAI_API_KEY: "test-key" },
      fetchImpl: async () =>
        jsonResponse({
          output_text: "responses ok",
          usage: { input_tokens: 4, output_tokens: 5 }
        })
    });

    const result = await adapter.complete({
      model: "gpt-test",
      messages: [textMessage("user", "hello")]
    });

    expect(result.text).toBe("responses ok");
    expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 5 });
  });

  it("parses OpenAI-compatible array content text parts", async () => {
    const adapter = new OpenAiAdapter({
      name: "main",
      config: { type: "openai", apiKeyEnv: "MAGI_OPENAI_API_KEY", endpoint: "chat" },
      env: { MAGI_OPENAI_API_KEY: "test-key" },
      fetchImpl: async () =>
        jsonResponse({
          choices: [
            {
              message: {
                content: [
                  { type: "text", text: "visible " },
                  { type: "output_text", text: { value: "answer" } }
                ]
              }
            }
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2 }
        })
    });

    const result = await adapter.complete({
      model: "gpt-test",
      messages: [textMessage("user", "hello")]
    });

    expect(result.text).toBe("visible answer");
  });

  it("wraps OpenAI fetch failures as retryable network provider errors", async () => {
    const adapter = new OpenAiAdapter({
      name: "main",
      config: { type: "openai", apiKeyEnv: "MAGI_OPENAI_API_KEY", endpoint: "chat" },
      env: { MAGI_OPENAI_API_KEY: "test-key" },
      fetchImpl: async () => {
        throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
      }
    });

    await expect(
      adapter.complete({ model: "gpt-test", messages: [textMessage("user", "hello")] })
    ).rejects.toMatchObject({
      kind: "network",
      retryable: true
    });
    await expect(
      adapter.complete({ model: "gpt-test", messages: [textMessage("user", "hello")] })
    ).rejects.toThrow(/fetch failed/);
  });

  it("parses OpenAI-compatible streaming deltas", () => {
    const events = parseOpenAiStream(
      [
        'data: {"choices":[{"delta":{"content":"hel"}}]}',
        'data: {"choices":[{"delta":{"content":"lo"}}]}',
        'data: {"usage":{"prompt_tokens":1,"completion_tokens":2}}',
        "data: [DONE]",
        ""
      ].join("\n")
    );

    expect(events).toEqual([
      { type: "text-delta", text: "hel" },
      { type: "text-delta", text: "lo" },
      { type: "usage", usage: { inputTokens: 1, outputTokens: 2 } },
      { type: "done" }
    ]);
  });

  it("parses OpenAI-compatible streaming array content deltas", () => {
    const events = parseOpenAiStream(
      [
        'data: {"choices":[{"delta":{"content":[{"type":"text","text":"hel"}]}}]}',
        'data: {"choices":[{"delta":{"content":[{"type":"output_text","text":{"value":"lo"}}]}}]}',
        "data: [DONE]",
        ""
      ].join("\n")
    );

    expect(events).toEqual([
      { type: "text-delta", text: "hel" },
      { type: "text-delta", text: "lo" },
      { type: "done" }
    ]);
  });

  it("streams OpenAI chat deltas and tool-call chunks", async () => {
    const adapter = new OpenAiAdapter({
      name: "main",
      config: { type: "openai", apiKeyEnv: "MAGI_OPENAI_API_KEY", endpoint: "chat" },
      env: { MAGI_OPENAI_API_KEY: "test-key" },
      fetchImpl: async (_url, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({ stream: true });
        return sseResponse([
          { choices: [{ delta: { content: "hel" } }] },
          { choices: [{ delta: { content: "lo" } }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-1",
                      function: { name: "FileRead", arguments: '{"file_path":' }
                    }
                  ]
                }
              }
            ]
          },
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] } }
            ]
          },
          { usage: { prompt_tokens: 2, completion_tokens: 3 }, choices: [] }
        ]);
      }
    });

    const events = [];
    const stream = adapter.stream!({ model: "gpt-test", messages: [textMessage("user", "hello")] });
    let next = await stream.next();
    while (!next.done) {
      events.push(next.value);
      next = await stream.next();
    }

    expect(events).toContainEqual({ type: "text-delta", text: "hel" });
    expect(events).toContainEqual({ type: "text-delta", text: "lo" });
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 2, outputTokens: 3 } });
    expect(next.value).toMatchObject({
      text: "hello",
      usage: { inputTokens: 2, outputTokens: 3 },
      toolUses: [{ id: "call-1", name: "FileRead", input: { file_path: "README.md" } }]
    });
  });

  it("uses non-streaming OpenAI completion when tools are available", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const adapter = new OpenAiAdapter({
      name: "main",
      config: { type: "openai", apiKeyEnv: "MAGI_OPENAI_API_KEY", endpoint: "chat" },
      env: { MAGI_OPENAI_API_KEY: "test-key" },
      fetchImpl: async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return jsonResponse({
          choices: [{ message: { content: "complete ok" } }],
          usage: { prompt_tokens: 2, completion_tokens: 3 }
        });
      }
    });

    const stream = adapter.stream!({
      model: "gpt-test",
      messages: [textMessage("user", "inspect")],
      tools: [
        {
          name: "FileRead",
          description: "Read a file",
          inputSchema: { type: "object", properties: { file_path: { type: "string" } } }
        }
      ]
    });
    const first = await stream.next();

    expect(first.done).toBe(true);
    expect(first.value).toMatchObject({
      text: "complete ok",
      usage: { inputTokens: 2, outputTokens: 3 }
    });
    expect(calls[0]).toMatchObject({
      tool_choice: "auto",
      parallel_tool_calls: true
    });
    expect(calls[0]).not.toHaveProperty("stream");
  });

  it("calls messages-compatible providers only from explicit MAGI_* config", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const adapter = new MessagesCompatibleAdapter({
      name: "compatible",
      config: {
        type: "messages-compatible",
        apiKeyEnv: "MAGI_COMPATIBLE_API_KEY",
        baseUrl: "https://example.invalid/v1",
        defaultModel: "compat-model"
      },
      env: { MAGI_COMPATIBLE_API_KEY: "test-key", CLAUDE_API_KEY: "ignored" },
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return jsonResponse({
          choices: [{ message: { content: "compatible ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        });
      }
    });

    const result = await adapter.complete({
      model: "compat-model",
      messages: [textMessage("user", "hello")]
    });

    expect(calls[0].url).toBe("https://example.invalid/v1/chat/completions");
    expect(calls[0].body).toMatchObject({ model: "compat-model" });
    expect(result.text).toBe("compatible ok");
  });

  it("supports Anthropic Messages-compatible providers with explicit MAGI_* config", async () => {
    const calls: Array<{ url: string; headers: unknown; body: unknown }> = [];
    const adapter = new MessagesCompatibleAdapter({
      name: "anthropic",
      config: {
        type: "messages-compatible",
        format: "anthropic-messages",
        apiKeyEnv: "MAGI_ANTHROPIC_AUTH_TOKEN",
        baseUrl: "https://example.invalid",
        defaultModel: "claude-test"
      },
      env: { MAGI_ANTHROPIC_AUTH_TOKEN: "test-key", ANTHROPIC_AUTH_TOKEN: "ignored" },
      fetchImpl: async (url, init) => {
        calls.push({
          url: String(url),
          headers: init?.headers,
          body: JSON.parse(String(init?.body))
        });
        return jsonResponse({
          content: [{ type: "text", text: "anthropic ok" }],
          usage: { input_tokens: 2, output_tokens: 3 }
        });
      }
    });

    const result = await adapter.complete({
      model: "claude-test",
      messages: [textMessage("user", "hello")]
    });

    expect(calls[0].url).toBe("https://example.invalid/v1/messages");
    expect(calls[0].body).toMatchObject({
      model: "claude-test",
      messages: [{ role: "user", content: "hello" }]
    });
    expect(JSON.stringify(calls[0].headers)).toContain("x-api-key");
    expect(result.text).toBe("anthropic ok");
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 3 });
  });

  it("wraps compatible provider fetch failures as retryable network provider errors", async () => {
    const adapter = new MessagesCompatibleAdapter({
      name: "compatible",
      config: {
        type: "messages-compatible",
        apiKeyEnv: "MAGI_COMPATIBLE_API_KEY",
        baseUrl: "https://example.invalid",
        defaultModel: "compatible-test"
      },
      env: { MAGI_COMPATIBLE_API_KEY: "test-key" },
      fetchImpl: async () => {
        throw new TypeError("fetch failed", { cause: new Error("UND_ERR_SOCKET") });
      }
    });

    await expect(
      adapter.complete({ model: "compatible-test", messages: [textMessage("user", "hello")] })
    ).rejects.toMatchObject({
      kind: "network",
      retryable: true
    });
  });

  it("resolves model aliases and fallback chains", () => {
    const config = configWithAliases();
    expect(resolveModelAlias(config, "fast")).toEqual({
      providerName: "main",
      model: "gpt-fast",
      source: "fast"
    });
    expect(
      resolveFallbackChain(config, "main").map((item) => `${item.providerName}:${item.model}`)
    ).toEqual(["main:gpt-main", "backup:gpt-backup"]);
  });

  it("falls back on retryable provider failures", async () => {
    const config = configWithAliases();
    const registry = new Map<string, ProviderAdapter>([
      ["main", failingAdapter("main", new ProviderError("rate limited", { kind: "rate-limit" }))],
      ["backup", successfulAdapter("backup", "backup ok")]
    ]);

    const result = await routeProviderRequest({
      config,
      registry,
      alias: "main",
      messages: [textMessage("user", "hello")]
    });

    expect(result.response.text).toBe("backup ok");
    expect(result.attempts).toEqual([
      { providerName: "main", model: "gpt-main", ok: false, errorKind: "rate-limit" },
      { providerName: "backup", model: "gpt-backup", ok: true }
    ]);
  });

  it("does not fall back on non-retryable provider failures", async () => {
    const config = configWithAliases();
    const registry = new Map<string, ProviderAdapter>([
      [
        "main",
        failingAdapter("main", new ProviderError("bad key", { kind: "auth", retryable: false }))
      ],
      ["backup", successfulAdapter("backup", "should not run")]
    ]);

    await expect(
      routeProviderRequest({
        config,
        registry,
        alias: "main",
        messages: [textMessage("user", "hello")]
      })
    ).rejects.toThrow(/bad key/);
  });

  it("calls the default provider when --model is not explicit", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(
      paths.configFile,
      [
        "providers:",
        "  main:",
        "    type: openai",
        "    apiKeyEnv: MAGI_OPENAI_API_KEY",
        "    baseUrl: http://127.0.0.1:9/v1",
        "models:",
        "  aliases:",
        "    main: main:gpt-test",
        "  fallbacks: {}",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await runCli(
      ["-p", "hello"],
      { ...temp.env, MAGI_OPENAI_API_KEY: "test-key" },
      process.cwd()
    );

    // Provider call attempted (connection refused since port 9 is closed)
    expect(result.exitCode).toBeGreaterThan(0);
  });

  it("routes magi -p through provider config only with explicit --model", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(
      paths.configFile,
      [
        "providers:",
        "  main:",
        "    type: openai",
        "    apiKeyEnv: MAGI_OPENAI_API_KEY",
        "    baseUrl: http://127.0.0.1:9/v1",
        "models:",
        "  aliases:",
        "    main: main:gpt-test",
        "  fallbacks: {}",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await runCli(
      ["--model", "main", "-p", "hello"],
      { ...temp.env, MAGI_OPENAI_API_KEY: "test-key" },
      process.cwd()
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("fetch failed");
  });
});

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function configWithAliases() {
  return {
    version: "0.1",
    control: { bind: "127.0.0.1", port: 8765 },
    providers: {
      main: { type: "openai" as const, apiKeyEnv: "MAGI_OPENAI_API_KEY" },
      backup: { type: "openai" as const, apiKeyEnv: "MAGI_OPENAI_API_KEY" }
    },
    models: {
      aliases: {
        main: "main:gpt-main",
        fast: "main:gpt-fast",
        review: "main:gpt-review",
        deep: "backup:gpt-deep"
      },
      fallbacks: {
        main: ["backup:gpt-backup"]
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
    webSearch: {
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
  };
}

function sseResponse(events: unknown[]): Response {
  const body = [
    ...events.map((event) => `data: ${JSON.stringify(event)}\n\n`),
    "data: [DONE]\n\n"
  ].join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

function successfulAdapter(name: string, text: string): ProviderAdapter {
  return {
    name,
    complete: async () => ({ text })
  };
}

function failingAdapter(name: string, error: Error): ProviderAdapter {
  return {
    name,
    complete: async () => {
      throw error;
    }
  };
}
