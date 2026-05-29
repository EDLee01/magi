import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { classifyMemoryNodeType, MemoryNodeStore } from "../src/memory-node-store.js";
import { MagiPaths } from "../src/paths.js";

function makePaths(): MagiPaths {
  const root = mkdtempSync(path.join(tmpdir(), "magi-memory-graph-"));
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

describe("memory-node-store", () => {
  it("classifies durable memory into graph node types", () => {
    expect(classifyMemoryNodeType("User prefers focused checks before broad checks")).toBe(
      "work_habit"
    );
    expect(classifyMemoryNodeType("User prefers concise terminal summaries")).toBe("preference");
    expect(classifyMemoryNodeType("I am Edward, Magi's creator")).toBe("user_profile");
    expect(classifyMemoryNodeType("Use this release workflow before publishing")).toBe("workflow");
    expect(classifyMemoryNodeType("Magi memory architecture uses SQLite graph storage")).toBe(
      "project"
    );
    expect(classifyMemoryNodeType("Run this process", { scope: "session" })).toBe("session");
  });

  it("stores weighted memory graph nodes and orders hot memory by type and weight", () => {
    const paths = makePaths();
    const store = MemoryNodeStore.open(paths);
    try {
      const workflow = store.upsertNode({
        type: "workflow",
        title: "Release workflow",
        summary: "Run verification before release.",
        body: "Run typecheck, tests, build, and smoke before publishing.",
        source: "test",
        weight: 0.9
      });
      const habit = store.upsertNode({
        type: "work_habit",
        title: "Focused checks",
        summary: "User prefers focused checks first.",
        body: "Run focused checks before broad checks.",
        source: "test",
        weight: 0.5
      });
      const edge = store.addEdge({
        fromNodeId: habit.id,
        toNodeId: workflow.id,
        relation: "relates_to",
        weight: 0.7
      });

      const hot = store.listHotNodes({ limit: 10, minWeight: 0 });
      expect(hot.map((node) => node.type)).toEqual(["work_habit", "workflow"]);
      expect(edge).toMatchObject({
        fromNodeId: habit.id,
        toNodeId: workflow.id,
        relation: "relates_to",
        weight: 0.7
      });
    } finally {
      store.close();
    }
  });

  it("deduplicates explicit memories and reinforces used nodes", () => {
    const paths = makePaths();
    const store = MemoryNodeStore.open(paths);
    try {
      const first = store.upsertNode({
        type: "preference",
        body: "User prefers direct answers.",
        source: "explicit",
        weight: 0.8
      });
      const second = store.upsertNode({
        type: "preference",
        body: "User prefers direct answers.",
        source: "explicit",
        weight: 0.9
      });
      store.markUsed([first.id], 0.05);
      const updated = store.getNode(first.id);

      expect(second.id).toBe(first.id);
      expect(updated?.useCount).toBe(1);
      expect(updated?.weight).toBeCloseTo(0.95);
    } finally {
      store.close();
    }
  });

  it("stores graph sources, chunks, and archives missing source chunks", () => {
    const paths = makePaths();
    const store = MemoryNodeStore.open(paths);
    try {
      const source = store.upsertSource({
        kind: "wiki",
        uri: "memory/workflows/release.md",
        title: "Release workflow",
        contentHash: "hash-1"
      });
      const chunk = store.upsertChunk({
        sourceId: source.id,
        uri: "memory/workflows/release.md#verify",
        type: "workflow",
        heading: "Verify release",
        body: "Run focused tests before broad checks.",
        summary: "Run focused tests before broad checks.",
        contentHash: "chunk-1",
        weight: 0.7
      });
      const found = store.searchGraph({ query: "focused checks", limit: 5 });
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        source: expect.objectContaining({ uri: "memory/workflows/release.md" }),
        chunk: expect.objectContaining({ id: chunk.id, heading: "Verify release" }),
        node: expect.objectContaining({ type: "workflow", source: "wiki" })
      });

      const updated = store.upsertChunk({
        sourceId: source.id,
        uri: "memory/workflows/release.md#verify",
        type: "workflow",
        heading: "Verify release",
        body: "Run typecheck, focused tests, and build before broad checks.",
        summary: "Updated release verification.",
        contentHash: "chunk-2",
        weight: 0.75
      });
      expect(updated.id).toBe(chunk.id);
      expect(store.listChunksForSource(source.id)).toHaveLength(1);
      expect(store.getNode(chunk.nodeId)?.body).toContain("typecheck");

      store.archiveChunksForSourceExcept(source.id, []);
      expect(store.searchGraph({ query: "typecheck", limit: 5 })).toHaveLength(0);
      expect(store.getNode(chunk.nodeId)?.status).toBe("archived");
    } finally {
      store.close();
    }
  });
});
