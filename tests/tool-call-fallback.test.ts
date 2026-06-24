import { describe, expect, it } from "vitest";

import {
  applyEmbeddedToolCallFallback,
  hasEmbeddedToolCall,
  parseEmbeddedToolCalls
} from "../src/providers/tool-call-fallback.js";

describe("embedded tool-call fallback", () => {
  it("parses Hermes XML <tool_call><function=...><parameter=...> form", () => {
    const content = [
      "Let me read that file.",
      "<tool_call>",
      "<function=FileRead>",
      "<parameter=file_path>/etc/hosts</parameter>",
      "</function>",
      "</tool_call>"
    ].join("\n");

    const { toolUses, text } = parseEmbeddedToolCalls(content);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("FileRead");
    expect(toolUses[0].input).toEqual({ file_path: "/etc/hosts" });
    // The block is stripped from the surfaced text.
    expect(text).toBe("Let me read that file.");
    expect(text).not.toContain("<tool_call>");
  });

  it("parses the Hermes JSON form inside <tool_call>", () => {
    const content =
      '<tool_call>{"name": "Grep", "arguments": {"pattern": "TODO", "path": "/src"}}</tool_call>';
    const { toolUses } = parseEmbeddedToolCalls(content);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("Grep");
    expect(toolUses[0].input).toEqual({ pattern: "TODO", path: "/src" });
  });

  it("parses a bare <function=...> block not wrapped in <tool_call>", () => {
    const content = "<function=Bash><parameter=command>ls -la</parameter></function>";
    const { toolUses } = parseEmbeddedToolCalls(content);
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0].name).toBe("Bash");
    expect(toolUses[0].input).toEqual({ command: "ls -la" });
  });

  it("coerces scalar parameter types", () => {
    const content = [
      "<tool_call>",
      "<function=Demo>",
      "<parameter=count>3</parameter>",
      "<parameter=flag>true</parameter>",
      "<parameter=name>hello</parameter>",
      "</function>",
      "</tool_call>"
    ].join("\n");
    const { toolUses } = parseEmbeddedToolCalls(content);
    expect(toolUses[0].input).toEqual({ count: 3, flag: true, name: "hello" });
  });

  it("parses multiple tool calls in one content blob", () => {
    const content = [
      "<tool_call><function=FileRead><parameter=file_path>a.txt</parameter></function></tool_call>",
      "<tool_call><function=FileRead><parameter=file_path>b.txt</parameter></function></tool_call>"
    ].join("\n");
    const { toolUses } = parseEmbeddedToolCalls(content);
    expect(toolUses).toHaveLength(2);
    expect(toolUses.map((t) => t.input.file_path)).toEqual(["a.txt", "b.txt"]);
  });

  it("returns nothing for plain prose", () => {
    const content = "This is just a normal answer with no tool calls.";
    expect(hasEmbeddedToolCall(content)).toBe(false);
    expect(parseEmbeddedToolCalls(content).toolUses).toHaveLength(0);
  });

  it("leaves unrecognized <tool_call> content intact rather than dropping it", () => {
    const content = "<tool_call>not a real tool call</tool_call>";
    const { toolUses, text } = parseEmbeddedToolCalls(content);
    expect(toolUses).toHaveLength(0);
    expect(text).toContain("<tool_call>");
  });

  describe("applyEmbeddedToolCallFallback", () => {
    it("is a no-op when structured tool_calls already exist", () => {
      const structured = {
        text: "<tool_call><function=FileRead><parameter=file_path>x</parameter></function></tool_call>",
        toolUses: [{ type: "tool-use" as const, id: "1", name: "RealTool", input: {} }]
      };
      const result = applyEmbeddedToolCallFallback(structured);
      // Structured channel is authoritative — text untouched, no embedded parse.
      expect(result.toolUses).toHaveLength(1);
      expect(result.toolUses[0].name).toBe("RealTool");
      expect(result.text).toContain("<tool_call>");
    });

    it("recovers tool calls when structured channel is empty", () => {
      const result = applyEmbeddedToolCallFallback({
        text: "Verifying.\n<tool_call><function=Bash><parameter=command>pytest</parameter></function></tool_call>",
        toolUses: []
      });
      expect(result.toolUses).toHaveLength(1);
      expect(result.toolUses[0].name).toBe("Bash");
      expect(result.text).toBe("Verifying.");
    });

    it("leaves plain text untouched", () => {
      const result = applyEmbeddedToolCallFallback({ text: "all good", toolUses: [] });
      expect(result.toolUses).toHaveLength(0);
      expect(result.text).toBe("all good");
    });
  });
});
