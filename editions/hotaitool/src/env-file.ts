import { existsSync, readFileSync } from "node:fs";

export function loadProviderEnvFile(
  envFile: string,
  merged: NodeJS.ProcessEnv = { ...process.env }
): NodeJS.ProcessEnv {
  if (!existsSync(envFile)) {
    return merged;
  }
  const parsed = parseEnvFile(readFileSync(envFile, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (merged[key] === undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

function parseEnvFile(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const body = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(body);
    if (!match) {
      continue;
    }
    result[match[1]] = parseEnvValue(match[2].trim());
  }
  return result;
}

function parseEnvValue(raw: string): string {
  if (!raw) {
    return "";
  }
  const quote = raw[0];
  if (quote === "'" || quote === '"') {
    if (raw.length < 2 || raw.at(-1) !== quote) {
      return raw;
    }
    return raw.slice(1, -1);
  }
  return raw;
}
