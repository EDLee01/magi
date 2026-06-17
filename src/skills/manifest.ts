/**
 * magi-native skill install manifest (`.magi-skill.json`).
 *
 * This is magi's own install record, written into the skill directory root and
 * kept separate from the author's `SKILL.md` / `manifest.yaml`. It records where
 * the skill came from and, crucially, which files were materialized immediately
 * (`core`) versus left as on-demand pointers (`deferred`). Each entry carries the
 * git blob `sha`, which is content-addressed and immutable, so a deferred file
 * can be fetched later and is guaranteed to match what was installed.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { atomicWrite } from "../fs-utils.js";

export const SKILL_MANIFEST_FILE = ".magi-skill.json";

export interface SkillManifestSource {
  owner: string;
  repo: string;
  /** The ref the user asked for (branch/tag/commit), if any. */
  ref?: string;
  /** The ref actually used to list the tree (branch name or commit). */
  resolvedRef: string;
  /** Path within the repo to the skill directory ("" means repo root). */
  subdir: string;
}

export interface SkillFileEntry {
  /** Path relative to the skill directory root. */
  path: string;
  /** Git blob sha — content-addressed, immutable. Used to fetch deferred files. */
  sha: string;
  /** Size in bytes as reported by the git trees API (0 if unknown). */
  size: number;
}

export interface SkillManifestStats {
  totalFiles: number;
  coreFiles: number;
  coreBytes: number;
  deferredFiles: number;
  deferredBytes: number;
}

export interface SkillManifest {
  source: SkillManifestSource;
  installedAt: string;
  core: SkillFileEntry[];
  deferred: SkillFileEntry[];
  stats: SkillManifestStats;
}

export function manifestPathFor(skillDir: string): string {
  return path.join(skillDir, SKILL_MANIFEST_FILE);
}

export function buildSkillManifest(input: {
  source: SkillManifestSource;
  core: SkillFileEntry[];
  deferred: SkillFileEntry[];
  installedAt?: string;
}): SkillManifest {
  const core = sortEntries(input.core);
  const deferred = sortEntries(input.deferred);
  const coreBytes = core.reduce((sum, entry) => sum + entry.size, 0);
  const deferredBytes = deferred.reduce((sum, entry) => sum + entry.size, 0);
  return {
    source: input.source,
    installedAt: input.installedAt ?? new Date().toISOString(),
    core,
    deferred,
    stats: {
      totalFiles: core.length + deferred.length,
      coreFiles: core.length,
      coreBytes,
      deferredFiles: deferred.length,
      deferredBytes
    }
  };
}

export function writeSkillManifest(skillDir: string, manifest: SkillManifest): void {
  atomicWrite(manifestPathFor(skillDir), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Read a skill's install manifest. Returns undefined when the skill predates
 * the manifest model or the file is missing/unreadable/invalid — callers treat
 * a missing manifest as "fully materialized, nothing deferred".
 */
export function readSkillManifest(skillDir: string): SkillManifest | undefined {
  const file = manifestPathFor(skillDir);
  if (!existsSync(file)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  if (!isManifestShape(parsed)) {
    return undefined;
  }
  return parsed;
}

function sortEntries(entries: SkillFileEntry[]): SkillFileEntry[] {
  return [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function isManifestShape(value: unknown): value is SkillManifest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    isRecord(record.source) &&
    typeof record.installedAt === "string" &&
    Array.isArray(record.core) &&
    Array.isArray(record.deferred) &&
    record.core.every(isFileEntry) &&
    record.deferred.every(isFileEntry)
  );
}

function isFileEntry(value: unknown): value is SkillFileEntry {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.sha === "string" &&
    typeof value.size === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
