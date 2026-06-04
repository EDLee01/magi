import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

import { isBinaryBuffer } from "./workspace.js";

export interface SearchContextLine {
  line: number;
  text: string;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
  before?: SearchContextLine[];
  after?: SearchContextLine[];
}

export function searchWorkspace(input: {
  cwd: string;
  query: string;
  basePath?: string;
  maxMatches?: number;
  headLimit?: number;
  maxFileBytes?: number;
  glob?: string;
  type?: string;
  outputMode?: "content" | "files_with_matches" | "count";
  ignoreCase?: boolean;
  fixedStrings?: boolean;
  beforeContext?: number;
  afterContext?: number;
}): SearchMatch[] {
  if (!input.query) {
    return [];
  }

  const root = resolveWorkspaceRoot(input.cwd, input.basePath);
  const searchPath = path.relative(input.cwd, root) || ".";
  const headLimit = readHeadLimit(input);
  const beforeContext = input.beforeContext ?? 0;
  const afterContext = input.afterContext ?? 0;
  const glob = input.glob ? normalizeMatchPath(input.glob) : undefined;
  const typeGlobs = typeToGlobs(input.type);

  const args = [
    "--json",
    ...(input.fixedStrings ? ["--fixed-strings"] : []),
    ...(input.ignoreCase ? ["--ignore-case"] : []),
    ...(glob ? ["--glob", glob] : []),
    ...typeGlobs.flatMap((glob) => ["--glob", glob]),
    ...(beforeContext > 0 ? ["--before-context", String(beforeContext)] : []),
    ...(afterContext > 0 ? ["--after-context", String(afterContext)] : []),
    "--",
    input.query,
    searchPath
  ];
  const rg = spawnSync("rg", args, {
    cwd: input.cwd,
    encoding: "utf8",
    timeout: 10_000
  });

  if (rg.status === 0 || rg.status === 1) {
    return parseRipgrepJson(rg.stdout, headLimit, beforeContext, afterContext);
  }

  if (rg.error && (rg.error as NodeJS.ErrnoException).code !== "ENOENT") {
    return [];
  }

  return searchWithoutRipgrep({
    cwd: input.cwd,
    root,
    query: input.query,
    headLimit,
    maxFileBytes: input.maxFileBytes ?? 128 * 1024,
    glob,
    typeGlobs,
    ignoreCase: input.ignoreCase,
    fixedStrings: input.fixedStrings,
    beforeContext,
    afterContext
  });
}

export function globWorkspace(input: {
  cwd: string;
  pattern: string;
  basePath?: string;
  maxMatches?: number;
}): string[] {
  const root = resolveWorkspaceRoot(input.cwd, input.basePath);
  const regex = globToRegExp(input.pattern);
  const matches: Array<{ path: string; mtimeMs: number }> = [];
  walk(root);
  return matches
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path))
    .slice(0, input.maxMatches ?? 250)
    .map((match) => match.path);

  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === ".git") {
        continue;
      }
      const item = path.join(dir, name);
      const stat = statSync(item);
      if (stat.isDirectory()) {
        walk(item);
        continue;
      }
      if (!stat.isFile()) {
        continue;
      }
      const rel = normalizeMatchPath(path.relative(input.cwd, item));
      if (regex.test(rel)) {
        matches.push({ path: rel, mtimeMs: stat.mtimeMs });
      }
    }
  }
}

export function formatSearchMatches(
  matches: SearchMatch[],
  input: {
    outputMode?: "content" | "files_with_matches" | "count";
    lineNumbers?: boolean;
    pattern?: string;
  } = {}
): string {
  const outputMode = input.outputMode ?? "content";
  if (outputMode === "count") {
    return String(matches.length);
  }
  if (outputMode === "files_with_matches") {
    return [...new Set(matches.map((match) => match.path))].join("\n") || "No matches";
  }
  if (matches.length === 0) {
    return "No matches";
  }
  const fileCount = new Set(matches.map((match) => match.path)).size;
  const header = input.pattern
    ? `Search: ${input.pattern} -> ${fileCount} files, ${matches.length} matches`
    : undefined;
  const body = matches.flatMap((match) => formatMatchWithContext(match, input.lineNumbers ?? true));
  return [header, ...body].filter((line): line is string => Boolean(line)).join("\n");
}

export function globToRegExp(pattern: string): RegExp {
  const normalizedPattern = normalizeMatchPath(pattern);
  let out = "^";
  for (let i = 0; i < normalizedPattern.length; i += 1) {
    const char = normalizedPattern[i];
    const next = normalizedPattern[i + 1];
    if (char === "*" && next === "*") {
      out += ".*";
      i += 1;
      continue;
    }
    if (char === "*") {
      out += "[^/]*";
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    out += char.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
  }
  return new RegExp(`${out}$`);
}

function resolveWorkspaceRoot(cwd: string, basePath: string | undefined): string {
  const root = path.resolve(cwd, basePath ?? ".");
  const allowParents = [cwd, os.homedir()].filter((dir, i, arr) => arr.indexOf(dir) === i);
  const allowed = allowParents.some((dir) => {
    const rel = path.relative(dir, root);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  });
  if (!allowed) {
    throw new Error(`Search path is outside allowed directories: ${basePath}`);
  }
  return root;
}

function readHeadLimit(input: { headLimit?: number; maxMatches?: number }): number {
  const raw = input.headLimit ?? input.maxMatches ?? 250;
  if (!Number.isInteger(raw) || raw < 0) {
    throw new Error("Grep head_limit must be a non-negative integer");
  }
  return raw;
}

function parseRipgrepJson(
  stdout: string,
  headLimit: number,
  beforeContext: number,
  afterContext: number
): SearchMatch[] {
  const matches: SearchMatch[] = [];
  const pendingBefore = new Map<string, SearchContextLine[]>();
  const lastMatchByPath = new Map<string, SearchMatch>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const event = readJsonRecord(line);
    if (!isRecord(event) || !isRecord(event.data)) {
      continue;
    }
    const filePath = readTextField(event.data.path);
    const lineNumber =
      typeof event.data.line_number === "number" ? event.data.line_number : undefined;
    const text = readTextField(event.data.lines)?.replace(/\r?\n$/, "");
    if (!filePath || !lineNumber || text === undefined) {
      continue;
    }
    const normalizedPath = normalizeMatchPath(filePath);
    if (event.type === "context") {
      const last = lastMatchByPath.get(normalizedPath);
      if (last && lineNumber > last.line && lineNumber <= last.line + afterContext) {
        last.after = [...(last.after ?? []), { line: lineNumber, text }];
      } else {
        const before = pendingBefore.get(normalizedPath) ?? [];
        before.push({ line: lineNumber, text });
        pendingBefore.set(normalizedPath, before.slice(Math.max(0, before.length - beforeContext)));
      }
      continue;
    }
    if (event.type === "match") {
      if (headLimit !== 0 && matches.length >= headLimit) {
        continue;
      }
      const match: SearchMatch = {
        path: normalizedPath,
        line: lineNumber,
        text,
        before: pendingBefore.get(normalizedPath)
      };
      pendingBefore.delete(normalizedPath);
      matches.push(match);
      lastMatchByPath.set(normalizedPath, match);
    }
  }
  return matches;
}

function readJsonRecord(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

export function normalizeMatchPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

function searchWithoutRipgrep(input: {
  cwd: string;
  root: string;
  query: string;
  headLimit: number;
  maxFileBytes: number;
  glob?: string;
  typeGlobs: string[];
  ignoreCase?: boolean;
  fixedStrings?: boolean;
  beforeContext: number;
  afterContext: number;
}): SearchMatch[] {
  const matches: SearchMatch[] = [];
  const globRegex = input.glob ? globToRegExp(input.glob) : undefined;
  const typeRegexes = input.typeGlobs.map(globToRegExp);
  const matcher = createLineMatcher(input.query, {
    ignoreCase: input.ignoreCase,
    fixedStrings: input.fixedStrings
  });
  walk(input.root);
  return matches;

  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      if (
        (input.headLimit !== 0 && matches.length >= input.headLimit) ||
        name === "node_modules" ||
        name === "dist" ||
        name === ".git"
      ) {
        continue;
      }
      const item = path.join(dir, name);
      const stat = statSync(item);
      if (stat.isDirectory()) {
        walk(item);
        continue;
      }
      if (!stat.isFile() || stat.size > input.maxFileBytes) {
        continue;
      }
      const rel = normalizeMatchPath(path.relative(input.cwd, item));
      if (globRegex && !globRegex.test(rel)) {
        continue;
      }
      if (typeRegexes.length > 0 && !typeRegexes.some((regex) => regex.test(rel))) {
        continue;
      }
      const buffer = readFileSync(item);
      if (isBinaryBuffer(buffer)) {
        continue;
      }
      const lines = buffer.toString("utf8").split(/\r?\n/);
      lines.forEach((text, index) => {
        if ((input.headLimit === 0 || matches.length < input.headLimit) && matcher(text)) {
          matches.push({
            path: rel,
            line: index + 1,
            text,
            before: readContext(lines, index, input.beforeContext, "before"),
            after: readContext(lines, index, input.afterContext, "after")
          });
        }
      });
    }
  }
}

function createLineMatcher(
  query: string,
  input: { ignoreCase?: boolean; fixedStrings?: boolean }
): (line: string) => boolean {
  if (input.fixedStrings) {
    const needle = input.ignoreCase ? query.toLowerCase() : query;
    return (line) => (input.ignoreCase ? line.toLowerCase() : line).includes(needle);
  }
  const regex = new RegExp(query, input.ignoreCase ? "i" : "");
  return (line) => regex.test(line);
}

function readContext(
  lines: string[],
  index: number,
  count: number,
  direction: "before" | "after"
): SearchContextLine[] | undefined {
  if (count <= 0) {
    return undefined;
  }
  if (direction === "before") {
    return lines
      .slice(Math.max(0, index - count), index)
      .map((text, offset) => ({ line: index - Math.min(index, count) + offset + 1, text }));
  }
  return lines
    .slice(index + 1, index + 1 + count)
    .map((text, offset) => ({ line: index + offset + 2, text }));
}

function formatMatchWithContext(match: SearchMatch, lineNumbers: boolean): string[] {
  return [
    ...(match.before ?? []).map((line) =>
      formatSearchLine(match.path, line.line, line.text, lineNumbers, "-")
    ),
    formatSearchLine(match.path, match.line, match.text, lineNumbers, ":"),
    ...(match.after ?? []).map((line) =>
      formatSearchLine(match.path, line.line, line.text, lineNumbers, "-")
    )
  ];
}

function formatSearchLine(
  filePath: string,
  line: number,
  text: string,
  lineNumbers: boolean,
  separator: ":" | "-"
): string {
  return lineNumbers
    ? `${filePath}${separator}${line}${separator}${text}`
    : `${filePath}${separator}${text}`;
}

function typeToGlobs(type: string | undefined): string[] {
  if (!type) {
    return [];
  }
  const globs = TYPE_GLOBS[type.toLowerCase()];
  if (!globs) {
    throw new Error(`Unsupported Grep type: ${type}`);
  }
  return globs;
}

function readTextField(value: unknown): string | undefined {
  return isRecord(value) && typeof value.text === "string" ? value.text : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TYPE_GLOBS: Record<string, string[]> = {
  js: ["*.js", "**/*.js", "*.jsx", "**/*.jsx", "*.mjs", "**/*.mjs", "*.cjs", "**/*.cjs"],
  javascript: ["*.js", "**/*.js", "*.jsx", "**/*.jsx", "*.mjs", "**/*.mjs", "*.cjs", "**/*.cjs"],
  ts: ["*.ts", "**/*.ts", "*.tsx", "**/*.tsx", "*.mts", "**/*.mts", "*.cts", "**/*.cts"],
  typescript: ["*.ts", "**/*.ts", "*.tsx", "**/*.tsx", "*.mts", "**/*.mts", "*.cts", "**/*.cts"],
  py: ["*.py", "**/*.py"],
  python: ["*.py", "**/*.py"],
  rs: ["*.rs", "**/*.rs"],
  rust: ["*.rs", "**/*.rs"],
  go: ["*.go", "**/*.go"],
  java: ["*.java", "**/*.java"],
  kt: ["*.kt", "**/*.kt", "*.kts", "**/*.kts"],
  kotlin: ["*.kt", "**/*.kt", "*.kts", "**/*.kts"],
  swift: ["*.swift", "**/*.swift"],
  c: ["*.c", "**/*.c", "*.h", "**/*.h"],
  cpp: [
    "*.cc",
    "**/*.cc",
    "*.cpp",
    "**/*.cpp",
    "*.cxx",
    "**/*.cxx",
    "*.hh",
    "**/*.hh",
    "*.hpp",
    "**/*.hpp"
  ],
  cs: ["*.cs", "**/*.cs"],
  csharp: ["*.cs", "**/*.cs"],
  php: ["*.php", "**/*.php"],
  rb: ["*.rb", "**/*.rb"],
  ruby: ["*.rb", "**/*.rb"],
  md: ["*.md", "**/*.md", "*.markdown", "**/*.markdown"],
  markdown: ["*.md", "**/*.md", "*.markdown", "**/*.markdown"],
  json: ["*.json", "**/*.json"],
  yaml: ["*.yaml", "**/*.yaml", "*.yml", "**/*.yml"],
  yml: ["*.yaml", "**/*.yaml", "*.yml", "**/*.yml"],
  html: ["*.html", "**/*.html", "*.htm", "**/*.htm"],
  css: ["*.css", "**/*.css"],
  sh: ["*.sh", "**/*.sh", "*.bash", "**/*.bash", "*.zsh", "**/*.zsh"],
  shell: ["*.sh", "**/*.sh", "*.bash", "**/*.bash", "*.zsh", "**/*.zsh"]
};
