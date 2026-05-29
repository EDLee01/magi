import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { atomicWrite } from "./fs-utils.js";

export interface MemoryRootOptions {
  appRoot: string;
  root?: string;
}

export interface MemoryFileRecord {
  path: string;
  absolutePath: string;
  size: number;
  updatedAt: string;
}

export const MEMORY_DIRNAME = "memory";

const MEMORY_FILES: Record<string, string> = {
  "INDEX.md": [
    "# Memory",
    "",
    "Memory stores durable preferences, project context, decisions, workflows, and permission notes.",
    "Dream creates reviewable drafts that organize Memory without changing formal files automatically.",
    ""
  ].join("\n"),
  "user.md": [
    "# User",
    "",
    "Long-lived user facts and stable context. Do not store sensitive personal data unless the user explicitly asks.",
    ""
  ].join("\n"),
  "preferences.md": [
    "# Preferences",
    "",
    "Durable communication, product, writing, and workflow preferences.",
    ""
  ].join("\n"),
  "projects/default.md": [
    "# Project: Default",
    "",
    "Project context, open questions, and active decisions that are not tied to a more specific project file yet.",
    ""
  ].join("\n"),
  "skills/README.md": ["# Skills", "", "Skill-specific memory and operating context.", ""].join(
    "\n"
  ),
  "workflows/README.md": [
    "# Workflows",
    "",
    "Reusable task flows, operating procedures, and references.",
    ""
  ].join("\n"),
  "decisions/README.md": [
    "# Decisions",
    "",
    "Accepted, rejected, and superseded decisions with reasoning.",
    ""
  ].join("\n"),
  "permissions/policy.md": [
    "# Permissions Policy",
    "",
    "Durable permission boundaries and approval rules. Changes to this file should be reviewed carefully.",
    ""
  ].join("\n"),
  "sessions/README.md": [
    "# Sessions",
    "",
    "Session-derived summaries that are worth keeping as durable Memory.",
    ""
  ].join("\n"),
  "archive/README.md": [
    "# Archive",
    "",
    "Superseded or retired Memory. Deletion-like actions should archive rather than remove content.",
    ""
  ].join("\n")
};

const MEMORY_DIRS = [
  "projects",
  "skills",
  "workflows",
  "decisions",
  "permissions",
  "sessions",
  "drafts",
  "dreams",
  "archive"
];

export function memoryRoot(input: MemoryRootOptions): string {
  return path.resolve(input.root?.trim() || path.join(input.appRoot, MEMORY_DIRNAME));
}

export function initMemory(input: MemoryRootOptions): string {
  const root = ensureMemoryStructure(input);
  rebuildMemoryIndex({ ...input, root });
  return root;
}

export function ensureMemoryStructure(input: MemoryRootOptions): string {
  const root = memoryRoot(input);
  mkdirSync(root, { recursive: true });
  for (const dir of MEMORY_DIRS) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }
  for (const [relativePath, content] of Object.entries(MEMORY_FILES)) {
    const absolutePath = path.join(root, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    if (!existsSync(absolutePath)) {
      writeFileSync(absolutePath, content, { encoding: "utf8", flag: "wx" });
    }
  }
  return root;
}

export function listMemoryFiles(input: MemoryRootOptions): MemoryFileRecord[] {
  const root = memoryRoot(input);
  if (!existsSync(root)) return [];
  const records: MemoryFileRecord[] = [];
  walkMemoryFiles(root, root, records);
  return records.sort((a, b) => a.path.localeCompare(b.path));
}

export function readMemoryFile(input: MemoryRootOptions & { filePath: string }): string {
  const root = memoryRoot(input);
  const absolutePath = resolveMemoryFilePath(root, input.filePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`Memory file not found: ${input.filePath}`);
  }
  const stat = statSync(absolutePath);
  if (!stat.isFile()) {
    throw new Error(`Memory path is not a file: ${input.filePath}`);
  }
  return readFileSync(absolutePath, "utf8");
}

export function appendMemoryFile(
  input: MemoryRootOptions & {
    filePath: string;
    content: string;
  }
): string {
  ensureMemoryStructure(input);
  const root = memoryRoot(input);
  const absolutePath = resolveMemoryFilePath(root, input.filePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  const existing = existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : "";
  const next = `${existing}${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}${input.content.trimEnd()}\n`;
  atomicWrite(absolutePath, next);
  rebuildMemoryIndex(input);
  return absolutePath;
}

export function writeMemoryFile(
  input: MemoryRootOptions & {
    filePath: string;
    content: string;
  }
): string {
  ensureMemoryStructure(input);
  const root = memoryRoot(input);
  const absolutePath = resolveMemoryFilePath(root, input.filePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  atomicWrite(absolutePath, input.content.endsWith("\n") ? input.content : `${input.content}\n`);
  rebuildMemoryIndex(input);
  return absolutePath;
}

export function resolveMemoryFilePath(root: string, filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0")) {
    throw new Error("Memory file path must not be empty");
  }
  const absolutePath = path.resolve(root, normalized);
  const relative = path.relative(root, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Memory file path escapes Memory root: ${filePath}`);
  }
  return absolutePath;
}

export function isMemoryContentSafe(content: string): boolean {
  const patterns = [
    /\b(api[_-]?key|token|password|passwd|secret|authorization|bearer)\b\s*[:=]/i,
    /\bsk-[A-Za-z0-9_-]{16,}\b/,
    /\bghp_[A-Za-z0-9_]{20,}\b/,
    /\b[A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*\s*=/,
    /\b[A-Za-z0-9_]*SECRET[A-Za-z0-9_]*\s*=/
  ];
  return !patterns.some((pattern) => pattern.test(content));
}

export function rebuildMemoryIndex(input: MemoryRootOptions): void {
  const root = memoryRoot(input);
  if (!existsSync(root)) return;
  const records = listMemoryFiles(input).filter(
    (record) =>
      record.path !== "INDEX.md" &&
      !record.path.startsWith("drafts/") &&
      !record.path.startsWith("dreams/")
  );
  const lines = [
    "# Memory",
    "",
    "Memory stores durable preferences, project context, decisions, workflows, and permission notes.",
    "Dream creates reviewable drafts that organize Memory without changing formal files automatically.",
    "",
    "## Files"
  ];
  for (const record of records) {
    lines.push(`- [${record.path}](${record.path})`);
  }
  lines.push("");
  atomicWrite(path.join(root, "INDEX.md"), lines.join("\n"));
}

function walkMemoryFiles(root: string, current: string, records: MemoryFileRecord[]): void {
  for (const name of readdirSync(current).sort()) {
    const absolutePath = path.join(current, name);
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) {
      walkMemoryFiles(root, absolutePath, records);
      continue;
    }
    if (!stat.isFile() || !name.endsWith(".md")) continue;
    records.push({
      path: path.relative(root, absolutePath).replace(/\\/g, "/"),
      absolutePath,
      size: stat.size,
      updatedAt: stat.mtime.toISOString()
    });
  }
}
