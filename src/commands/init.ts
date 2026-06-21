/**
 * `magi init` — interactive first-run setup wizard.
 *
 * Detects environment variables, asks the user a few questions via stdin,
 * and writes a working ~/.magi-next/config.yaml that includes:
 *   - One provider configured to a detected API key
 *   - Three model aliases (fast/main/deep)
 *   - A models.router so /model auto works out of the box
 */

import { existsSync, readFileSync } from "node:fs";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { MagiPaths } from "../paths.js";
import { atomicWrite } from "../fs-utils.js";

export interface InitInput {
  paths: MagiPaths;
  env: NodeJS.ProcessEnv;
  /** If true, never prompt — fail or skip if input would be needed. */
  nonInteractive?: boolean;
  /** Override: write provider directly without prompts. */
  preset?: "anthropic" | "openai" | "deepseek";
}

export interface InitResult {
  configFile: string;
  wrote: boolean;
  reason?: string;
  providerName?: string;
  baseUrl?: string;
}

interface ProviderPreset {
  name: string;
  envVars: string[];
  type: "messages-compatible" | "openai";
  format?: "anthropic-messages" | "openai-chat";
  defaultBaseUrl: string;
  fastModel: string;
  mainModel: string;
  deepModel: string;
  family: "claude" | "gpt" | "deepseek";
}

const PRESETS: Record<string, ProviderPreset> = {
  anthropic: {
    name: "anthropic",
    envVars: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"],
    type: "messages-compatible",
    format: "anthropic-messages",
    defaultBaseUrl: "https://api.anthropic.com",
    fastModel: "claude-haiku-4-5",
    mainModel: "claude-sonnet-4-6",
    deepModel: "claude-opus-4-7",
    family: "claude"
  },
  openai: {
    name: "openai",
    envVars: ["OPENAI_API_KEY"],
    type: "openai",
    defaultBaseUrl: "https://api.openai.com/v1",
    fastModel: "gpt-5.5",
    mainModel: "gpt-5.5",
    deepModel: "gpt-5.5",
    family: "gpt"
  },
  deepseek: {
    name: "deepseek",
    envVars: ["DEEPSEEK_API_KEY"],
    type: "openai",
    defaultBaseUrl: "https://api.deepseek.com",
    fastModel: "deepseek-chat",
    mainModel: "deepseek-chat",
    deepModel: "deepseek-reasoner",
    family: "deepseek"
  }
};

export async function runInit(input: InitInput): Promise<InitResult> {
  const configFile = input.paths.configFile;
  const exists = existsSync(configFile);
  let body = exists ? readFileSync(configFile, "utf8") : "";
  const isStubConfig = body.includes("providers: {}") && !body.includes("aliases:\n    main:");
  // Suppress stdout in non-interactive mode (let callers control output)
  const log = input.nonInteractive ? (_msg: string) => {} : (msg: string) => stdout.write(msg);

  if (exists && !isStubConfig && !input.preset) {
    if (input.nonInteractive) {
      return { configFile, wrote: false, reason: "config already exists" };
    }
    const ok = await ask(`${configFile} already has a real config. Overwrite? [y/N] `);
    if (ok.toLowerCase() !== "y" && ok.toLowerCase() !== "yes") {
      return { configFile, wrote: false, reason: "user declined" };
    }
  }

  // Detect which providers have credentials available
  const detected: ProviderPreset[] = [];
  for (const preset of Object.values(PRESETS)) {
    if (preset.envVars.some((v) => input.env[v])) {
      detected.push(preset);
    }
  }

  let preset: ProviderPreset;
  if (input.preset) {
    preset = PRESETS[input.preset];
  } else if (detected.length === 1) {
    preset = detected[0];
    log(`Found credentials for ${preset.name} (${envVarsFor(preset, input.env)}). Using it.\n`);
  } else if (detected.length > 1) {
    if (input.nonInteractive) {
      preset = detected[0];
    } else {
      log("Multiple credentials detected:\n");
      for (let i = 0; i < detected.length; i++) {
        log(`  ${i + 1}. ${detected[i].name} (${envVarsFor(detected[i], input.env)})\n`);
      }
      const choice = await ask(`Pick a provider [1-${detected.length}]: `);
      const idx = Math.max(0, Math.min(detected.length - 1, Number(choice) - 1));
      preset = detected[idx] ?? detected[0];
    }
  } else {
    if (input.nonInteractive) {
      return {
        configFile,
        wrote: false,
        reason:
          "no provider credentials detected (set ANTHROPIC_AUTH_TOKEN or similar in env, then re-run)"
      };
    }
    log("No API keys detected in your environment.\n\n");
    log("Pick a provider to set up:\n");
    const choices = Object.values(PRESETS);
    for (let i = 0; i < choices.length; i++) {
      log(`  ${i + 1}. ${choices[i].name} (set ${choices[i].envVars[0]} in your shell)\n`);
    }
    const choice = await ask(`Pick a provider [1-${choices.length}]: `);
    const idx = Math.max(0, Math.min(choices.length - 1, Number(choice) - 1));
    preset = choices[idx] ?? choices[0];
    log(`\nAdd to your shell profile (~/.zshrc or ~/.bashrc):\n`);
    log(`  export ${preset.envVars[0]}="<your-key>"\n\n`);
    log(`Then run 'magi init' again.\n`);
    return { configFile, wrote: false, reason: "credentials missing", providerName: preset.name };
  }

  let baseUrl = preset.defaultBaseUrl;
  if (!input.preset && !input.nonInteractive) {
    const customBase = await ask(`Base URL [${baseUrl}]: `);
    if (customBase.trim()) baseUrl = customBase.trim();
  }

  // Build the config
  const apiKeyEnv = preset.envVars.find((v) => input.env[v]) ?? preset.envVars[0];
  body = renderConfig({
    preset,
    apiKeyEnv,
    baseUrl
  });
  atomicWrite(configFile, body);

  log(`\n✓ Wrote ${configFile}\n`);
  log(`  Provider: ${preset.name}\n`);
  log(`  Aliases:  fast=${preset.fastModel}, main=${preset.mainModel}, deep=${preset.deepModel}\n`);
  log(`  Auto routing: enabled (try /model auto in the TUI)\n\n`);
  log(`Try:\n`);
  log(`  magi -p "hello"           # one-shot prompt\n`);
  log(`  magi                      # interactive TUI\n`);
  log(`  magi daemon start         # run a background daemon for /tasks and remote control\n\n`);

  return {
    configFile,
    wrote: true,
    providerName: preset.name,
    baseUrl
  };
}

function envVarsFor(preset: ProviderPreset, env: NodeJS.ProcessEnv): string {
  const set = preset.envVars.filter((v) => env[v]);
  return set[0] ?? "(none)";
}

async function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(prompt);
    return answer.trim();
  } finally {
    rl.close();
  }
}

function renderConfig(input: {
  preset: ProviderPreset;
  apiKeyEnv: string;
  baseUrl: string;
}): string {
  const { preset, apiKeyEnv, baseUrl } = input;
  const formatLine = preset.format ? `    format: ${preset.format}\n` : "";
  return `version: 0.1
control:
  bind: 127.0.0.1
  port: 8765
providers:
  ${preset.name}:
    type: ${preset.type}
${formatLine}    apiKeyEnv: ${apiKeyEnv}
    baseUrl: ${baseUrl}
    defaultModel: ${preset.mainModel}
models:
  aliases:
    fast: ${preset.name}:${preset.fastModel}
    main: ${preset.name}:${preset.mainModel}
    review: ${preset.name}:${preset.mainModel}
    deep: ${preset.name}:${preset.deepModel}
  fallbacks: {}
  router:
    fast:
      family: ${preset.family}
      role: haiku
      contextWindow: 200000
      supportsVision: true
    main:
      family: ${preset.family}
      role: sonnet
      contextWindow: 200000
      supportsVision: true
    review:
      family: ${preset.family}
      role: sonnet
      contextWindow: 200000
      supportsVision: true
    deep:
      family: ${preset.family}
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
  # Passive memory consolidation while the daemon is idle (reviewable drafts only).
  dream:
    enabled: false
    intervalMs: 86400000
hooks: []
`;
}
