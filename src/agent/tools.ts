import { MagiMessage, MagiToolDefinition, MagiToolUsePart } from "../providers/ir.js";
import { WebSearchConfig } from "../config.js";
import {
  executeRegisteredTool,
  executeRegisteredTools,
  getBuiltinToolDefinitions,
  getCoreToolDefinitions,
  SubAgentRequest,
  SubAgentResult,
  ToolPermissionMode,
  ToolPermissionRules
} from "../tools/registry.js";
import { UserQuestionResolver } from "../tools/user-question.js";
import { UserMessageSink } from "../tools/user-message.js";

export interface AgentToolResult {
  toolCallId: string;
  toolName: string;
  content: string;
  isError?: boolean;
  retryable?: boolean;
  permission?: { decision: "allow" | "ask" | "deny"; reason: string; diff?: string };
}

export type { ToolPermissionMode };

export const BUILTIN_AGENT_TOOLS: MagiToolDefinition[] = getBuiltinToolDefinitions();
export const CORE_AGENT_TOOLS: MagiToolDefinition[] = getCoreToolDefinitions();

export async function executeBuiltinAgentTool(input: {
  cwd: string;
  toolUse: MagiToolUsePart;
  env?: NodeJS.ProcessEnv;
  stateRoot?: string;
  memoryRoot?: string;
  sessionId?: string;
  webSearchConfig?: WebSearchConfig;
  permissionMode?: ToolPermissionMode;
  rules?: ToolPermissionRules;
  promptModel?: (request: { messages: MagiMessage[] }) => Promise<{ text: string }>;
  userQuestionResolver?: UserQuestionResolver;
  userMessageSink?: UserMessageSink;
  spawnSubAgent?: (request: SubAgentRequest) => Promise<SubAgentResult>;
  approvalResolver?: (request: {
    toolUse: MagiToolUsePart;
    permission: { decision: "allow" | "ask" | "deny"; reason: string; diff?: string };
  }) => Promise<boolean> | boolean;
  signal?: AbortSignal;
}): Promise<AgentToolResult> {
  return executeRegisteredTool({
    cwd: input.cwd,
    toolUse: input.toolUse,
    env: input.env,
    stateRoot: input.stateRoot,
    memoryRoot: input.memoryRoot,
    sessionId: input.sessionId,
    webSearchConfig: input.webSearchConfig,
    permissionMode: input.permissionMode ?? "default",
    rules: input.rules,
    promptModel: input.promptModel,
    userQuestionResolver: input.userQuestionResolver,
    userMessageSink: input.userMessageSink,
    spawnSubAgent: input.spawnSubAgent,
    approvalResolver: input.approvalResolver,
    signal: input.signal
  });
}

export async function executeBuiltinAgentTools(input: {
  cwd: string;
  toolUses: MagiToolUsePart[];
  env?: NodeJS.ProcessEnv;
  stateRoot?: string;
  memoryRoot?: string;
  sessionId?: string;
  webSearchConfig?: WebSearchConfig;
  permissionMode?: ToolPermissionMode;
  rules?: ToolPermissionRules;
  promptModel?: (request: { messages: MagiMessage[] }) => Promise<{ text: string }>;
  userQuestionResolver?: UserQuestionResolver;
  userMessageSink?: UserMessageSink;
  spawnSubAgent?: (request: SubAgentRequest) => Promise<SubAgentResult>;
  approvalResolver?: (request: {
    toolUse: MagiToolUsePart;
    permission: { decision: "allow" | "ask" | "deny"; reason: string; diff?: string };
  }) => Promise<boolean> | boolean;
  signal?: AbortSignal;
}): Promise<AgentToolResult[]> {
  return executeRegisteredTools({
    cwd: input.cwd,
    toolUses: input.toolUses,
    env: input.env,
    stateRoot: input.stateRoot,
    memoryRoot: input.memoryRoot,
    sessionId: input.sessionId,
    webSearchConfig: input.webSearchConfig,
    permissionMode: input.permissionMode ?? "default",
    rules: input.rules,
    promptModel: input.promptModel,
    userQuestionResolver: input.userQuestionResolver,
    userMessageSink: input.userMessageSink,
    spawnSubAgent: input.spawnSubAgent,
    approvalResolver: input.approvalResolver,
    signal: input.signal
  });
}
