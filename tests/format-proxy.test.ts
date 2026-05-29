import { describe, it, expect } from "vitest";
import {
  magiToOpenAiChat,
  openAiChatToMagi,
  magiToAnthropicMessages,
  anthropicMessagesToMagi,
  openAiChatToAnthropicMessages,
  anthropicMessagesToOpenAiChat
} from "../src/providers/format-proxy.js";
import { textMessage, MagiMessage } from "../src/providers/ir.js";

describe("format-proxy", () => {
  describe("magiToOpenAiChat", () => {
    it("converts a simple text request", () => {
      const result = magiToOpenAiChat({
        model: "gpt-4",
        messages: [textMessage("user", "hello")],
        temperature: 0.7
      });
      expect(result.model).toBe("gpt-4");
      expect(result.messages).toEqual([{ role: "user", content: "hello" }]);
      expect(result.temperature).toBe(0.7);
    });

    it("converts tool definitions", () => {
      const result = magiToOpenAiChat({
        model: "gpt-4",
        messages: [textMessage("user", "read file")],
        tools: [
          {
            name: "read",
            description: "Read a file",
            inputSchema: { type: "object", properties: { path: { type: "string" } } }
          }
        ]
      });
      expect(result.tools).toHaveLength(1);
      expect(result.tools![0].type).toBe("function");
      expect(result.tools![0].function.name).toBe("read");
    });

    it("converts assistant messages with tool_use", () => {
      const msg: MagiMessage = {
        role: "assistant",
        content: [
          { type: "text", text: "Let me read that." },
          { type: "tool-use", id: "tc1", name: "read", input: { path: "/tmp/x" } }
        ]
      };
      const result = magiToOpenAiChat({ model: "gpt-4", messages: [msg] });
      expect(result.messages[0].tool_calls).toHaveLength(1);
      expect(result.messages[0].tool_calls![0].function.name).toBe("read");
      expect(result.messages[0].content).toBe("Let me read that.");
    });

    it("converts tool result messages", () => {
      const msg: MagiMessage = {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "tc1", content: "file contents here" }]
      };
      const result = magiToOpenAiChat({ model: "gpt-4", messages: [msg] });
      expect(result.messages[0].role).toBe("tool");
      expect(result.messages[0].tool_call_id).toBe("tc1");
      expect(result.messages[0].content).toBe("file contents here");
    });

    it("sets stream options when streaming", () => {
      const result = magiToOpenAiChat(
        { model: "gpt-4", messages: [textMessage("user", "hi")] },
        { stream: true }
      );
      expect(result.stream).toBe(true);
      expect(result.stream_options).toEqual({ include_usage: true });
    });
  });

  describe("openAiChatToMagi", () => {
    it("converts a simple text response", () => {
      const result = openAiChatToMagi({
        choices: [{ message: { role: "assistant", content: "Hello!" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 }
      });
      expect(result.text).toBe("Hello!");
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    });

    it("converts tool calls in response", () => {
      const result = openAiChatToMagi({
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "tc1",
                  type: "function",
                  function: { name: "bash", arguments: '{"command":"ls"}' }
                }
              ]
            }
          }
        ]
      });
      expect(result.toolUses).toHaveLength(1);
      expect(result.toolUses![0].name).toBe("bash");
      expect(result.toolUses![0].input).toEqual({ command: "ls" });
    });
  });

  describe("magiToAnthropicMessages", () => {
    it("extracts system messages", () => {
      const result = magiToAnthropicMessages({
        model: "claude-3",
        messages: [textMessage("system", "You are helpful."), textMessage("user", "hi")]
      });
      expect(result.system).toBe("You are helpful.");
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe("user");
    });

    it("converts tool definitions to Anthropic format", () => {
      const result = magiToAnthropicMessages({
        model: "claude-3",
        messages: [textMessage("user", "read")],
        tools: [{ name: "read", description: "Read file", inputSchema: { type: "object" } }]
      });
      expect(result.tools).toHaveLength(1);
      expect(result.tools![0].input_schema).toEqual({ type: "object" });
    });

    it("converts tool result messages to user role", () => {
      const msg: MagiMessage = {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "tc1", content: "result data" }]
      };
      const result = magiToAnthropicMessages({ model: "claude-3", messages: [msg] });
      expect(result.messages[0].role).toBe("user");
      const blocks = result.messages[0].content as Array<{ type: string; tool_use_id?: string }>;
      expect(blocks[0].type).toBe("tool_result");
      expect(blocks[0].tool_use_id).toBe("tc1");
    });
  });

  describe("anthropicMessagesToMagi", () => {
    it("converts text response", () => {
      const result = anthropicMessagesToMagi({
        content: [{ type: "text", text: "Hello!" }],
        usage: { input_tokens: 10, output_tokens: 5 }
      });
      expect(result.text).toBe("Hello!");
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    });

    it("converts tool_use blocks", () => {
      const result = anthropicMessagesToMagi({
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "tu1", name: "bash", input: { command: "ls" } }
        ]
      });
      expect(result.text).toBe("Let me check.");
      expect(result.toolUses).toHaveLength(1);
      expect(result.toolUses![0].name).toBe("bash");
    });
  });

  describe("cross-format: OpenAI ↔ Anthropic", () => {
    it("converts OpenAI request to Anthropic request", () => {
      const result = openAiChatToAnthropicMessages({
        model: "claude-3",
        messages: [
          { role: "system", content: "Be helpful" },
          { role: "user", content: "hello" }
        ],
        tools: [
          {
            type: "function",
            function: { name: "bash", description: "Run command", parameters: { type: "object" } }
          }
        ],
        max_tokens: 2048
      });
      expect(result.system).toBe("Be helpful");
      expect(result.messages).toHaveLength(1);
      expect(result.tools).toHaveLength(1);
      expect(result.max_tokens).toBe(2048);
    });

    it("converts Anthropic response to OpenAI response", () => {
      const result = anthropicMessagesToOpenAiChat({
        content: [
          { type: "text", text: "Done" },
          { type: "tool_use", id: "tu1", name: "bash", input: { command: "pwd" } }
        ],
        usage: { input_tokens: 100, output_tokens: 50 }
      });
      expect(result.choices[0].message.content).toBe("Done");
      expect(result.choices[0].message.tool_calls).toHaveLength(1);
      expect(result.choices[0].message.tool_calls![0].function.name).toBe("bash");
      expect(result.usage).toEqual({ prompt_tokens: 100, completion_tokens: 50 });
    });

    it("handles assistant tool_calls in OpenAI → Anthropic conversion", () => {
      const result = openAiChatToAnthropicMessages({
        model: "claude-3",
        messages: [
          { role: "user", content: "do it" },
          {
            role: "assistant",
            content: "OK",
            tool_calls: [
              { id: "tc1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } }
            ]
          },
          { role: "tool", tool_call_id: "tc1", content: "file.txt" }
        ]
      });
      expect(result.messages).toHaveLength(3);
      const assistantContent = result.messages[1].content as Array<{ type: string }>;
      expect(assistantContent[0].type).toBe("text");
      expect(assistantContent[1].type).toBe("tool_use");
      const toolResult = result.messages[2].content as Array<{
        type: string;
        tool_use_id?: string;
      }>;
      expect(toolResult[0].type).toBe("tool_result");
      expect(toolResult[0].tool_use_id).toBe("tc1");
    });
  });
});
