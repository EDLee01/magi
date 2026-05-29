import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
  statSync
} from "node:fs";
import path from "node:path";

import { MagiPaths } from "./paths.js";
import { atomicWrite } from "./fs-utils.js";

/**
 * Memdir: typed multi-file memory system.
 *
 * Each memory is a separate .md file with YAML frontmatter:
 *
 *   ---
 *   name: User role
 *   description: User is a senior backend engineer
 *   type: user
 *   ---
 *   <body content>
 *
 * MEMORY.md is the index; one line per memory: `- [Name](file.md) - description`.
 *
 * Types:
 *   - user: facts about the user (role, goals, expertise)
 *   - feedback: corrections/preferences from past interactions
 *   - project: ongoing work, decisions, deadlines
 *   - reference: pointers to external systems (Linear, Grafana, etc.)
 */

export type MemdirType = "user" | "feedback" | "project" | "reference";

export interface MemdirEntry {
  name: string;
  description: string;
  type: MemdirType;
  body: string;
  filename: string;
  path: string;
}

export interface MemdirSearchResult extends MemdirEntry {
  score: number;
}

const MEMDIR_DIRNAME = "memdir";
const INDEX_FILENAME = "MEMORY.md";
const MAX_INDEX_LINES = 200;

type MemdirInput = MagiPaths | { root: string };

export function memdirRoot(input: MemdirInput): string {
  return path.join(input.root, MEMDIR_DIRNAME);
}

export function memdirIndexFile(input: MemdirInput): string {
  return path.join(memdirRoot(input), INDEX_FILENAME);
}

export function ensureMemdir(input: MemdirInput): string {
  const root = memdirRoot(input);
  mkdirSync(root, { recursive: true });
  const indexFile = memdirIndexFile(input);
  if (!existsSync(indexFile)) {
    writeFileSync(indexFile, "", "utf8");
  }
  return root;
}

export function listMemdirEntries(input: MemdirInput): MemdirEntry[] {
  const root = memdirRoot(input);
  if (!existsSync(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".md") && name !== INDEX_FILENAME)
    .sort()
    .flatMap((filename) => {
      const filePath = path.join(root, filename);
      try {
        if (!statSync(filePath).isFile()) return [];
        const content = readFileSync(filePath, "utf8");
        const parsed = parseMemdirFile(content);
        if (!parsed) return [];
        return [
          {
            ...parsed,
            filename,
            path: filePath
          }
        ];
      } catch {
        return [];
      }
    });
}

export function readMemdirIndex(input: MemdirInput): string {
  const file = memdirIndexFile(input);
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf8");
}

export function writeMemdirEntry(input: {
  paths: MemdirInput;
  type: MemdirType;
  name: string;
  description: string;
  body: string;
}): MemdirEntry {
  const root = ensureMemdir(input.paths);
  const filename = `${input.type}_${slugify(input.name)}.md`;
  const filePath = path.join(root, filename);
  const content = formatMemdirFile({
    name: input.name,
    description: input.description,
    type: input.type,
    body: input.body
  });
  atomicWrite(filePath, content);
  updateIndex(input.paths);
  return {
    name: input.name,
    description: input.description,
    type: input.type,
    body: input.body,
    filename,
    path: filePath
  };
}

export function deleteMemdirEntry(input: MemdirInput, filename: string): boolean {
  const root = memdirRoot(input);
  const filePath = path.join(root, filename);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  updateIndex(input);
  return true;
}

export function findMemdirEntry(
  input: MemdirInput,
  filenameOrName: string
): MemdirEntry | undefined {
  const entries = listMemdirEntries(input);
  return (
    entries.find((e) => e.filename === filenameOrName || e.name === filenameOrName) ??
    entries.find((e) => slugify(e.name) === slugify(filenameOrName))
  );
}

export function searchMemdir(input: {
  paths: MemdirInput;
  query: string;
  maxResults?: number;
  types?: MemdirType[];
}): MemdirSearchResult[] {
  const terms = tokenize(input.query);
  if (terms.length === 0) return [];
  const entries = listMemdirEntries(input.paths).filter(
    (e) => !input.types || input.types.includes(e.type)
  );
  return entries
    .map((entry) => ({
      ...entry,
      score: scoreEntry(entry, terms)
    }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, input.maxResults ?? 8);
}

export function formatMemdirIndex(input: MemdirInput): string {
  const entries = listMemdirEntries(input);
  if (entries.length === 0) return "";
  const lines = ["# Memory index", ""];
  const byType: Record<MemdirType, MemdirEntry[]> = {
    user: [],
    feedback: [],
    project: [],
    reference: []
  };
  for (const entry of entries) {
    byType[entry.type].push(entry);
  }
  for (const type of ["user", "feedback", "project", "reference"] as MemdirType[]) {
    const list = byType[type];
    if (list.length === 0) continue;
    lines.push(`## ${type}`);
    for (const entry of list) {
      lines.push(`- [${entry.name}](${entry.filename}) - ${entry.description}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

function updateIndex(input: MemdirInput): void {
  const indexFile = memdirIndexFile(input);
  let content = formatMemdirIndex(input);
  const lines = content.split("\n");
  if (lines.length > MAX_INDEX_LINES) {
    content = lines.slice(0, MAX_INDEX_LINES).join("\n") + "\n... (truncated)\n";
  }
  atomicWrite(indexFile, content);
}

function parseMemdirFile(
  content: string
): { name: string; description: string; type: MemdirType; body: string } | undefined {
  if (!content.startsWith("---\n")) return undefined;
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return undefined;
  const frontmatter = content.slice(4, end);
  const body = content.slice(end + 5).trim();
  const fields: Record<string, string> = {};
  for (const line of frontmatter.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    fields[key] = value;
  }
  if (!fields.name || !fields.description || !fields.type) return undefined;
  if (!isValidType(fields.type)) return undefined;
  return {
    name: fields.name,
    description: fields.description,
    type: fields.type,
    body
  };
}

function formatMemdirFile(input: {
  name: string;
  description: string;
  type: MemdirType;
  body: string;
}): string {
  return [
    "---",
    `name: ${input.name}`,
    `description: ${input.description}`,
    `type: ${input.type}`,
    "---",
    "",
    input.body.trim(),
    ""
  ].join("\n");
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "entry"
  );
}

function isValidType(value: string): value is MemdirType {
  return value === "user" || value === "feedback" || value === "project" || value === "reference";
}

function tokenize(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_-]+/gu, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 2)
    )
  );
}

function scoreEntry(entry: MemdirEntry, terms: string[]): number {
  const haystack = tokenize(`${entry.name} ${entry.description} ${entry.body}`);
  const haystackSet = new Set(haystack);
  let score = 0;
  for (const term of terms) {
    if (haystackSet.has(term)) {
      score += 3;
    } else if (haystack.some((w) => w.includes(term) || term.includes(w))) {
      score += 1;
    }
  }
  // Boost for type relevance
  const typeBoost: Record<MemdirType, number> = { user: 2, feedback: 2, project: 1, reference: 1 };
  return score + typeBoost[entry.type];
}
