import { existsSync, readFileSync } from "node:fs";

import { listMemdirEntries } from "./memdir.js";
import { searchMemory, MemoryScope } from "./memory.js";
import { listMemoryFiles, memoryRoot, MemoryRootOptions } from "./memory-files.js";
import { recordMemoryAudit } from "./memory-audit.js";
import { MemoryGraphSearchHit, MemoryNodeStore } from "./memory-node-store.js";
import { syncMemoryGraph } from "./memory-wiki-indexer.js";
import { MagiPaths } from "./paths.js";

export interface MemorySearchHit {
  source: "graph" | "memory" | "memdir" | "legacy";
  file: string;
  title: string;
  snippet: string;
  score: number;
  nodeId?: string;
  sourceId?: string;
  chunkId?: string;
  sourceKind?: string;
  graphDistance?: number;
  viaNodeIds?: string[];
  viaEdgeIds?: number[];
}

export function retrieveRelevantMemory(
  input: MemoryRootOptions & {
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
  }
): MemorySearchHit[] {
  const terms = tokenize(input.query);
  if (terms.length === 0) return [];
  const hits: MemorySearchHit[] = [];
  const graphHits = retrieveGraphMemory(input, terms);
  hits.push(...graphHits);
  if (graphHits.length === 0) {
    for (const file of listMemoryFiles(input)) {
      if (
        file.path === "INDEX.md" ||
        file.path.startsWith("drafts/") ||
        file.path.startsWith("dreams/") ||
        file.path.startsWith("logs/") ||
        file.path.startsWith("archive/")
      ) {
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
        graphResultCount: result.filter((hit) => hit.source === "graph").length,
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
    if (hit.nodeId) {
      lines.push(`node: ${hit.nodeId}`);
    }
    if (hit.graphDistance && hit.graphDistance > 0) {
      lines.push(`graph-distance: ${hit.graphDistance}`);
      if (hit.viaNodeIds && hit.viaNodeIds.length > 0) {
        lines.push(`via: ${hit.viaNodeIds.join(" -> ")}`);
      }
    }
    lines.push(hit.snippet.length > 900 ? `${hit.snippet.slice(0, 900)}...` : hit.snippet);
  }
  return lines.join("\n").trim();
}

function retrieveGraphMemory(
  input: MemoryRootOptions & {
    query: string;
    maxResults?: number;
    includeMemdir?: boolean;
    legacy?: {
      paths: MagiPaths;
      cwd: string;
      sessionId?: string;
      scopes?: MemoryScope[];
    };
  },
  terms: string[]
): MemorySearchHit[] {
  const paths = input.legacy?.paths;
  if (!paths) {
    return [];
  }
  try {
    syncMemoryGraph({
      appRoot: input.appRoot,
      root: input.root,
      paths,
      includeMemdir: input.includeMemdir
    });
    const store = MemoryNodeStore.open(paths);
    try {
      const hits = store.searchGraph({
        query: input.query,
        limit: input.maxResults ?? 8
      });
      store.markUsed(
        hits.map((hit) => hit.node.id),
        0.03
      );
      store.markEdgesUsed(
        hits.flatMap((hit) => hit.viaEdgeIds ?? []),
        0.02
      );
      return hits.map((hit) => graphHitToMemorySearchHit(hit, terms));
    } finally {
      store.close();
    }
  } catch {
    return [];
  }
}

function graphHitToMemorySearchHit(hit: MemoryGraphSearchHit, terms: string[]): MemorySearchHit {
  return {
    source: "graph",
    file: graphHitFile(hit.source.uri, hit.chunk.heading),
    title: hit.chunk.heading || hit.source.title,
    snippet: makeSnippet(hit.chunk.body, terms),
    score: hit.score,
    nodeId: hit.node.id,
    sourceId: hit.source.id,
    chunkId: hit.chunk.id,
    sourceKind: hit.source.kind,
    graphDistance: hit.graphDistance,
    viaNodeIds: hit.viaNodeIds,
    viaEdgeIds: hit.viaEdgeIds
  };
}

function graphHitFile(uri: string, heading: string): string {
  if (uri.startsWith("memory/")) {
    return `${uri.slice("memory/".length)}#${heading}`;
  }
  return uri;
}

function tokenize(text: string): string[] {
  const terms: string[] = [];
  for (const term of text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .split(/\s+/)
    .map((item) => item.trim())) {
    if (isSearchTerm(term)) {
      terms.push(term);
    }
    terms.push(...cjkNgrams(term));
  }
  return Array.from(new Set(terms));
}

function cjkNgrams(term: string): string[] {
  const grams: string[] = [];
  const runs = term.match(/[\u3400-\u9fff\uf900-\ufaff]+/gu) ?? [];
  for (const run of runs) {
    const chars = Array.from(run);
    for (let size = 2; size <= 4; size += 1) {
      if (chars.length < size) continue;
      for (let index = 0; index <= chars.length - size; index += 1) {
        const gram = chars.slice(index, index + size).join("");
        if (isSearchTerm(gram)) {
          grams.push(gram);
        }
      }
    }
  }
  return grams;
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
  if (normalized === "preferences.md")
    score += terms.some((term) => ["prefer", "preference", "偏好", "喜欢"].includes(term)) ? 4 : 0;
  if (normalized.startsWith("projects/"))
    score += terms.some((term) => ["project", "项目", "产品"].includes(term)) ? 4 : 0;
  if (normalized.startsWith("decisions/"))
    score += terms.some((term) => ["decision", "决定", "决策"].includes(term)) ? 4 : 0;
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
  return lines
    .slice(start, start + 8)
    .join("\n")
    .slice(0, 900);
}

function isSearchTerm(term: string): boolean {
  if (SEARCH_STOPWORDS.has(term)) return false;
  if (term.length >= 3) return true;
  return /[\u4e00-\u9fff]/.test(term) && term.length >= 2;
}

const SEARCH_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "do",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "should",
  "the",
  "this",
  "to",
  "use",
  "what",
  "when",
  "where",
  "who",
  "why",
  "with",
  "you",
  "your"
]);
