import { McpServerConfig } from "../config.js";
import { McpApprovalRequest } from "./types.js";

export function classifyMcpToolRisk(
  toolName: string,
  params: Record<string, unknown>
): McpApprovalRequest["risk"] {
  const lowered = toolName.toLowerCase();
  if (/(write|delete|exec|shell|apply|mutate|create|update)/.test(lowered)) {
    return "high";
  }
  if (Object.keys(params).some((key) => /(path|command|script)/i.test(key))) {
    return "high";
  }
  return "low";
}

export function requiresMcpApproval(input: {
  serverName: string;
  server: McpServerConfig;
  toolName: string;
  params: Record<string, unknown>;
}): McpApprovalRequest | undefined {
  const risk = classifyMcpToolRisk(input.toolName, input.params);
  if (input.server.approval === "never") {
    return undefined;
  }
  if (input.server.approval === "always" || risk === "high") {
    return {
      serverName: input.serverName,
      toolName: input.toolName,
      params: input.params,
      risk,
      reason:
        input.server.approval === "always"
          ? "server requires approval for every MCP call"
          : "tool call is high risk"
    };
  }
  return undefined;
}
