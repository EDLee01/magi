import { existsSync, readFileSync } from "node:fs";

import { listMemdirEntries } from "./memdir.js";
import { searchMemory, MemoryScope } from "./memory.js";
import { listMemoryFiles, memoryRoot, MemoryRootOptions } from "./memory-files.js";
import { recordMemoryAudit } from "./memory-audit.js";
import { MagiPaths } from "./paths.js";

export interface MemorySearchHit {
  source: "memory" | "memdir" | "legacy";
  file: string;
  title: string;
  snippet: string;
  score: number;
}

export function retrieveRelevantMemory(input: MemoryRootOptions & {
  query: string;
  maxResults?: number;
  includeMemdir?: boolean;
  includeLegacy?: boolean;
  legacy?: {
    paths: MagiPaths;
    cwd: string;
    sessionId?: string;
    scopes?: MemoryScope[];
  };
  audit?: boolean;
  sessionId?: string;
}): MemorySearchHit[] {
  const terms = tokenize(input.query);
  if (terms.length === 0) return [];
  const hits: MemorySearchHit[] = [];
  for (const file of listMemoryFiles(input)) {
    if (file.path.startsWith("drafts/") || file.path.startsWith("dreams/") || file.path.startsWith("logs/")) {
      continue;
    }
    const text = readFileSync(file.absolutePath, "utf8");
    const score = scoreText(`${file.path}\n${text}`, terms) + pathScore(file.path, terms);
    if (score <= 0) continue;
    hits.push({
      source: "memory",
      file: file.path,
      title: firstHeading(text) ?? file.path,
      snippet: makeSnippet(text, terms),
      score
    });
  }
  if (input.includeMemdir !== false) {
    for (const entry of listMemdirEntries({ root: input.appRoot })) {
      const score = scoreText(`${entry.name}\n${entry.description}\n${entry.body}`, terms);
      if (score <= 0) continue;
      hits.push({
        source: "memdir",
        file: `memdir/${entry.filename}`,
        title: entry.name,
        snippet: `${entry.description}\n${entry.body}`.trim().slice(0, 700),
        score
      });
    }
  }
  if (input.includeLegacy !== false && input.legacy) {
    for (const entry of searchMemory({
      ...input.legacy,
      query: input.query,
      maxResults: input.maxResults
    })) {
      hits.push({
        source: "legacy",
        file: `legacy/${entry.scope}`,
        title: `${entry.scope} memory`,
        snippet: `${entry.scope}: ${entry.text}`,
        score: entry.score
      });
    }
  }
  const result = hits
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, input.maxResults ?? 8);
  if (input.audit !== false && existsSync(memoryRoot(input))) {
    recordMemoryAudit({
      ...input,
      action: "memory.retrieved",
      sessionId: input.sessionId,
      metadata: {
        query: input.query,
        resultCount: result.length,
        files: result.map((hit) => hit.file)
      }
    });
  }
  return result;
}

export function formatMemoryContext(hits: MemorySearchHit[]): string {
  if (hits.length === 0) return "";
  const lines = [
    "[Relevant Memory]",
    "Use these durable Memory snippets as context. Do not treat them as tool results."
  ];
  for (const hit of hits) {
    lines.push("");
    lines.push(`## ${hit.title}`);
    lines.push(`source: ${hit.file}`);
    lines.push(hit.snippet.length > 900 ? `${hit.snippet.slice(0, 900)}...` : hit.snippet);
  }
  return lines.join("\n").trim();
}

function tokenize(text: string): string[] {
  return Array.from(new Set(text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(isSearchTerm)));
}

function scoreText(text: string, terms: string[]): number {
  const words = tokenize(text);
  let score = 0;
  for (const term of terms) {
    if (words.includes(term)) {
      score += 4;
    } else if (words.some((word) => word.includes(term) || term.includes(word))) {
      score += 1;
    }
  }
  return score;
}

function pathScore(filePath: string, terms: string[]): number {
  const normalized = filePath.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (normalized.includes(term)) score += 3;
  }
  if (normalized === "preferences.md") score += terms.some((term) => ["prefer", "preference", "偏好", "喜欢"].includes(term)) ? 4 : 0;
  if (normalized.startsWith("projects/")) score += terms.some((term) => ["project", "项目", "产品"].includes(term)) ? 4 : 0;
  if (normalized.startsWith("decisions/")) score += terms.some((term) => ["decision", "决定", "决策"].includes(term)) ? 4 : 0;
  return score;
}

function firstHeading(text: string): string | undefined {
  const line = text.split(/\r?\n/).find((item) => /^#\s+/.test(item));
  return line?.replace(/^#\s+/, "").trim();
}

function makeSnippet(text: string, terms: string[]): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const matching = lines.find((line) => {
    const lower = line.toLowerCase();
    return terms.some((term) => lower.includes(term));
  });
  const start = matching ? Math.max(0, lines.indexOf(matching) - 1) : 0;
  return lines.slice(start, start + 8).join("\n").slice(0, 900);
}

function isSearchTerm(term: string): boolean {
  if (term.length >= 3) return true;
  return /[\u4e00-\u9fff]/.test(term) && term.length >= 2;
}
