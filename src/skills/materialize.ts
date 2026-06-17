/**
 * Materialize a skill's deferred files — fetch the on-demand pointers recorded
 * in `.magi-skill.json` and write them to disk.
 *
 * Two callers share this:
 *   - `skills materialize <name> [glob]` (explicit, used before running skill
 *     scripts that read resource files directly — magi isn't on that fs path).
 *   - the lazy read hook (transparent, when magi's own file tools read a path
 *     that's deferred but not yet on disk).
 *
 * Fetches use the manifest's pinned `resolvedRef` so deferred content always
 * matches what was installed, even if upstream has moved on.
 */

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { atomicWrite } from "../fs-utils.js";
import { makeMatcher } from "./glob.js";
import { SkillFileEntry, SkillManifest, readSkillManifest } from "./manifest.js";

export interface MaterializeDeps {
  /** Fetch a GitHub API URL and parse the JSON body. */
  fetchJson(url: string): Promise<unknown>;
}

export interface MaterializeOptions {
  skillDir: string;
  deps: MaterializeDeps;
  /** Glob-ish pattern (supports `*` and `**`). Undefined materializes all deferred files. */
  pattern?: string;
  /** Re-fetch even if the file already exists on disk. */
  force?: boolean;
}

export interface MaterializeResult {
  materialized: string[];
  skipped: string[];
  totalBytes: number;
}

export class SkillMaterializeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillMaterializeError";
  }
}

export async function materializeSkillFiles(
  options: MaterializeOptions
): Promise<MaterializeResult> {
  const manifest = readSkillManifest(options.skillDir);
  if (!manifest) {
    throw new SkillMaterializeError(
      `No install manifest (.magi-skill.json) for this skill. ` +
        `Only skills installed with the deferred-resource model can be materialized.`
    );
  }

  const matcher = options.pattern ? makeMatcher(options.pattern) : () => true;
  const targets = manifest.deferred.filter((entry) => matcher(entry.path));
  if (targets.length === 0) {
    return { materialized: [], skipped: [], totalBytes: 0 };
  }

  const materialized: string[] = [];
  const skipped: string[] = [];
  let totalBytes = 0;

  for (const entry of targets) {
    const dest = safeJoin(options.skillDir, entry.path);
    if (!options.force && existsSync(dest)) {
      skipped.push(entry.path);
      continue;
    }
    const content = await fetchBlobContent(manifest, entry, options.deps);
    mkdirSync(path.dirname(dest), { recursive: true });
    atomicWrite(dest, content);
    materialized.push(entry.path);
    totalBytes += content.byteLength;
  }

  return { materialized: materialized.sort(), skipped: skipped.sort(), totalBytes };
}

/**
 * Resolve a single deferred path to disk if it isn't already present. Returns
 * the absolute on-disk path when the file exists (already there or just fetched),
 * or undefined when the path isn't a known deferred file. Used by the lazy read
 * hook — never throws on "not a deferred path", only on a genuine fetch failure.
 */
export async function materializeDeferredPath(input: {
  skillDir: string;
  relPath: string;
  deps: MaterializeDeps;
}): Promise<string | undefined> {
  const dest = safeJoin(input.skillDir, input.relPath);
  if (existsSync(dest)) {
    return dest;
  }
  const manifest = readSkillManifest(input.skillDir);
  if (!manifest) {
    return undefined;
  }
  const normalized = path.posix.normalize(input.relPath);
  const entry = manifest.deferred.find((item) => item.path === normalized);
  if (!entry) {
    return undefined;
  }
  const content = await fetchBlobContent(manifest, entry, input.deps);
  mkdirSync(path.dirname(dest), { recursive: true });
  atomicWrite(dest, content);
  return dest;
}

async function fetchBlobContent(
  manifest: SkillManifest,
  entry: SkillFileEntry,
  deps: MaterializeDeps
): Promise<Buffer> {
  const { owner, repo } = manifest.source;
  const url = `https://api.github.com/repos/${owner}/${repo}/git/blobs/${entry.sha}`;
  const body = await deps.fetchJson(url);
  if (typeof body !== "object" || body === null) {
    throw new SkillMaterializeError(`Unexpected blob response for ${entry.path}`);
  }
  const record = body as Record<string, unknown>;
  if (typeof record.content !== "string") {
    throw new SkillMaterializeError(`Unexpected blob response for ${entry.path}`);
  }
  const encoding = typeof record.encoding === "string" ? record.encoding : "base64";
  if (encoding !== "base64") {
    throw new SkillMaterializeError(`Unsupported blob encoding "${encoding}" for ${entry.path}`);
  }
  return Buffer.from(record.content, "base64");
}

function safeJoin(root: string, relPath: string): string {
  if (relPath.includes("\0")) {
    throw new SkillMaterializeError(`Invalid file path: ${JSON.stringify(relPath)}`);
  }
  const dest = path.resolve(root, relPath);
  const rootResolved = path.resolve(root);
  if (dest !== rootResolved && !dest.startsWith(`${rootResolved}${path.sep}`)) {
    throw new SkillMaterializeError(`Refusing to write outside the skill directory: ${relPath}`);
  }
  return dest;
}
