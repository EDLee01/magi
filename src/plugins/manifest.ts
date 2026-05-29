import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { MagiConfigError } from "../errors.js";
import { MagiPaths } from "../paths.js";

export interface PluginManifest {
  schemaVersion: "0.1";
  name: string;
  version: string;
  description?: string;
  entry?: string;
  permissions: string[];
}

export interface PluginRecord {
  manifest: PluginManifest;
  root: string;
}

export function loadPluginManifest(file: string): PluginManifest {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  return validatePluginManifest(parsed, file);
}

export function validatePluginManifest(value: unknown, source = "plugin.json"): PluginManifest {
  if (!isRecord(value)) {
    throw new MagiConfigError(`Invalid plugin manifest at ${source}: root must be an object`);
  }
  if (value.schemaVersion !== "0.1") {
    throw new MagiConfigError(`Invalid plugin manifest at ${source}: schemaVersion must be 0.1`);
  }
  const name = readName(value.name, "name", source);
  const version = readString(value.version, "version", source);
  const description =
    value.description === undefined
      ? undefined
      : readString(value.description, "description", source);
  const entry =
    value.entry === undefined ? undefined : readRelativePath(value.entry, "entry", source);
  const permissions = readStringList(value.permissions, "permissions", source);
  return { schemaVersion: "0.1", name, version, description, entry, permissions };
}

export function listLocalPlugins(paths: MagiPaths): PluginRecord[] {
  return listManifestDirectories(paths.pluginsRoot, "plugin.json").map((file) => ({
    root: path.dirname(file),
    manifest: loadPluginManifest(file)
  }));
}

export function formatPluginList(plugins: PluginRecord[]): string {
  if (plugins.length === 0) {
    return "No plugins installed\n";
  }
  return `${plugins
    .map((plugin) =>
      [
        plugin.manifest.name,
        plugin.manifest.version,
        plugin.manifest.permissions.join(",") || "no-permissions",
        plugin.root
      ].join("\t")
    )
    .join("\n")}\n`;
}

function listManifestDirectories(root: string, manifestName: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const manifests: string[] = [];
  for (const name of entries) {
    const item = path.join(root, name);
    const stat = statSync(item);
    if (!stat.isDirectory()) {
      continue;
    }
    const manifest = path.join(item, manifestName);
    try {
      if (statSync(manifest).isFile()) {
        manifests.push(manifest);
      }
    } catch {
      // Directories without manifests are ignored.
    }
  }
  return manifests.sort();
}

function readName(value: unknown, field: string, source: string): string {
  const name = readString(value, field, source);
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(name)) {
    throw new MagiConfigError(
      `Invalid plugin manifest at ${source}: ${field} must be a lowercase plugin id`
    );
  }
  return name;
}

function readRelativePath(value: unknown, field: string, source: string): string {
  const filePath = readString(value, field, source);
  if (path.isAbsolute(filePath) || filePath.includes("..")) {
    throw new MagiConfigError(
      `Invalid plugin manifest at ${source}: ${field} must be a relative in-plugin path`
    );
  }
  return filePath;
}

function readString(value: unknown, field: string, source: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new MagiConfigError(
      `Invalid plugin manifest at ${source}: ${field} must be a non-empty string`
    );
  }
  return value;
}

function readStringList(value: unknown, field: string, source: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    throw new MagiConfigError(
      `Invalid plugin manifest at ${source}: ${field} must be a string list`
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
