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
    expect(classifyMemoryNodeType("User prefers focused checks before broad checks")).toBe("work_habit");
    expect(classifyMemoryNodeType("User prefers concise terminal summaries")).toBe("preference");
    expect(classifyMemoryNodeType("I am Edward, Magi's creator")).toBe("user_profile");
    expect(classifyMemoryNodeType("Use this release workflow before publishing")).toBe("workflow");
    expect(classifyMemoryNodeType("Magi memory architecture uses SQLite graph storage")).toBe("project");
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
});
