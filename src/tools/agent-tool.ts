/**
 * Sub-agent tool: Agent.
 *
 * Spawns a sub-agent to handle complex, multi-step tasks autonomously.
 * Sub-agents run in the background and return results when complete.
 * This preserves the main context window for implementation work.
 */

import { randomUUID } from "node:crypto";

export type SubagentType = "general" | "explore" | "plan" | "verification";

export interface AgentToolInput {
  description: string;
  prompt: string;
  subagentType?: SubagentType;
  runInBackground?: boolean;
  /** Optional peer name (mDNS instance/hostname) or URL to dispatch the sub-agent to. */
  target?: string;
}

export interface SubagentResult {
  agentId: string;
  type: SubagentType;
  status: "completed" | "running" | "failed";
  result?: string;
  error?: string;
}

export const AgentToolInputSchema = {
  type: "object",
  properties: {
    description: {
      type: "string",
      description: "Short (3-5 word) description of what the agent will do"
    },
    prompt: { type: "string", description: "The task for the agent to perform" },
    subagent_type: {
      type: "string",
      enum: ["general", "explore", "plan", "verification"],
      description: "Type of specialized agent to use"
    },
    run_in_background: { type: "boolean", description: "Run agent in background (default false)" },
    target: {
      type: "string",
      description:
        "Optional peer name (mDNS) or URL of a remote Magi daemon to dispatch this sub-agent to. Use 'magi peers' to see available targets. If omitted, runs locally."
    }
  },
  required: ["description", "prompt"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseAgentToolInput(input: Record<string, unknown>): AgentToolInput {
  const description = input.description;
  if (typeof description !== "string" || !description.trim()) {
    throw new Error("Agent tool requires a non-empty description");
  }
  const prompt = input.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("Agent tool requires a non-empty prompt");
  }
  const subagentType = input.subagent_type;
  let parsedType: SubagentType = "general";
  if (subagentType !== undefined) {
    if (
      subagentType !== "general" &&
      subagentType !== "explore" &&
      subagentType !== "plan" &&
      subagentType !== "verification"
    ) {
      throw new Error("subagent_type must be general, explore, plan, or verification");
    }
    parsedType = subagentType;
  }
  const target =
    typeof input.target === "string" && input.target.trim() ? input.target.trim() : undefined;
  return {
    description: description.trim(),
    prompt: prompt.trim(),
    subagentType: parsedType,
    runInBackground: typeof input.run_in_background === "boolean" ? input.run_in_background : false,
    target
  };
}

export function formatAgentToolResult(result: SubagentResult): string {
  if (result.status === "running") {
    return `Agent ${result.agentId} (${result.type}) is running in the background.\nUse TaskList to check progress.`;
  }
  if (result.status === "failed") {
    return `Agent ${result.agentId} (${result.type}) failed: ${result.error ?? "unknown error"}`;
  }
  return result.result ?? "(no output)";
}
