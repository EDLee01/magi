import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { writeMemdirEntry } from "../src/memdir.js";
import { MemoryNodeStore } from "../src/memory-node-store.js";
import { appendMemoryFile, writeMemoryFile } from "../src/memory-files.js";
import { parseWikiSections, syncMemoryGraph } from "../src/memory-wiki-indexer.js";
import { MagiPaths } from "../src/paths.js";

function makePaths(): MagiPaths {
  const root = mkdtempSync(path.join(tmpdir(), "magi-memory-wiki-"));
  const stateRoot = path.join(root, "state");
  return {
    root,
    stateRoot,
    sessionsRoot: path.join(root, "sessions"),
    logsRoot: path.join(root, "logs"),
    cacheRoot: path.join(root, "cache"),
    pluginsRoot: path.join(root, "plugins"),
    skillsRoot: path.join(root, "skills"),
    devicesRoot: path.join(root, "devices"),
    configFile: path.join(root, "config.yaml"),
    sessionDbFile: path.join(stateRoot, "sessions.sqlite")
  };
}

describe("memory-wiki-indexer", () => {
  it("parses markdown headings as wiki memory sections", () => {
    const sections = parseWikiSections(
      "workflows/release.md",
      [
        "# Release",
        "",
        "Overview text.",
        "",
        "## Verify",
        "Run typecheck and tests.",
        "",
        "## Publish",
        "Publish package."
      ].join("\n")
    );

    expect(sections.map((section) => section.heading)).toEqual(["Release", "Verify", "Publish"]);
    expect(sections[1]).toMatchObject({
      filePath: "workflows/release.md",
      uri: "memory/workflows/release.md#verify",
      body: "Run typecheck and tests."
    });
  });

  it("syncs wiki and memdir memory into graph sources and chunks", () => {
    const paths = makePaths();
    appendMemoryFile({
      appRoot: paths.root,
      filePath: "workflows/release.md",
      content: [
        "## Verify release",
        "Run focused tests before broad checks.",
        "",
        "## Publish release",
        "Publish after build passes."
      ].join("\n")
    });
    writeMemdirEntry({
      paths,
      type: "reference",
      name: "Release dashboard",
      description: "Dashboard for release checks",
      body: "Use the release dashboard after verification."
    });

    const result = syncMemoryGraph({ appRoot: paths.root, paths });
    const store = MemoryNodeStore.open(paths);
    try {
      const wikiSource = store.getSourceByUri("memory/workflows/release.md");
      const memdirSource = store.getSourceByUri("memdir/reference_release_dashboard.md");
      expect(result.sourceCount).toBeGreaterThanOrEqual(2);
      expect(wikiSource).toBeDefined();
      expect(memdirSource).toBeDefined();
      expect(store.listChunksForSource(wikiSource!.id).map((chunk) => chunk.heading)).toEqual([
        "Verify release",
        "Publish release"
      ]);
      expect(store.searchGraph({ query: "focused broad checks", limit: 5 })[0]).toMatchObject({
        source: expect.objectContaining({ kind: "wiki" }),
        chunk: expect.objectContaining({ heading: "Verify release" })
      });
      expect(store.searchGraph({ query: "dashboard verification", limit: 5 })).toContainEqual(
        expect.objectContaining({
          source: expect.objectContaining({ kind: "memdir" })
        })
      );
    } finally {
      store.close();
    }
  });

  it("keeps user wiki identity and preferences as hot user memory types", () => {
    const paths = makePaths();
    appendMemoryFile({
      appRoot: paths.root,
      filePath: "user.md",
      content: [
        "## Edward creator identity",
        "Edward is the creator of Magi Next.",
        "Use this identity only as durable user context.",
        "",
        "## Magi summary preference",
        "User prefers concise Magi verification summaries."
      ].join("\n")
    });

    syncMemoryGraph({ appRoot: paths.root, paths });
    const store = MemoryNodeStore.open(paths);
    try {
      const hot = store.listHotNodes({ limit: 10, minWeight: 0 });
      expect(hot).toContainEqual(
        expect.objectContaining({
          title: "Edward creator identity",
          type: "user_profile"
        })
      );
      expect(hot).toContainEqual(
        expect.objectContaining({
          title: "Magi summary preference",
          type: "preference"
        })
      );
    } finally {
      store.close();
    }
  });

  it("updates wiki chunks without duplicates and archives missing sources", () => {
    const paths = makePaths();
    writeMemoryFile({
      appRoot: paths.root,
      filePath: "projects/magi.md",
      content: [
        "# Magi Project",
        "",
        "Memory graph uses SQLite.",
        "",
        "## Harness",
        "Harness should avoid extra provider calls."
      ].join("\n")
    });
    syncMemoryGraph({ appRoot: paths.root, paths });

    writeMemoryFile({
      appRoot: paths.root,
      filePath: "projects/magi.md",
      content: [
        "# Magi Project",
        "",
        "Memory graph uses SQLite and wiki chunks.",
        "",
        "## Harness",
        "Harness should avoid extra provider calls."
      ].join("\n")
    });
    syncMemoryGraph({ appRoot: paths.root, paths });

    const store = MemoryNodeStore.open(paths);
    try {
      const source = store.getSourceByUri("memory/projects/magi.md");
      expect(source).toBeDefined();
      expect(store.listChunksForSource(source!.id)).toHaveLength(2);
      expect(store.searchGraph({ query: "wiki chunks", limit: 5 })).toHaveLength(1);
    } finally {
      store.close();
    }

    rmSync(path.join(paths.root, "memory", "projects", "magi.md"));
    const archived = syncMemoryGraph({ appRoot: paths.root, paths });
    const afterStore = MemoryNodeStore.open(paths);
    try {
      expect(archived.archivedSourceCount).toBeGreaterThanOrEqual(1);
      expect(afterStore.getSourceByUri("memory/projects/magi.md")?.status).toBe("archived");
      expect(afterStore.searchGraph({ query: "wiki chunks", limit: 5 })).toHaveLength(0);
    } finally {
      afterStore.close();
    }
  });
});
