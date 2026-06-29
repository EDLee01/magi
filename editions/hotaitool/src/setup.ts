import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import {
  getHotaitoolPaths,
  hasHotaitoolCredential,
  renderHotaitoolConfig,
  resolveHotaitoolClaudeBaseUrl,
  resolveHotaitoolOpenAiBaseUrl
} from "./config.js";

export interface SetupResult {
  configRoot: string;
  configFile: string;
  providerEnvFile: string;
  wroteConfig: boolean;
  wroteProviderEnv: boolean;
  reason?: string;
}

const PROVIDER_ENV_TEMPLATE = `# Magi HotAITool edition credentials
# Claude path (base URL without /v1):
# ANTHROPIC_AUTH_TOKEN=
# ANTHROPIC_BASE_URL=https://www.hotaitool.net
#
# GPT path (base URL with /v1):
# OPENAI_API_KEY=
# OPENAI_BASE_URL=https://www.hotaitool.net/v1
#
# Or a single shared key:
# HOTAITOOL_API_KEY=
`;

export function runSetup(env: NodeJS.ProcessEnv = process.env): SetupResult {
  const paths = getHotaitoolPaths(env);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  try {
    chmodSync(paths.root, 0o700);
  } catch {
    // best-effort on mounted dirs
  }

  let wroteProviderEnv = false;
  if (!existsSync(paths.providerEnvFile)) {
    writeFileSync(paths.providerEnvFile, PROVIDER_ENV_TEMPLATE, { encoding: "utf8", mode: 0o600 });
    wroteProviderEnv = true;
  }

  const mergedEnv = { ...env, ...loadInlineProviderEnv(paths.providerEnvFile) };
  if (!hasHotaitoolCredential(mergedEnv)) {
    return {
      configRoot: paths.root,
      configFile: paths.configFile,
      providerEnvFile: paths.providerEnvFile,
      wroteConfig: false,
      wroteProviderEnv,
      reason:
        "credentials missing — edit provider.env and set ANTHROPIC_AUTH_TOKEN, OPENAI_API_KEY, or HOTAITOOL_API_KEY"
    };
  }

  const configBody = renderHotaitoolConfig(mergedEnv);
  const exists = existsSync(paths.configFile);
  const shouldWrite =
    !exists || isStubConfig(exists ? readFileSync(paths.configFile, "utf8") : "");
  if (shouldWrite) {
    writeFileSync(paths.configFile, configBody, { encoding: "utf8", mode: 0o600 });
  }

  return {
    configRoot: paths.root,
    configFile: paths.configFile,
    providerEnvFile: paths.providerEnvFile,
    wroteConfig: shouldWrite,
    wroteProviderEnv
  };
}

export function formatSetupReport(result: SetupResult, env: NodeJS.ProcessEnv = process.env): string {
  const lines = [
    "Magi HotAITool setup",
    `configRoot: ${result.configRoot}`,
    `configFile: ${result.configFile}`,
    `providerEnvFile: ${result.providerEnvFile}`,
    `claudeBaseUrl: ${resolveHotaitoolClaudeBaseUrl(env)}`,
    `openAiBaseUrl: ${resolveHotaitoolOpenAiBaseUrl(env)}`,
    `wroteConfig: ${result.wroteConfig ? "yes" : "no"}`,
    `wroteProviderEnv: ${result.wroteProviderEnv ? "yes" : "no"}`
  ];
  if (result.reason) {
    lines.push(`note: ${result.reason}`);
  }
  lines.push("");
  return lines.join("\n");
}

function isStubConfig(body: string): boolean {
  return body.includes("providers: {}") && !body.includes("aliases:\n    main:");
}

function loadInlineProviderEnv(providerEnvFile: string): Record<string, string> {
  if (!existsSync(providerEnvFile)) {
    return {};
  }
  const parsed: Record<string, string> = {};
  for (const line of readFileSync(providerEnvFile, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) {
      continue;
    }
    parsed[match[1]] = match[2].trim();
  }
  return parsed;
}
