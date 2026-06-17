/**
 * Classify a skill's files into `core` (materialized at install time) and
 * `deferred` (recorded as on-demand pointers).
 *
 * Two-level strategy, author declaration first:
 *
 *   A. If the skill ships a `manifest.yaml` (e.g. nature-reader), honor the
 *      author's load contract: `always_load` + every `axes.*.values` path is
 *      core; every `references.on_demand[].path` is deferred.
 *   B. For anything the author didn't classify (or skills with no manifest at
 *      all, e.g. ppt-master): binary or oversized single files are deferred;
 *      everything else is core.
 *
 * Deliberately NO directory-file-count threshold (see docs/skill-install-design.md
 * section 5): guessing "this dir has too many files so defer it" is fragile and
 * misfires on skills whose core is genuinely many small text files. If the core
 * still exceeds the file limit, the installer reports honestly and lets the user
 * choose `--full` or ask the author for a manifest, rather than guessing.
 */

import path from "node:path";

import YAML from "yaml";

import { globToRegExp } from "./glob.js";
import type { SkillFileEntry } from "./manifest.js";

export const SKILL_AUTHOR_MANIFEST = "manifest.yaml";
const DEFAULT_DEFERRED_SINGLE_FILE_BYTES = 256 * 1024;

/** Extensions that are always treated as deferred resources, never core. */
const BINARY_EXTENSIONS = new Set([
  // images
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".tif",
  ".tiff",
  ".psd",
  // documents / archives
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".tar",
  ".bz2",
  ".7z",
  ".rar",
  ".xz",
  // audio / video
  ".mp3",
  ".wav",
  ".flac",
  ".ogg",
  ".mp4",
  ".mov",
  ".avi",
  ".webm",
  ".mkv",
  // fonts
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  // binaries / data
  ".wasm",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".dat",
  ".db",
  ".sqlite",
  ".parquet",
  ".npy",
  ".npz",
  ".pkl",
  ".pickle"
]);

export interface ClassifyInput {
  /** All blob entries under the skill directory, paths relative to its root. */
  blobs: SkillFileEntry[];
  /** Raw text of the author's manifest.yaml, if the skill ships one. */
  authorManifestText?: string;
  /** Force everything into core (the `--full` flag). */
  full?: boolean;
  /** Override the single-file deferral size threshold (bytes). */
  deferredSingleFileBytes?: number;
  /**
   * Installer-provided defer globs (the `--defer` flag). The highest-priority
   * classification signal after SKILL.md itself: when the author shipped no
   * manifest and magi's heuristics can't tell (e.g. ppt-master's thousands of
   * text SVGs), the person installing declares which paths are on-demand
   * resources. Supports `*` (within a segment) and `**` (across segments).
   */
  deferGlobs?: string[];
}

export interface ClassifyResult {
  core: SkillFileEntry[];
  deferred: SkillFileEntry[];
  /** True when an author manifest was parsed and used to drive classification. */
  usedAuthorManifest: boolean;
  /** True when installer-provided defer globs matched at least one file. */
  usedDeferGlobs: boolean;
}

interface AuthorDeclaration {
  core: Set<string>;
  deferred: Set<string>;
}

export function classifySkillFiles(input: ClassifyInput): ClassifyResult {
  const single = input.deferredSingleFileBytes ?? DEFAULT_DEFERRED_SINGLE_FILE_BYTES;

  if (input.full) {
    return {
      core: [...input.blobs],
      deferred: [],
      usedAuthorManifest: false,
      usedDeferGlobs: false
    };
  }

  const declaration = input.authorManifestText
    ? parseAuthorDeclaration(input.authorManifestText)
    : undefined;

  const deferMatchers = (input.deferGlobs ?? [])
    .map((glob) => path.posix.normalize(glob.trim()))
    .filter((glob) => glob && !glob.startsWith("..") && !path.posix.isAbsolute(glob))
    .map((glob) => globToRegExp(glob));

  const core: SkillFileEntry[] = [];
  const deferred: SkillFileEntry[] = [];
  let usedDeferGlobs = false;

  for (const blob of input.blobs) {
    if (isAlwaysCore(blob.path)) {
      core.push(blob);
      continue;
    }
    if (deferMatchers.some((regex) => regex.test(blob.path))) {
      deferred.push(blob);
      usedDeferGlobs = true;
      continue;
    }
    if (declaration?.deferred.has(blob.path)) {
      deferred.push(blob);
      continue;
    }
    if (declaration?.core.has(blob.path)) {
      core.push(blob);
      continue;
    }
    if (isDeferredByHeuristic(blob, single)) {
      deferred.push(blob);
      continue;
    }
    core.push(blob);
  }

  return { core, deferred, usedAuthorManifest: declaration !== undefined, usedDeferGlobs };
}

function isAlwaysCore(relPath: string): boolean {
  return relPath === "SKILL.md" || relPath === SKILL_AUTHOR_MANIFEST;
}

function isDeferredByHeuristic(blob: SkillFileEntry, singleFileBytes: number): boolean {
  const ext = path.posix.extname(blob.path).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) {
    return true;
  }
  if (blob.size > singleFileBytes) {
    return true;
  }
  return false;
}

/**
 * Pull declared core/deferred paths out of an author manifest.yaml. Returns
 * undefined if the YAML can't be parsed — the caller then falls back to pure
 * heuristics. Paths are normalized relative to the skill directory; entries
 * that escape the skill dir (e.g. shared `../_shared/...`) are dropped because
 * they aren't part of this skill's own file set.
 */
export function parseAuthorDeclaration(yamlText: string): AuthorDeclaration | undefined {
  let doc: unknown;
  try {
    doc = YAML.parse(yamlText);
  } catch {
    return undefined;
  }
  if (typeof doc !== "object" || doc === null) {
    return undefined;
  }
  const record = doc as Record<string, unknown>;
  const core = new Set<string>();
  const deferred = new Set<string>();

  for (const entry of asStringArray(record.always_load)) {
    addRelPath(core, entry);
  }

  if (isRecord(record.axes)) {
    for (const axis of Object.values(record.axes)) {
      if (!isRecord(axis)) {
        continue;
      }
      if (isRecord(axis.values)) {
        for (const value of Object.values(axis.values)) {
          if (typeof value === "string") {
            addRelPath(core, value);
          }
        }
      }
    }
  }

  if (isRecord(record.references) && Array.isArray(record.references.on_demand)) {
    for (const item of record.references.on_demand) {
      if (isRecord(item) && typeof item.path === "string") {
        addRelPath(deferred, item.path);
      }
    }
  }

  return { core, deferred };
}

function addRelPath(set: Set<string>, raw: string): void {
  const normalized = path.posix.normalize(raw.trim());
  if (!normalized || normalized.startsWith("..") || path.posix.isAbsolute(normalized)) {
    return;
  }
  set.add(normalized);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
