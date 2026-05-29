import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";

import { HookDefinition, loadConfig } from "../config.js";
import { MagiPaths } from "../paths.js";

export type ConfigToolValue = string | number | boolean;

export interface ConfigToolRequest {
  setting: string;
  value?: ConfigToolValue;
}

export const ConfigToolInputSchema = {
  type: "object",
  properties: {
    setting: { type: "string" },
    value: {
      anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }]
    }
  },
  required: ["setting"],
  additionalProperties: false
} satisfies Record<string, unknown>;

const SAFE_SETTINGS = {
  "control.bind": "string",
  "control.port": "number",
  "context.recentMessages": "number",
  "context.autoCompactTokenThreshold": "number",
  "context.compactionModel": "string",
  "models.aliases.main": "string"
} as const;

export function parseConfigToolInput(input: Record<string, unknown>): ConfigToolRequest {
  assertAllowedKeys(input, ["setting", "value"], "Config input");
  const setting = readNonEmptyString(input.setting, "setting");
  if (!isSafeSetting(setting)) {
    throw new Error(`Unsupported config setting: ${setting}`);
  }
  const value = input.value;
  if (value === undefined) {
    return { setting };
  }
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw new Error("Tool input value must be a string, number, or boolean");
  }
  const expected = SAFE_SETTINGS[setting];
  if (expected === "string" && typeof value !== "string") {
    throw new Error(`Config setting ${setting} requires a string value`);
  }
  if (
    expected === "number" &&
    (typeof value !== "number" || !Number.isInteger(value) || value < 1)
  ) {
    throw new Error(`Config setting ${setting} requires a positive integer value`);
  }
  return { setting, value };
}

export async function executeConfigTool(input: {
  request: ConfigToolRequest;
  configFile: string;
  env?: NodeJS.ProcessEnv;
  hooks?: HookDefinition[];
  sessionId?: string;
  cwd?: string;
}): Promise<string> {
  if (!existsSync(input.configFile)) {
    throw new Error(`Magi config file not found: ${input.configFile}`);
  }
  if (input.request.value === undefined) {
    const config = loadConfig(pathsFromConfigFile(input.configFile), input.env);
    const value = getNested(config as unknown as Record<string, unknown>, input.request.setting);
    return [
      `Config ${input.request.setting}`,
      `value: ${formatValue(value)}`,
      `configFile: ${input.configFile}`
    ].join("\n");
  }

  const raw = YAML.parse(readFileSync(input.configFile, "utf8"));
  const document = isRecord(raw) ? raw : {};
  setNested(document, input.request.setting, input.request.value);
  const text = YAML.stringify(document);
  validateConfigText(input.configFile, text, input.env);
  writeAtomic(input.configFile, text);

  if (input.hooks) {
    const { triggerHook } = await import("../hooks/trigger.js");
    void triggerHook({
      event: "config_change",
      hooks: input.hooks,
      context: {
        sessionId: input.sessionId,
        cwd: input.cwd ?? process.cwd(),
        action: "update",
        filePath: input.configFile
      }
    });
  }

  return [
    `Updated config ${input.request.setting}`,
    `value: ${formatValue(input.request.value)}`,
    `configFile: ${input.configFile}`
  ].join("\n");
}

export function safeConfigSettings(): string[] {
  return Object.keys(SAFE_SETTINGS).sort();
}

function validateConfigText(configFile: string, text: string, env?: NodeJS.ProcessEnv): void {
  const tmp = `${configFile}.validate-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, "utf8");
  try {
    loadConfig({ ...pathsFromConfigFile(configFile), configFile: tmp }, env);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function pathsFromConfigFile(configFile: string): MagiPaths {
  const root = path.dirname(configFile);
  const stateRoot = path.join(root, "state");
  return {
    root,
    configFile,
    stateRoot,
    sessionsRoot: path.join(root, "sessions"),
    logsRoot: path.join(root, "logs"),
    cacheRoot: path.join(root, "cache"),
    pluginsRoot: path.join(root, "plugins"),
    skillsRoot: path.join(root, "skills"),
    devicesRoot: path.join(root, "devices"),
    sessionDbFile: path.join(stateRoot, "sessions.sqlite")
  };
}

function setNested(root: Record<string, unknown>, dotted: string, value: ConfigToolValue): void {
  const parts = dotted.split(".");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!isRecord(next)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

function getNested(root: Record<string, unknown>, dotted: string): unknown {
  let current: unknown = root;
  for (const part of dotted.split(".")) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function writeAtomic(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, filePath);
}

function formatValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function isSafeSetting(value: string): value is keyof typeof SAFE_SETTINGS {
  return Object.prototype.hasOwnProperty.call(SAFE_SETTINGS, value);
}

function readNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Tool input ${label} must be a non-empty string`);
  }
  return value.trim();
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown field: ${unknown[0]}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
