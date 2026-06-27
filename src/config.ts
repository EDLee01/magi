import { readFileSync } from "node:fs";
import YAML from "yaml";

import { MagiConfigError } from "./errors.js";
import { MagiPaths, getRuntimeSettings } from "./paths.js";

export type ProviderKind = "openai" | "messages-compatible";
export type OpenAiEndpoint = "chat" | "responses";
export type MessagesCompatibleFormat = "openai-chat" | "anthropic-messages";

export interface ProviderConfig {
  type: ProviderKind;
  apiKeyEnv?: string;
  baseUrl?: string;
  defaultModel?: string;
  endpoint?: OpenAiEndpoint;
  format?: MessagesCompatibleFormat;
  timeoutMs?: number;
}

export interface MagiConfig {
  version: string;
  control: {
    bind: string;
    port: number;
    /** When true, Control API jobs may use any existing directory as cwd. */
    allowAnyCwd?: boolean;
    /** Default cwd for remote Control API jobs when the client omits cwd. */
    defaultCwd?: string;
    /** Deny delete/destructive tools on Control API jobs (yolo still applies otherwise). */
    denyDestructive?: boolean;
  };
  providers: Record<string, ProviderConfig>;
  models: {
    aliases: Record<string, string>;
    fallbacks: Record<string, string[]>;
    router?: Record<string, import("./routing/model-router.js").ModelCapabilities>;
  };
  mcp: {
    servers: Record<string, McpServerConfig>;
  };
  hooks: HookDefinition[];
  context: ContextConfig;
  memory: MemoryConfig;
  webSearch: WebSearchConfig;
}

export interface McpServerConfig {
  transport?: "stdio" | "http" | "sse" | "websocket" | "websocket-ide";
  command: string;
  args: string[];
  url?: string;
  headers?: Record<string, string>;
  env: Record<string, string>;
  approval: "always" | "dangerous" | "never";
  oauth?: McpOAuthConfig;
}

export interface McpOAuthConfig {
  /** Authorization Server URL. If omitted, server is expected to advertise via WWW-Authenticate. */
  authServerUrl?: string;
  /** Static client_id. If omitted, Dynamic Client Registration is attempted. */
  clientId?: string;
  /** Optional client secret (for confidential clients; PKCE prefers no secret). */
  clientSecret?: string;
  /** OAuth scope to request. */
  scope?: string;
}

export interface ContextConfig {
  recentMessages: number;
  autoCompactTokenThreshold?: number;
  /** Trigger compaction once the session reaches this many messages, even if
   * the token estimate is below the token threshold. Long conversations cause
   * model attention drift / hallucinations long before they hit the context
   * window, so this gives an earlier safety net. */
  autoCompactMessageThreshold?: number;
  compactionModel?: string;
}

export interface MemoryDreamConfig {
  enabled: boolean;
  intervalMs: number;
}

export interface MemoryConfig {
  enabled: boolean;
  root?: string;
  autoWrite: "off" | "explicit";
  maxResults: number;
  scopes: Array<"user" | "project" | "session">;
  selectionModel?: string;
  writeDecisionModel?: string;
  dream: MemoryDreamConfig;
}

export interface WebSearchConfig {
  provider?: "http-json";
  endpoint?: string;
  apiKeyEnv?: string;
  locale: string;
  market: string;
  mainlandBoost: boolean;
  queryParam: string;
  apiKeyHeader?: string;
  resultsPath: string;
  titlePath: string;
  urlPath: string;
  snippetPath: string;
  maxResults: number;
}

export type HookEvent =
  | "pre_tool_use"
  | "post_tool_use"
  | "post_tool_use_failure"
  | "session_start"
  | "session_end"
  | "user_prompt_submit"
  | "pre_compact"
  | "post_compact"
  | "permission_request"
  | "permission_denied"
  | "subagent_start"
  | "subagent_stop"
  | "teammate_idle"
  | "task_created"
  | "task_completed"
  | "elicitation"
  | "elicitation_result"
  | "config_change"
  | "worktree_create"
  | "worktree_remove"
  | "instructions_loaded"
  | "cwd_changed"
  | "file_changed"
  | "notification"
  | "setup"
  | "stop"
  | "stop_failure";
export type HookType = "command" | "prompt" | "http" | "agent";

export interface HookDefinition {
  event: HookEvent;
  type: HookType;
  if?: string;
  command?: string;
  prompt?: string;
  model?: string;
  url?: string;
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
  timeoutMs?: number;
  once?: boolean;
  blocking?: boolean;
}

export function loadConfig(paths: MagiPaths, env: NodeJS.ProcessEnv = process.env): MagiConfig {
  let raw: string;
  try {
    raw = readFileSync(paths.configFile, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new MagiConfigError(`Unable to read Magi config at ${paths.configFile}: ${detail}`);
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new MagiConfigError(
      [
        `Could not parse ${paths.configFile} as YAML.`,
        "",
        `  ${detail}`,
        "",
        "Common fixes:",
        "  - Check indentation (YAML uses spaces, not tabs)",
        "  - Quote strings with special chars (URLs with :, etc)",
        "  - Make sure list items start with `- `",
        "",
        "Run 'magi config' to see the resolved config (or 'magi doctor' for paths)."
      ].join("\n")
    );
  }

  return validateConfig(parsed, paths.configFile, env);
}

export function validateConfig(
  value: unknown,
  configFile: string,
  env: NodeJS.ProcessEnv = process.env
): MagiConfig {
  if (!isRecord(value)) {
    throw new MagiConfigError(`Invalid Magi config at ${configFile}: root value must be a mapping`);
  }

  const runtime = getRuntimeSettings(env);
  const controlValue = optionalRecord(value.control, "control", configFile);
  const providersValue = optionalRecord(value.providers, "providers", configFile);
  const modelsValue = optionalRecord(value.models, "models", configFile);
  const aliasesValue = optionalRecord(modelsValue.aliases, "models.aliases", configFile);
  const fallbacksValue = optionalRecord(modelsValue.fallbacks, "models.fallbacks", configFile);
  const mcpValue = optionalRecord(value.mcp, "mcp", configFile);
  const mcpServersValue = optionalRecord(mcpValue.servers, "mcp.servers", configFile);
  const hooksValue = value.hooks === undefined || value.hooks === null ? [] : value.hooks;
  const contextValue = optionalRecord(value.context, "context", configFile);
  const memoryValue = optionalRecord(value.memory, "memory", configFile);
  const webSearchValue = optionalRecord(value.webSearch, "webSearch", configFile);

  const version = value.version === undefined ? "0.1" : String(value.version);
  const control = {
    bind: readString(controlValue.bind, "control.bind", configFile, runtime.controlBind),
    port: readPort(controlValue.port, "control.port", configFile, runtime.controlPort),
    allowAnyCwd:
      readOptionalBoolean(controlValue.allowAnyCwd, "control.allowAnyCwd", configFile) ?? false,
    defaultCwd: readOptionalString(controlValue.defaultCwd, "control.defaultCwd", configFile),
    denyDestructive:
      readOptionalBoolean(controlValue.denyDestructive, "control.denyDestructive", configFile) ??
      false
  };

  const providers: Record<string, ProviderConfig> = {};
  for (const [name, rawProvider] of Object.entries(providersValue)) {
    if (!isRecord(rawProvider)) {
      throw new MagiConfigError(
        `Invalid Magi config at ${configFile}: providers.${name} must be a mapping`
      );
    }

    const type = rawProvider.type;
    if (type !== "openai" && type !== "messages-compatible") {
      throw new MagiConfigError(
        `Invalid Magi config at ${configFile}: providers.${name}.type must be openai or messages-compatible`
      );
    }

    const apiKeyEnv = readOptionalString(
      rawProvider.apiKeyEnv,
      `providers.${name}.apiKeyEnv`,
      configFile
    );

    const baseUrl = readOptionalString(
      rawProvider.baseUrl,
      `providers.${name}.baseUrl`,
      configFile
    );
    if (baseUrl !== undefined) {
      validateUrl(baseUrl, `providers.${name}.baseUrl`, configFile);
    }
    if (type === "messages-compatible" && baseUrl === undefined) {
      throw new MagiConfigError(
        `Invalid Magi config at ${configFile}: providers.${name}.baseUrl is required`
      );
    }

    const defaultModel = readOptionalString(
      rawProvider.defaultModel,
      `providers.${name}.defaultModel`,
      configFile
    );
    if (type === "messages-compatible" && defaultModel === undefined) {
      throw new MagiConfigError(
        `Invalid Magi config at ${configFile}: providers.${name}.defaultModel is required`
      );
    }

    const endpoint = readOptionalEndpoint(
      rawProvider.endpoint,
      `providers.${name}.endpoint`,
      configFile
    );
    const format = readOptionalMessagesFormat(
      rawProvider.format,
      `providers.${name}.format`,
      configFile
    );
    const timeoutMs = readOptionalPositiveInteger(
      rawProvider.timeoutMs,
      `providers.${name}.timeoutMs`,
      configFile
    );

    providers[name] = {
      type,
      apiKeyEnv,
      baseUrl,
      defaultModel,
      endpoint,
      format,
      timeoutMs
    };
  }

  const aliases: Record<string, string> = {};
  for (const [alias, target] of Object.entries(aliasesValue)) {
    if (!alias.trim()) {
      throw new MagiConfigError(
        `Invalid Magi config at ${configFile}: model alias names must not be empty`
      );
    }
    if (typeof target !== "string" || !target.trim()) {
      throw new MagiConfigError(
        `Invalid Magi config at ${configFile}: models.aliases.${alias} must be a non-empty string`
      );
    }
    aliases[alias] = target;
  }

  const fallbacks: Record<string, string[]> = {};
  for (const [alias, rawList] of Object.entries(fallbacksValue)) {
    if (!alias.trim()) {
      throw new MagiConfigError(
        `Invalid Magi config at ${configFile}: fallback names must not be empty`
      );
    }
    if (!Array.isArray(rawList)) {
      throw new MagiConfigError(
        `Invalid Magi config at ${configFile}: models.fallbacks.${alias} must be a list`
      );
    }
    fallbacks[alias] = rawList.map((target, index) => {
      if (typeof target !== "string" || !target.trim()) {
        throw new MagiConfigError(
          `Invalid Magi config at ${configFile}: models.fallbacks.${alias}.${index} must be a non-empty string`
        );
      }
      return target;
    });
  }

  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [name, rawServer] of Object.entries(mcpServersValue)) {
    if (!isRecord(rawServer)) {
      throw new MagiConfigError(
        `Invalid Magi config at ${configFile}: mcp.servers.${name} must be a mapping`
      );
    }
    const transport = readMcpTransport(
      rawServer.transport,
      `mcp.servers.${name}.transport`,
      configFile
    );
    const command = readString(rawServer.command, `mcp.servers.${name}.command`, configFile, "");
    const args = readStringList(rawServer.args, `mcp.servers.${name}.args`, configFile);
    const url = readOptionalString(rawServer.url, `mcp.servers.${name}.url`, configFile);
    const headers = readOptionalPlainStringMap(
      rawServer.headers,
      `mcp.servers.${name}.headers`,
      configFile
    );
    const serverEnv = readStringMap(rawServer.env, `mcp.servers.${name}.env`, configFile);
    if (transport === "stdio" && !command) {
      throw new MagiConfigError(
        `Invalid Magi config at ${configFile}: mcp.servers.${name}.command is required`
      );
    }
    if (transport !== "stdio") {
      if (!url) {
        throw new MagiConfigError(
          `Invalid Magi config at ${configFile}: mcp.servers.${name}.url is required`
        );
      }
      validateMcpUrl(url, `mcp.servers.${name}.url`, configFile, transport);
    }
    mcpServers[name] = {
      transport:
        rawServer.transport === undefined || rawServer.transport === null ? undefined : transport,
      command,
      args,
      url,
      headers,
      env: serverEnv,
      approval: readApproval(rawServer.approval, `mcp.servers.${name}.approval`, configFile),
      oauth: readOptionalMcpOAuth(rawServer.oauth, `mcp.servers.${name}.oauth`, configFile)
    };
  }
  const hooks = readHooks(hooksValue, "hooks", configFile);
  const context = {
    recentMessages:
      readOptionalPositiveInteger(
        contextValue.recentMessages,
        "context.recentMessages",
        configFile
      ) ?? 6,
    autoCompactTokenThreshold:
      readOptionalPositiveInteger(
        contextValue.autoCompactTokenThreshold,
        "context.autoCompactTokenThreshold",
        configFile
      ) ?? 150_000, // Default: compact at 150k estimated tokens (~75% of 200k context)
    autoCompactMessageThreshold:
      readOptionalPositiveInteger(
        contextValue.autoCompactMessageThreshold,
        "context.autoCompactMessageThreshold",
        configFile
      ) ?? 80, // Default: compact after 80 messages — quality drops well before context fills.
    compactionModel: readOptionalString(
      contextValue.compactionModel,
      "context.compactionModel",
      configFile
    )
  };
  const routerValue = optionalRecord(modelsValue.router, "models.router", configFile);
  const router = readRouterConfig(routerValue, configFile);
  const memory = readMemoryConfig(memoryValue, configFile);
  const webSearch = readWebSearchConfig(webSearchValue, configFile, env);

  return {
    version,
    control,
    providers,
    models: { aliases, fallbacks, router },
    mcp: { servers: mcpServers },
    hooks,
    context,
    memory,
    webSearch
  };
}

export function formatConfig(config: MagiConfig): string {
  return YAML.stringify(config);
}

function optionalRecord(
  value: unknown,
  field: string,
  configFile: string
): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new MagiConfigError(`Invalid Magi config at ${configFile}: ${field} must be a mapping`);
  }
  return value;
}

function readString(value: unknown, field: string, configFile: string, fallback: string): string {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new MagiConfigError(
      `Invalid Magi config at ${configFile}: ${field} must be a non-empty string`
    );
  }
  return value;
}

function readOptionalString(value: unknown, field: string, configFile: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new MagiConfigError(
      `Invalid Magi config at ${configFile}: ${field} must be a non-empty string`
    );
  }
  return value;
}

function readPort(value: unknown, field: string, configFile: string, fallback: number): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new MagiConfigError(
      `Invalid Magi config at ${configFile}: ${field} must be an integer from 1 to 65535`
    );
  }
  return value;
}

function readStringList(value: unknown, field: string, configFile: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new MagiConfigError(`Invalid Magi config at ${configFile}: ${field} must be a list`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new MagiConfigError(
        `Invalid Magi config at ${configFile}: ${field}.${index} must be a string`
      );
    }
    return item;
  });
}

function readStringMap(value: unknown, field: string, configFile: string): Record<string, string> {
  const record = optionalRecord(value, field, configFile);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== "string") {
      throw new MagiConfigError(
        `Invalid Magi config at ${configFile}: ${field}.${key} must be a string`
      );
    }
    if (!key.startsWith("MAGI_")) {
      throw new MagiConfigError(
        `Invalid Magi config at ${configFile}: ${field}.${key} must use MAGI_*`
      );
    }
    result[key] = item;
  }
  return result;
}

function readOptionalPlainStringMap(
  value: unknown,
  field: string,
  configFile: string
): Record<string, string> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const record = optionalRecord(value, field, configFile);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== "string") {
      throw new MagiConfigError(
        `Invalid Magi config at ${configFile}: ${field}.${key} must be a string`
      );
    }
    result[key] = item;
  }
  return result;
}

function readApproval(
  value: unknown,
  field: string,
  configFile: string
): "always" | "dangerous" | "never" {
  if (value === undefined || value === null) {
    return "dangerous";
  }
  if (value !== "always" && value !== "dangerous" && value !== "never") {
    throw new MagiConfigError(
      `Invalid Magi config at ${configFile}: ${field} must be always, dangerous, or never`
    );
  }
  return value;
}

function readOptionalMcpOAuth(
  value: unknown,
  field: string,
  configFile: string
): McpOAuthConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new MagiConfigError(`Invalid Magi config at ${configFile}: ${field} must be a mapping`);
  }
  return {
    authServerUrl: readOptionalString(value.authServerUrl, `${field}.authServerUrl`, configFile),
    clientId: readOptionalString(value.clientId, `${field}.clientId`, configFile),
    clientSecret: readOptionalString(value.clientSecret, `${field}.clientSecret`, configFile),
    scope: readOptionalString(value.scope, `${field}.scope`, configFile)
  };
}

function readMcpTransport(
  value: unknown,
  field: string,
  configFile: string
): "stdio" | "http" | "sse" | "websocket" | "websocket-ide" {
  if (value === undefined || value === null) {
    return "stdio";
  }
  if (
    value !== "stdio" &&
    value !== "http" &&
    value !== "sse" &&
    value !== "websocket" &&
    value !== "websocket-ide"
  ) {
    throw new MagiConfigError(
      `Invalid Magi config at ${configFile}: ${field} must be stdio, http, sse, websocket, or websocket-ide`
    );
  }
  return value;
}

function readHooks(value: unknown, field: string, configFile: string): HookDefinition[] {
  if (!Array.isArray(value)) {
    throw new MagiConfigError(`Invalid Magi config at ${configFile}: ${field} must be a list`);
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new MagiConfigError(
        `Invalid Magi config at ${configFile}: ${field}.${index} must be a mapping`
      );
    }
    const event = readHookEvent(item.event, `${field}.${index}.event`, configFile);
    const type = readHookType(item.type, `${field}.${index}.type`, configFile);
    const hook: HookDefinition = {
      event,
      type,
      if: readOptionalString(item.if, `${field}.${index}.if`, configFile),
      command: readOptionalString(item.command, `${field}.${index}.command`, configFile),
      prompt: readOptionalString(item.prompt, `${field}.${index}.prompt`, configFile),
      model: readOptionalString(item.model, `${field}.${index}.model`, configFile),
      url: readOptionalString(item.url, `${field}.${index}.url`, configFile),
      headers: readOptionalPlainStringMap(item.headers, `${field}.${index}.headers`, configFile),
      allowedEnvVars: readStringList(
        item.allowedEnvVars,
        `${field}.${index}.allowedEnvVars`,
        configFile
      ),
      timeoutMs: readOptionalPositiveInteger(
        item.timeoutMs ?? item.timeout,
        `${field}.${index}.timeoutMs`,
        configFile
      ),
      once: readOptionalBoolean(item.once, `${field}.${index}.once`, configFile),
      blocking: readOptionalBoolean(item.blocking, `${field}.${index}.blocking`, configFile)
    };
    if (type === "command" && !hook.command) {
      throw new MagiConfigError(
        `Invalid Magi config at ${configFile}: ${field}.${index}.command is required`
      );
    }
    if (type === "prompt") {
      if (!hook.prompt) {
        throw new MagiConfigError(
          `Invalid Magi config at ${configFile}: ${field}.${index}.prompt is required`
        );
      }
      if (!hook.model) {
        throw new MagiConfigError(
          `Invalid Magi config at ${configFile}: ${field}.${index}.model is required`
        );
      }
    }
    if (type === "http") {
      if (!hook.url) {
        throw new MagiConfigError(
          `Invalid Magi config at ${configFile}: ${field}.${index}.url is required`
        );
      }
      validateUrl(hook.url, `${field}.${index}.url`, configFile);
    }
    return hook;
  });
}

function readWebSearchConfig(
  value: Record<string, unknown>,
  configFile: string,
  env: NodeJS.ProcessEnv
): WebSearchConfig {
  const providerRaw = readOptionalString(value.provider, "webSearch.provider", configFile);
  const endpoint =
    readOptionalString(value.endpoint, "webSearch.endpoint", configFile) ??
    readOptionalString(env.MAGI_WEBSEARCH_ENDPOINT, "MAGI_WEBSEARCH_ENDPOINT", configFile);
  let provider: "http-json" | undefined;
  if (providerRaw !== undefined) {
    if (providerRaw !== "http-json") {
      throw new MagiConfigError(
        `Invalid Magi config at ${configFile}: webSearch.provider must be http-json`
      );
    }
    provider = providerRaw;
  } else if (endpoint !== undefined) {
    provider = "http-json";
  }
  if (endpoint !== undefined) {
    validateUrl(endpoint, "webSearch.endpoint", configFile);
  }

  const apiKeyEnv =
    readOptionalString(value.apiKeyEnv, "webSearch.apiKeyEnv", configFile) ??
    readOptionalString(env.MAGI_WEBSEARCH_API_KEY_ENV, "MAGI_WEBSEARCH_API_KEY_ENV", configFile);

  return {
    provider,
    endpoint,
    apiKeyEnv,
    locale: readOptionalString(value.locale, "webSearch.locale", configFile) ?? "zh-CN",
    market: readOptionalString(value.market, "webSearch.market", configFile) ?? "CN",
    mainlandBoost:
      readOptionalBoolean(value.mainlandBoost, "webSearch.mainlandBoost", configFile) ?? true,
    queryParam: readOptionalString(value.queryParam, "webSearch.queryParam", configFile) ?? "q",
    apiKeyHeader: readOptionalString(value.apiKeyHeader, "webSearch.apiKeyHeader", configFile),
    resultsPath:
      readOptionalString(value.resultsPath, "webSearch.resultsPath", configFile) ?? "results",
    titlePath: readOptionalString(value.titlePath, "webSearch.titlePath", configFile) ?? "title",
    urlPath: readOptionalString(value.urlPath, "webSearch.urlPath", configFile) ?? "url",
    snippetPath:
      readOptionalString(value.snippetPath, "webSearch.snippetPath", configFile) ?? "snippet",
    maxResults:
      readOptionalPositiveInteger(value.maxResults, "webSearch.maxResults", configFile) ?? 10
  };
}

function readMemoryConfig(value: Record<string, unknown>, configFile: string): MemoryConfig {
  return {
    enabled: readOptionalBoolean(value.enabled, "memory.enabled", configFile) ?? true,
    root: readOptionalString(value.root, "memory.root", configFile),
    autoWrite: readMemoryAutoWrite(value.autoWrite, "memory.autoWrite", configFile),
    maxResults: readOptionalPositiveInteger(value.maxResults, "memory.maxResults", configFile) ?? 8,
    scopes: readMemoryScopes(value.scopes, "memory.scopes", configFile),
    selectionModel: readOptionalString(value.selectionModel, "memory.selectionModel", configFile),
    writeDecisionModel: readOptionalString(
      value.writeDecisionModel,
      "memory.writeDecisionModel",
      configFile
    ),
    dream: readMemoryDreamConfig(value.dream, "memory.dream", configFile)
  };
}

const MEMORY_DREAM_DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

function readMemoryDreamConfig(
  value: unknown,
  field: string,
  configFile: string
): MemoryDreamConfig {
  const record = optionalRecord(value, field, configFile);
  const intervalMs =
    readOptionalPositiveInteger(record.intervalMs, `${field}.intervalMs`, configFile) ??
    MEMORY_DREAM_DEFAULT_INTERVAL_MS;
  if (intervalMs < 1000) {
    throw new MagiConfigError(
      `Invalid Magi config at ${configFile}: ${field}.intervalMs must be >= 1000`
    );
  }
  return {
    enabled: readOptionalBoolean(record.enabled, `${field}.enabled`, configFile) ?? false,
    intervalMs
  };
}

function readMemoryAutoWrite(
  value: unknown,
  field: string,
  configFile: string
): "off" | "explicit" {
  if (value === undefined || value === null) {
    return "explicit";
  }
  if (value === "off" || value === "explicit") {
    return value;
  }
  throw new MagiConfigError(
    `Invalid Magi config at ${configFile}: ${field} must be off or explicit`
  );
}

function readMemoryScopes(
  value: unknown,
  field: string,
  configFile: string
): Array<"user" | "project" | "session"> {
  if (value === undefined || value === null) {
    return ["user", "project", "session"];
  }
  if (!Array.isArray(value)) {
    throw new MagiConfigError(`Invalid Magi config at ${configFile}: ${field} must be a list`);
  }
  const scopes = value.map((item, index) => {
    if (item === "user" || item === "project" || item === "session") {
      return item;
    }
    throw new MagiConfigError(
      `Invalid Magi config at ${configFile}: ${field}.${index} must be user, project, or session`
    );
  });
  return scopes.length === 0 ? ["user", "project", "session"] : scopes;
}

function readHookEvent(value: unknown, field: string, configFile: string): HookEvent {
  if (
    value === "pre_tool_use" ||
    value === "post_tool_use" ||
    value === "post_tool_use_failure" ||
    value === "session_start" ||
    value === "session_end" ||
    value === "user_prompt_submit" ||
    value === "pre_compact" ||
    value === "post_compact" ||
    value === "permission_request" ||
    value === "permission_denied" ||
    value === "subagent_start" ||
    value === "subagent_stop" ||
    value === "teammate_idle" ||
    value === "task_created" ||
    value === "task_completed" ||
    value === "elicitation" ||
    value === "elicitation_result" ||
    value === "config_change" ||
    value === "worktree_create" ||
    value === "worktree_remove" ||
    value === "instructions_loaded" ||
    value === "cwd_changed" ||
    value === "file_changed" ||
    value === "notification" ||
    value === "setup" ||
    value === "stop" ||
    value === "stop_failure"
  ) {
    return value;
  }
  throw new MagiConfigError(
    `Invalid Magi config at ${configFile}: ${field} is not a supported hook event`
  );
}

function readHookType(value: unknown, field: string, configFile: string): HookType {
  if (value === "command" || value === "prompt" || value === "http" || value === "agent") {
    return value;
  }
  throw new MagiConfigError(
    `Invalid Magi config at ${configFile}: ${field} is not a supported hook type`
  );
}

function readOptionalBoolean(
  value: unknown,
  field: string,
  configFile: string
): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new MagiConfigError(`Invalid Magi config at ${configFile}: ${field} must be a boolean`);
  }
  return value;
}

function readOptionalEndpoint(
  value: unknown,
  field: string,
  configFile: string
): OpenAiEndpoint | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value !== "chat" && value !== "responses") {
    throw new MagiConfigError(
      `Invalid Magi config at ${configFile}: ${field} must be chat or responses`
    );
  }
  return value;
}

function readOptionalMessagesFormat(
  value: unknown,
  field: string,
  configFile: string
): MessagesCompatibleFormat | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value !== "openai-chat" && value !== "anthropic-messages") {
    throw new MagiConfigError(
      `Invalid Magi config at ${configFile}: ${field} must be openai-chat or anthropic-messages`
    );
  }
  return value;
}

function readOptionalPositiveInteger(
  value: unknown,
  field: string,
  configFile: string
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new MagiConfigError(
      `Invalid Magi config at ${configFile}: ${field} must be a positive integer`
    );
  }
  return value;
}

function validateUrl(value: string, field: string, configFile: string): void {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new MagiConfigError(
      `Invalid Magi config at ${configFile}: ${field} must be an http or https URL`
    );
  }
}

function validateMcpUrl(
  value: string,
  field: string,
  configFile: string,
  transport: "http" | "sse" | "websocket" | "websocket-ide"
): void {
  try {
    const url = new URL(value);
    if (
      (transport === "http" || transport === "sse") &&
      url.protocol !== "https:" &&
      url.protocol !== "http:"
    ) {
      throw new Error("unsupported protocol");
    }
    if (transport === "websocket" && url.protocol !== "wss:" && url.protocol !== "ws:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    const expected = transport === "websocket" ? "ws or wss URL" : "http or https URL";
    throw new MagiConfigError(
      `Invalid Magi config at ${configFile}: ${field} must be a ${expected}`
    );
  }
}

function readRouterConfig(
  value: Record<string, unknown>,
  configFile: string
): Record<string, import("./routing/model-router.js").ModelCapabilities> | undefined {
  if (Object.keys(value).length === 0) {
    return undefined;
  }
  const result: Record<string, import("./routing/model-router.js").ModelCapabilities> = {};
  for (const [alias, raw] of Object.entries(value)) {
    if (!isRecord(raw)) {
      throw new MagiConfigError(
        `Invalid Magi config at ${configFile}: models.router.${alias} must be a mapping`
      );
    }
    const family = readString(raw.family, `models.router.${alias}.family`, configFile, "unknown");
    const role = readOptionalString(raw.role, `models.router.${alias}.role`, configFile) as
      | "haiku"
      | "sonnet"
      | "opus"
      | "main"
      | undefined;
    const contextWindow =
      readOptionalPositiveInteger(
        raw.contextWindow,
        `models.router.${alias}.contextWindow`,
        configFile
      ) ?? 128_000;
    const supportsVision = raw.supportsVision === true;
    const specialty = readOptionalSpecialty(
      raw.specialty,
      `models.router.${alias}.specialty`,
      configFile
    );
    const priority = readOptionalInteger(
      raw.priority,
      `models.router.${alias}.priority`,
      configFile
    );
    result[alias] = { family, role, contextWindow, supportsVision, specialty, priority };
  }
  return result;
}

function readOptionalSpecialty(
  value: unknown,
  field: string,
  configFile: string
): "coding" | "reasoning" | "vision" | "general" | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === "coding" || value === "reasoning" || value === "vision" || value === "general") {
    return value;
  }
  throw new MagiConfigError(
    `Invalid Magi config at ${configFile}: ${field} must be coding, reasoning, vision, or general`
  );
}

function readOptionalInteger(
  value: unknown,
  field: string,
  configFile: string
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new MagiConfigError(`Invalid Magi config at ${configFile}: ${field} must be an integer`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
