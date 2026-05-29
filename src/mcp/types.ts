export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpApprovalRequest {
  serverName: string;
  toolName: string;
  params: Record<string, unknown>;
  risk: "low" | "high";
  reason: string;
}

export interface McpToolCallResult {
  content: unknown;
}

export interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceContent {
  uri?: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface McpReadResourceResult {
  contents: McpResourceContent[];
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

export interface McpPromptMessage {
  role: "user" | "assistant" | "system";
  content:
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
    | { type: "resource"; resource: McpResourceContent };
}

export interface McpGetPromptResult {
  description?: string;
  messages: McpPromptMessage[];
}
