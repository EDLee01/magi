import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { atomicWrite } from "./fs-utils.js";

import { MagiPaths } from "./paths.js";
import { SessionStore } from "./session-store.js";

export type MemoryScope = "project" | "user" | "session";
export type DurableMemoryScope = "project" | "user";

export interface MemoryEntry {
  scope: MemoryScope;
  text: string;
  key?: string;
  value?: string;
  createdAt?: string;
  file: string;
  line: number;
}

export interface MemorySearchResult extends MemoryEntry {
  score: number;
}

export interface MemoryConflict {
  scope: MemoryScope;
  key: string;
  existing: MemoryEntry;
  incoming: MemoryEntry;
}

export interface AppendMemoryResult {
  file: string;
  entry: MemoryEntry;
  appended: boolean;
  duplicate: boolean;
  conflicts: MemoryConflict[];
}

export function memoryFile(paths: MagiPaths, scope: MemoryScope, cwd: string): string {
  if (scope === "user") {
    return path.join(paths.root, "memory.md");
  }
  if (scope === "session") {
    throw new Error("Session memory requires a session id");
  }
  const projectId = Buffer.from(path.resolve(cwd)).toString("base64url");
  return path.join(paths.stateRoot, "project-memory", `${projectId}.md`);
}

export function sessionMemoryFile(paths: MagiPaths, sessionId: string): string {
  return path.join(paths.stateRoot, "session-memory", `${safeSessionId(sessionId)}.md`);
}

export function resolveMemoryFile(input: {
  paths: MagiPaths;
  scope: MemoryScope;
  cwd: string;
  sessionId?: string;
}): string {
  return input.scope === "session"
    ? sessionMemoryFile(input.paths, requireSessionId(input.sessionId))
    : memoryFile(input.paths, input.scope, input.cwd);
}

export function readMemory(input: {
  paths: MagiPaths;
  scope: MemoryScope;
  cwd: string;
  sessionId?: string;
}): string {
  const file = resolveMemoryFile(input);
  if (!existsSync(file)) {
    return "";
  }
  return readFileSync(file, "utf8");
}

export function appendMemory(input: {
  paths: MagiPaths;
  scope: MemoryScope;
  cwd: string;
  text: string;
  store?: SessionStore;
  sessionId?: string;
}): string;
export function appendMemory(input: {
  paths: MagiPaths;
  scope: MemoryScope;
  cwd: string;
  text: string;
  store?: SessionStore;
  sessionId?: string;
  detailed: true;
}): AppendMemoryResult;
export function appendMemory(input: {
  paths: MagiPaths;
  scope: MemoryScope;
  cwd: string;
  text: string;
  store?: SessionStore;
  sessionId?: string;
  detailed?: boolean;
}): string | AppendMemoryResult {
  const file = resolveMemoryFile(input);
  mkdirSync(path.dirname(file), { recursive: true });
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const existingEntries = parseMemoryEntries({ text: existing, scope: input.scope, file });
  const incoming = parseMemoryEntryLine({
    line: normalizeMemoryLine(input.text),
    scope: input.scope,
    file,
    lineNumber: existingEntries.length + 1
  });
  const duplicate = existingEntries.some(
    (entry) => normalizeText(entry.text) === normalizeText(incoming.text)
  );
  const conflicts = findMemoryConflicts(existingEntries, incoming);
  const appended = !duplicate && conflicts.length === 0;
  if (appended) {
    const next = `${existing}${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}${incoming.text.trimEnd()}\n`;
    atomicWrite(file, next);
  }
  if (input.store && input.sessionId) {
    input.store.recordAudit({
      sessionId: input.sessionId,
      action: appended
        ? "memory.append"
        : conflicts.length > 0
          ? "memory.conflict"
          : "memory.duplicate",
      target: file,
      metadata: {
        scope: input.scope,
        appended,
        duplicate,
        conflictCount: conflicts.length,
        key: incoming.key
      }
    });
  }
  const result: AppendMemoryResult = {
    file,
    entry: incoming,
    appended,
    duplicate,
    conflicts
  };
  return input.detailed ? result : file;
}

export function formatMemory(input: {
  paths: MagiPaths;
  cwd: string;
  scope?: MemoryScope;
  sessionId?: string;
}): string {
  if (input.scope) {
    const text = readMemory({
      paths: input.paths,
      cwd: input.cwd,
      scope: input.scope,
      sessionId: input.sessionId
    });
    return text || `No ${input.scope} memory\n`;
  }

  const user = readMemory({ paths: input.paths, cwd: input.cwd, scope: "user" });
  const project = readMemory({ paths: input.paths, cwd: input.cwd, scope: "project" });
  const session = input.sessionId
    ? readMemory({
        paths: input.paths,
        cwd: input.cwd,
        scope: "session",
        sessionId: input.sessionId
      })
    : "";
  return [
    "# user",
    user.trimEnd() || "(empty)",
    "",
    "# project",
    project.trimEnd() || "(empty)",
    "",
    "# session",
    session.trimEnd() || "(empty)",
    ""
  ].join("\n");
}

export function listMemoryEntries(input: {
  paths: MagiPaths;
  cwd: string;
  sessionId?: string;
  scopes?: MemoryScope[];
}): MemoryEntry[] {
  const scopes = input.scopes ?? [
    "user",
    "project",
    ...(input.sessionId ? ["session" as const] : [])
  ];
  return scopes.flatMap((scope) => {
    if (scope === "session" && !input.sessionId) {
      return [];
    }
    const file = resolveMemoryFile({
      paths: input.paths,
      cwd: input.cwd,
      sessionId: input.sessionId,
      scope
    });
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    return parseMemoryEntries({ text, scope, file });
  });
}

export function searchMemory(input: {
  paths: MagiPaths;
  cwd: string;
  query: string;
  sessionId?: string;
  scopes?: MemoryScope[];
  maxResults?: number;
}): MemorySearchResult[] {
  const terms = tokenize(input.query);
  if (terms.length === 0) {
    return [];
  }
  const scopeWeight: Record<MemoryScope, number> = {
    session: 3,
    project: 2,
    user: 1
  };
  return listMemoryEntries(input)
    .map((entry) => ({
      ...entry,
      score: scoreMemoryEntry(entry, terms) + scopeWeight[entry.scope]
    }))
    .filter((entry) => entry.score > scopeWeight[entry.scope])
    .sort(
      (left, right) =>
        right.score - left.score ||
        scopeWeight[right.scope] - scopeWeight[left.scope] ||
        left.line - right.line
    )
    .slice(0, input.maxResults ?? 8);
}

export function formatMemorySearchResults(results: MemorySearchResult[]): string {
  if (results.length === 0) {
    return "";
  }
  return ["[Relevant memory]", ...results.map((entry) => `- ${entry.scope}: ${entry.text}`)].join(
    "\n"
  );
}

export function extractExplicitMemoryWrite(
  prompt: string
): { scope: MemoryScope; text: string } | undefined {
  const trimmed = prompt.trim();
  const patterns: Array<{ pattern: RegExp; scope?: MemoryScope }> = [
    { pattern: /^(?:remember|please remember)\s+(?:for\s+)?(user|project|session)\s*:\s*(.+)$/i },
    { pattern: /^(?:remember|please remember)\s+(?:that\s+)?(.+)$/i, scope: "user" },
    { pattern: /^记住[，,]\s*(.+)$/, scope: "user" },
    { pattern: /^记住(?:到|为)?(用户|项目|会话)?记忆?[:：]\s*(.+)$/ },
    { pattern: /^把(.+?)记到(用户|项目|会话)记忆$/ }
  ];
  for (const item of patterns) {
    const match = item.pattern.exec(trimmed);
    if (!match) {
      continue;
    }
    if (item.pattern.source.startsWith("^把")) {
      return { scope: readChineseScope(match[2]), text: match[1].trim() };
    }
    if (item.scope) {
      const text = match[1]?.trim();
      if (text) {
        return { scope: item.scope, text };
      }
      continue;
    }
    const scope = match[1] ? readScope(match[1]) : "session";
    const text = match[2]?.trim();
    if (text) {
      return { scope, text };
    }
  }
  return undefined;
}

function parseMemoryEntries(input: {
  text: string;
  scope: MemoryScope;
  file: string;
}): MemoryEntry[] {
  return input.text
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter((line) => Boolean(line.line))
    .map((line) =>
      parseMemoryEntryLine({
        line: line.line,
        scope: input.scope,
        file: input.file,
        lineNumber: line.lineNumber
      })
    );
}

function parseMemoryEntryLine(input: {
  line: string;
  scope: MemoryScope;
  file: string;
  lineNumber: number;
}): MemoryEntry {
  const text = normalizeMemoryLine(input.line);
  const keyValue = parseKeyValue(text);
  return {
    scope: input.scope,
    text,
    key: keyValue?.key,
    value: keyValue?.value,
    file: input.file,
    line: input.lineNumber
  };
}

function normalizeMemoryLine(text: string): string {
  const normalized = text.trim().replace(/^\s*[-*]\s+/, "");
  if (!normalized) {
    throw new Error("Memory text must not be empty");
  }
  return normalized;
}

function parseKeyValue(text: string): { key: string; value: string } | undefined {
  const match = /^([^:=：]{2,80})\s*(?:=|:|：)\s*(.+)$/.exec(text);
  if (!match) {
    return undefined;
  }
  return {
    key: normalizeKey(match[1]),
    value: normalizeText(match[2])
  };
}

function findMemoryConflicts(entries: MemoryEntry[], incoming: MemoryEntry): MemoryConflict[] {
  if (!incoming.key || incoming.value === undefined) {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.key === incoming.key && entry.value !== undefined && entry.value !== incoming.value
    )
    .map((existing) => ({
      scope: incoming.scope,
      key: incoming.key!,
      existing,
      incoming
    }));
}

function scoreMemoryEntry(entry: MemoryEntry, terms: string[]): number {
  const haystack = tokenize(`${entry.key ?? ""} ${entry.value ?? ""} ${entry.text}`);
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) {
      score += entry.key === term ? 5 : 2;
    } else if (haystack.some((word) => word.includes(term) || term.includes(word))) {
      score += 1;
    }
  }
  return score;
}

function tokenize(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_-]+/gu, " ")
        .split(/\s+/)
        .map((term) => term.trim())
        .filter((term) => term.length >= 2)
    )
  );
}

function normalizeKey(text: string): string {
  return normalizeText(text).replace(/\s+/g, " ");
}

function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function readScope(value: string): MemoryScope {
  if (value === "user" || value === "project" || value === "session") {
    return value;
  }
  return readChineseScope(value);
}

function readChineseScope(value: string): MemoryScope {
  if (value === "用户") return "user";
  if (value === "项目") return "project";
  if (value === "会话" || !value) return "session";
  throw new Error(`Unsupported memory scope: ${value}`);
}

function requireSessionId(sessionId: string | undefined): string {
  if (!sessionId) {
    throw new Error("Session memory requires a session id");
  }
  return sessionId;
}

function safeSessionId(sessionId: string): string {
  return encodeURIComponent(sessionId).replace(/%/g, "_");
}
