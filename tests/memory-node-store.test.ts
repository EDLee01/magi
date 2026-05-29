import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

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

  it("decays active memory nodes that have not been used recently", () => {
    const paths = makePaths();
    const store = MemoryNodeStore.open(paths);
    try {
      const stale = store.upsertNode({
        type: "preference",
        title: "Stale preference",
        summary: "Old preference.",
        body: "User preferred a stale behavior long ago.",
        source: "explicit",
        weight: 0.9
      });
      const fresh = store.upsertNode({
        type: "preference",
        title: "Fresh preference",
        summary: "Fresh preference.",
        body: "User prefers the current behavior.",
        source: "explicit",
        weight: 0.9
      });
      store.markUsed([fresh.id], 0);
      const db = new Database(paths.sessionDbFile);
      db.prepare("update memory_nodes set updated_at = ?, last_used_at = null where id = ?").run(
        "2026-01-01T00:00:00.000Z",
        stale.id
      );
      db.close();

      const preview = store.decayUnusedNodes({
        now: new Date("2026-05-29T00:00:00Z"),
        olderThanDays: 1,
        decay: 0.2,
        minWeight: 0.4,
        apply: false
      });
      expect(preview.applied).toBe(false);
      expect(preview.changed.map((item) => item.node.id)).toContain(stale.id);
      expect(store.getNode(stale.id)?.weight).toBe(0.9);

      const applied = store.decayUnusedNodes({
        now: new Date("2026-05-29T00:00:00Z"),
        olderThanDays: 1,
        decay: 0.2,
        minWeight: 0.4,
        apply: true
      });
      expect(applied.changed.find((item) => item.node.id === stale.id)).toMatchObject({
        previousWeight: 0.9,
        nextWeight: 0.72
      });
      expect(store.getNode(stale.id)?.weight).toBeCloseTo(0.72);
      expect(store.getNode(stale.id)?.metadata.decay).toMatchObject({
        previousWeight: 0.9,
        nextWeight: 0.72,
        olderThanDays: 1
      });
    } finally {
      store.close();
    }
  });

  it("disputes incorrect nodes and recalls corrected replacements through supersedes edges", () => {
    const paths = makePaths();
    const store = MemoryNodeStore.open(paths);
    try {
      const oldNode = store.upsertNode({
        type: "user_profile",
        title: "User role",
        summary: "Incorrect user role.",
        body: "The user is a documentation reviewer.",
        source: "explicit",
        weight: 0.95
      });

      const corrected = store.correctNode({
        nodeId: oldNode.id,
        reason: "User explicitly corrected their role.",
        replacement: {
          body: "The user is the creator of Magi.",
          title: "User role",
          summary: "Correct user role.",
          source: "explicit"
        }
      });

      expect(corrected.disputed).toMatchObject({
        id: oldNode.id,
        status: "disputed"
      });
      expect(corrected.replacement).toMatchObject({
        status: "active",
        body: "The user is the creator of Magi."
      });
      expect(corrected.edges.map((edge) => edge.relation)).toEqual([
        "supersedes",
        "conflicts_with"
      ]);

      const hits = store.searchGraph({ query: "documentation reviewer", limit: 5 });
      expect(hits.map((hit) => hit.node.id)).toContain(corrected.replacement!.id);
      expect(hits.map((hit) => hit.node.id)).not.toContain(oldNode.id);
    } finally {
      store.close();
    }
  });

  it("uses graph edges to recall related memory nodes", () => {
    const paths = makePaths();
    const store = MemoryNodeStore.open(paths);
    try {
      const source = store.upsertSource({
        kind: "wiki",
        uri: "memory/projects/magi.md",
        title: "Magi project memory",
        contentHash: "source-edge-related"
      });
      const project = store.upsertChunk({
        sourceId: source.id,
        uri: "memory/projects/magi.md#memory-graph",
        type: "project",
        heading: "Memory graph",
        body: "Magi stores durable memory as weighted SQLite graph nodes.",
        summary: "Durable memory uses weighted graph nodes.",
        contentHash: "project-edge-related",
        weight: 0.7
      });
      const workflow = store.upsertChunk({
        sourceId: source.id,
        uri: "memory/projects/magi.md#verification-workflow",
        type: "workflow",
        heading: "Verification workflow",
        body: "Run focused business checks before broad verification.",
        summary: "Focused verification workflow.",
        contentHash: "workflow-edge-related",
        weight: 0.6
      });
      store.addEdge({
        fromNodeId: project.nodeId,
        toNodeId: workflow.nodeId,
        relation: "relates_to",
        weight: 0.9
      });

      const hits = store.searchGraph({ query: "durable sqlite graph", limit: 5 });
      expect(hits.map((hit) => hit.chunk.heading)).toEqual(
        expect.arrayContaining(["Memory graph", "Verification workflow"])
      );
      expect(
        hits.find((hit) => hit.chunk.heading === "Verification workflow")?.score
      ).toBeGreaterThan(1);
    } finally {
      store.close();
    }
  });

  it("prefers superseding memories over superseded matches", () => {
    const paths = makePaths();
    const store = MemoryNodeStore.open(paths);
    try {
      const source = store.upsertSource({
        kind: "wiki",
        uri: "memory/preferences/verification.md",
        title: "Verification preferences",
        contentHash: "source-edge-supersedes"
      });
      const oldNode = store.upsertChunk({
        sourceId: source.id,
        uri: "memory/preferences/verification.md#old",
        type: "preference",
        heading: "Old verification style",
        body: "Old preference: show detailed terminal logs after every test run.",
        summary: "Show detailed terminal logs.",
        contentHash: "old-edge-supersedes",
        weight: 0.65
      });
      const currentNode = store.upsertChunk({
        sourceId: source.id,
        uri: "memory/preferences/verification.md#current",
        type: "preference",
        heading: "Current verification style",
        body: "Current preference: summarize verification results concisely.",
        summary: "Summarize verification concisely.",
        contentHash: "current-edge-supersedes",
        weight: 0.75
      });
      store.addEdge({
        fromNodeId: currentNode.nodeId,
        toNodeId: oldNode.nodeId,
        relation: "supersedes",
        weight: 1
      });

      const hits = store.searchGraph({ query: "detailed terminal logs verification", limit: 5 });
      expect(hits.map((hit) => hit.chunk.heading)).toContain("Current verification style");
      expect(hits.map((hit) => hit.chunk.heading)).not.toContain("Old verification style");
    } finally {
      store.close();
    }
  });

  it("filters indirectly recalled conflicting memories", () => {
    const paths = makePaths();
    const store = MemoryNodeStore.open(paths);
    try {
      const source = store.upsertSource({
        kind: "wiki",
        uri: "memory/preferences/output.md",
        title: "Output preferences",
        contentHash: "source-edge-conflict"
      });
      const concise = store.upsertChunk({
        sourceId: source.id,
        uri: "memory/preferences/output.md#concise",
        type: "preference",
        heading: "Concise summaries",
        body: "Prefer concise summaries for verification output.",
        summary: "Concise verification summaries.",
        contentHash: "concise-edge-conflict",
        weight: 0.8
      });
      const verbose = store.upsertChunk({
        sourceId: source.id,
        uri: "memory/preferences/output.md#verbose",
        type: "preference",
        heading: "Verbose logs",
        body: "Prefer verbose logs for verification output.",
        summary: "Verbose verification logs.",
        contentHash: "verbose-edge-conflict",
        weight: 0.6
      });
      store.addEdge({
        fromNodeId: concise.nodeId,
        toNodeId: verbose.nodeId,
        relation: "conflicts_with",
        weight: 1
      });
      store.addEdge({
        fromNodeId: concise.nodeId,
        toNodeId: verbose.nodeId,
        relation: "relates_to",
        weight: 1
      });

      const hits = store.searchGraph({ query: "concise summaries", limit: 5 });
      expect(hits.map((hit) => hit.chunk.heading)).toContain("Concise summaries");
      expect(hits.map((hit) => hit.chunk.heading)).not.toContain("Verbose logs");
      const conflicts = store.listConflicts();
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({
        from: expect.objectContaining({ id: concise.nodeId }),
        to: expect.objectContaining({ id: verbose.nodeId }),
        recommendation: "prefer_from"
      });
      expect(conflicts[0].reason).toContain("higher weight");
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
