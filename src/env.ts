import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { MagiConfigError } from "./errors.js";
import { getMagiPaths, MAGI_ENV_PREFIX } from "./paths.js";

export interface MagiEnvFileResult {
  env: NodeJS.ProcessEnv;
  envFile: string;
  loadedKeys: string[];
}

export function loadMagiEnvFile(env: NodeJS.ProcessEnv = process.env): MagiEnvFileResult {
  const paths = getMagiPaths(env);
  const envFile = path.join(paths.root, ".env");
  const merged: NodeJS.ProcessEnv = { ...env };
  const loadedKeys: string[] = [];

  mergeEnvFile(merged, loadedKeys, envFile, { magiPrefixOnly: true });
  mergeEnvFile(merged, loadedKeys, path.join(paths.root, "provider.env"), {
    magiPrefixOnly: false
  });

  return { env: merged, envFile, loadedKeys };
}

function mergeEnvFile(
  merged: NodeJS.ProcessEnv,
  loadedKeys: string[],
  envFile: string,
  options: { magiPrefixOnly: boolean }
): void {
  if (!existsSync(envFile)) {
    return;
  }
  const parsed = parseMagiEnv(readFileSync(envFile, "utf8"), envFile);
  for (const [key, value] of Object.entries(parsed)) {
    if (options.magiPrefixOnly && !key.startsWith(MAGI_ENV_PREFIX)) {
      continue;
    }
    if (merged[key] === undefined) {
      merged[key] = value;
      loadedKeys.push(key);
    }
  }
}

export function parseMagiEnv(raw: string, envFile = ".env"): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const body = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(body);
    if (!match) {
      throw new MagiConfigError(`Invalid Magi env at ${envFile}:${lineNumber}: expected KEY=value`);
    }

    result[match[1]] = parseEnvValue(match[2].trim(), envFile, lineNumber);
  }
  return result;
}

function parseEnvValue(raw: string, envFile: string, lineNumber: number): string {
  if (!raw) {
    return "";
  }
  const quote = raw[0];
  if (quote === "'" || quote === '"') {
    if (raw.length < 2 || raw.at(-1) !== quote) {
      throw new MagiConfigError(
        `Invalid Magi env at ${envFile}:${lineNumber}: unterminated quoted value`
      );
    }
    const inner = raw.slice(1, -1);
    return quote === '"' ? unescapeDoubleQuotedValue(inner, envFile, lineNumber) : inner;
  }
  return raw;
}

function unescapeDoubleQuotedValue(value: string, envFile: string, lineNumber: number): string {
  return value.replace(/\\(.)/g, (_match, escaped: string) => {
    if (escaped === "n") return "\n";
    if (escaped === "r") return "\r";
    if (escaped === "t") return "\t";
    if (escaped === '"' || escaped === "\\" || escaped === "$") return escaped;
    throw new MagiConfigError(
      `Invalid Magi env at ${envFile}:${lineNumber}: unsupported escape \\${escaped}`
    );
  });
}
