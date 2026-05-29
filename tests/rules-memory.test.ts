import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import {
  appendMemory,
  extractExplicitMemoryWrite,
  formatMemorySearchResults,
  memoryFile,
  readMemory,
  searchMemory,
  sessionMemoryFile
} from "../src/memory.js";
import { appendMemoryFile } from "../src/memory-files.js";
import { retrieveRelevantMemory } from "../src/memory-search.js";
import { MemoryNodeStore } from "../src/memory-node-store.js";
import { syncMemoryGraph } from "../src/memory-wiki-indexer.js";
import { writeMemdirEntry } from "../src/memdir.js";
import { getMagiPaths } from "../src/paths.js";
import { loadAgentInstructions } from "../src/rules/agents-loader.js";
import { SessionStore } from "../src/session-store.js";
import { listDrafts, showDraft } from "../src/memory-draft.js";
import { listDreams, showDream } from "../src/memory-dream.js";
import { makeTempRoot, TempRoot } from "./helpers.js";

let workspace: string | undefined;
let temp: TempRoot | undefined;

afterEach(() => {
  if (workspace) {
    rmSync(workspace, { recursive: true, force: true });
    workspace = undefined;
  }
  temp?.cleanup();
  temp = undefined;
});

describe("AGENTS rules and memory", () => {
  it("loads nested AGENTS.md files from root to cwd", () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-rules-"));
    const child = path.join(workspace, "a", "b");
    mkdirSync(child, { recursive: true });
    writeFileSync(path.join(workspace, "AGENTS.md"), "root rules\n", "utf8");
    writeFileSync(path.join(workspace, "a", "AGENTS.md"), "child rules\n", "utf8");

    const files = loadAgentInstructions(child, workspace);

    expect(files.map((file) => file.content.trim())).toEqual(["root rules", "child rules"]);
  });

  it("reads rules through the CLI", async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-rules-"));
    writeFileSync(path.join(workspace, "AGENTS.md"), "workspace rules\n", "utf8");

    const result = await runCli(["rules"], {}, workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("workspace rules");
  });

  it("appends and reads project and user memory under Magi Next roots", () => {
    temp = makeTempRoot();
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-memory-"));
    const paths = getMagiPaths(temp.env);

    appendMemory({ paths, scope: "project", cwd: workspace, text: "project fact" });
    appendMemory({ paths, scope: "user", cwd: workspace, text: "user fact" });
    appendMemory({
      paths,
      scope: "session",
      cwd: workspace,
      sessionId: "session-1",
      text: "session fact"
    });

    expect(readMemory({ paths, scope: "project", cwd: workspace })).toContain("project fact");
    expect(readMemory({ paths, scope: "user", cwd: workspace })).toContain("user fact");
    expect(
      readMemory({ paths, scope: "session", cwd: workspace, sessionId: "session-1" })
    ).toContain("session fact");
    expect(memoryFile(paths, "project", workspace)).toContain(
      path.join(temp.path, "state", "project-memory")
    );
    expect(memoryFile(paths, "user", workspace)).toBe(path.join(temp.path, "memory.md"));
    expect(sessionMemoryFile(paths, "session-1")).toContain(
      path.join(temp.path, "state", "session-memory")
    );
  });

  it("records memory append audit when a session is supplied", () => {
    temp = makeTempRoot();
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-memory-"));
    const paths = getMagiPaths(temp.env);
    const store = SessionStore.open(paths);
    try {
      const sessionId = store.createSession({ title: "memory", cwd: workspace });
      appendMemory({
        paths,
        scope: "project",
        cwd: workspace,
        text: "audited fact",
        store,
        sessionId
      });
      expect(store.countRows("audit_events")).toBe(1);
    } finally {
      store.close();
    }
  });

  it("proposes CLI memory append as a draft", async () => {
    temp = makeTempRoot();
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-memory-"));

    const append = await runCli(["memory", "append", "project", "cli fact"], temp.env, workspace);
    expect(append.exitCode).toBe(0);
    expect(append.stdout).toContain("Created Memory Draft");

    const paths = getMagiPaths(temp.env);
    const drafts = listDrafts({ appRoot: paths.root });
    expect(drafts).toHaveLength(1);
    const draft = showDraft({ appRoot: paths.root, id: drafts[0].id });
    expect(draft).toMatchObject({
      status: "pending",
      targetFile: "projects/default.md",
      content: "cli fact"
    });

    const view = await runCli(["memory", "show", "projects/default.md"], temp.env, workspace);
    expect(view.stdout).not.toContain("cli fact");

    const shown = await runCli(["memory", "draft", "show", draft.id], temp.env, workspace);
    expect(shown.stdout).toContain(`Memory Draft: ${draft.id}`);
    expect(shown.stdout).toContain("Preview:");
    expect(shown.stdout).toContain("cli fact");
  });

  it("adds SQLite graph cleanup candidates to memory dream runs", async () => {
    temp = makeTempRoot();
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-memory-"));
    const paths = getMagiPaths(temp.env);
    const nodeStore = MemoryNodeStore.open(paths);
    const stale = nodeStore.upsertNode({
      type: "workflow",
      title: "Dormant CLI workflow",
      summary: "Dormant CLI workflow.",
      body: "An old workflow that should be reviewed for archive.",
      source: "explicit",
      weight: 0.25
    });
    nodeStore.close();
    const db = new Database(paths.sessionDbFile);
    db.prepare(
      "update memory_nodes set created_at = ?, updated_at = ?, last_used_at = null where id = ?"
    ).run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", stale.id);
    db.close();

    const dream = await runCli(["memory", "dream"], temp.env, workspace);
    expect(dream.exitCode).toBe(0);
    expect(dream.stdout).toContain("Experimental Dream created:");
    expect(dream.stdout).toContain("archive_candidate");

    const dreams = listDreams({ appRoot: paths.root });
    expect(dreams).toHaveLength(1);
    const manifest = showDream({ appRoot: paths.root, id: dreams[0].id });
    expect(manifest.operations).toContainEqual(
      expect.objectContaining({
        type: "archive_candidate",
        reason: expect.stringContaining(stale.id),
        relatedFiles: [`graph:${stale.id}`],
        graphNodeIds: [stale.id]
      })
    );
    expect(manifest.graphNodeIds).toContain(stale.id);
  });

  it("adds corrected disputed graph nodes to memory dream cleanup candidates", async () => {
    temp = makeTempRoot();
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-memory-"));
    const paths = getMagiPaths(temp.env);
    const nodeStore = MemoryNodeStore.open(paths);
    const stale = nodeStore.upsertNode({
      type: "preference",
      title: "Outdated verification preference",
      summary: "Outdated verification preference.",
      body: "User prefers verbose logs after verification.",
      source: "explicit",
      weight: 0.95
    });
    nodeStore.correctNode({
      nodeId: stale.id,
      reason: "User corrected the stale preference.",
      replacement: {
        title: "Current verification preference",
        summary: "Current verification preference.",
        body: "User prefers concise verification summaries.",
        source: "explicit"
      }
    });
    nodeStore.close();

    const dream = await runCli(["memory", "dream"], temp.env, workspace);
    expect(dream.exitCode).toBe(0);
    expect(dream.stdout).toContain("archive_candidate");

    const dreams = listDreams({ appRoot: paths.root });
    const manifest = showDream({ appRoot: paths.root, id: dreams[0].id });
    expect(manifest.operations).toContainEqual(
      expect.objectContaining({
        type: "archive_candidate",
        reason: expect.stringContaining("superseded by active node"),
        relatedFiles: [`graph:${stale.id}`],
        graphNodeIds: [stale.id]
      })
    );

    const applied = await runCli(["memory", "dream", "apply", dreams[0].id], temp.env, workspace);
    expect(applied.exitCode).toBe(0);
    expect(applied.stdout).toContain("Archived graph nodes: 1");
    const afterApply = MemoryNodeStore.open(paths);
    expect(afterApply.getNode(stale.id)?.status).toBe("archived");
    afterApply.close();
  });

  it("adds duplicate graph nodes to memory dream merge candidates", async () => {
    temp = makeTempRoot();
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-memory-"));
    const paths = getMagiPaths(temp.env);
    const nodeStore = MemoryNodeStore.open(paths);
    const keep = nodeStore.upsertNode({
      type: "workflow",
      title: "Focused release verification",
      summary: "Run focused checks before broad checks.",
      body: "Run focused checks and typecheck before broad checks for releases.",
      source: "agent",
      weight: 0.9
    });
    const duplicate = nodeStore.upsertNode({
      type: "workflow",
      title: "Focused release verification",
      summary: "Run focused checks before broad checks.",
      body: "Run focused checks and typecheck before broad verification for releases.",
      source: "agent",
      weight: 0.45
    });
    const project = nodeStore.upsertNode({
      type: "project",
      title: "Release project",
      summary: "Release project context.",
      body: "Release project uses the duplicate verification workflow for package publishing.",
      source: "explicit",
      weight: 0.7
    });
    const skill = nodeStore.upsertNode({
      type: "skill_ref",
      title: "Verification skill",
      summary: "Verification skill.",
      body: "Verification skill supports focused release checks.",
      source: "explicit",
      weight: 0.7
    });
    nodeStore.addEdge({
      fromNodeId: project.id,
      toNodeId: duplicate.id,
      relation: "depends_on",
      weight: 0.8,
      metadata: { source: "test" }
    });
    nodeStore.addEdge({
      fromNodeId: duplicate.id,
      toNodeId: skill.id,
      relation: "uses_skill",
      weight: 0.6,
      metadata: { source: "test" }
    });
    nodeStore.addEdge({
      fromNodeId: keep.id,
      toNodeId: skill.id,
      relation: "conflicts_with",
      weight: 0.2,
      metadata: { source: "stale-conflict" }
    });
    nodeStore.close();

    const dream = await runCli(["memory", "dream"], temp.env, workspace);
    expect(dream.exitCode).toBe(0);
    expect(dream.stdout).toContain("duplicate");

    const dreams = listDreams({ appRoot: paths.root });
    const manifest = showDream({ appRoot: paths.root, id: dreams[0].id });
    expect(manifest.operations).toContainEqual(
      expect.objectContaining({
        type: "duplicate",
        reason: expect.stringContaining(duplicate.id),
        relatedFiles: [`graph:${keep.id}`, `graph:${duplicate.id}`],
        graphNodeIds: [duplicate.id],
        graphMerge: {
          keepNodeId: keep.id,
          duplicateNodeId: duplicate.id
        }
      })
    );

    const applied = await runCli(["memory", "dream", "apply", dreams[0].id], temp.env, workspace);
    expect(applied.exitCode).toBe(0);
    expect(applied.stdout).toContain("Archived graph nodes: 1");
    expect(applied.stdout).toContain("Redirected graph edges: 2");
    expect(applied.stdout).toContain("Fused graph node weights: 1");
    expect(applied.stdout).toContain("Resolved graph edge conflicts: 1");
    const afterApply = MemoryNodeStore.open(paths);
    expect(afterApply.getNode(keep.id)?.status).toBe("active");
    expect(afterApply.getNode(keep.id)?.weight).toBeGreaterThan(keep.weight);
    expect(afterApply.getNode(duplicate.id)?.status).toBe("archived");
    expect(afterApply.getNode(duplicate.id)?.metadata).toMatchObject({
      archive: expect.objectContaining({
        mergedInto: keep.id,
        redirectedEdgeCount: 2,
        resolvedEdgeConflictCount: 1
      })
    });
    expect(showDream({ appRoot: paths.root, id: dreams[0].id })).toMatchObject({
      graphReview: expect.objectContaining({
        redirectedEdgeCount: 2,
        fusedWeightCount: 1,
        resolvedEdgeConflictCount: 1
      })
    });
    expect(afterApply.listConflicts()).toHaveLength(0);
    expect(
      afterApply.searchGraph({ query: "package publishing", limit: 5 }).map((hit) => hit.node.id)
    ).toContain(keep.id);
    afterApply.close();

    const mergeAudit = await runCli(["memory", "merges", "--limit", "5"], temp.env, workspace);
    expect(mergeAudit.exitCode).toBe(0);
    expect(mergeAudit.stdout).toContain("Memory graph merges: 1");
    expect(mergeAudit.stdout).toContain(
      "Focused release verification -> Focused release verification"
    );
    expect(mergeAudit.stdout).toContain("weight: 0.90 ->");
    expect(mergeAudit.stdout).toContain("redirected edges: 2");
    expect(mergeAudit.stdout).toContain("resolved edge conflicts: 1");
    expect(mergeAudit.stdout).toContain(dreams[0].id);
  });

  it("applies or rejects Dream graph cleanup through reviewable CLI actions", async () => {
    temp = makeTempRoot();
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-memory-"));
    const paths = getMagiPaths(temp.env);
    const firstStore = MemoryNodeStore.open(paths);
    const archiveCandidate = firstStore.upsertNode({
      type: "workflow",
      title: "Archive reviewed workflow",
      summary: "Archive reviewed workflow.",
      body: "Archive reviewed workflow should disappear from active graph recall.",
      source: "explicit",
      weight: 0.2
    });
    firstStore.close();
    const db = new Database(paths.sessionDbFile);
    db.prepare(
      "update memory_nodes set created_at = ?, updated_at = ?, last_used_at = null where id = ?"
    ).run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", archiveCandidate.id);
    db.close();

    const archiveDream = await runCli(["memory", "dream"], temp.env, workspace);
    expect(archiveDream.exitCode).toBe(0);
    const pendingDreams = listDreams({ appRoot: paths.root });
    const archiveDreamId = pendingDreams.find((dream) => dream.status === "pending")?.id;
    expect(archiveDreamId).toBeDefined();

    const applied = await runCli(
      ["memory", "dream", "apply", archiveDreamId!],
      temp.env,
      workspace
    );
    expect(applied.exitCode).toBe(0);
    expect(applied.stdout).toContain("Archived graph nodes: 1");
    const afterApply = MemoryNodeStore.open(paths);
    expect(afterApply.getNode(archiveCandidate.id)).toMatchObject({
      status: "archived",
      metadata: expect.objectContaining({
        archive: expect.objectContaining({ dreamId: archiveDreamId })
      })
    });
    afterApply.close();
    expect(showDream({ appRoot: paths.root, id: archiveDreamId! })).toMatchObject({
      status: "applied",
      graphReview: expect.objectContaining({
        decision: "archive",
        nodeIds: [archiveCandidate.id]
      })
    });

    const secondStore = MemoryNodeStore.open(paths);
    const keepCandidate = secondStore.upsertNode({
      type: "workflow",
      title: "Keep reviewed workflow",
      summary: "Keep reviewed workflow.",
      body: "Keep reviewed workflow should stay in active graph recall.",
      source: "explicit",
      weight: 0.2
    });
    secondStore.close();
    const keepDb = new Database(paths.sessionDbFile);
    keepDb
      .prepare(
        "update memory_nodes set created_at = ?, updated_at = ?, last_used_at = null where id = ?"
      )
      .run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", keepCandidate.id);
    keepDb.close();

    const keepDream = await runCli(["memory", "dream"], temp.env, workspace);
    expect(keepDream.exitCode).toBe(0);
    const keepDreamId = listDreams({ appRoot: paths.root }).find(
      (dream) => dream.status === "pending"
    )?.id;
    expect(keepDreamId).toBeDefined();

    const rejected = await runCli(["memory", "dream", "reject", keepDreamId!], temp.env, workspace);
    expect(rejected.exitCode).toBe(0);
    expect(rejected.stdout).toContain("Kept graph nodes: 1");
    const afterReject = MemoryNodeStore.open(paths);
    expect(afterReject.getNode(keepCandidate.id)).toMatchObject({
      status: "active",
      metadata: expect.objectContaining({
        cleanupReview: expect.objectContaining({
          decision: "kept",
          dreamId: keepDreamId
        })
      })
    });
    afterReject.close();
    expect(showDream({ appRoot: paths.root, id: keepDreamId! })).toMatchObject({
      status: "rejected",
      graphReview: expect.objectContaining({
        decision: "keep",
        nodeIds: [keepCandidate.id]
      })
    });
  });

  it("applies or rejects Dream graph conflict groups through reviewable CLI actions", async () => {
    temp = makeTempRoot();
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-memory-"));
    const paths = getMagiPaths(temp.env);
    const firstStore = MemoryNodeStore.open(paths);
    const current = firstStore.upsertNode({
      type: "preference",
      title: "Current verification preference",
      summary: "Current verification preference.",
      body: "User prefers concise verification summaries.",
      source: "explicit",
      weight: 0.95,
      metadata: { correctionFor: "old-output" }
    });
    const staleVerbose = firstStore.upsertNode({
      type: "preference",
      title: "Verbose verification preference",
      summary: "Verbose verification preference.",
      body: "User prefers verbose terminal dumps.",
      source: "explicit",
      weight: 0.35
    });
    const staleRawLogs = firstStore.upsertNode({
      type: "preference",
      title: "Raw log preference",
      summary: "Raw log preference.",
      body: "User prefers raw terminal logs after tests.",
      source: "explicit",
      weight: 0.3
    });
    firstStore.addEdge({
      fromNodeId: current.id,
      toNodeId: staleVerbose.id,
      relation: "conflicts_with",
      weight: 1,
      metadata: { reason: "User corrected verbose output." }
    });
    firstStore.addEdge({
      fromNodeId: staleVerbose.id,
      toNodeId: staleRawLogs.id,
      relation: "conflicts_with",
      weight: 0.8,
      metadata: { reason: "Both stale nodes describe verbose output." }
    });
    firstStore.close();

    const dream = await runCli(["memory", "dream"], temp.env, workspace);
    expect(dream.exitCode).toBe(0);
    expect(dream.stdout).toContain("conflict");

    const dreams = listDreams({ appRoot: paths.root });
    const manifest = showDream({ appRoot: paths.root, id: dreams[0].id });
    expect(manifest.operations).toContainEqual(
      expect.objectContaining({
        type: "conflict",
        reason: expect.stringContaining("Graph conflict group"),
        relatedFiles: expect.arrayContaining([
          `graph:${current.id}`,
          `graph:${staleVerbose.id}`,
          `graph:${staleRawLogs.id}`
        ]),
        graphNodeIds: expect.arrayContaining([staleVerbose.id, staleRawLogs.id]),
        graphConflictGroup: expect.objectContaining({
          preferredNodeId: current.id,
          nodeIds: expect.arrayContaining([current.id, staleVerbose.id, staleRawLogs.id])
        })
      })
    );

    const rejected = await runCli(["memory", "dream", "reject", dreams[0].id], temp.env, workspace);
    expect(rejected.exitCode).toBe(0);
    expect(rejected.stdout).toContain("Kept graph nodes: 2");
    const afterReject = MemoryNodeStore.open(paths);
    expect(afterReject.getNode(staleVerbose.id)?.status).toBe("active");
    expect(afterReject.getNode(staleRawLogs.id)?.status).toBe("active");
    afterReject.close();

    const secondDream = await runCli(["memory", "dream"], temp.env, workspace);
    expect(secondDream.exitCode).toBe(0);
    expect(secondDream.stdout).toContain("conflict");
    const secondDreamId = listDreams({ appRoot: paths.root }).find(
      (item) => item.status === "pending"
    )?.id;
    expect(secondDreamId).toBeTruthy();

    const applied = await runCli(["memory", "dream", "apply", secondDreamId!], temp.env, workspace);
    expect(applied.exitCode).toBe(0);
    expect(applied.stdout).toContain("Archived graph nodes: 2");
    const afterApply = MemoryNodeStore.open(paths);
    expect(afterApply.getNode(current.id)?.status).toBe("active");
    expect(afterApply.getNode(staleVerbose.id)?.status).toBe("archived");
    expect(afterApply.getNode(staleRawLogs.id)?.status).toBe("archived");
    expect(afterApply.getNode(staleVerbose.id)?.metadata).toMatchObject({
      archive: expect.objectContaining({
        dreamId: secondDreamId
      })
    });
    afterApply.close();
  });

  it("rejects memory drafts that look like secrets", async () => {
    temp = makeTempRoot();
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-memory-"));

    const result = await runCli(
      ["memory", "append", "project", "api_key: sk-abc123456789012345"],
      temp.env,
      workspace
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Memory Draft rejected");
  });

  it("retrieves wiki, legacy, and memdir memory through one ranked path", () => {
    temp = makeTempRoot();
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-memory-"));
    const paths = getMagiPaths(temp.env);

    appendMemoryFile({
      appRoot: paths.root,
      filePath: "projects/default.md",
      content: "api wiki fact: use explicit routes"
    });
    appendMemory({
      paths,
      scope: "session",
      cwd: workspace,
      sessionId: "s-1",
      text: "api legacy fact: event streaming"
    });
    writeMemdirEntry({
      paths,
      type: "project",
      name: "API reference",
      description: "api memdir fact",
      body: "routing reference"
    });

    const hits = retrieveRelevantMemory({
      appRoot: paths.root,
      query: "api routes streaming",
      maxResults: 6,
      legacy: {
        paths,
        cwd: workspace,
        sessionId: "s-1",
        scopes: ["session"]
      },
      audit: false
    });

    expect(hits.map((hit) => hit.source)).toEqual(expect.arrayContaining(["graph", "legacy"]));
    expect(hits.map((hit) => hit.sourceKind)).toEqual(expect.arrayContaining(["wiki", "memdir"]));
    expect(hits.map((hit) => hit.file)).toEqual(
      expect.arrayContaining(["projects/default.md#Project: Default", "legacy/session"])
    );
  });

  it("retrieves wiki-backed graph memory and reinforces matched nodes", () => {
    temp = makeTempRoot();
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-memory-"));
    const paths = getMagiPaths(temp.env);

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

    const hits = retrieveRelevantMemory({
      appRoot: paths.root,
      query: "focused broad checks",
      maxResults: 4,
      legacy: {
        paths,
        cwd: workspace,
        sessionId: "s-1",
        scopes: ["session"]
      },
      audit: false
    });

    const graphHit = hits.find((hit) => hit.source === "graph" && hit.title === "Verify release");
    expect(graphHit).toBeDefined();
    expect(graphHit?.file).toBe("workflows/release.md#Verify release");
    expect(graphHit?.nodeId).toBeDefined();

    const store = MemoryNodeStore.open(paths);
    try {
      const node = store.getNode(graphHit!.nodeId!);
      expect(node?.useCount).toBe(1);
      expect(node?.metadata).toMatchObject({
        sourceKind: "wiki",
        filePath: "workflows/release.md",
        heading: "Verify release"
      });
    } finally {
      store.close();
    }
  });

  it("retrieves graph-neighbor memory through the normal memory search path", () => {
    temp = makeTempRoot();
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-memory-"));
    const paths = getMagiPaths(temp.env);
    appendMemoryFile({
      appRoot: paths.root,
      filePath: "projects/magi.md",
      content: [
        "## Graph memory",
        "Magi stores durable facts as weighted graph memory.",
        "",
        "## Verification workflow",
        "Run focused business checks before broad checks."
      ].join("\n")
    });
    syncMemoryGraph({ appRoot: paths.root, paths });

    const store = MemoryNodeStore.open(paths);
    let edgeId = 0;
    try {
      const source = store.getSourceByUri("memory/projects/magi.md");
      expect(source).toBeDefined();
      const chunks = store.listChunksForSource(source!.id);
      const project = chunks.find((chunk) => chunk.heading === "Graph memory");
      const workflow = chunks.find((chunk) => chunk.heading === "Verification workflow");
      expect(project).toBeDefined();
      expect(workflow).toBeDefined();
      edgeId = store.addEdge({
        fromNodeId: project!.nodeId,
        toNodeId: workflow!.nodeId,
        relation: "relates_to",
        weight: 0.9
      }).id;
    } finally {
      store.close();
    }

    const hits = retrieveRelevantMemory({
      appRoot: paths.root,
      query: "durable weighted graph",
      maxResults: 5,
      legacy: {
        paths,
        cwd: workspace,
        sessionId: "s-1",
        scopes: ["session"]
      },
      audit: false
    });

    expect(hits.map((hit) => hit.title)).toEqual(
      expect.arrayContaining(["Graph memory", "Verification workflow"])
    );

    const reinforcedStore = MemoryNodeStore.open(paths);
    try {
      const edge = reinforcedStore.getEdge(edgeId);
      expect(edge?.useCount).toBe(1);
      expect(edge?.lastUsedAt).toBeDefined();
      expect(edge?.weight).toBeCloseTo(0.92);
      const neighborHit = hits.find((hit) => hit.title === "Verification workflow");
      expect(neighborHit?.viaEdgeIds).toEqual([edgeId]);
    } finally {
      reinforcedStore.close();
    }
  });

  it("runs memory recall quality evals from CLI case files", async () => {
    temp = makeTempRoot();
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-memory-"));
    const paths = getMagiPaths(temp.env);
    appendMemoryFile({
      appRoot: paths.root,
      filePath: "projects/magi.md",
      content: [
        "## Graph memory",
        "Magi stores durable facts as weighted graph memory.",
        "",
        "## Verification workflow",
        "Run focused business checks before broad checks."
      ].join("\n")
    });
    syncMemoryGraph({ appRoot: paths.root, paths });
    const store = MemoryNodeStore.open(paths);
    try {
      const source = store.getSourceByUri("memory/projects/magi.md");
      const chunks = store.listChunksForSource(source!.id);
      const project = chunks.find((chunk) => chunk.heading === "Graph memory");
      const workflow = chunks.find((chunk) => chunk.heading === "Verification workflow");
      store.addEdge({
        fromNodeId: project!.nodeId,
        toNodeId: workflow!.nodeId,
        relation: "relates_to",
        weight: 0.9
      });
    } finally {
      store.close();
    }
    const caseFile = path.join(workspace, "memory-eval.json");
    writeFileSync(
      caseFile,
      JSON.stringify(
        {
          name: "memory graph recall",
          cases: [
            {
              name: "linked workflow recall",
              query: "durable weighted graph",
              expect: ["Graph memory", "Verification workflow"],
              forbid: ["verbose terminal dumps"],
              minResults: 2
            }
          ]
        },
        null,
        2
      )
    );

    const reportFile = path.join(workspace, "memory-eval-report.json");
    const passed = await runCli(
      [
        "memory",
        "eval",
        "--case-file",
        caseFile,
        "--max-results",
        "5",
        "--min-score",
        "1",
        "--report",
        reportFile
      ],
      temp.env,
      workspace
    );
    expect(passed.exitCode).toBe(0);
    expect(passed.stdout).toContain("Memory recall eval: memory graph recall");
    expect(passed.stdout).toContain("1. PASS linked workflow recall");
    expect(passed.stdout).toContain("score: 1.00");
    expect(passed.stdout).toContain(`Report: ${reportFile}`);
    expect(JSON.parse(readFileSync(reportFile, "utf8"))).toMatchObject({
      version: 1,
      name: "memory graph recall",
      total: 1,
      passed: 1,
      failed: 0,
      score: 1,
      minScore: 1,
      thresholdPassed: true,
      results: [
        expect.objectContaining({
          name: "linked workflow recall",
          passed: true,
          expectedMatched: ["Graph memory", "Verification workflow"],
          forbiddenFound: []
        })
      ]
    });

    writeFileSync(
      caseFile,
      JSON.stringify(
        {
          cases: [
            {
              name: "missing memory",
              query: "durable weighted graph",
              expect: ["nonexistent recall marker"]
            }
          ]
        },
        null,
        2
      )
    );
    const failed = await runCli(["memory", "eval", "--case-file", caseFile], temp.env, workspace);
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout).toContain("1. FAIL missing memory");
    expect(failed.stdout).toContain("expected missing: nonexistent recall marker");

    writeFileSync(
      caseFile,
      JSON.stringify(
        {
          cases: [
            {
              name: "empty exploratory recall threshold",
              query: "qzxv-unmatched-recall-token"
            }
          ]
        },
        null,
        2
      )
    );
    const thresholdFailed = await runCli(
      ["memory", "eval", "--case-file", caseFile, "--min-score", "0.75"],
      temp.env,
      workspace
    );
    expect(thresholdFailed.exitCode).toBe(1);
    expect(thresholdFailed.stdout).toContain("1. PASS empty exploratory recall threshold");
    expect(thresholdFailed.stdout).toContain("score: 0.00");
    expect(thresholdFailed.stdout).toContain("min score: 0.75");
    expect(thresholdFailed.stdout).toContain("threshold: FAIL");
  });

  it("links graph memory nodes through the CLI and retrieves the linked neighbor", async () => {
    temp = makeTempRoot();
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-memory-"));
    const paths = getMagiPaths(temp.env);
    appendMemoryFile({
      appRoot: paths.root,
      filePath: "projects/magi.md",
      content: [
        "## Graph CLI anchor",
        "Magi CLI exposes durable graph memory linking.",
        "",
        "## Linked workflow neighbor",
        "Run business-level verification after graph memory changes."
      ].join("\n")
    });

    const linked = await runCli(
      [
        "memory",
        "link",
        "--from",
        "Graph CLI anchor",
        "--to",
        "Linked workflow neighbor",
        "--relation",
        "relates_to",
        "--weight",
        "0.9"
      ],
      temp.env,
      workspace
    );
    expect(linked.exitCode).toBe(0);
    expect(linked.stdout).toContain("Linked Memory nodes:");
    expect(linked.stdout).toContain("relates_to -> Linked workflow neighbor");

    const search = await runCli(
      ["memory", "search", "durable graph memory linking"],
      temp.env,
      workspace
    );
    expect(search.exitCode).toBe(0);
    expect(search.stdout).toContain("Graph CLI anchor");
    expect(search.stdout).toContain("Linked workflow neighbor");
  });

  it("corrects graph memory through the CLI and stops returning the disputed node", async () => {
    temp = makeTempRoot();
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-memory-"));
    const paths = getMagiPaths(temp.env);
    const nodeStore = MemoryNodeStore.open(paths);
    const wrong = nodeStore.upsertNode({
      type: "user_profile",
      title: "User role",
      summary: "Incorrect role.",
      body: "The user is only a documentation reviewer.",
      source: "explicit",
      weight: 0.95
    });
    nodeStore.close();

    const corrected = await runCli(
      [
        "memory",
        "correct",
        "--target",
        wrong.id,
        "--reason",
        "User corrected the stale profile.",
        "--replacement",
        "The user is the creator of Magi.",
        "--replacement-summary",
        "Correct user role.",
        "--type",
        "user_profile"
      ],
      temp.env,
      workspace
    );
    expect(corrected.exitCode).toBe(0);
    expect(corrected.stdout).toContain("Corrected Memory node:");
    expect(corrected.stdout).toContain("replacement:");

    const search = await runCli(
      ["memory", "search", "documentation reviewer"],
      temp.env,
      workspace
    );
    expect(search.exitCode).toBe(0);
    expect(search.stdout).toContain("creator of Magi");
    expect(search.stdout).not.toContain("only a documentation reviewer");

    const conflicts = await runCli(["memory", "conflicts"], temp.env, workspace);
    expect(conflicts.exitCode).toBe(0);
    expect(conflicts.stdout).toContain("Memory graph conflicts: 1");
    expect(conflicts.stdout).toContain("User role");
    expect(conflicts.stdout).toContain("recommendation: prefer_from");
    expect(conflicts.stdout).toContain("is active while");

    const audit = readFileSync(path.join(paths.root, "memory", "logs", "audit.jsonl"), "utf8");
    expect(audit).toContain("memory.corrected");
    expect(audit).toContain(wrong.id);
  });

  it("applies user memory feedback through the CLI and records trend evidence", async () => {
    temp = makeTempRoot();
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-memory-"));
    const paths = getMagiPaths(temp.env);
    const nodeStore = MemoryNodeStore.open(paths);
    const useful = nodeStore.upsertNode({
      type: "workflow",
      title: "Focused verification workflow",
      summary: "Focused verification workflow.",
      body: "Run focused checks before broad verification.",
      source: "explicit",
      weight: 0.6
    });
    const stale = nodeStore.upsertNode({
      type: "user_profile",
      title: "Stale user role",
      summary: "Stale user role.",
      body: "The user is only a temporary reviewer.",
      source: "explicit",
      weight: 0.95
    });
    nodeStore.close();

    const helpful = await runCli(
      [
        "memory",
        "feedback",
        "--target",
        useful.id,
        "--signal",
        "useful",
        "--reason",
        "This workflow matched the task."
      ],
      temp.env,
      workspace
    );
    expect(helpful.exitCode).toBe(0);
    expect(helpful.stdout).toContain("Memory feedback applied:");
    expect(helpful.stdout).toContain("signal: useful");
    expect(helpful.stdout).toContain("weight: 0.60 -> 0.68");

    const trends = await runCli(
      ["memory", "feedback", "trends", "--limit", "3"],
      temp.env,
      workspace
    );
    expect(trends.exitCode).toBe(0);
    expect(trends.stdout).toContain("Memory feedback trends: 1");
    expect(trends.stdout).toContain("Focused verification workflow");
    expect(trends.stdout).toContain("useful=1 irrelevant=0 net=1");
    expect(trends.stdout).toContain("This workflow matched the task.");

    const wrong = await runCli(
      [
        "memory",
        "feedback",
        "--target",
        stale.id,
        "--signal",
        "wrong",
        "--reason",
        "User corrected stale role feedback.",
        "--replacement",
        "The user is the creator of Magi.",
        "--replacement-summary",
        "Correct user role.",
        "--type",
        "user_profile"
      ],
      temp.env,
      workspace
    );
    expect(wrong.exitCode).toBe(0);
    expect(wrong.stdout).toContain("signal: wrong");
    expect(wrong.stdout).toContain("replacement:");

    const store = MemoryNodeStore.open(paths);
    try {
      const boosted = store.getNode(useful.id);
      expect(boosted?.weight).toBeCloseTo(0.68);
      expect(boosted?.metadata.feedbackTrend).toMatchObject({
        useful: 1,
        lastSignal: "useful"
      });
      expect(store.getNode(stale.id)?.status).toBe("disputed");
    } finally {
      store.close();
    }

    const search = await runCli(["memory", "search", "temporary reviewer"], temp.env, workspace);
    expect(search.exitCode).toBe(0);
    expect(search.stdout).toContain("creator of Magi");
    expect(search.stdout).not.toContain("only a temporary reviewer");

    const audit = readFileSync(path.join(paths.root, "memory", "logs", "audit.jsonl"), "utf8");
    expect(audit).toContain("memory.feedback.applied");
    expect(audit).toContain("useful");
    expect(audit).toContain("wrong");
  });

  it("previews and applies memory maintenance decay through the CLI", async () => {
    temp = makeTempRoot();
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-memory-"));
    const paths = getMagiPaths(temp.env);
    const nodeStore = MemoryNodeStore.open(paths);
    const stale = nodeStore.upsertNode({
      type: "preference",
      title: "Old output preference",
      summary: "Old output preference.",
      body: "User previously preferred long verification logs.",
      source: "explicit",
      weight: 0.9
    });
    nodeStore.close();

    const preview = await runCli(
      ["memory", "maintain", "--older-than-days", "0", "--decay", "0.2", "--min-weight", "0.4"],
      temp.env,
      workspace
    );
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toContain("Memory maintenance preview");
    expect(preview.stdout).toContain("Old output preference");

    const afterPreview = MemoryNodeStore.open(paths);
    expect(afterPreview.getNode(stale.id)?.weight).toBe(0.9);
    afterPreview.close();

    const applied = await runCli(
      [
        "memory",
        "maintain",
        "--apply",
        "--older-than-days",
        "0",
        "--decay",
        "0.2",
        "--min-weight",
        "0.4"
      ],
      temp.env,
      workspace
    );
    expect(applied.exitCode).toBe(0);
    expect(applied.stdout).toContain("Memory maintenance applied");
    expect(applied.stdout).toContain("0.900 -> 0.720");

    const afterApply = MemoryNodeStore.open(paths);
    expect(afterApply.getNode(stale.id)?.weight).toBeCloseTo(0.72);
    afterApply.close();
    const audit = readFileSync(path.join(paths.root, "memory", "logs", "audit.jsonl"), "utf8");
    expect(audit).toContain("memory.maintenance.previewed");
    expect(audit).toContain("memory.maintenance.applied");
  });

  it("persists memory maintenance policy and uses it by default", async () => {
    temp = makeTempRoot();
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-memory-"));
    const paths = getMagiPaths(temp.env);
    const nodeStore = MemoryNodeStore.open(paths);
    const stale = nodeStore.upsertNode({
      type: "workflow",
      title: "Old workflow habit",
      summary: "Old workflow habit.",
      body: "Run obsolete broad checks before focused checks.",
      source: "explicit",
      weight: 0.8
    });
    nodeStore.close();

    const configured = await runCli(
      [
        "memory",
        "maintain",
        "config",
        "--older-than-days",
        "0",
        "--decay",
        "0.25",
        "--min-weight",
        "0.3",
        "--limit",
        "7"
      ],
      temp.env,
      workspace
    );
    expect(configured.exitCode).toBe(0);
    expect(configured.stdout).toContain("Memory maintenance policy");
    expect(configured.stdout).toContain("olderThanDays: 0");
    expect(configured.stdout).toContain("decay: 0.250");
    expect(configured.stdout).toContain("changed: yes");

    const shown = await runCli(["memory", "maintain", "config"], temp.env, workspace);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain("minWeight: 0.300");
    expect(shown.stdout).toContain("limit: 7");

    const applied = await runCli(["memory", "maintain", "--apply"], temp.env, workspace);
    expect(applied.exitCode).toBe(0);
    expect(applied.stdout).toContain("olderThanDays: 0");
    expect(applied.stdout).toContain("decay: 0.250");
    expect(applied.stdout).toContain("0.800 -> 0.700");
    expect(applied.stdout).toContain("effectiveDecay=0.125");

    const afterApply = MemoryNodeStore.open(paths);
    expect(afterApply.getNode(stale.id)?.weight).toBeCloseTo(0.7);
    afterApply.close();
    const audit = readFileSync(path.join(paths.root, "memory", "logs", "audit.jsonl"), "utf8");
    expect(audit).toContain("memory.maintenance.configured");
    expect(audit).toContain("memory.maintenance.applied");
  });

  it("searches layered memory with session and project relevance", () => {
    temp = makeTempRoot();
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-memory-"));
    const paths = getMagiPaths(temp.env);

    appendMemory({ paths, scope: "user", cwd: workspace, text: "theme: quiet interface" });
    appendMemory({ paths, scope: "project", cwd: workspace, text: "api style: explicit routes" });
    appendMemory({
      paths,
      scope: "session",
      cwd: workspace,
      sessionId: "s-1",
      text: "api current task: event streaming"
    });

    const results = searchMemory({
      paths,
      cwd: workspace,
      sessionId: "s-1",
      query: "api event streaming"
    });
    expect(results.map((result) => result.scope)).toEqual(["session", "project"]);
    expect(formatMemorySearchResults(results)).toContain("session: api current task");
  });

  it("detects duplicate and conflicting memory entries", () => {
    temp = makeTempRoot();
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-memory-"));
    const paths = getMagiPaths(temp.env);
    const first = appendMemory({
      paths,
      scope: "project",
      cwd: workspace,
      text: "model: gpt-main",
      detailed: true
    });
    const duplicate = appendMemory({
      paths,
      scope: "project",
      cwd: workspace,
      text: "model: gpt-main",
      detailed: true
    });
    const conflict = appendMemory({
      paths,
      scope: "project",
      cwd: workspace,
      text: "model: gpt-other",
      detailed: true
    });

    expect(first.appended).toBe(true);
    expect(duplicate).toMatchObject({ appended: false, duplicate: true });
    expect(conflict.appended).toBe(false);
    expect(conflict.conflicts[0]).toMatchObject({
      key: "model",
      existing: expect.objectContaining({ value: "gpt-main" }),
      incoming: expect.objectContaining({ value: "gpt-other" })
    });
    expect(readMemory({ paths, scope: "project", cwd: workspace }).match(/model:/g)).toHaveLength(
      1
    );
  });

  it("parses explicit memory write prompts only", () => {
    expect(extractExplicitMemoryWrite("remember project: api style: explicit routes")).toEqual({
      scope: "project",
      text: "api style: explicit routes"
    });
    expect(extractExplicitMemoryWrite("记住用户记忆：theme: quiet interface")).toEqual({
      scope: "user",
      text: "theme: quiet interface"
    });
    expect(extractExplicitMemoryWrite("那你记得哈，我是edward 你的创造者")).toBeUndefined();
    expect(extractExplicitMemoryWrite("the project uses explicit routes")).toBeUndefined();
  });
});
