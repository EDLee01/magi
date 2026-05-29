import { describe, expect, it } from "vitest";
import {
  parseAgentToolInput,
  formatAgentToolResult,
  AgentToolInputSchema,
  type SubagentResult
} from "../src/tools/agent-tool.js";

describe("Agent tool", () => {
  describe("parseAgentToolInput", () => {
    it("parses minimal valid input with default subagent type", () => {
      const result = parseAgentToolInput({
        description: "Find references",
        prompt: "Use Grep to find all uses of 'foo'"
      });
      expect(result.description).toBe("Find references");
      expect(result.prompt).toBe("Use Grep to find all uses of 'foo'");
      expect(result.subagentType).toBe("general");
      expect(result.runInBackground).toBe(false);
    });

    it("accepts all valid subagent types", () => {
      for (const type of ["general", "explore", "plan", "verification"] as const) {
        const result = parseAgentToolInput({
          description: "test",
          prompt: "test prompt",
          subagent_type: type
        });
        expect(result.subagentType).toBe(type);
      }
    });

    it("rejects invalid subagent types", () => {
      expect(() =>
        parseAgentToolInput({
          description: "test",
          prompt: "test",
          subagent_type: "invalid"
        })
      ).toThrow();
    });

    it("rejects empty description or prompt", () => {
      expect(() => parseAgentToolInput({ description: "", prompt: "test" })).toThrow();
      expect(() => parseAgentToolInput({ description: "test", prompt: "" })).toThrow();
      expect(() => parseAgentToolInput({ description: "test", prompt: "   " })).toThrow();
    });

    it("respects runInBackground flag", () => {
      const result = parseAgentToolInput({
        description: "bg task",
        prompt: "do something",
        run_in_background: true
      });
      expect(result.runInBackground).toBe(true);
    });
  });

  describe("formatAgentToolResult", () => {
    it("formats running background tasks with task ID hint", () => {
      const result: SubagentResult = {
        agentId: "abc-123",
        type: "general",
        status: "running"
      };
      const formatted = formatAgentToolResult(result);
      expect(formatted).toContain("abc-123");
      expect(formatted).toContain("background");
    });

    it("formats completed results by returning the result text", () => {
      const result: SubagentResult = {
        agentId: "xyz",
        type: "verification",
        status: "completed",
        result: "VERDICT: PASS\nAll tests green."
      };
      const formatted = formatAgentToolResult(result);
      expect(formatted).toContain("VERDICT: PASS");
    });

    it("formats failure with error context", () => {
      const result: SubagentResult = {
        agentId: "fail-1",
        type: "general",
        status: "failed",
        error: "Provider not configured"
      };
      const formatted = formatAgentToolResult(result);
      expect(formatted).toContain("failed");
      expect(formatted).toContain("Provider not configured");
    });
  });

  describe("AgentToolInputSchema", () => {
    it("declares description and prompt as required", () => {
      expect((AgentToolInputSchema as { required: string[] }).required).toContain("description");
      expect((AgentToolInputSchema as { required: string[] }).required).toContain("prompt");
    });

    it("declares all four valid subagent types", () => {
      const props = (AgentToolInputSchema as { properties: Record<string, { enum?: string[] }> })
        .properties;
      const enumValues = props.subagent_type.enum;
      expect(enumValues).toEqual(["general", "explore", "plan", "verification"]);
    });
  });
});
