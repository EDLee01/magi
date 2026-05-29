import { McpServerConfig } from "../config.js";
import { MagiUsageError } from "../errors.js";
import { VERSION } from "../version.js";
import { requiresMcpApproval } from "./approval.js";
import { createMcpTransport, McpTransport } from "./transport.js";
import {
  McpApprovalRequest,
  McpGetPromptResult,
  McpPrompt,
  McpPromptMessage,
  McpReadResourceResult,
  McpResource,
  McpResourceContent,
  McpTool,
  McpToolCallResult
} from "./types.js";

export class McpClient {
  private transport: McpTransport;
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason: unknown) => void;
    }
  >();

  constructor(
    private readonly input: {
      serverName: string;
      server: McpServerConfig;
      env?: NodeJS.ProcessEnv;
      onDisconnect?: () => void;
      /**
       * Called when the server returns 401. Should attempt to refresh the OAuth
       * token and return the new token, or undefined if not possible. The client
       * will retry the request once with the new token in headers.
       */
      onUnauthorized?: (info: { wwwAuthenticate: string | null }) => Promise<string | undefined>;
    }
  ) {
    this.transport = this.openConnection();
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "magi-next", version: VERSION },
      capabilities: {}
    });
  }

  async reconnect(): Promise<void> {
    if (this.closed) {
      throw new Error(`MCP client ${this.input.serverName} is closed`);
    }
    this.rejectAll(new Error(`MCP server ${this.input.serverName} reconnecting`));
    this.transport.close();
    this.transport = this.openConnection();
    await this.initialize();
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.requestWithSessionRetry("tools/list", {});
    if (!isRecord(result) || !Array.isArray(result.tools)) {
      return [];
    }
    return result.tools
      .filter(isRecord)
      .map((tool) => ({
        name: typeof tool.name === "string" ? tool.name : "",
        description: typeof tool.description === "string" ? tool.description : undefined,
        inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : undefined
      }))
      .filter((tool) => tool.name);
  }

  async callTool(input: {
    toolName: string;
    params: Record<string, unknown>;
    approved?: boolean;
  }): Promise<McpToolCallResult> {
    const approval = requiresMcpApproval({
      serverName: this.input.serverName,
      server: this.input.server,
      toolName: input.toolName,
      params: input.params
    });
    if (approval && !input.approved) {
      throw new McpApprovalRequiredError(approval);
    }
    const result = await this.requestWithSessionRetry("tools/call", {
      name: input.toolName,
      arguments: input.params
    });
    return { content: result };
  }

  async listResources(): Promise<McpResource[]> {
    const result = await this.requestWithSessionRetry("resources/list", {});
    if (!isRecord(result) || !Array.isArray(result.resources)) {
      return [];
    }
    return result.resources
      .filter(isRecord)
      .map((resource) => ({
        uri: typeof resource.uri === "string" ? resource.uri : "",
        name: typeof resource.name === "string" ? resource.name : undefined,
        description: typeof resource.description === "string" ? resource.description : undefined,
        mimeType: typeof resource.mimeType === "string" ? resource.mimeType : undefined
      }))
      .filter((resource) => resource.uri);
  }

  async readResource(uri: string): Promise<McpReadResourceResult> {
    const result = await this.requestWithSessionRetry("resources/read", { uri });
    if (!isRecord(result) || !Array.isArray(result.contents)) {
      return { contents: [] };
    }
    return {
      contents: result.contents.filter(isRecord).map(readResourceContent)
    };
  }

  /**
   * Lightweight health check. MCP has no standard ping RPC, so we use
   * `tools/list` (most servers cache its result) as a heartbeat.
   * Returns true if the server responds within timeoutMs.
   */
  async ping(timeoutMs = 5000): Promise<boolean> {
    try {
      await Promise.race([
        this.request("tools/list", {}),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("ping timeout")), timeoutMs)
        )
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async listPrompts(): Promise<McpPrompt[]> {
    const result = await this.requestWithSessionRetry("prompts/list", {});
    if (!isRecord(result) || !Array.isArray(result.prompts)) {
      return [];
    }
    return result.prompts
      .filter(isRecord)
      .map((prompt) => ({
        name: typeof prompt.name === "string" ? prompt.name : "",
        description: typeof prompt.description === "string" ? prompt.description : undefined,
        arguments: Array.isArray(prompt.arguments)
          ? prompt.arguments
              .filter(isRecord)
              .map((arg) => ({
                name: typeof arg.name === "string" ? arg.name : "",
                description: typeof arg.description === "string" ? arg.description : undefined,
                required: typeof arg.required === "boolean" ? arg.required : undefined
              }))
              .filter((a) => a.name)
          : undefined
      }))
      .filter((prompt) => prompt.name);
  }

  async getPrompt(name: string, params?: Record<string, string>): Promise<McpGetPromptResult> {
    const result = await this.requestWithSessionRetry("prompts/get", {
      name,
      arguments: params ?? {}
    });
    if (!isRecord(result)) {
      return { messages: [] };
    }
    const description = typeof result.description === "string" ? result.description : undefined;
    const messages = Array.isArray(result.messages)
      ? result.messages.filter(isRecord).map(readPromptMessage)
      : [];
    return { description, messages };
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.transport.close();
    this.rejectAll(new Error(`MCP client ${this.input.serverName} closed`));
  }

  private openConnection(): McpTransport {
    return createMcpTransport({
      serverName: this.input.serverName,
      server: this.input.server,
      env: this.input.env,
      callbacks: {
        onMessage: (message) => this.handleMessage(message),
        onError: (error) => this.rejectAll(error),
        onDisconnect: () => this.input.onDisconnect?.()
      }
    });
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error(`MCP client ${this.input.serverName} is closed`));
    }
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0" as const, id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport
        .ready()
        .then(() => this.transport.send(payload))
        .catch((error: unknown) => {
          if (this.pending.delete(id)) {
            reject(error);
          }
        });
    });
  }

  private async requestWithSessionRetry(
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    try {
      return await this.request(method, params);
    } catch (error) {
      if (error instanceof McpJsonRpcError && error.code === -32001) {
        await this.reconnect();
        return this.request(method, params);
      }
      // 401 Unauthorized — try to refresh OAuth token and retry once
      if (
        error &&
        typeof error === "object" &&
        (error as { name?: string }).name === "McpUnauthorizedError"
      ) {
        const unauthorizedError = error as { wwwAuthenticate: string | null };
        if (this.input.onUnauthorized) {
          const newToken = await this.input.onUnauthorized({
            wwwAuthenticate: unauthorizedError.wwwAuthenticate
          });
          if (newToken) {
            // Update headers and reconnect with new token
            this.input.server.headers = {
              ...(this.input.server.headers ?? {}),
              Authorization: `Bearer ${newToken}`
            };
            await this.reconnect();
            return this.request(method, params);
          }
        }
      }
      throw error;
    }
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message) || typeof message.id !== "number") {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(toJsonRpcError(message.error));
      return;
    }
    pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class McpApprovalRequiredError extends MagiUsageError {
  readonly approval: McpApprovalRequest;

  constructor(approval: McpApprovalRequest) {
    super(
      `MCP approval required for ${approval.serverName}/${approval.toolName}: ${approval.reason}`
    );
    this.name = "McpApprovalRequiredError";
    this.approval = approval;
  }
}

export class McpJsonRpcError extends Error {
  readonly code?: number;
  readonly data?: unknown;

  constructor(input: { code?: number; message: string; data?: unknown }) {
    super(input.message);
    this.name = "McpJsonRpcError";
    this.code = input.code;
    this.data = input.data;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJsonRpcError(error: unknown): McpJsonRpcError {
  if (!isRecord(error)) {
    return new McpJsonRpcError({ message: String(error) });
  }
  return new McpJsonRpcError({
    code: typeof error.code === "number" ? error.code : undefined,
    message: typeof error.message === "string" ? error.message : JSON.stringify(error),
    data: error.data
  });
}

function readResourceContent(value: Record<string, unknown>): McpResourceContent {
  return {
    uri: typeof value.uri === "string" ? value.uri : undefined,
    mimeType: typeof value.mimeType === "string" ? value.mimeType : undefined,
    text: typeof value.text === "string" ? value.text : undefined,
    blob: typeof value.blob === "string" ? value.blob : undefined
  };
}

function readPromptMessage(value: Record<string, unknown>): McpPromptMessage {
  const role =
    value.role === "user" || value.role === "assistant" || value.role === "system"
      ? value.role
      : "user";
  const content = isRecord(value.content) ? value.content : { type: "text", text: "" };
  if (
    content.type === "image" &&
    typeof content.data === "string" &&
    typeof content.mimeType === "string"
  ) {
    return { role, content: { type: "image", data: content.data, mimeType: content.mimeType } };
  }
  if (content.type === "resource" && isRecord(content.resource)) {
    return { role, content: { type: "resource", resource: readResourceContent(content.resource) } };
  }
  return {
    role,
    content: { type: "text", text: typeof content.text === "string" ? content.text : "" }
  };
}
