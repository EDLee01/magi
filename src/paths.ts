import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { MagiConfigError } from "./errors.js";

export const MAGI_ENV_PREFIX = "MAGI_";
export const DEVELOPMENT_ROOT_NAME = ".magi-next";
export const FUTURE_STABLE_ROOT_NAME = ".magi";
export const DEFAULT_CONTROL_BIND = "127.0.0.1";
export const DEFAULT_CONTROL_PORT = 8765;

export interface MagiPaths {
  root: string;
  configFile: string;
  stateRoot: string;
  sessionsRoot: string;
  logsRoot: string;
  cacheRoot: string;
  pluginsRoot: string;
  skillsRoot: string;
  devicesRoot: string;
  sessionDbFile: string;
}

export interface RuntimeSettings {
  controlBind: string;
  controlPort: number;
}

export function getMagiPaths(
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir()
): MagiPaths {
  const root = env.MAGI_CONFIG_DIR
    ? path.resolve(env.MAGI_CONFIG_DIR)
    : path.join(homeDir, DEVELOPMENT_ROOT_NAME);

  const stateRoot = path.join(root, "state");

  return {
    root,
    configFile: path.join(root, "config.yaml"),
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

export function getRuntimeSettings(env: NodeJS.ProcessEnv = process.env): RuntimeSettings {
  return {
    controlBind: env.MAGI_CONTROL_BIND?.trim() || DEFAULT_CONTROL_BIND,
    controlPort: parseControlPort(env.MAGI_CONTROL_PORT)
  };
}

export function ensureMagiHome(paths: MagiPaths): void {
  for (const dir of [
    paths.root,
    paths.stateRoot,
    paths.sessionsRoot,
    paths.logsRoot,
    paths.cacheRoot,
    paths.pluginsRoot,
    paths.skillsRoot,
    paths.devicesRoot
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  if (!existsSync(paths.configFile)) {
    writeFileSync(paths.configFile, defaultConfigYaml(), { encoding: "utf8", flag: "wx" });
  }
}

export function defaultConfigYaml(): string {
  return [
    "version: 0.1",
    "control:",
    `  bind: ${DEFAULT_CONTROL_BIND}`,
    `  port: ${DEFAULT_CONTROL_PORT}`,
    "providers: {}",
    "models:",
    "  aliases: {}",
    "  fallbacks: {}",
    "mcp:",
    "  servers: {}",
    "context:",
    "  recentMessages: 6",
    "memory:",
    "  enabled: true",
    "  # root: /path/to/shared/Memory",
    "  autoWrite: explicit",
    "  maxResults: 8",
    "  scopes:",
    "    - user",
    "    - project",
    "    - session",
    "webSearch:",
    "  locale: zh-CN",
    "  market: CN",
    "  mainlandBoost: true",
    "  queryParam: q",
    "  resultsPath: results",
    "  titlePath: title",
    "  urlPath: url",
    "  snippetPath: snippet",
    "  maxResults: 10",
    ""
  ].join("\n");
}

function parseControlPort(raw: string | undefined): number {
  if (!raw) {
    return DEFAULT_CONTROL_PORT;
  }

  if (!/^[0-9]+$/.test(raw)) {
    throw new MagiConfigError(
      `MAGI_CONTROL_PORT must be an integer from 1 to 65535, got ${JSON.stringify(raw)}`
    );
  }

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new MagiConfigError(
      `MAGI_CONTROL_PORT must be an integer from 1 to 65535, got ${JSON.stringify(raw)}`
    );
  }

  return port;
}
