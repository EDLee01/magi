import os from "node:os";
import path from "node:path";

export const HOTAITOOL_CONFIG_DIR_ENV = "MAGI_HOTAITOOL_CONFIG_DIR";
export const DEFAULT_CONFIG_ROOT_NAME = ".magi-hotaitool";

export const DEFAULT_HOTAITOOL_CLAUDE_BASE_URL = "https://www.hotaitool.net";
export const DEFAULT_HOTAITOOL_OPENAI_BASE_URL = "https://www.hotaitool.net/v1";

const CLAUDE_KEY_ENVS = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "HOTAITOOL_API_KEY"] as const;
const OPENAI_KEY_ENVS = ["OPENAI_API_KEY", "HOTAITOOL_API_KEY"] as const;

export interface HotaitoolPaths {
  root: string;
  configFile: string;
  providerEnvFile: string;
}

export function getHotaitoolPaths(
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir()
): HotaitoolPaths {
  const root = env[HOTAITOOL_CONFIG_DIR_ENV]
    ? path.resolve(env[HOTAITOOL_CONFIG_DIR_ENV])
    : path.join(homeDir, DEFAULT_CONFIG_ROOT_NAME);
  return {
    root,
    configFile: path.join(root, "config.yaml"),
    providerEnvFile: path.join(root, "provider.env")
  };
}

export function hasHotaitoolCredential(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    resolveHotaitoolClaudeApiKeyEnv(env) !== undefined ||
    resolveHotaitoolOpenAiApiKeyEnv(env) !== undefined
  );
}

export function resolveHotaitoolClaudeApiKeyEnv(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  return CLAUDE_KEY_ENVS.find((name) => Boolean(env[name]?.trim()));
}

export function resolveHotaitoolOpenAiApiKeyEnv(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  for (const name of OPENAI_KEY_ENVS) {
    if (env[name]?.trim()) {
      return name;
    }
  }
  return resolveHotaitoolClaudeApiKeyEnv(env);
}

export function resolveHotaitoolClaudeBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MAGI_HOTAITOOL_CLAUDE_BASE_URL?.trim();
  if (override) {
    return stripTrailingSlashes(override);
  }
  const anthropicBase = env.ANTHROPIC_BASE_URL?.trim();
  if (anthropicBase) {
    return stripTrailingSlashes(anthropicBase.replace(/\/v1\/?$/, ""));
  }
  return DEFAULT_HOTAITOOL_CLAUDE_BASE_URL;
}

export function resolveHotaitoolOpenAiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MAGI_HOTAITOOL_OPENAI_BASE_URL?.trim();
  if (override) {
    return ensureOpenAiBaseHasV1(override);
  }
  const openAiBase = env.OPENAI_BASE_URL?.trim();
  if (openAiBase) {
    return ensureOpenAiBaseHasV1(openAiBase);
  }
  return DEFAULT_HOTAITOOL_OPENAI_BASE_URL;
}

export function renderHotaitoolConfig(env: NodeJS.ProcessEnv = process.env): string {
  const claudeApiKeyEnv = resolveHotaitoolClaudeApiKeyEnv(env);
  const openAiApiKeyEnv = resolveHotaitoolOpenAiApiKeyEnv(env);
  const claudeBaseUrl = resolveHotaitoolClaudeBaseUrl(env);
  const openAiBaseUrl = resolveHotaitoolOpenAiBaseUrl(env);

  const providerBlocks: string[] = [];
  if (claudeApiKeyEnv) {
    providerBlocks.push(`  hotaitool-claude:
    type: messages-compatible
    format: anthropic-messages
    apiKeyEnv: ${claudeApiKeyEnv}
    baseUrl: ${claudeBaseUrl}
    defaultModel: claude-sonnet-4-6`);
  }
  if (openAiApiKeyEnv) {
    providerBlocks.push(`  hotaitool-openai:
    type: openai
    apiKeyEnv: ${openAiApiKeyEnv}
    baseUrl: ${openAiBaseUrl}
    defaultModel: gpt-5.5`);
  }

  const fastAlias = claudeApiKeyEnv
    ? "hotaitool-claude:claude-haiku-4-5"
    : "hotaitool-openai:gpt-5-mini";
  const mainAlias = claudeApiKeyEnv
    ? "hotaitool-claude:claude-sonnet-4-6"
    : "hotaitool-openai:gpt-5.5";
  const deepAlias = claudeApiKeyEnv
    ? "hotaitool-claude:claude-opus-4-7"
    : "hotaitool-openai:gpt-5.5-codex-max";

  return `version: 0.1
control:
  bind: 127.0.0.1
  port: 8765
providers:
${providerBlocks.join("\n")}
models:
  aliases:
    fast: ${fastAlias}
    main: ${mainAlias}
    review: ${mainAlias}
    deep: ${deepAlias}
  fallbacks: {}
  router:
    fast:
      family: ${claudeApiKeyEnv ? "claude" : "gpt"}
      role: haiku
      contextWindow: 200000
      supportsVision: true
    main:
      family: ${claudeApiKeyEnv ? "claude" : "gpt"}
      role: sonnet
      contextWindow: 200000
      supportsVision: true
    review:
      family: ${claudeApiKeyEnv ? "claude" : "gpt"}
      role: sonnet
      contextWindow: 200000
      supportsVision: true
    deep:
      family: ${claudeApiKeyEnv ? "claude" : "gpt"}
      role: opus
      contextWindow: 200000
      supportsVision: true
mcp:
  servers: {}
context:
  recentMessages: 6
  autoCompactTokenThreshold: 150000
  autoCompactMessageThreshold: 80
memory:
  enabled: true
  autoWrite: explicit
  maxResults: 5
  scopes:
    - user
    - project
  dream:
    enabled: false
    intervalMs: 86400000
webSearch:
  locale: zh-CN
  market: CN
  mainlandBoost: true
  queryParam: q
  resultsPath: results
  titlePath: title
  urlPath: url
  snippetPath: snippet
  maxResults: 10
hooks: []
`;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function ensureOpenAiBaseHasV1(value: string): string {
  const trimmed = stripTrailingSlashes(value);
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}
