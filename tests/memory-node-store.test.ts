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

  it("tracks and reinforces graph edges used during recall", () => {
    const paths = makePaths();
    const store = MemoryNodeStore.open(paths);
    try {
      const project = store.upsertNode({
        type: "project",
        title: "Release rollout project",
        summary: "Release rollout project.",
        body: "Release rollout project uses staged deployment gates.",
        source: "test",
        weight: 0.9
      });
      const workflow = store.upsertNode({
        type: "workflow",
        title: "Deployment gate workflow",
        summary: "Deployment gate workflow.",
        body: "Run smoke verification before deployment expansion.",
        source: "test",
        weight: 0.7
      });
      const edge = store.addEdge({
        fromNodeId: project.id,
        toNodeId: workflow.id,
        relation: "depends_on",
        weight: 0.5
      });

      const hits = store.searchGraph({ query: "staged deployment gates", limit: 4 });
      const workflowHit = hits.find((hit) => hit.node.id === workflow.id);
      expect(workflowHit).toMatchObject({
        graphDistance: 1,
        viaNodeIds: [project.id],
        viaEdgeIds: [edge.id]
      });

      store.markEdgesUsed(workflowHit!.viaEdgeIds!, 0.04);
      const updated = store.getEdge(edge.id);
      expect(updated?.useCount).toBe(1);
      expect(updated?.lastUsedAt).toBeDefined();
      expect(updated?.weight).toBeCloseTo(0.54);
    } finally {
      store.close();
    }
  });

  it("applies explicit feedback signals to memory weight and trend metadata", () => {
    const paths = makePaths();
    const store = MemoryNodeStore.open(paths);
    try {
      const node = store.upsertNode({
        type: "preference",
        title: "Verification output",
        summary: "Verification output.",
        body: "User prefers concise verification summaries.",
        source: "explicit",
        weight: 0.6
      });

      const useful = store.applyFeedback({
        nodeId: node.id,
        signal: "useful",
        reason: "This helped answer the user."
      });
      expect(useful.previousWeight).toBe(0.6);
      expect(useful.nextWeight).toBeCloseTo(0.68);
      expect(useful.node.useCount).toBe(1);
      expect(useful.node.metadata.feedbackTrend).toMatchObject({
        useful: 1,
        irrelevant: 0,
        lastSignal: "useful",
        lastReason: "This helped answer the user."
      });

      const irrelevant = store.applyFeedback({
        nodeId: node.id,
        signal: "irrelevant",
        reason: "Wrong context for this task."
      });
      expect(irrelevant.previousWeight).toBeCloseTo(0.68);
      expect(irrelevant.nextWeight).toBeCloseTo(0.5);
      expect(irrelevant.node.metadata.feedbackTrend).toMatchObject({
        useful: 1,
        irrelevant: 1,
        lastSignal: "irrelevant",
        lastReason: "Wrong context for this task."
      });

      const trends = store.listFeedbackTrends({ limit: 5 });
      expect(trends[0]).toMatchObject({
        node: { id: node.id, title: "Verification output" },
        useful: 1,
        irrelevant: 1,
        net: 0,
        lastSignal: "irrelevant",
        lastReason: "Wrong context for this task."
      });
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
        nextWeight: 0.72,
        effectiveDecay: 0.2
      });
      expect(store.getNode(stale.id)?.weight).toBeCloseTo(0.72);
      expect(store.getNode(stale.id)?.metadata.decay).toMatchObject({
        previousWeight: 0.9,
        nextWeight: 0.72,
        olderThanDays: 1,
        effectiveDecay: 0.2,
        type: "preference"
      });
    } finally {
      store.close();
    }
  });

  it("decays reusable workflow memory more slowly than ordinary project facts", () => {
    const paths = makePaths();
    const store = MemoryNodeStore.open(paths);
    try {
      const workflow = store.upsertNode({
        type: "workflow",
        title: "Release workflow",
        summary: "Release workflow.",
        body: "Run focused memory eval before broad verify.",
        source: "explicit",
        weight: 0.9
      });
      const project = store.upsertNode({
        type: "project",
        title: "Release project fact",
        summary: "Release project fact.",
        body: "Release project uses the current package name.",
        source: "explicit",
        weight: 0.9
      });
      const db = new Database(paths.sessionDbFile);
      db.prepare("update memory_nodes set updated_at = ?, last_used_at = null").run(
        "2026-01-01T00:00:00.000Z"
      );
      db.close();

      const applied = store.decayUnusedNodes({
        now: new Date("2026-05-29T00:00:00Z"),
        olderThanDays: 1,
        decay: 0.2,
        minWeight: 0.4,
        apply: true
      });
      const workflowDecay = applied.changed.find((item) => item.node.id === workflow.id);
      const projectDecay = applied.changed.find((item) => item.node.id === project.id);

      expect(workflowDecay).toMatchObject({
        previousWeight: 0.9,
        nextWeight: 0.81,
        effectiveDecay: 0.1
      });
      expect(projectDecay).toMatchObject({
        previousWeight: 0.9,
        nextWeight: 0.72,
        effectiveDecay: 0.2
      });
      expect(store.getNode(workflow.id)?.weight).toBeGreaterThan(store.getNode(project.id)!.weight);
    } finally {
      store.close();
    }
  });

  it("prioritizes repeatedly useful current memory over stale keyword-heavy memory", () => {
    const paths = makePaths();
    const store = MemoryNodeStore.open(paths);
    try {
      const stale = store.upsertNode({
        type: "workflow",
        title: "Legacy invoice export workflow",
        summary: "Invoice export workflow.",
        body: "Invoice export workflow uses legacy spreadsheet manual reconciliation with invoice export checklist and manual review.",
        source: "explicit",
        weight: 0.95
      });
      const current = store.upsertNode({
        type: "workflow",
        title: "Current invoice export workflow",
        summary: "Invoice export workflow.",
        body: "Invoice export workflow uses automated ledger reconciliation.",
        source: "explicit",
        weight: 0.45
      });
      const db = new Database(paths.sessionDbFile);
      db.prepare("update memory_nodes set updated_at = ?, last_used_at = null where id = ?").run(
        "2026-01-01T00:00:00.000Z",
        stale.id
      );
      db.close();

      store.decayUnusedNodes({
        now: new Date("2026-05-29T00:00:00Z"),
        olderThanDays: 1,
        decay: 0.6,
        minWeight: 0.2,
        apply: true
      });
      store.applyFeedback({
        nodeId: current.id,
        signal: "useful",
        reason: "Current workflow matched the task."
      });
      store.applyFeedback({
        nodeId: current.id,
        signal: "useful",
        reason: "Current workflow matched the task again."
      });

      const hits = store.searchGraph({ query: "invoice export workflow", limit: 5 });
      expect(hits[0]).toMatchObject({
        node: expect.objectContaining({ id: current.id, title: "Current invoice export workflow" })
      });
      expect(hits.map((hit) => hit.node.id)).toContain(stale.id);
      expect(store.getNode(current.id)).toMatchObject({
        useCount: 2,
        metadata: expect.objectContaining({
          feedbackTrend: expect.objectContaining({ useful: 2 })
        })
      });
      expect(store.getNode(stale.id)?.metadata.decay).toMatchObject({
        previousWeight: 0.95,
        effectiveDecay: 0.3
      });
    } finally {
      store.close();
    }
  });

  it("lists low-weight cleanup candidates from stale graph nodes", () => {
    const paths = makePaths();
    const store = MemoryNodeStore.open(paths);
    try {
      const stale = store.upsertNode({
        type: "workflow",
        title: "Dormant workflow",
        summary: "Dormant workflow.",
        body: "An old workflow that has not been used recently.",
        source: "explicit",
        weight: 0.3
      });
      const important = store.upsertNode({
        type: "workflow",
        title: "Important workflow",
        summary: "Important workflow.",
        body: "A retained workflow.",
        source: "explicit",
        weight: 0.9
      });
      const db = new Database(paths.sessionDbFile);
      db.prepare(
        "update memory_nodes set created_at = ?, updated_at = ?, last_used_at = null where id in (?, ?)"
      ).run("2026-01-01T00:00:00.000Z", "2026-05-28T00:00:00.000Z", stale.id, important.id);
      db.close();

      const candidates = store.listCleanupCandidates({
        now: new Date("2026-05-29T00:00:00Z"),
        olderThanDays: 30,
        maxWeight: 0.35
      });
      expect(candidates.map((item) => item.node.id)).toEqual([stale.id]);
      expect(candidates[0]).toMatchObject({
        ageDays: 148,
        reason: expect.stringContaining("low-weight")
      });
    } finally {
      store.close();
    }
  });

  it("lists disputed nodes superseded by active replacements as cleanup candidates", () => {
    const paths = makePaths();
    const store = MemoryNodeStore.open(paths);
    try {
      const stale = store.upsertNode({
        type: "preference",
        title: "Old verification preference",
        summary: "Old verification preference.",
        body: "User prefers verbose logs after verification.",
        source: "explicit",
        weight: 0.95
      });

      const corrected = store.correctNode({
        nodeId: stale.id,
        reason: "User corrected the stale preference.",
        replacement: {
          title: "Current verification preference",
          summary: "Current verification preference.",
          body: "User prefers concise verification summaries.",
          source: "explicit"
        }
      });

      const candidates = store.listCleanupCandidates({
        now: new Date("2026-05-29T00:00:00Z"),
        olderThanDays: 90,
        maxWeight: 0.35
      });
      expect(candidates.map((item) => item.node.id)).toContain(stale.id);
      expect(candidates.find((item) => item.node.id === stale.id)).toMatchObject({
        node: expect.objectContaining({ status: "disputed" }),
        reason: expect.stringContaining(`superseded by active node ${corrected.replacement!.id}`)
      });
    } finally {
      store.close();
    }
  });

  it("lists similar explicit memory nodes as duplicate candidates", () => {
    const paths = makePaths();
    const store = MemoryNodeStore.open(paths);
    try {
      const keep = store.upsertNode({
        type: "workflow",
        title: "Release verification workflow",
        summary: "Run focused checks before broad checks.",
        body: "Run focused checks and typecheck before broad checks for releases.",
        source: "agent",
        weight: 0.9
      });
      const duplicate = store.upsertNode({
        type: "workflow",
        title: "Release verification workflow",
        summary: "Run focused checks before broad checks.",
        body: "Run focused checks and typecheck before broad verification for releases.",
        source: "agent",
        weight: 0.45
      });

      const candidates = store.listDuplicateCandidates();
      expect(candidates).toContainEqual(
        expect.objectContaining({
          keep: expect.objectContaining({ id: keep.id }),
          duplicate: expect.objectContaining({ id: duplicate.id }),
          reason: expect.stringContaining("looks like a duplicate")
        })
      );
    } finally {
      store.close();
    }
  });

  it("merges duplicate memory nodes without dropping graph edges", () => {
    const paths = makePaths();
    const store = MemoryNodeStore.open(paths);
    try {
      const keep = store.upsertNode({
        type: "workflow",
        title: "Focused release verification",
        summary: "Run focused checks before broad checks.",
        body: "Run focused checks and typecheck before broad checks for releases.",
        source: "agent",
        weight: 0.9
      });
      const duplicate = store.upsertNode({
        type: "workflow",
        title: "Focused release verification",
        summary: "Run focused checks before broad checks.",
        body: "Run focused checks and typecheck before broad verification for releases.",
        source: "agent",
        weight: 0.45
      });
      store.markUsed([duplicate.id], 0);
      const project = store.upsertNode({
        type: "project",
        title: "Release project",
        summary: "Release project context.",
        body: "Release project uses the duplicate workflow for package publishing.",
        source: "explicit",
        weight: 0.7
      });
      const skill = store.upsertNode({
        type: "skill_ref",
        title: "Verification skill",
        summary: "Verification skill.",
        body: "Verification skill supports focused release checks.",
        source: "explicit",
        weight: 0.7
      });
      store.addEdge({
        fromNodeId: project.id,
        toNodeId: duplicate.id,
        relation: "depends_on",
        weight: 0.8,
        metadata: { source: "test" }
      });
      store.addEdge({
        fromNodeId: duplicate.id,
        toNodeId: skill.id,
        relation: "uses_skill",
        weight: 0.6,
        metadata: { source: "test" }
      });
      store.addEdge({
        fromNodeId: keep.id,
        toNodeId: skill.id,
        relation: "conflicts_with",
        weight: 0.2,
        metadata: { source: "stale-conflict" }
      });

      const result = store.mergeDuplicateNode({
        keepId: keep.id,
        duplicateId: duplicate.id,
        reason: "Duplicate cleanup",
        metadata: { dreamId: "dream_merge" }
      });

      expect(result.archived.map((node) => node.id)).toEqual([duplicate.id]);
      expect(result.nextKeepWeight).toBeGreaterThan(result.previousKeepWeight);
      expect(result.keep.weight).toBeGreaterThan(keep.weight);
      expect(result.keep.useCount).toBe(1);
      expect(result.resolvedEdgeConflictCount).toBe(1);
      expect(result.redirectedEdges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fromNodeId: project.id,
            toNodeId: keep.id,
            relation: "depends_on"
          }),
          expect.objectContaining({
            fromNodeId: keep.id,
            toNodeId: skill.id,
            relation: "uses_skill"
          })
        ])
      );
      expect(store.getNode(duplicate.id)).toMatchObject({
        status: "archived",
        metadata: expect.objectContaining({
          archive: expect.objectContaining({
            mergedInto: keep.id,
            redirectedEdgeCount: 2,
            resolvedEdgeConflictCount: 1
          })
        })
      });
      expect(store.getNode(keep.id)?.metadata).toMatchObject({
        merge: expect.objectContaining({
          duplicateNodeId: duplicate.id,
          previousWeight: keep.weight,
          duplicateUseCount: 1
        })
      });
      expect(store.listMergeRecords()).toContainEqual(
        expect.objectContaining({
          keep: expect.objectContaining({ id: keep.id }),
          duplicate: expect.objectContaining({ id: duplicate.id }),
          previousWeight: keep.weight,
          nextWeight: result.nextKeepWeight,
          redirectedEdgeCount: 2,
          resolvedEdgeConflictCount: 1,
          dreamId: "dream_merge"
        })
      );
      expect(store.listConflicts()).toHaveLength(0);
      expect(
        store.searchGraph({ query: "package publishing", limit: 5 }).map((hit) => hit.node.id)
      ).toContain(keep.id);
    } finally {
      store.close();
    }
  });

  it("archives and keeps reviewed graph cleanup nodes", () => {
    const paths = makePaths();
    const store = MemoryNodeStore.open(paths);
    try {
      const source = store.upsertSource({
        kind: "wiki",
        uri: "memory/workflows/cleanup.md",
        title: "Cleanup workflow",
        contentHash: "hash-cleanup-1"
      });
      const chunk = store.upsertChunk({
        sourceId: source.id,
        uri: "memory/workflows/cleanup.md#stale",
        type: "workflow",
        heading: "Stale workflow",
        body: "Stale workflow should be removed from active recall.",
        summary: "Stale workflow.",
        contentHash: "chunk-cleanup-1",
        weight: 0.25
      });
      const standalone = store.upsertNode({
        type: "workflow",
        title: "Reviewed workflow",
        summary: "Reviewed workflow.",
        body: "Reviewed workflow should remain active after cleanup review.",
        source: "explicit",
        weight: 0.25
      });

      const kept = store.keepNodes({
        ids: [standalone.id],
        reason: "Reviewer kept this workflow",
        metadata: { dreamId: "dream_keep" }
      });
      expect(kept.map((node) => node.id)).toEqual([standalone.id]);
      expect(store.getNode(standalone.id)).toMatchObject({
        status: "active",
        metadata: expect.objectContaining({
          cleanupReview: expect.objectContaining({
            decision: "kept",
            dreamId: "dream_keep"
          })
        })
      });

      const archived = store.archiveNodes({
        ids: [chunk.nodeId],
        reason: "Reviewer archived this workflow",
        metadata: { dreamId: "dream_archive" }
      });
      expect(archived.map((node) => node.id)).toEqual([chunk.nodeId]);
      expect(store.getNode(chunk.nodeId)).toMatchObject({
        status: "archived",
        metadata: expect.objectContaining({
          archive: expect.objectContaining({
            dreamId: "dream_archive"
          })
        })
      });
      expect(store.searchGraph({ query: "removed recall", limit: 5 })).toHaveLength(0);

      store.upsertChunk({
        sourceId: source.id,
        uri: "memory/workflows/cleanup.md#stale",
        type: "workflow",
        heading: "Stale workflow",
        body: "Stale workflow should be removed from active recall.",
        summary: "Stale workflow.",
        contentHash: "chunk-cleanup-2",
        weight: 0.72
      });
      expect(store.getNode(chunk.nodeId)?.status).toBe("archived");
      expect(store.searchGraph({ query: "removed recall", limit: 5 })).toHaveLength(0);
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

  it("walks workflow graph neighborhoods across multiple related nodes", () => {
    const paths = makePaths();
    const store = MemoryNodeStore.open(paths);
    try {
      const project = store.upsertNode({
        type: "project",
        title: "Release project context",
        body: "The release project uses staged rollout verification.",
        summary: "Release project context.",
        source: "explicit",
        weight: 0.8
      });
      const workflow = store.upsertNode({
        type: "workflow",
        title: "Deployment gate workflow",
        body: "Run smoke verification before deployment expansion.",
        summary: "Deployment gate workflow.",
        source: "explicit",
        weight: 0.7
      });
      const habit = store.upsertNode({
        type: "work_habit",
        title: "Concise deployment reporting",
        body: "Summarize expansion verification with concise risk notes.",
        summary: "Concise deployment reporting.",
        source: "explicit",
        weight: 0.65
      });
      store.addEdge({
        fromNodeId: project.id,
        toNodeId: workflow.id,
        relation: "depends_on",
        weight: 0.95
      });
      store.addEdge({
        fromNodeId: workflow.id,
        toNodeId: habit.id,
        relation: "relates_to",
        weight: 0.95
      });

      const hits = store.searchGraph({ query: "release project", limit: 5 });
      const hitHeadings = hits.map((hit) => hit.chunk.heading);
      const habitHit = hits.find((hit) => hit.chunk.heading === "Concise deployment reporting");

      expect(hitHeadings).toEqual(
        expect.arrayContaining([
          "Release project context",
          "Deployment gate workflow",
          "Concise deployment reporting"
        ])
      );
      expect(habitHit).toMatchObject({
        graphDistance: 2,
        viaNodeIds: [project.id, workflow.id]
      });
      expect(habitHit!.score).toBeGreaterThan(1);
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

  it("groups connected conflict edges into reviewable memory conflict clusters", () => {
    const paths = makePaths();
    const store = MemoryNodeStore.open(paths);
    try {
      const current = store.upsertNode({
        type: "preference",
        title: "Current verification preference",
        summary: "Current verification preference.",
        body: "User prefers concise verification summaries.",
        source: "explicit",
        weight: 0.95
      });
      const staleVerbose = store.upsertNode({
        type: "preference",
        title: "Verbose verification preference",
        summary: "Verbose verification preference.",
        body: "User prefers verbose terminal dumps.",
        source: "explicit",
        weight: 0.4
      });
      const staleRawLogs = store.upsertNode({
        type: "preference",
        title: "Raw log preference",
        summary: "Raw log preference.",
        body: "User prefers raw terminal logs after tests.",
        source: "explicit",
        weight: 0.35
      });
      store.addEdge({
        fromNodeId: current.id,
        toNodeId: staleVerbose.id,
        relation: "conflicts_with",
        weight: 1,
        metadata: { reason: "User corrected verbose output." }
      });
      store.addEdge({
        fromNodeId: staleVerbose.id,
        toNodeId: staleRawLogs.id,
        relation: "conflicts_with",
        weight: 0.8,
        metadata: { reason: "Both stale preferences describe verbose logs." }
      });

      const groups = store.listConflictGroups();

      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({
        recommendation: "prefer_node",
        preferredNodeId: current.id,
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: current.id }),
          expect.objectContaining({ id: staleVerbose.id }),
          expect.objectContaining({ id: staleRawLogs.id })
        ]),
        conflicts: expect.arrayContaining([
          expect.objectContaining({ from: expect.objectContaining({ id: current.id }) }),
          expect.objectContaining({ to: expect.objectContaining({ id: staleRawLogs.id }) })
        ])
      });
      expect(groups[0].reason).toContain("strongest active signal");
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

  it("recalls Chinese workflow nodes through SQL graph search", () => {
    const paths = makePaths();
    const store = MemoryNodeStore.open(paths);
    try {
      const source = store.upsertSource({
        kind: "explicit",
        uri: "memory/nature-workflow",
        title: "Nature公众号推文工作流",
        contentHash: "test"
      });
      store.upsertChunk({
        sourceId: source.id,
        uri: "memory/nature-workflow#Nature公众号推文工作流",
        type: "workflow",
        heading: "Nature公众号推文工作流",
        summary: "High-priority workflow for recurring Nature/公众号推文 creation tasks",
        body: "用户做 Nature 论文中文推文的标准提示词、模板位置和完整工作流程",
        weight: 1
      });

      const hits = store.searchGraph({
        query: "我们公众号的推文你还记得怎么做么",
        limit: 3
      });

      expect(hits.map((hit) => hit.node.title)).toContain("Nature公众号推文工作流");
    } finally {
      store.close();
    }
  });

  it("preserves manually decayed chunk node weight across graph re-index", () => {
    const paths = makePaths();
    const store = MemoryNodeStore.open(paths);
    try {
      const source = store.upsertSource({
        kind: "wiki",
        uri: "memory/workflows/archive.md",
        title: "Archive workflow",
        contentHash: "hash-archive-1"
      });
      const chunk = store.upsertChunk({
        sourceId: source.id,
        uri: "memory/workflows/archive.md#dormant",
        type: "workflow",
        heading: "Dormant workflow",
        body: "Review dormant graph cleanup workflow.",
        summary: "Review dormant workflow.",
        contentHash: "chunk-archive-1",
        weight: 0.7
      });
      const db = new Database(paths.sessionDbFile);
      db.prepare("update memory_nodes set weight = ? where id = ?").run(0.25, chunk.nodeId);
      db.close();

      store.upsertChunk({
        sourceId: source.id,
        uri: "memory/workflows/archive.md#dormant",
        type: "workflow",
        heading: "Dormant workflow",
        body: "Review dormant graph cleanup workflow.",
        summary: "Review dormant workflow.",
        contentHash: "chunk-archive-2",
        weight: 0.7
      });
      expect(store.getNode(chunk.nodeId)?.weight).toBeCloseTo(0.25);
    } finally {
      store.close();
    }
  });
});
