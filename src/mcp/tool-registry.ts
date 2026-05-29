import { McpServerConfig } from "../config.js";
import { MagiToolDefinition, MagiToolUsePart } from "../providers/ir.js";
import { AgentToolResult } from "../agent/tools.js";
import { McpApprovalRequiredError, McpClient, McpJsonRpcError } from "./client.js";
import { McpConnectionManager } from "./connection-manager.js";
import { McpResourceContent, McpTool } from "./types.js";

export interface McpToolRegistryInput {
  servers: Record<string, McpServerConfig>;
  env?: NodeJS.ProcessEnv;
  healthCheckIntervalMs?: number;
  tokenLookup?: (serverName: string) => string | undefined;
  tokenRefresh?: (serverName: string) => Promise<string | undefined>;
}

export class McpToolRegistry {
  private readonly manager: McpConnectionManager;
  private readonly toolsByName = new Map<
    string,
    {
      serverName: string;
      originalName: string;
      tool: McpTool;
    }
  >();
  private discovered = false;

  constructor(private readonly input: McpToolRegistryInput) {
    this.manager = new McpConnectionManager({
      servers: input.servers,
      env: input.env,
      healthCheckIntervalMs: input.healthCheckIntervalMs ?? 60_000,
      tokenLookup: input.tokenLookup,
      tokenRefresh: input.tokenRefresh
    });
  }

  async getToolDefinitions(): Promise<MagiToolDefinition[]> {
    await this.discover();
    return [
      ...MCP_RESOURCE_TOOLS,
      ...[...this.toolsByName.entries()].map(([name, record]) => ({
        name,
        description: record.tool.description,
        inputSchema: record.tool.inputSchema ?? { type: "object" }
      }))
    ];
  }

  hasTool(name: string): boolean {
    return name === "ListMcpResources" || name === "ReadMcpResource" || this.toolsByName.has(name);
  }

  async executeTool(input: {
    toolUse: MagiToolUsePart;
    approved?: boolean;
  }): Promise<AgentToolResult> {
    await this.discover();
    if (input.toolUse.name === "ListMcpResources") {
      return this.listResources(input.toolUse);
    }
    if (input.toolUse.name === "ReadMcpResource") {
      return this.readResource(input.toolUse);
    }
    const record = this.toolsByName.get(input.toolUse.name);
    if (!record) {
      return {
        toolCallId: input.toolUse.id,
        toolName: input.toolUse.name,
        content: `Unknown MCP tool: ${input.toolUse.name}`,
        isError: true
      };
    }
    const client = await this.client(record.serverName);
    try {
      const result = await client.callTool({
        toolName: record.originalName,
        params: input.toolUse.input,
        approved: input.approved
      });
      return {
        toolCallId: input.toolUse.id,
        toolName: input.toolUse.name,
        content: formatMcpToolContent(result.content)
      };
    } catch (error) {
      if (error instanceof McpApprovalRequiredError) {
        return {
          toolCallId: input.toolUse.id,
          toolName: input.toolUse.name,
          content: error.message,
          isError: true,
          permission: { decision: "ask", reason: error.approval.reason }
        };
      }
      if (error instanceof McpJsonRpcError && error.code === -32042) {
        return {
          toolCallId: input.toolUse.id,
          toolName: input.toolUse.name,
          content: `MCP auth required for ${record.serverName}/${record.originalName}`,
          isError: true,
          retryable: true
        };
      }
      return {
        toolCallId: input.toolUse.id,
        toolName: input.toolUse.name,
        content: error instanceof Error ? error.message : String(error),
        isError: true
      };
    }
  }

  private async listResources(toolUse: MagiToolUsePart): Promise<AgentToolResult> {
    const servers = readOptionalString(toolUse.input.server)
      ? [readString(toolUse.input.server, "server")]
      : Object.keys(this.input.servers);
    const lines: string[] = [];
    for (const serverName of servers) {
      const client = await this.client(serverName);
      const resources = await client.listResources();
      for (const resource of resources) {
        lines.push(
          [
            `${serverName}: ${resource.uri}`,
            resource.name ? `name=${resource.name}` : undefined,
            resource.mimeType ? `mime=${resource.mimeType}` : undefined,
            resource.description ? `description=${resource.description}` : undefined
          ]
            .filter((part): part is string => Boolean(part))
            .join(" | ")
        );
      }
    }
    return {
      toolCallId: toolUse.id,
      toolName: toolUse.name,
      content: lines.length === 0 ? "No MCP resources" : lines.join("\n")
    };
  }

  private async readResource(toolUse: MagiToolUsePart): Promise<AgentToolResult> {
    const serverName = readString(toolUse.input.server, "server");
    const uri = readString(toolUse.input.uri, "uri");
    const client = await this.client(serverName);
    const result = await client.readResource(uri);
    return {
      toolCallId: toolUse.id,
      toolName: toolUse.name,
      content:
        result.contents.length === 0
          ? `No content for ${uri}`
          : result.contents
              .map((content: McpResourceContent) =>
                [
                  content.uri ? `uri: ${content.uri}` : undefined,
                  content.mimeType ? `mime: ${content.mimeType}` : undefined,
                  content.text ?? content.blob ?? ""
                ]
                  .filter((part): part is string => Boolean(part))
                  .join("\n")
              )
              .join("\n\n")
    };
  }

  close(): void {
    this.manager.disconnectAll();
  }

  private async discover(): Promise<void> {
    if (this.discovered) {
      return;
    }
    for (const [serverName] of Object.entries(this.input.servers)) {
      const client = await this.client(serverName);
      const tools = await client.listTools();
      for (const tool of tools) {
        this.toolsByName.set(toMcpToolName(serverName, tool.name), {
          serverName,
          originalName: tool.name,
          tool
        });
      }
    }
    this.discovered = true;
  }

  private async client(serverName: string): Promise<McpClient> {
    return this.manager.connect(serverName);
  }
}

export function toMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

const MCP_RESOURCE_TOOLS: MagiToolDefinition[] = [
  {
    name: "ListMcpResources",
    description: "List resources exposed by configured MCP servers.",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string", description: "Optional MCP server name to filter resources." }
      },
      additionalProperties: false
    }
  },
  {
    name: "ReadMcpResource",
    description: "Read a resource by URI from a configured MCP server.",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string" },
        uri: { type: "string" }
      },
      required: ["server", "uri"],
      additionalProperties: false
    }
  }
];

function formatMcpToolContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (isRecord(value) && Array.isArray(value.content)) {
    const text = value.content
      .filter(isRecord)
      .map((part) => (typeof part.text === "string" ? part.text : JSON.stringify(part)))
      .join("\n");
    return text || JSON.stringify(value);
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`MCP tool input ${field} must be a non-empty string`);
  }
  return value;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
