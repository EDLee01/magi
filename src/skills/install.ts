/**
 * Install a skill from GitHub without cloning the whole repository.
 *
 * Cloning large skill repos (lots of png/gif assets) times out, so this uses
 * the GitHub API instead: the git trees API to list just the skill directory,
 * then the git blobs API to fetch each file as base64. One list call plus N
 * blob calls — no `git clone`, no raw-CDN timeouts.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { atomicWrite } from "../fs-utils.js";
import { classifySkillFiles, SKILL_AUTHOR_MANIFEST } from "./classify.js";
import {
  buildSkillManifest,
  SkillFileEntry,
  SkillManifestSource,
  writeSkillManifest
} from "./manifest.js";

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const DEFAULT_MAX_FILES = 400;
const DEFAULT_MAX_TOTAL_BYTES = 25 * 1024 * 1024;

export interface SkillSourceRef {
  owner: string;
  repo: string;
  /** Branch, tag, or commit. Undefined means use the repository default branch. */
  ref?: string;
  /** Path within the repo to the skill directory. Undefined means auto-detect. */
  subdir?: string;
}

export interface SkillInstallDeps {
  /** Fetch a GitHub API URL and parse the JSON body. */
  fetchJson(url: string): Promise<unknown>;
}

export interface SkillInstallOptions {
  source: string;
  skillsRoot: string;
  deps: SkillInstallDeps;
  force?: boolean;
  maxFiles?: number;
  maxTotalBytes?: number;
  /** Materialize every file at install time instead of deferring resources. */
  full?: boolean;
  /**
   * Installer-declared defer globs (`--defer`). Paths matching these are
   * recorded as on-demand pointers instead of materialized. Lets a person
   * install resource-heavy skills (e.g. ppt-master) that ship no manifest and
   * whose resources are text files the heuristics can't detect.
   */
  deferGlobs?: string[];
}

export interface SkillInstallResult {
  name: string;
  ref: SkillSourceRef;
  resolvedRef: string;
  skillDir: string;
  files: string[];
  totalBytes: number;
  installPath: string;
  /** Number of files materialized immediately. */
  coreFiles: number;
  /** Number of files left as on-demand pointers in the manifest. */
  deferredFiles: number;
  /** Whether the author's manifest.yaml drove classification. */
  usedAuthorManifest: boolean;
  /** Whether installer-provided `--defer` globs matched at least one file. */
  usedDeferGlobs: boolean;
}

export class SkillInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillInstallError";
  }
}

/**
 * Parse a skill source string into owner/repo/ref/subdir.
 * Accepts:
 *   owner/repo
 *   owner/repo/sub/dir
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/<ref>/<sub/dir>
 *   git@github.com:owner/repo.git
 */
export function parseSkillSource(input: string): SkillSourceRef {
  const raw = input.trim();
  if (!raw) {
    throw new SkillInstallError("Skill source is empty");
  }

  // git@github.com:owner/repo(.git)
  const sshMatch = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(raw);
  if (sshMatch) {
    return { owner: sanitizeSegment(sshMatch[1]), repo: sanitizeSegment(sshMatch[2]) };
  }

  if (/^https?:\/\//i.test(raw) || raw.startsWith("github.com/")) {
    return parseUrlSource(raw);
  }

  // Shorthand: owner/repo[/sub/dir]
  const parts = raw.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new SkillInstallError(
      `Invalid skill source: ${input}. Use owner/repo, owner/repo/path, or a GitHub URL.`
    );
  }
  const owner = sanitizeSegment(parts[0]!);
  const repo = sanitizeSegment(parts[1]!);
  const subdir = parts.length > 2 ? normalizeSubdir(parts.slice(2).join("/")) : undefined;
  return { owner, repo, subdir };
}

function parseUrlSource(raw: string): SkillSourceRef {
  let url: URL;
  try {
    url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  } catch {
    throw new SkillInstallError(`Invalid GitHub URL: ${raw}`);
  }
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
    throw new SkillInstallError(`Only github.com URLs are supported, got ${url.hostname}`);
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new SkillInstallError(`GitHub URL must include owner and repo: ${raw}`);
  }
  const owner = sanitizeSegment(segments[0]!);
  let repo = sanitizeSegment(segments[1]!);
  if (repo.endsWith(".git")) {
    repo = repo.slice(0, -4);
  }
  // .../tree/<ref>/<sub/dir>  or  .../blob/<ref>/<sub/dir>
  let ref: string | undefined;
  let subdir: string | undefined;
  if (segments.length > 2 && (segments[2] === "tree" || segments[2] === "blob")) {
    ref = segments[3] ? decodeURIComponent(segments[3]) : undefined;
    if (segments.length > 4) {
      subdir = normalizeSubdir(segments.slice(4).map(decodeURIComponent).join("/"));
    }
  } else if (segments.length > 2) {
    subdir = normalizeSubdir(segments.slice(2).map(decodeURIComponent).join("/"));
  }
  return { owner, repo, ref, subdir };
}

function sanitizeSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("..") || trimmed.includes("\0")) {
    throw new SkillInstallError(`Invalid path segment: ${JSON.stringify(value)}`);
  }
  return trimmed;
}

function normalizeSubdir(value: string): string {
  const cleaned = value.replace(/^\/+|\/+$/g, "");
  if (!cleaned) {
    return "";
  }
  for (const segment of cleaned.split("/")) {
    if (segment === ".." || segment === "." || segment.includes("\0")) {
      throw new SkillInstallError(`Invalid subdirectory: ${JSON.stringify(value)}`);
    }
  }
  return cleaned;
}

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

export async function installSkillFromGitHub(
  options: SkillInstallOptions
): Promise<SkillInstallResult> {
  const ref = parseSkillSource(options.source);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

  const resolvedRef = ref.ref ?? (await resolveDefaultBranch(ref, options.deps));
  const tree = await fetchTree(ref, resolvedRef, options.deps);

  const skillDir = resolveSkillDir(tree, ref.subdir);
  const name = skillDir === "" ? ref.repo : path.posix.basename(skillDir);
  if (!SKILL_NAME_RE.test(name)) {
    throw new SkillInstallError(
      `Resolved skill name "${name}" is not a valid skill directory name.`
    );
  }

  const prefix = skillDir === "" ? "" : `${skillDir}/`;
  const blobs = tree.filter(
    (entry) => entry.type === "blob" && (prefix === "" || entry.path.startsWith(prefix))
  );
  if (blobs.length === 0) {
    throw new SkillInstallError(`No files found at ${skillDir || "<repo root>"}`);
  }

  // Re-key blobs to skill-relative paths so classification, the manifest, and
  // the on-disk layout all speak the same coordinate system.
  const relBlobs: SkillFileEntry[] = blobs.map((blob) => ({
    path: prefix === "" ? blob.path : blob.path.slice(prefix.length),
    sha: blob.sha,
    size: blob.size ?? 0
  }));

  // Author declaration first: if the skill ships manifest.yaml, fetch it before
  // classifying so its load contract can drive core/deferred.
  const authorManifestBlob = relBlobs.find((blob) => blob.path === SKILL_AUTHOR_MANIFEST);
  let authorManifestText: string | undefined;
  if (authorManifestBlob) {
    authorManifestText = (await fetchBlob(ref, authorManifestBlob.sha, options.deps)).toString(
      "utf8"
    );
  }

  const { core, deferred, usedAuthorManifest, usedDeferGlobs } = classifySkillFiles({
    blobs: relBlobs,
    authorManifestText,
    full: options.full,
    deferGlobs: options.deferGlobs
  });

  const coreBytes = core.reduce((sum, blob) => sum + blob.size, 0);
  // maxFiles / maxTotalBytes now constrain only what we materialize (core).
  // Deferred resources are pointers in the manifest, so they don't count.
  if (core.length > maxFiles) {
    throw new SkillInstallError(
      `Skill core has ${core.length} files, exceeding the limit of ${maxFiles}. ` +
        `This skill's non-resource files alone are unusually large. ` +
        `Pass a more specific subdirectory, raise --max-files, use --full to ` +
        `materialize everything, or ask the author to ship a manifest.yaml ` +
        `declaring on-demand resources.`
    );
  }
  if (coreBytes > maxTotalBytes) {
    throw new SkillInstallError(
      `Skill core is ${formatBytes(coreBytes)}, exceeding the limit of ${formatBytes(
        maxTotalBytes
      )}. Pass a more specific subdirectory, raise --max-bytes, or use --full.`
    );
  }

  const installPath = path.resolve(options.skillsRoot, name);
  const skillsRootResolved = path.resolve(options.skillsRoot);
  if (installPath !== path.join(skillsRootResolved, name)) {
    throw new SkillInstallError(`Refusing to install outside the skills root: ${installPath}`);
  }
  if (existsSync(installPath) && !options.force) {
    throw new SkillInstallError(
      `Skill "${name}" already exists at ${installPath}. Use --force to overwrite.`
    );
  }
  // On --force, remove the existing skill directory first so files that were
  // deleted upstream don't linger (atomicWrite only overwrites paths it writes).
  if (existsSync(installPath) && options.force) {
    rmSync(installPath, { recursive: true, force: true });
  }

  // Materialize core only. Deferred files become pointers in the manifest and
  // are fetched on demand later (lazy read or `skills materialize`).
  const written: string[] = [];
  for (const blob of core) {
    const dest = safeJoin(installPath, blob.path);
    const content = await fetchBlob(ref, blob.sha, options.deps);
    mkdirSync(path.dirname(dest), { recursive: true });
    atomicWrite(dest, content);
    written.push(blob.path);
  }

  const manifestSource: SkillManifestSource = {
    owner: ref.owner,
    repo: ref.repo,
    ref: ref.ref,
    resolvedRef,
    subdir: skillDir
  };
  const manifest = buildSkillManifest({ source: manifestSource, core, deferred });
  mkdirSync(installPath, { recursive: true });
  writeSkillManifest(installPath, manifest);

  return {
    name,
    ref,
    resolvedRef,
    skillDir,
    files: written.sort(),
    totalBytes: coreBytes,
    installPath,
    coreFiles: core.length,
    deferredFiles: deferred.length,
    usedAuthorManifest,
    usedDeferGlobs
  };
}

async function resolveDefaultBranch(ref: SkillSourceRef, deps: SkillInstallDeps): Promise<string> {
  const meta = await deps.fetchJson(`https://api.github.com/repos/${ref.owner}/${ref.repo}`);
  if (isRecord(meta) && typeof meta.default_branch === "string" && meta.default_branch) {
    return meta.default_branch;
  }
  throw new SkillInstallError(
    `Could not resolve default branch for ${ref.owner}/${ref.repo}. Specify a ref with /tree/<branch>.`
  );
}

async function fetchTree(
  ref: SkillSourceRef,
  resolvedRef: string,
  deps: SkillInstallDeps
): Promise<TreeEntry[]> {
  const url = `https://api.github.com/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(
    resolvedRef
  )}?recursive=1`;
  const body = await deps.fetchJson(url);
  if (!isRecord(body) || !Array.isArray(body.tree)) {
    throw new SkillInstallError(
      `Unexpected tree response for ${ref.owner}/${ref.repo}@${resolvedRef}`
    );
  }
  if (body.truncated === true) {
    throw new SkillInstallError(
      `Repository tree for ${ref.owner}/${ref.repo} is too large to list in one request. ` +
        `Pass a specific subdirectory.`
    );
  }
  return body.tree.flatMap((entry) => {
    if (
      isRecord(entry) &&
      typeof entry.path === "string" &&
      typeof entry.type === "string" &&
      typeof entry.sha === "string"
    ) {
      return [
        {
          path: entry.path,
          type: entry.type,
          sha: entry.sha,
          size: typeof entry.size === "number" ? entry.size : undefined
        }
      ];
    }
    return [];
  });
}

function resolveSkillDir(tree: TreeEntry[], subdir: string | undefined): string {
  if (subdir !== undefined) {
    const target = subdir === "" ? "SKILL.md" : `${subdir}/SKILL.md`;
    const found = tree.some((entry) => entry.type === "blob" && entry.path === target);
    if (!found) {
      throw new SkillInstallError(`No SKILL.md found at ${subdir || "<repo root>"}`);
    }
    return subdir;
  }

  // Auto-detect: prefer SKILL.md at the repo root.
  const dirs = tree
    .filter((entry) => entry.type === "blob" && entry.path.endsWith("SKILL.md"))
    .map((entry) => (entry.path === "SKILL.md" ? "" : entry.path.slice(0, -"/SKILL.md".length)));

  if (dirs.length === 0) {
    throw new SkillInstallError(
      "No SKILL.md found in the repository. Pass the skill subdirectory explicitly."
    );
  }
  if (dirs.includes("")) {
    return "";
  }
  if (dirs.length === 1) {
    return dirs[0]!;
  }
  throw new SkillInstallError(
    `Multiple skills found. Pass one explicitly:\n${dirs.map((dir) => `  - ${dir}`).join("\n")}`
  );
}

async function fetchBlob(
  ref: SkillSourceRef,
  sha: string,
  deps: SkillInstallDeps
): Promise<Buffer> {
  const url = `https://api.github.com/repos/${ref.owner}/${ref.repo}/git/blobs/${sha}`;
  const body = await deps.fetchJson(url);
  if (!isRecord(body) || typeof body.content !== "string") {
    throw new SkillInstallError(`Unexpected blob response for ${sha}`);
  }
  const encoding = typeof body.encoding === "string" ? body.encoding : "base64";
  if (encoding !== "base64") {
    throw new SkillInstallError(`Unsupported blob encoding "${encoding}" for ${sha}`);
  }
  return Buffer.from(body.content, "base64");
}

function safeJoin(root: string, relPath: string): string {
  const dest = path.resolve(root, relPath);
  const rootResolved = path.resolve(root);
  if (dest !== rootResolved && !dest.startsWith(`${rootResolved}${path.sep}`)) {
    throw new SkillInstallError(`Refusing to write outside the skill directory: ${relPath}`);
  }
  if (relPath.includes("\0")) {
    throw new SkillInstallError(`Invalid file path: ${JSON.stringify(relPath)}`);
  }
  return dest;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
