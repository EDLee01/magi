import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { MagiConfigError } from "../errors.js";
import { MagiPaths } from "../paths.js";

export type MarketplaceSourceKind = "local" | "git" | "url";

export interface MarketplaceSource {
  name: string;
  kind: MarketplaceSourceKind;
  location: string;
}

export interface MarketplaceEntry {
  name: string;
  version: string;
  source: string;
  description?: string;
}

export interface MarketplaceRecord {
  source: MarketplaceSource;
  entries: MarketplaceEntry[];
}

export function loadMarketplaceSource(
  value: unknown,
  source = "marketplace source"
): MarketplaceSource {
  if (!isRecord(value)) {
    throw new MagiConfigError(`Invalid ${source}: source must be an object`);
  }
  const name = readString(value.name, "name", source);
  if (value.kind !== "local" && value.kind !== "git" && value.kind !== "url") {
    throw new MagiConfigError(`Invalid ${source}: kind must be local, git, or url`);
  }
  const location = readString(value.location, "location", source);
  return { name, kind: value.kind, location };
}

export function listMarketplaceSources(paths: MagiPaths): MarketplaceSource[] {
  const dir = path.join(paths.pluginsRoot, "marketplaces");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) =>
      loadMarketplaceSource(JSON.parse(readFileSync(path.join(dir, entry), "utf8")), entry)
    );
}

export function loadMarketplace(source: MarketplaceSource): MarketplaceRecord {
  if (source.kind !== "local") {
    return { source, entries: [] };
  }
  const file = path.join(source.location, "marketplace.json");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.plugins)) {
    throw new MagiConfigError(`Invalid marketplace at ${file}: plugins must be a list`);
  }
  return {
    source,
    entries: parsed.plugins.map((entry, index) =>
      validateMarketplaceEntry(entry, `${file}:plugins.${index}`, source.name)
    )
  };
}

export function discoverLocalMarketplaceSources(paths: MagiPaths): MarketplaceSource[] {
  const root = path.join(paths.pluginsRoot, "marketplaces");
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const item = path.join(root, name);
    try {
      if (statSync(path.join(item, "marketplace.json")).isFile()) {
        return [{ name, kind: "local" as const, location: item }];
      }
    } catch {
      return [];
    }
    return [];
  });
}

export function formatMarketplaces(records: MarketplaceRecord[]): string {
  if (records.length === 0) {
    return "No marketplaces configured\n";
  }
  const lines: string[] = [];
  for (const record of records) {
    lines.push(`${record.source.name}\t${record.source.kind}\t${record.source.location}`);
    for (const entry of record.entries) {
      lines.push(`  ${entry.name}\t${entry.version}\t${entry.source}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function validateMarketplaceEntry(
  value: unknown,
  source: string,
  sourceName: string
): MarketplaceEntry {
  if (!isRecord(value)) {
    throw new MagiConfigError(`Invalid marketplace entry at ${source}: entry must be an object`);
  }
  return {
    name: readString(value.name, "name", source),
    version: readString(value.version, "version", source),
    source: readString(value.source, "source", source),
    description:
      value.description === undefined
        ? undefined
        : readString(value.description, "description", source)
  };
}

function readString(value: unknown, field: string, source: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new MagiConfigError(`Invalid ${source}: ${field} must be a non-empty string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
