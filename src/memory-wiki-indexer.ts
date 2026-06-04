import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { listMemdirEntries } from "./memdir.js";
import { listMemoryFiles, MemoryRootOptions } from "./memory-files.js";
import { classifyMemoryNodeType, MemoryNodeStore, MemorySourceKind } from "./memory-node-store.js";
import { MagiPaths } from "./paths.js";

export interface MemoryWikiSection {
  filePath: string;
  heading: string;
  level: number;
  body: string;
  uri: string;
  contentHash: string;
}

export interface SyncMemoryGraphResult {
  sourceCount: number;
  chunkCount: number;
  archivedSourceCount: number;
}

export function syncMemoryGraph(
  input: MemoryRootOptions & {
    paths: MagiPaths;
    includeMemdir?: boolean;
  }
): SyncMemoryGraphResult {
  const store = MemoryNodeStore.open(input.paths);
  try {
    const activeWikiUris = new Set<string>();
    let sourceCount = 0;
    let chunkCount = 0;
    for (const file of listMemoryFiles(input)) {
      if (shouldSkipWikiFile(file.path)) {
        continue;
      }
      if (!existsSync(file.absolutePath)) {
        continue;
      }
      const text = readFileSync(file.absolutePath, "utf8");
      const sections = parseWikiSections(file.path, text);
      if (sections.length === 0) {
        continue;
      }
      const source = store.upsertSource({
        kind: "wiki",
        uri: `memory/${file.path}`,
        title: firstHeading(text) ?? file.path,
        contentHash: hashText(text),
        metadata: {
          filePath: file.path,
          absolutePath: file.absolutePath,
          updatedAt: file.updatedAt,
          sectionCount: sections.length
        }
      });
      activeWikiUris.add(source.uri);
      sourceCount += 1;
      const headings: string[] = [];
      for (const [index, section] of sections.entries()) {
        const heading = section.heading;
        headings.push(heading);
        store.upsertChunk({
          sourceId: source.id,
          uri: section.uri,
          type: classifyMemoryNodeType(`${section.heading}\n${section.body}`, {
            scope: wikiFileMemoryScope(file.path)
          }),
          heading,
          body: section.body,
          summary: summarizeSection(section.body),
          contentHash: section.contentHash,
          orderIndex: index,
          weight: weightForWikiPath(file.path),
          metadata: {
            sourceKind: "wiki",
            filePath: file.path,
            heading: section.heading,
            level: section.level,
            uri: section.uri
          }
        });
        chunkCount += 1;
      }
      store.archiveChunksForSourceExcept(source.id, headings);
    }

    let archivedSourceCount = archiveMissingSources(store, "wiki", activeWikiUris);

    if (input.includeMemdir !== false) {
      const activeMemdirUris = new Set<string>();
      for (const entry of listMemdirEntries({ root: input.appRoot })) {
        const uri = `memdir/${entry.filename}`;
        const source = store.upsertSource({
          kind: "memdir",
          uri,
          title: entry.name,
          contentHash: hashText(`${entry.name}\n${entry.description}\n${entry.body}`),
          metadata: {
            filename: entry.filename,
            path: entry.path,
            type: entry.type
          }
        });
        activeMemdirUris.add(source.uri);
        sourceCount += 1;
        store.upsertChunk({
          sourceId: source.id,
          uri,
          type: classifyMemoryNodeType(`${entry.name}\n${entry.description}\n${entry.body}`),
          heading: entry.name,
          body: entry.body,
          summary: entry.description,
          orderIndex: 0,
          weight: 0.6,
          metadata: {
            sourceKind: "memdir",
            filename: entry.filename,
            memdirType: entry.type
          }
        });
        store.archiveChunksForSourceExcept(source.id, [entry.name]);
        chunkCount += 1;
      }
      archivedSourceCount += archiveMissingSources(store, "memdir", activeMemdirUris);
    }

    return { sourceCount, chunkCount, archivedSourceCount };
  } finally {
    store.close();
  }
}

export function parseWikiSections(filePath: string, text: string): MemoryWikiSection[] {
  const lines = text.split(/\r?\n/);
  const sections: Array<{ heading: string; level: number; start: number; end?: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index]);
    if (!match) {
      continue;
    }
    sections.push({ heading: match[2].trim(), level: match[1].length, start: index });
  }
  if (sections.length === 0) {
    const body = text.trim();
    return body
      ? [
          {
            filePath,
            heading: filePath,
            level: 1,
            body,
            uri: `memory/${filePath}`,
            contentHash: hashText(body)
          }
        ]
      : [];
  }
  return sections.flatMap((section, index) => {
    const next = sections[index + 1];
    const end = next?.start ?? lines.length;
    const body = lines
      .slice(section.start + 1, end)
      .join("\n")
      .trim();
    if (!body) {
      return [];
    }
    if (isBoilerplateSection(filePath, section.heading, body)) {
      return [];
    }
    const uri = `memory/${filePath}#${slugify(section.heading)}`;
    return [
      {
        filePath,
        heading: section.heading,
        level: section.level,
        body,
        uri,
        contentHash: hashText(`${section.heading}\n${body}`)
      }
    ];
  });
}

function archiveMissingSources(
  store: MemoryNodeStore,
  kind: MemorySourceKind,
  activeUris: Set<string>
): number {
  let archived = 0;
  for (const source of store.listSources({ kind, status: "active" })) {
    if (activeUris.has(source.uri)) {
      continue;
    }
    store.markSourceMissing(source.id);
    archived += 1;
  }
  return archived;
}

function shouldSkipWikiFile(filePath: string): boolean {
  return (
    filePath === "INDEX.md" ||
    filePath.startsWith("drafts/") ||
    filePath.startsWith("dreams/") ||
    filePath.startsWith("logs/") ||
    filePath.startsWith("archive/")
  );
}

function isBoilerplateSection(filePath: string, heading: string, body: string): boolean {
  const normalized = `${heading}\n${body}`.toLowerCase();
  if (filePath === "INDEX.md") return true;
  return (
    normalized ===
      "memory\nmemory stores durable preferences, project context, decisions, workflows, and permission notes.\ndream creates reviewable drafts that organize memory without changing formal files automatically." ||
    normalized ===
      "user\nlong-lived user facts and stable context. do not store sensitive personal data unless the user explicitly asks." ||
    normalized ===
      "preferences\ndurable communication, product, writing, and workflow preferences." ||
    normalized ===
      "project: default\nproject context, open questions, and active decisions that are not tied to a more specific project file yet." ||
    normalized === "skills\nskill-specific memory and operating context." ||
    normalized === "workflows\nreusable task flows, operating procedures, and references." ||
    normalized === "decisions\naccepted, rejected, and superseded decisions with reasoning." ||
    normalized ===
      "permissions policy\ndurable permission boundaries and approval rules. changes to this file should be reviewed carefully." ||
    normalized === "sessions\nsession-derived summaries that are worth keeping as durable memory."
  );
}

function weightForWikiPath(filePath: string): number {
  if (filePath === "user.md") return 0.85;
  if (filePath === "preferences.md") return 0.82;
  if (filePath.startsWith("workflows/")) return 0.72;
  if (filePath.startsWith("projects/")) return 0.7;
  if (filePath.startsWith("decisions/")) return 0.68;
  return 0.6;
}

function wikiFileMemoryScope(filePath: string): "user" | undefined {
  if (filePath === "user.md" || filePath === "preferences.md") {
    return "user";
  }
  return undefined;
}

function summarizeSection(body: string): string {
  return body
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 180);
}

function firstHeading(text: string): string | undefined {
  const line = text.split(/\r?\n/).find((item) => /^#\s+/.test(item));
  return line?.replace(/^#\s+/, "").trim();
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_-]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "section"
  );
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
