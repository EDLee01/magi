import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

import { MagiPaths } from "./paths.js";

export type MemoryNodeType =
  | "user_profile"
  | "preference"
  | "work_habit"
  | "workflow"
  | "project"
  | "decision"
  | "problem"
  | "reference"
  | "skill_ref"
  | "session";
export type MemoryNodeStatus = "active" | "disputed" | "archived";
export type MemorySourceKind = "wiki" | "memdir" | "legacy" | "explicit" | "tool";
export type MemorySourceStatus = "active" | "archived";
export type MemoryEdgeRelation =
  | "relates_to"
  | "belongs_to"
  | "depends_on"
  | "supersedes"
  | "conflicts_with"
  | "derived_from"
  | "uses_skill";

export interface MemoryNode {
  id: string;
  type: MemoryNodeType;
  title: string;
  summary: string;
  body: string;
  weight: number;
  status: MemoryNodeStatus;
  source: string;
  sourceSessionId?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  useCount: number;
  metadata: Record<string, unknown>;
}

export interface UpsertMemoryNodeInput {
  type: MemoryNodeType;
  title?: string;
  summary?: string;
  body: string;
  weight?: number;
  source: string;
  sourceSessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface ListHotMemoryNodesInput {
  limit?: number;
  minWeight?: number;
}

export interface CorrectMemoryNodeInput {
  nodeId: string;
  reason: string;
  replacement?: {
    type?: MemoryNodeType;
    title?: string;
    summary?: string;
    body: string;
    weight?: number;
    source?: string;
    sourceSessionId?: string;
    metadata?: Record<string, unknown>;
  };
  metadata?: Record<string, unknown>;
}

export interface CorrectMemoryNodeResult {
  disputed: MemoryNode;
  replacement?: MemoryNode;
  edges: MemoryEdge[];
}

export interface DecayUnusedMemoryInput {
  olderThanDays?: number;
  decay?: number;
  minWeight?: number;
  now?: Date;
  apply?: boolean;
  limit?: number;
}

export interface DecayedMemoryNode {
  node: MemoryNode;
  previousWeight: number;
  nextWeight: number;
  effectiveDecay: number;
  ageDays: number;
}

export interface MemoryCleanupCandidate {
  node: MemoryNode;
  ageDays: number;
  reason: string;
}

export interface MemoryDuplicateCandidate {
  keep: MemoryNode;
  duplicate: MemoryNode;
  reason: string;
}

export interface MergeDuplicateMemoryNodeInput {
  keepId: string;
  duplicateId: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface MergeDuplicateMemoryNodeResult {
  keep: MemoryNode;
  duplicate: MemoryNode;
  redirectedEdges: MemoryEdge[];
  archived: MemoryNode[];
  previousKeepWeight: number;
  nextKeepWeight: number;
  resolvedEdgeConflictCount: number;
}

export interface MemoryMergeRecord {
  keep: MemoryNode;
  duplicate: MemoryNode;
  mergedAt: string;
  reason: string;
  previousWeight?: number;
  nextWeight?: number;
  duplicateWeight?: number;
  duplicateUseCount?: number;
  redirectedEdgeCount: number;
  resolvedEdgeConflictCount: number;
  dreamId?: string;
}

export interface ArchiveMemoryNodesInput {
  ids: string[];
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface KeepMemoryNodesInput {
  ids: string[];
  reason?: string;
  metadata?: Record<string, unknown>;
}

export type MemoryFeedbackSignal = "useful" | "irrelevant" | "wrong" | "stale";

export interface ApplyMemoryFeedbackInput {
  nodeId: string;
  signal: MemoryFeedbackSignal;
  reason?: string;
  replacement?: {
    type?: MemoryNodeType;
    title?: string;
    summary?: string;
    body: string;
    weight?: number;
    source?: string;
    sourceSessionId?: string;
    metadata?: Record<string, unknown>;
  };
  metadata?: Record<string, unknown>;
}

export interface ApplyMemoryFeedbackResult {
  node: MemoryNode;
  previousWeight: number;
  nextWeight: number;
  signal: MemoryFeedbackSignal;
  replacement?: MemoryNode;
  edges: MemoryEdge[];
}

export interface MemoryFeedbackTrend {
  node: MemoryNode;
  useful: number;
  irrelevant: number;
  net: number;
  lastSignal?: string;
  lastReason?: string;
  lastFeedbackAt?: string;
}

export interface DecayUnusedMemoryResult {
  applied: boolean;
  olderThanDays: number;
  decay: number;
  minWeight: number;
  changed: DecayedMemoryNode[];
}

export interface MemoryEdge {
  id: number;
  fromNodeId: string;
  toNodeId: string;
  relation: MemoryEdgeRelation;
  weight: number;
  createdAt: string;
  lastUsedAt?: string;
  useCount: number;
  metadata: Record<string, unknown>;
}

export interface MemoryConflictRecord {
  edge: MemoryEdge;
  from: MemoryNode;
  to: MemoryNode;
  recommendation: "prefer_from" | "prefer_to" | "needs_review";
  reason: string;
}

export interface MemoryConflictGroup {
  id: string;
  nodes: MemoryNode[];
  conflicts: MemoryConflictRecord[];
  recommendation: "prefer_node" | "needs_review";
  preferredNodeId?: string;
  reason: string;
}

export interface MemorySource {
  id: string;
  kind: MemorySourceKind;
  uri: string;
  title: string;
  contentHash: string;
  status: MemorySourceStatus;
  indexedAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface MemoryChunk {
  id: string;
  sourceId: string;
  nodeId: string;
  uri: string;
  heading: string;
  body: string;
  summary: string;
  contentHash: string;
  orderIndex: number;
  status: MemorySourceStatus;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface UpsertMemorySourceInput {
  kind: MemorySourceKind;
  uri: string;
  title: string;
  contentHash: string;
  metadata?: Record<string, unknown>;
}

export interface UpsertMemoryChunkInput {
  sourceId: string;
  uri: string;
  type: MemoryNodeType;
  heading: string;
  body: string;
  summary?: string;
  contentHash?: string;
  orderIndex?: number;
  weight?: number;
  metadata?: Record<string, unknown>;
}

export interface SearchMemoryGraphInput {
  query: string;
  limit?: number;
  minScore?: number;
  maxGraphDistance?: number;
}

export interface MemoryGraphSearchHit {
  node: MemoryNode;
  source: MemorySource;
  chunk: MemoryChunk;
  score: number;
  graphDistance?: number;
  viaNodeIds?: string[];
  viaEdgeIds?: number[];
}

export function classifyMemoryNodeType(
  text: string,
  input: { scope?: "project" | "user" | "session" } = {}
): MemoryNodeType {
  if (input.scope === "project") return "project";
  if (input.scope === "session") return "session";

  const normalized = normalizeClassifierText(text);
  if (!normalized) return "user_profile";

  if (
    hasAny(normalized, [
      "workflow",
      "process",
      "procedure",
      "runbook",
      "checklist",
      "playbook",
      "工作流",
      "流程",
      "步骤",
      "sop"
    ])
  ) {
    return "workflow";
  }

  if (
    hasAny(normalized, [
      "work habit",
      "habit",
      "usually",
      "normally",
      "routine",
      "工作习惯",
      "习惯",
      "通常",
      "一般"
    ]) ||
    (hasAny(normalized, ["before", "after", "first", "then", "prioritize", "先", "再", "优先"]) &&
      hasAny(normalized, [
        "check",
        "test",
        "verify",
        "verification",
        "build",
        "review",
        "验证",
        "测试",
        "检查"
      ]))
  ) {
    return "work_habit";
  }

  if (
    hasAny(normalized, [
      "i am",
      "i'm",
      "my name is",
      "call me",
      "my role is",
      "身份",
      "我是",
      "我叫",
      "我的名字",
      "称呼我"
    ])
  ) {
    return "user_profile";
  }

  if (hasAny(normalized, ["skill", "skill.md", "技能"])) {
    return "skill_ref";
  }

  if (
    hasAny(normalized, [
      "http://",
      "https://",
      "docs",
      "documentation",
      "link",
      "url",
      "文档",
      "链接",
      "参考"
    ]) ||
    /\breferences?\b/.test(normalized)
  ) {
    return "reference";
  }

  if (
    input.scope !== "user" &&
    hasAny(normalized, [
      "project",
      "repo",
      "repository",
      "codebase",
      "magi",
      "项目",
      "仓库",
      "代码库"
    ])
  ) {
    return "project";
  }

  if (
    hasAny(normalized, [
      "decision",
      "decided",
      "we chose",
      "architecture",
      "technical direction",
      "决定",
      "决策",
      "技术路线",
      "架构"
    ])
  ) {
    return "decision";
  }

  if (
    hasAny(normalized, [
      "problem",
      "issue",
      "bug",
      "error",
      "failure",
      "failed",
      "broken",
      "risk",
      "问题",
      "错误",
      "失败",
      "异常",
      "风险"
    ])
  ) {
    return "problem";
  }

  if (
    hasAny(normalized, [
      "prefer",
      "preference",
      "likes",
      "dislikes",
      "wants",
      "default",
      "style",
      "tone",
      "language",
      "偏好",
      "喜欢",
      "不喜欢",
      "默认",
      "风格",
      "语气",
      "语言",
      "简洁"
    ])
  ) {
    return "preference";
  }

  return "user_profile";
}

export class MemoryNodeStore {
  private readonly db: Database.Database;

  constructor(dbFile: string) {
    mkdirSync(path.dirname(dbFile), { recursive: true });
    this.db = new Database(dbFile);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  static open(paths: MagiPaths): MemoryNodeStore {
    return new MemoryNodeStore(paths.sessionDbFile);
  }

  close(): void {
    this.db.close();
  }

  upsertNode(input: UpsertMemoryNodeInput): MemoryNode {
    const body = normalizeWhitespace(input.body);
    if (!body) {
      throw new Error("Memory node body must not be empty");
    }
    const now = nowIso();
    const existing = this.findDuplicate(input.type, body);
    if (existing) {
      const weight = Math.max(existing.weight, input.weight ?? existing.weight);
      this.db
        .prepare(
          `
        update memory_nodes
        set title = ?, summary = ?, body = ?, weight = ?, status = 'active', source = ?,
            source_session_id = ?, updated_at = ?, metadata_json = ?
        where id = ?
      `
        )
        .run(
          input.title?.trim() || existing.title,
          input.summary?.trim() || existing.summary,
          body,
          weight,
          input.source,
          input.sourceSessionId ?? existing.sourceSessionId ?? null,
          now,
          encodeJson({ ...existing.metadata, ...(input.metadata ?? {}) }),
          existing.id
        );
      return this.getNode(existing.id)!;
    }

    const id = randomUUID();
    this.db
      .prepare(
        `
      insert into memory_nodes
        (id, type, title, summary, body, weight, status, source, source_session_id,
         created_at, updated_at, last_used_at, use_count, metadata_json)
      values (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, null, 0, ?)
    `
      )
      .run(
        id,
        input.type,
        input.title?.trim() || defaultTitle(input.type, body),
        input.summary?.trim() || defaultSummary(body),
        body,
        input.weight ?? defaultWeight(input.source),
        input.source,
        input.sourceSessionId ?? null,
        now,
        now,
        encodeJson(input.metadata)
      );
    return this.getNode(id)!;
  }

  upsertSource(input: UpsertMemorySourceInput): MemorySource {
    const uri = input.uri.trim();
    const title = input.title.trim() || uri;
    if (!uri) {
      throw new Error("Memory source uri must not be empty");
    }
    const now = nowIso();
    const existing = this.getSourceByUri(uri);
    if (existing) {
      this.db
        .prepare(
          `
        update memory_sources
        set kind = ?, title = ?, content_hash = ?, status = 'active',
            indexed_at = ?, updated_at = ?, metadata_json = ?
        where id = ?
      `
        )
        .run(
          input.kind,
          title,
          input.contentHash,
          now,
          now,
          encodeJson({ ...existing.metadata, ...(input.metadata ?? {}) }),
          existing.id
        );
      return this.getSource(existing.id)!;
    }

    const id = randomUUID();
    this.db
      .prepare(
        `
      insert into memory_sources
        (id, kind, uri, title, content_hash, status, indexed_at, updated_at, metadata_json)
      values (?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `
      )
      .run(id, input.kind, uri, title, input.contentHash, now, now, encodeJson(input.metadata));
    return this.getSource(id)!;
  }

  getSource(id: string): MemorySource | undefined {
    const row = this.db.prepare("select * from memory_sources where id = ?").get(id) as
      | DbMemorySource
      | undefined;
    return row ? toMemorySource(row) : undefined;
  }

  getSourceByUri(uri: string): MemorySource | undefined {
    const row = this.db.prepare("select * from memory_sources where uri = ?").get(uri) as
      | DbMemorySource
      | undefined;
    return row ? toMemorySource(row) : undefined;
  }

  upsertChunk(input: UpsertMemoryChunkInput): MemoryChunk {
    const body = normalizeWhitespace(input.body);
    if (!body) {
      throw new Error("Memory chunk body must not be empty");
    }
    const source = this.getSource(input.sourceId);
    if (!source) {
      throw new Error(`Memory source not found: ${input.sourceId}`);
    }
    const heading = input.heading.trim() || source.title;
    const now = nowIso();
    const contentHash = input.contentHash ?? hashText(body);
    const uri = input.uri.trim() || `${source.uri}#${heading}`;
    const existing = this.getChunkByUri(uri);
    if (existing) {
      const node = this.getNode(existing.nodeId);
      const weight = node?.weight ?? input.weight ?? defaultWeight(source.kind);
      const nodeStatus =
        node?.status === "archived" && node.metadata.archive
          ? "archived"
          : (node?.status ?? "active");
      const chunkStatus = nodeStatus === "archived" ? "archived" : "active";
      this.db
        .prepare(
          `
        update memory_nodes
        set type = ?, title = ?, summary = ?, body = ?, weight = ?, status = ?,
            source = ?, updated_at = ?, metadata_json = ?
        where id = ?
      `
        )
        .run(
          input.type,
          heading,
          input.summary?.trim() || defaultSummary(body),
          body,
          weight,
          nodeStatus,
          source.kind,
          now,
          encodeJson({
            ...(node?.metadata ?? {}),
            sourceKind: source.kind,
            sourceUri: source.uri,
            sourceId: source.id,
            ...(input.metadata ?? {})
          }),
          existing.nodeId
        );
      this.db
        .prepare(
          `
        update memory_chunks
        set uri = ?, heading = ?, body = ?, summary = ?, content_hash = ?, order_index = ?,
            status = ?, updated_at = ?, metadata_json = ?
        where id = ?
      `
        )
        .run(
          uri,
          heading,
          body,
          input.summary?.trim() || defaultSummary(body),
          contentHash,
          input.orderIndex ?? existing.orderIndex,
          chunkStatus,
          now,
          encodeJson({ ...existing.metadata, ...(input.metadata ?? {}) }),
          existing.id
        );
      return this.getChunk(existing.id)!;
    }

    const node = this.upsertNode({
      type: input.type,
      title: heading,
      summary: input.summary?.trim() || defaultSummary(body),
      body,
      weight: input.weight ?? defaultWeight(source.kind),
      source: source.kind,
      metadata: {
        sourceKind: source.kind,
        sourceUri: source.uri,
        sourceId: source.id,
        ...(input.metadata ?? {})
      }
    });
    const id = randomUUID();
    this.db
      .prepare(
        `
      insert into memory_chunks
        (id, source_id, node_id, uri, heading, body, summary, content_hash, order_index, status, updated_at, metadata_json)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `
      )
      .run(
        id,
        input.sourceId,
        node.id,
        uri,
        heading,
        body,
        input.summary?.trim() || defaultSummary(body),
        contentHash,
        input.orderIndex ?? 0,
        now,
        encodeJson(input.metadata)
      );
    return this.getChunk(id)!;
  }

  getChunk(id: string): MemoryChunk | undefined {
    const row = this.db.prepare("select * from memory_chunks where id = ?").get(id) as
      | DbMemoryChunk
      | undefined;
    return row ? toMemoryChunk(row) : undefined;
  }

  listChunksForSource(sourceId: string): MemoryChunk[] {
    const rows = this.db
      .prepare(
        `
      select * from memory_chunks
      where source_id = ?
      order by order_index asc, heading asc
    `
      )
      .all(sourceId) as DbMemoryChunk[];
    return rows.map(toMemoryChunk);
  }

  searchGraph(input: SearchMemoryGraphInput): MemoryGraphSearchHit[] {
    const terms = tokenizeSearch(input.query);
    if (terms.length === 0) return [];
    const limit = Math.max(1, Math.min(input.limit ?? 8, 50));
    const minScore = input.minScore ?? 1;
    const rows = this.db
      .prepare(
        `
      select
        n.*,
        s.id as source_id,
        s.kind as source_kind,
        s.uri as source_uri,
        s.title as source_title,
        s.content_hash as source_content_hash,
        s.status as source_status,
        s.indexed_at as source_indexed_at,
        s.updated_at as source_updated_at,
        s.metadata_json as source_metadata_json,
        c.id as chunk_id,
        c.source_id as chunk_source_id,
        c.node_id as chunk_node_id,
        c.uri as chunk_uri,
        c.heading as chunk_heading,
        c.body as chunk_body,
        c.summary as chunk_summary,
        c.content_hash as chunk_content_hash,
        c.order_index as chunk_order_index,
        c.status as chunk_status,
        c.updated_at as chunk_updated_at,
        c.metadata_json as chunk_metadata_json
      from memory_nodes n
      join memory_chunks c on c.node_id = n.id
      join memory_sources s on s.id = c.source_id
      where n.status in ('active', 'disputed') and c.status = 'active' and s.status = 'active'
    `
      )
      .all() as DbGraphSearchRow[];
    const baseHits = rows.map((row) => {
      const node = toMemoryNode(row);
      const source = graphRowToSource(row);
      const chunk = graphRowToChunk(row);
      return {
        node,
        source,
        chunk,
        score: scoreGraphHit({ node, source, chunk }, terms)
      };
    });
    const standaloneRows = this.db
      .prepare(
        `
      select *
      from memory_nodes n
      where n.status in ('active', 'disputed')
        and not exists (select 1 from memory_chunks c where c.node_id = n.id)
    `
      )
      .all() as DbMemoryNode[];
    for (const row of standaloneRows) {
      const node = toMemoryNode(row);
      const source = standaloneNodeSource(node);
      const chunk = standaloneNodeChunk(node);
      baseHits.push({
        node,
        source,
        chunk,
        score: scoreGraphHit({ node, source, chunk }, terms)
      });
    }
    const rankedHits = applyGraphEdges(
      baseHits,
      this.listActiveEdges(),
      minScore,
      input.maxGraphDistance ?? 2
    )
      .filter((hit) => hit.node.status === "active" && hit.score >= minScore)
      .sort(compareGraphSearchHits)
      .slice(0, limit);
    return rankedHits;
  }

  correctNode(input: CorrectMemoryNodeInput): CorrectMemoryNodeResult {
    const existing = this.getNode(input.nodeId);
    if (!existing) {
      throw new Error(`Memory node not found: ${input.nodeId}`);
    }
    if (existing.status === "archived") {
      throw new Error(`Cannot correct archived Memory node: ${input.nodeId}`);
    }
    const reason = normalizeWhitespace(input.reason);
    if (!reason) {
      throw new Error("Memory correction reason must not be empty");
    }
    const now = nowIso();
    return this.db.transaction(() => {
      this.db
        .prepare(
          `
        update memory_nodes
        set status = 'disputed',
            weight = max(0, weight * 0.25),
            updated_at = ?,
            metadata_json = ?
        where id = ?
      `
        )
        .run(
          now,
          encodeJson({
            ...existing.metadata,
            correction: {
              reason,
              correctedAt: now,
              ...(input.metadata ?? {})
            }
          }),
          existing.id
        );
      const disputed = this.getNode(existing.id)!;
      const edges: MemoryEdge[] = [];
      let replacement: MemoryNode | undefined;
      if (input.replacement?.body) {
        replacement = this.upsertNode({
          type: input.replacement.type ?? existing.type,
          title: input.replacement.title ?? existing.title,
          summary: input.replacement.summary ?? input.replacement.body,
          body: input.replacement.body,
          weight: input.replacement.weight ?? Math.max(0.75, existing.weight),
          source: input.replacement.source ?? "explicit",
          sourceSessionId: input.replacement.sourceSessionId ?? existing.sourceSessionId,
          metadata: {
            correctionFor: existing.id,
            correctionReason: reason,
            ...(input.replacement.metadata ?? {})
          }
        });
        edges.push(
          this.addEdge({
            fromNodeId: replacement.id,
            toNodeId: disputed.id,
            relation: "supersedes",
            weight: 1,
            metadata: {
              source: "memory-correction",
              reason,
              ...(input.metadata ?? {})
            }
          })
        );
      }
      if (replacement) {
        edges.push(
          this.addEdge({
            fromNodeId: replacement.id,
            toNodeId: disputed.id,
            relation: "conflicts_with",
            weight: 1,
            metadata: {
              source: "memory-correction",
              reason,
              ...(input.metadata ?? {})
            }
          })
        );
      }
      return { disputed, replacement, edges };
    })();
  }

  markSourceMissing(sourceId: string): void {
    const now = nowIso();
    this.db.transaction((id: string) => {
      this.db
        .prepare("update memory_sources set status = 'archived', updated_at = ? where id = ?")
        .run(now, id);
      this.db
        .prepare("update memory_chunks set status = 'archived', updated_at = ? where source_id = ?")
        .run(now, id);
      this.db
        .prepare(
          `
        update memory_nodes
        set status = 'archived', updated_at = ?
        where id in (select node_id from memory_chunks where source_id = ?)
      `
        )
        .run(now, id);
    })(sourceId);
  }

  archiveChunksForSourceExcept(sourceId: string, activeHeadings: string[]): void {
    const active = new Set(activeHeadings.map((heading) => heading.trim()).filter(Boolean));
    const chunks = this.listChunksForSource(sourceId).filter((chunk) => !active.has(chunk.heading));
    if (chunks.length === 0) {
      return;
    }
    const now = nowIso();
    const archiveChunk = this.db.prepare(
      "update memory_chunks set status = 'archived', updated_at = ? where id = ?"
    );
    const archiveNode = this.db.prepare(
      "update memory_nodes set status = 'archived', updated_at = ? where id = ?"
    );
    this.db.transaction((missing: MemoryChunk[]) => {
      for (const chunk of missing) {
        archiveChunk.run(now, chunk.id);
        archiveNode.run(now, chunk.nodeId);
      }
    })(chunks);
  }

  listSources(
    input: { kind?: MemorySourceKind; status?: MemorySourceStatus } = {}
  ): MemorySource[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (input.kind) {
      clauses.push("kind = ?");
      params.push(input.kind);
    }
    if (input.status) {
      clauses.push("status = ?");
      params.push(input.status);
    }
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    const rows = this.db
      .prepare(`select * from memory_sources ${where} order by uri asc`)
      .all(...params) as DbMemorySource[];
    return rows.map(toMemorySource);
  }

  listConflicts(input: { limit?: number } = {}): MemoryConflictRecord[] {
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
    const rows = this.db
      .prepare(
        `
      select e.*
      from memory_edges e
      join memory_nodes from_node on from_node.id = e.from_node_id
      join memory_nodes to_node on to_node.id = e.to_node_id
      where e.relation = 'conflicts_with'
        and from_node.status != 'archived'
        and to_node.status != 'archived'
      order by e.weight desc, e.created_at desc
      limit ?
    `
      )
      .all(limit) as DbMemoryEdge[];
    return rows.flatMap((row) => {
      const edge = toMemoryEdge(row);
      const from = this.getNode(edge.fromNodeId);
      const to = this.getNode(edge.toNodeId);
      if (!from || !to) {
        return [];
      }
      return [{ edge, from, to, ...recommendConflictResolution(from, to) }];
    });
  }

  listConflictGroups(input: { limit?: number } = {}): MemoryConflictGroup[] {
    const conflicts = this.listConflicts({ limit: input.limit ?? 200 });
    if (conflicts.length === 0) {
      return [];
    }
    const groups = groupConflictRecords(conflicts);
    return groups.slice(0, Math.max(1, Math.min(input.limit ?? 50, 200)));
  }

  listCleanupCandidates(
    input: { olderThanDays?: number; maxWeight?: number; limit?: number; now?: Date } = {}
  ): MemoryCleanupCandidate[] {
    const olderThanDays = clampNumber(input.olderThanDays ?? 90, 0, 3650);
    const maxWeight = clampNumber(input.maxWeight ?? 0.35, 0, 1);
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
    const now = input.now ?? new Date();
    const cutoff = new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000);
    const activeRows = this.db
      .prepare(
        `
      select * from memory_nodes
      where status = 'active'
        and weight <= ?
        and coalesce(last_used_at, created_at) < ?
      order by weight asc, coalesce(last_used_at, created_at) asc
      limit ?
    `
      )
      .all(maxWeight, cutoff.toISOString(), limit) as DbMemoryNode[];
    const supersededRows = this.db
      .prepare(
        `
      select to_node.*
      from memory_nodes to_node
      join memory_edges e on e.to_node_id = to_node.id
      join memory_nodes from_node on from_node.id = e.from_node_id
      where e.relation = 'supersedes'
        and to_node.status = 'disputed'
        and from_node.status = 'active'
      order by e.weight desc, to_node.weight asc, coalesce(to_node.last_used_at, to_node.updated_at, to_node.created_at) asc
      limit ?
    `
      )
      .all(limit) as DbMemoryNode[];
    const nodesById = new Map<string, MemoryNode>();
    for (const row of supersededRows) {
      nodesById.set(row.id, toMemoryNode(row));
    }
    for (const row of activeRows) {
      if (!nodesById.has(row.id)) {
        nodesById.set(row.id, toMemoryNode(row));
      }
    }
    return Array.from(nodesById.values())
      .slice(0, limit)
      .map((node) => {
        const lastSignal = node.lastUsedAt ?? node.createdAt;
        const ageDays = Math.max(
          0,
          Math.floor((now.getTime() - Date.parse(lastSignal)) / 86_400_000)
        );
        const supersededBy = this.getSupersedingActiveNode(node.id);
        return {
          node,
          ageDays,
          reason: supersededBy
            ? `${node.title} is disputed and superseded by active node ${supersededBy.id} (${supersededBy.title}).`
            : `${node.title} is low-weight (${node.weight.toFixed(2)}) and unused for ${ageDays}d.`
        };
      });
  }

  listDuplicateCandidates(input: { limit?: number } = {}): MemoryDuplicateCandidate[] {
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
    const rows = this.db
      .prepare(
        `
      select * from memory_nodes
      where status = 'active'
        and source in ('agent', 'tool', 'explicit')
      order by type asc, weight desc, updated_at desc
    `
      )
      .all() as DbMemoryNode[];
    const byKey = new Map<string, MemoryNode>();
    const candidates: MemoryDuplicateCandidate[] = [];
    for (const row of rows) {
      const node = toMemoryNode(row);
      const key = `${node.type}:${normalizeDuplicateTitle(node.title)}`;
      if (!key.endsWith(":")) {
        const existing = byKey.get(key);
        if (existing && existing.id !== node.id && hasDuplicateSimilarity(existing, node)) {
          const [keep, duplicate] = chooseDuplicateKeeper(existing, node);
          candidates.push({
            keep,
            duplicate,
            reason: `${duplicate.title} looks like a duplicate of active node ${keep.id} (${keep.title}).`
          });
          if (candidates.length >= limit) {
            break;
          }
          byKey.set(key, keep);
          continue;
        }
        byKey.set(key, node);
      }
    }
    return candidates;
  }

  listMergeRecords(input: { limit?: number } = {}): MemoryMergeRecord[] {
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
    const rows = this.db
      .prepare(
        `
      select duplicate.*
      from memory_nodes duplicate
      where duplicate.status = 'archived'
        and json_extract(duplicate.metadata_json, '$.archive.mergedInto') is not null
      order by coalesce(
        json_extract(duplicate.metadata_json, '$.archive.archivedAt'),
        duplicate.updated_at
      ) desc
      limit ?
    `
      )
      .all(limit) as DbMemoryNode[];

    const records: MemoryMergeRecord[] = [];
    for (const row of rows) {
      const duplicate = toMemoryNode(row);
      const archive = readRecord(duplicate.metadata.archive);
      if (!archive) {
        continue;
      }
      const keepId = readString(archive.mergedInto);
      if (!keepId) {
        continue;
      }
      const keep = this.getNode(keepId);
      if (!keep) {
        continue;
      }
      const merge = findMergeEntry(keep, duplicate.id);
      records.push({
        keep,
        duplicate,
        mergedAt:
          readString(merge?.mergedAt) ?? readString(archive.archivedAt) ?? duplicate.updatedAt,
        reason:
          readString(merge?.reason) ?? readString(archive.reason) ?? "Merged duplicate Memory node",
        previousWeight: readNumber(merge?.previousWeight),
        nextWeight: readNumber(merge?.nextWeight),
        duplicateWeight: readNumber(merge?.duplicateWeight) ?? duplicate.weight,
        duplicateUseCount: readNumber(merge?.duplicateUseCount),
        redirectedEdgeCount: readNumber(archive.redirectedEdgeCount) ?? 0,
        resolvedEdgeConflictCount: readNumber(archive.resolvedEdgeConflictCount) ?? 0,
        dreamId: readString(archive.dreamId) ?? readString(merge?.dreamId)
      });
    }
    return records;
  }

  archiveNodes(input: ArchiveMemoryNodesInput): MemoryNode[] {
    const ids = uniqueIds(input.ids);
    if (ids.length === 0) return [];
    const now = nowIso();
    const updateNode = this.db.prepare(`
      update memory_nodes
      set status = 'archived',
          updated_at = ?,
          metadata_json = ?
      where id = ? and status != 'archived'
    `);
    const updateChunks = this.db.prepare(`
      update memory_chunks
      set status = 'archived',
          updated_at = ?
      where node_id = ?
    `);
    const archived = this.db.transaction((nodeIds: string[]) => {
      const changed: MemoryNode[] = [];
      for (const id of nodeIds) {
        const node = this.getNode(id);
        if (!node || node.status === "archived") {
          continue;
        }
        updateNode.run(
          now,
          encodeJson({
            ...node.metadata,
            archive: {
              reason: input.reason ?? "Memory graph node archived",
              archivedAt: now,
              ...(input.metadata ?? {})
            }
          }),
          id
        );
        updateChunks.run(now, id);
        changed.push(this.getNode(id)!);
      }
      return changed;
    })(ids);
    return archived;
  }

  mergeDuplicateNode(input: MergeDuplicateMemoryNodeInput): MergeDuplicateMemoryNodeResult {
    const keepId = input.keepId.trim();
    const duplicateId = input.duplicateId.trim();
    if (!keepId || !duplicateId) {
      throw new Error("Memory merge requires keepId and duplicateId");
    }
    if (keepId === duplicateId) {
      throw new Error("Memory merge cannot merge a node into itself");
    }
    const now = nowIso();
    return this.db.transaction(() => {
      const keep = this.getNode(keepId);
      const duplicate = this.getNode(duplicateId);
      if (!keep) {
        throw new Error(`Memory keep node not found: ${keepId}`);
      }
      if (!duplicate) {
        throw new Error(`Memory duplicate node not found: ${duplicateId}`);
      }
      if (keep.status === "archived") {
        throw new Error(`Cannot merge into archived Memory node: ${keepId}`);
      }
      if (duplicate.status === "archived") {
        return {
          keep,
          duplicate,
          redirectedEdges: [],
          archived: [],
          previousKeepWeight: keep.weight,
          nextKeepWeight: keep.weight,
          resolvedEdgeConflictCount: 0
        };
      }

      const fusedKeep = this.fuseDuplicateIntoKeeper({
        keep,
        duplicate,
        now,
        reason: input.reason ?? "Merged duplicate Memory node",
        metadata: input.metadata
      });
      const redirectResult = this.redirectEdgesFromDuplicate({
        keepId,
        duplicateId,
        now,
        reason: input.reason ?? "Merged duplicate Memory node",
        metadata: input.metadata
      });
      const archived = this.archiveNodes({
        ids: [duplicateId],
        reason: input.reason ?? `Merged into Memory node ${keepId}`,
        metadata: {
          ...input.metadata,
          mergedInto: keepId,
          redirectedEdgeCount: redirectResult.redirectedEdges.length,
          resolvedEdgeConflictCount: redirectResult.resolvedEdgeConflictCount
        }
      });
      return {
        keep: fusedKeep,
        duplicate,
        redirectedEdges: redirectResult.redirectedEdges,
        archived,
        previousKeepWeight: keep.weight,
        nextKeepWeight: fusedKeep.weight,
        resolvedEdgeConflictCount: redirectResult.resolvedEdgeConflictCount
      };
    })();
  }

  keepNodes(input: KeepMemoryNodesInput): MemoryNode[] {
    const ids = uniqueIds(input.ids);
    if (ids.length === 0) return [];
    const now = nowIso();
    const update = this.db.prepare(`
      update memory_nodes
      set last_used_at = ?,
          updated_at = ?,
          metadata_json = ?
      where id = ? and status = 'active'
    `);
    const kept = this.db.transaction((nodeIds: string[]) => {
      const changed: MemoryNode[] = [];
      for (const id of nodeIds) {
        const node = this.getNode(id);
        if (!node || node.status !== "active") {
          continue;
        }
        update.run(
          now,
          now,
          encodeJson({
            ...node.metadata,
            cleanupReview: {
              decision: "kept",
              reason: input.reason ?? "Memory graph node kept after review",
              reviewedAt: now,
              ...(input.metadata ?? {})
            }
          }),
          id
        );
        changed.push(this.getNode(id)!);
      }
      return changed;
    })(ids);
    return kept;
  }

  applyFeedback(input: ApplyMemoryFeedbackInput): ApplyMemoryFeedbackResult {
    const node = this.getNode(input.nodeId);
    if (!node) {
      throw new Error(`Memory node not found: ${input.nodeId}`);
    }
    if (node.status === "archived") {
      throw new Error(`Cannot apply feedback to archived Memory node: ${input.nodeId}`);
    }
    const now = nowIso();
    const reason = normalizeWhitespace(input.reason ?? "");
    const previousWeight = node.weight;
    if (input.signal === "wrong" || input.signal === "stale") {
      const result = this.correctNode({
        nodeId: node.id,
        reason: reason || `User feedback marked Memory as ${input.signal}`,
        replacement: input.replacement
          ? {
              ...input.replacement,
              source: input.replacement.source ?? "explicit",
              weight: input.replacement.weight ?? Math.max(0.75, previousWeight)
            }
          : undefined,
        metadata: {
          feedback: input.signal,
          feedbackAt: now,
          ...(input.metadata ?? {})
        }
      });
      return {
        node: result.disputed,
        previousWeight,
        nextWeight: result.disputed.weight,
        signal: input.signal,
        replacement: result.replacement,
        edges: result.edges
      };
    }

    const delta = input.signal === "useful" ? 0.08 : -0.18;
    const nextWeight = Number(clampNumber(previousWeight + delta, 0, 1).toFixed(6));
    const existingTrend = readRecord(node.metadata.feedbackTrend);
    const useful = readNumber(existingTrend?.useful) ?? 0;
    const irrelevant = readNumber(existingTrend?.irrelevant) ?? 0;
    const update = this.db.prepare(`
      update memory_nodes
      set weight = ?,
          use_count = use_count + ?,
          last_used_at = ?,
          updated_at = ?,
          metadata_json = ?
      where id = ? and status = 'active'
    `);
    update.run(
      nextWeight,
      input.signal === "useful" ? 1 : 0,
      input.signal === "useful" ? now : (node.lastUsedAt ?? null),
      now,
      encodeJson({
        ...node.metadata,
        feedbackTrend: {
          ...(existingTrend ?? {}),
          useful: useful + (input.signal === "useful" ? 1 : 0),
          irrelevant: irrelevant + (input.signal === "irrelevant" ? 1 : 0),
          lastSignal: input.signal,
          lastReason: reason || undefined,
          lastFeedbackAt: now,
          ...(input.metadata ?? {})
        }
      }),
      node.id
    );
    return {
      node: this.getNode(node.id)!,
      previousWeight,
      nextWeight,
      signal: input.signal,
      edges: []
    };
  }

  listFeedbackTrends(input: { limit?: number; minEvents?: number } = {}): MemoryFeedbackTrend[] {
    const limit = Math.max(1, Math.min(input.limit ?? 20, 200));
    const minEvents = Math.max(1, Math.floor(input.minEvents ?? 1));
    const rows = this.db
      .prepare(
        `
      select *
      from memory_nodes
      where json_extract(metadata_json, '$.feedbackTrend') is not null
      order by
        coalesce(json_extract(metadata_json, '$.feedbackTrend.lastFeedbackAt'), updated_at) desc,
        weight desc
      limit ?
    `
      )
      .all(limit * 4) as DbMemoryNode[];
    return rows
      .map(toMemoryNode)
      .map((node) => {
        const trend = readRecord(node.metadata.feedbackTrend);
        const useful = readNumber(trend?.useful) ?? 0;
        const irrelevant = readNumber(trend?.irrelevant) ?? 0;
        return {
          node,
          useful,
          irrelevant,
          net: useful - irrelevant,
          lastSignal: readString(trend?.lastSignal),
          lastReason: readString(trend?.lastReason),
          lastFeedbackAt: readString(trend?.lastFeedbackAt)
        };
      })
      .filter((trend) => trend.useful + trend.irrelevant >= minEvents)
      .sort(compareFeedbackTrends)
      .slice(0, limit);
  }

  getNode(id: string): MemoryNode | undefined {
    const row = this.db.prepare("select * from memory_nodes where id = ?").get(id) as
      | DbMemoryNode
      | undefined;
    return row ? toMemoryNode(row) : undefined;
  }

  listHotNodes(input: ListHotMemoryNodesInput = {}): MemoryNode[] {
    const limit = Math.max(1, Math.min(input.limit ?? 12, 50));
    const minWeight = input.minWeight ?? 0.25;
    const rows = this.db
      .prepare(
        `
      select * from memory_nodes
      where status = 'active' and weight >= ?
      order by
        case type
          when 'user_profile' then 0
          when 'preference' then 1
          when 'work_habit' then 2
          when 'workflow' then 3
          when 'project' then 4
          when 'decision' then 5
          when 'problem' then 6
          when 'skill_ref' then 7
          when 'reference' then 8
          when 'session' then 9
          else 10
        end asc,
        weight desc,
        coalesce(last_used_at, updated_at) desc,
        updated_at desc
      limit ?
    `
      )
      .all(minWeight, limit) as DbMemoryNode[];
    return rows.map(toMemoryNode);
  }

  markUsed(ids: string[], boost = 0.05): void {
    const unique = Array.from(new Set(ids)).filter(Boolean);
    if (unique.length === 0) return;
    const now = nowIso();
    const update = this.db.prepare(`
      update memory_nodes
      set use_count = use_count + 1,
          last_used_at = ?,
          updated_at = ?,
          weight = min(1.0, weight + ?)
      where id = ? and status = 'active'
    `);
    const txn = this.db.transaction((nodeIds: string[]) => {
      for (const id of nodeIds) update.run(now, now, boost, id);
    });
    txn(unique);
  }

  markEdgesUsed(ids: number[], boost = 0.03): void {
    const unique = Array.from(new Set(ids)).filter(
      (id) => Number.isInteger(id) && Number.isFinite(id) && id > 0
    );
    if (unique.length === 0) return;
    const now = nowIso();
    const update = this.db.prepare(`
      update memory_edges
      set weight = min(1.0, weight + ?),
          last_used_at = ?,
          use_count = use_count + 1
      where id = ?
    `);
    const txn = this.db.transaction((edgeIds: number[]) => {
      for (const id of edgeIds) {
        update.run(boost, now, id);
      }
    });
    txn(unique);
  }

  decayUnusedNodes(input: DecayUnusedMemoryInput = {}): DecayUnusedMemoryResult {
    const olderThanDays = clampNumber(input.olderThanDays ?? 45, 0, 3650);
    const decay = clampNumber(input.decay ?? 0.08, 0, 1);
    const minWeight = clampNumber(input.minWeight ?? 0.2, 0, 1);
    const limit = Math.max(1, Math.min(input.limit ?? 100, 1000));
    const now = input.now ?? new Date();
    const cutoff = new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000);
    const rows = this.db
      .prepare(
        `
      select * from memory_nodes
      where status = 'active'
        and weight > ?
        and coalesce(last_used_at, updated_at) < ?
      order by coalesce(last_used_at, updated_at) asc, weight desc
      limit ?
    `
      )
      .all(minWeight, cutoff.toISOString(), limit) as DbMemoryNode[];
    const changed = rows
      .map(toMemoryNode)
      .map((node) => {
        const lastSignal = node.lastUsedAt ?? node.updatedAt;
        const effectiveDecay = memoryTypeEffectiveDecay(node.type, decay);
        return {
          node,
          previousWeight: node.weight,
          nextWeight: Math.max(minWeight, Number((node.weight * (1 - effectiveDecay)).toFixed(6))),
          effectiveDecay,
          ageDays: Math.max(0, Math.floor((now.getTime() - Date.parse(lastSignal)) / 86_400_000))
        };
      })
      .filter((item) => item.nextWeight < item.previousWeight);

    if (input.apply === true && changed.length > 0) {
      const stamp = now.toISOString();
      const update = this.db.prepare(`
        update memory_nodes
        set weight = ?,
            updated_at = ?,
            metadata_json = ?
        where id = ? and status = 'active'
      `);
      this.db.transaction((items: DecayedMemoryNode[]) => {
        for (const item of items) {
          update.run(
            item.nextWeight,
            stamp,
            encodeJson({
              ...item.node.metadata,
              decay: {
                previousWeight: item.previousWeight,
                nextWeight: item.nextWeight,
                olderThanDays,
                decay,
                effectiveDecay: item.effectiveDecay,
                type: item.node.type,
                decayedAt: stamp
              }
            }),
            item.node.id
          );
        }
      })(changed);
    }

    return {
      applied: input.apply === true,
      olderThanDays,
      decay,
      minWeight,
      changed
    };
  }

  addEdge(input: {
    fromNodeId: string;
    toNodeId: string;
    relation: MemoryEdgeRelation;
    weight?: number;
    metadata?: Record<string, unknown>;
  }): MemoryEdge {
    const now = nowIso();
    const result = this.db
      .prepare(
        `
      insert into memory_edges (from_node_id, to_node_id, relation, weight, created_at, metadata_json)
      values (?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        input.fromNodeId,
        input.toNodeId,
        input.relation,
        input.weight ?? 0.5,
        now,
        encodeJson(input.metadata)
      );
    return {
      id: Number(result.lastInsertRowid),
      fromNodeId: input.fromNodeId,
      toNodeId: input.toNodeId,
      relation: input.relation,
      weight: input.weight ?? 0.5,
      createdAt: now,
      useCount: 0,
      metadata: input.metadata ?? {}
    };
  }

  getEdge(id: number): MemoryEdge | undefined {
    const row = this.db.prepare("select * from memory_edges where id = ?").get(id) as
      | DbMemoryEdge
      | undefined;
    return row ? toMemoryEdge(row) : undefined;
  }

  private fuseDuplicateIntoKeeper(input: {
    keep: MemoryNode;
    duplicate: MemoryNode;
    now: string;
    reason: string;
    metadata?: Record<string, unknown>;
  }): MemoryNode {
    const previousWeight = input.keep.weight;
    const duplicateSignal = Math.max(0, Math.min(input.duplicate.weight, 1)) * 0.35;
    const nextWeight = Number(
      Math.min(
        1,
        Math.max(previousWeight, 1 - (1 - previousWeight) * (1 - duplicateSignal))
      ).toFixed(6)
    );
    const lastUsedAt = latestIso(input.keep.lastUsedAt, input.duplicate.lastUsedAt);
    const mergeEntry = {
      duplicateNodeId: input.duplicate.id,
      duplicateWeight: input.duplicate.weight,
      previousWeight,
      nextWeight,
      duplicateUseCount: input.duplicate.useCount,
      reason: input.reason,
      mergedAt: input.now,
      ...(input.metadata ?? {})
    };
    const mergeHistory = Array.isArray(input.keep.metadata.mergeHistory)
      ? [...input.keep.metadata.mergeHistory.slice(-9), mergeEntry]
      : [mergeEntry];
    this.db
      .prepare(
        `
      update memory_nodes
      set weight = ?,
          use_count = use_count + ?,
          last_used_at = ?,
          updated_at = ?,
          metadata_json = ?
      where id = ? and status != 'archived'
    `
      )
      .run(
        nextWeight,
        input.duplicate.useCount,
        lastUsedAt ?? input.keep.lastUsedAt ?? null,
        input.now,
        encodeJson({
          ...input.keep.metadata,
          merge: mergeEntry,
          mergeHistory
        }),
        input.keep.id
      );
    return this.getNode(input.keep.id) ?? input.keep;
  }

  private redirectEdgesFromDuplicate(input: {
    keepId: string;
    duplicateId: string;
    now: string;
    reason: string;
    metadata?: Record<string, unknown>;
  }): { redirectedEdges: MemoryEdge[]; resolvedEdgeConflictCount: number } {
    const rows = this.db
      .prepare(
        `
      select *
      from memory_edges
      where from_node_id = ? or to_node_id = ?
      order by id asc
    `
      )
      .all(input.duplicateId, input.duplicateId) as DbMemoryEdge[];
    const redirected: MemoryEdge[] = [];
    let resolvedEdgeConflictCount = 0;
    for (const row of rows) {
      const edge = toMemoryEdge(row);
      const fromNodeId = edge.fromNodeId === input.duplicateId ? input.keepId : edge.fromNodeId;
      const toNodeId = edge.toNodeId === input.duplicateId ? input.keepId : edge.toNodeId;
      if (fromNodeId === toNodeId) {
        continue;
      }
      const result = this.upsertRedirectedEdge({
        fromNodeId,
        toNodeId,
        relation: edge.relation,
        weight: edge.weight,
        now: input.now,
        sourceEdge: edge,
        keepId: input.keepId,
        duplicateId: input.duplicateId,
        reason: input.reason,
        metadata: input.metadata
      });
      if (result.edge) {
        redirected.push(result.edge);
      }
      if (result.resolvedConflict) {
        resolvedEdgeConflictCount += 1;
      }
    }
    return { redirectedEdges: redirected, resolvedEdgeConflictCount };
  }

  private upsertRedirectedEdge(input: {
    fromNodeId: string;
    toNodeId: string;
    relation: MemoryEdgeRelation;
    weight: number;
    now: string;
    sourceEdge: MemoryEdge;
    keepId: string;
    duplicateId: string;
    reason: string;
    metadata?: Record<string, unknown>;
  }): { edge?: MemoryEdge; resolvedConflict: boolean } {
    const existing = this.db
      .prepare(
        `
      select *
      from memory_edges
      where from_node_id = ? and to_node_id = ? and relation = ?
      order by weight desc, id asc
      limit 1
    `
      )
      .get(input.fromNodeId, input.toNodeId, input.relation) as DbMemoryEdge | undefined;
    const mergeMetadata = {
      keepNodeId: input.keepId,
      duplicateNodeId: input.duplicateId,
      sourceEdgeId: input.sourceEdge.id,
      reason: input.reason,
      mergedAt: input.now,
      ...(input.metadata ?? {})
    };
    if (existing) {
      this.db
        .prepare(
          `
        update memory_edges
        set weight = ?,
            metadata_json = ?
        where id = ?
      `
        )
        .run(
          Math.max(existing.weight, input.weight),
          encodeJson({
            ...decodeJson(existing.metadata_json),
            merge: mergeMetadata
          }),
          existing.id
        );
      const updated = this.db
        .prepare("select * from memory_edges where id = ?")
        .get(existing.id) as DbMemoryEdge | undefined;
      return { edge: toMemoryEdge(updated ?? existing), resolvedConflict: false };
    }
    const conflicting = this.findConflictingEdge(input.fromNodeId, input.toNodeId, input.relation);
    if (conflicting) {
      const keepExisting = conflicting.weight >= input.weight;
      const conflictMetadata = {
        ...mergeMetadata,
        keptEdgeId: keepExisting ? conflicting.id : undefined,
        removedEdgeId: keepExisting ? undefined : conflicting.id,
        keptRelation: keepExisting ? conflicting.relation : input.relation,
        skippedRelation: keepExisting ? input.relation : conflicting.relation
      };
      if (keepExisting) {
        this.markEdgeMergeConflictResolved(conflicting, conflictMetadata);
        return { resolvedConflict: true };
      }
      this.db.prepare("delete from memory_edges where id = ?").run(conflicting.id);
    }
    const result = this.db
      .prepare(
        `
      insert into memory_edges (from_node_id, to_node_id, relation, weight, created_at, metadata_json)
      values (?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        input.fromNodeId,
        input.toNodeId,
        input.relation,
        input.weight,
        input.now,
        encodeJson({
          ...input.sourceEdge.metadata,
          merge: mergeMetadata
        })
      );
    const edge = {
      id: Number(result.lastInsertRowid),
      fromNodeId: input.fromNodeId,
      toNodeId: input.toNodeId,
      relation: input.relation,
      weight: input.weight,
      createdAt: input.now,
      lastUsedAt: input.sourceEdge.lastUsedAt,
      useCount: input.sourceEdge.useCount,
      metadata: {
        ...input.sourceEdge.metadata,
        merge: mergeMetadata
      }
    };
    return { edge, resolvedConflict: Boolean(conflicting) };
  }

  private findConflictingEdge(
    fromNodeId: string,
    toNodeId: string,
    relation: MemoryEdgeRelation
  ): DbMemoryEdge | undefined {
    if (relation === "conflicts_with") {
      return this.db
        .prepare(
          `
        select *
        from memory_edges
        where relation != 'conflicts_with'
          and (
            (from_node_id = ? and to_node_id = ?)
            or (from_node_id = ? and to_node_id = ?)
          )
        order by weight desc, id asc
        limit 1
      `
        )
        .get(fromNodeId, toNodeId, toNodeId, fromNodeId) as DbMemoryEdge | undefined;
    }
    return this.db
      .prepare(
        `
      select *
      from memory_edges
      where relation = 'conflicts_with'
        and (
          (from_node_id = ? and to_node_id = ?)
          or (from_node_id = ? and to_node_id = ?)
        )
      order by weight desc, id asc
      limit 1
    `
      )
      .get(fromNodeId, toNodeId, toNodeId, fromNodeId) as DbMemoryEdge | undefined;
  }

  private markEdgeMergeConflictResolved(
    edge: DbMemoryEdge,
    metadata: Record<string, unknown>
  ): void {
    this.db
      .prepare(
        `
      update memory_edges
      set metadata_json = ?
      where id = ?
    `
      )
      .run(
        encodeJson({
          ...decodeJson(edge.metadata_json),
          mergeConflict: metadata
        }),
        edge.id
      );
  }

  private listActiveEdges(): MemoryEdge[] {
    const rows = this.db
      .prepare(
        `
      select e.*
      from memory_edges e
      join memory_nodes from_node on from_node.id = e.from_node_id
      join memory_nodes to_node on to_node.id = e.to_node_id
      where from_node.status in ('active', 'disputed') and to_node.status in ('active', 'disputed')
    `
      )
      .all() as DbMemoryEdge[];
    return rows.map(toMemoryEdge);
  }

  private getSupersedingActiveNode(nodeId: string): MemoryNode | undefined {
    const row = this.db
      .prepare(
        `
      select from_node.*
      from memory_edges e
      join memory_nodes from_node on from_node.id = e.from_node_id
      where e.to_node_id = ?
        and e.relation = 'supersedes'
        and from_node.status = 'active'
      order by e.weight desc, from_node.weight desc, e.created_at desc
      limit 1
    `
      )
      .get(nodeId) as DbMemoryNode | undefined;
    return row ? toMemoryNode(row) : undefined;
  }

  private findDuplicate(type: MemoryNodeType, body: string): MemoryNode | undefined {
    const row = this.db
      .prepare(
        `
      select * from memory_nodes
      where type = ? and lower(body) = lower(?) and status = 'active'
      order by updated_at desc
      limit 1
    `
      )
      .get(type, body) as DbMemoryNode | undefined;
    return row ? toMemoryNode(row) : undefined;
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists memory_nodes (
        id text primary key,
        type text not null,
        title text not null,
        summary text not null,
        body text not null,
        weight real not null,
        status text not null,
        source text not null,
        source_session_id text,
        created_at text not null,
        updated_at text not null,
        last_used_at text,
        use_count integer not null default 0,
        metadata_json text not null default '{}'
      );

      create index if not exists idx_memory_nodes_hot
        on memory_nodes(status, weight, type, updated_at);

      create table if not exists memory_edges (
        id integer primary key autoincrement,
        from_node_id text not null references memory_nodes(id) on delete cascade,
        to_node_id text not null references memory_nodes(id) on delete cascade,
        relation text not null,
        weight real not null,
        created_at text not null,
        last_used_at text,
        use_count integer not null default 0,
        metadata_json text not null default '{}'
      );

      create index if not exists idx_memory_edges_from
        on memory_edges(from_node_id, relation, weight);
      create index if not exists idx_memory_edges_to
        on memory_edges(to_node_id, relation, weight);

      create table if not exists memory_sources (
        id text primary key,
        kind text not null,
        uri text not null unique,
        title text not null,
        content_hash text not null,
        status text not null,
        indexed_at text not null,
        updated_at text not null,
        metadata_json text not null default '{}'
      );

      create index if not exists idx_memory_sources_kind_status
        on memory_sources(kind, status, uri);

      create table if not exists memory_chunks (
        id text primary key,
        source_id text not null references memory_sources(id) on delete cascade,
        node_id text not null references memory_nodes(id) on delete cascade,
        uri text not null unique,
        heading text not null,
        body text not null,
        summary text not null,
        content_hash text not null,
        order_index integer not null default 0,
        status text not null,
        updated_at text not null,
        metadata_json text not null default '{}'
      );

      create index if not exists idx_memory_chunks_source_status
        on memory_chunks(source_id, status);
      create index if not exists idx_memory_chunks_node
        on memory_chunks(node_id);
    `);
    this.ensureColumn("memory_edges", "last_used_at", "text");
    this.ensureColumn("memory_edges", "use_count", "integer not null default 0");
    this.ensureColumn("memory_chunks", "uri", "text");
    this.ensureColumn("memory_chunks", "order_index", "integer not null default 0");
    this.db
      .prepare(
        "update memory_chunks set uri = source_id || '#' || heading where uri is null or uri = ''"
      )
      .run();
    this.db.exec("create unique index if not exists idx_memory_chunks_uri on memory_chunks(uri)");
  }

  private getChunkByUri(uri: string): MemoryChunk | undefined {
    const row = this.db.prepare("select * from memory_chunks where uri = ? limit 1").get(uri) as
      | DbMemoryChunk
      | undefined;
    return row ? toMemoryChunk(row) : undefined;
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
    if (rows.some((row) => row.name === column)) {
      return;
    }
    this.db.prepare(`alter table ${table} add column ${column} ${definition}`).run();
  }
}

interface DbMemoryNode {
  id: string;
  type: MemoryNodeType;
  title: string;
  summary: string;
  body: string;
  weight: number;
  status: MemoryNodeStatus;
  source: string;
  source_session_id: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  use_count: number;
  metadata_json: string;
}

interface DbMemorySource {
  id: string;
  kind: MemorySourceKind;
  uri: string;
  title: string;
  content_hash: string;
  status: MemorySourceStatus;
  indexed_at: string;
  updated_at: string;
  metadata_json: string;
}

interface DbMemoryChunk {
  id: string;
  source_id: string;
  node_id: string;
  uri: string;
  heading: string;
  body: string;
  summary: string;
  content_hash: string;
  order_index: number;
  status: MemorySourceStatus;
  updated_at: string;
  metadata_json: string;
}

interface DbMemoryEdge {
  id: number;
  from_node_id: string;
  to_node_id: string;
  relation: MemoryEdgeRelation;
  weight: number;
  created_at: string;
  last_used_at: string | null;
  use_count: number;
  metadata_json: string;
}

type DbGraphSearchRow = DbMemoryNode & {
  source_id: string;
  source_kind: MemorySourceKind;
  source_uri: string;
  source_title: string;
  source_content_hash: string;
  source_status: MemorySourceStatus;
  source_indexed_at: string;
  source_updated_at: string;
  source_metadata_json: string;
  chunk_id: string;
  chunk_source_id: string;
  chunk_node_id: string;
  chunk_uri: string;
  chunk_heading: string;
  chunk_body: string;
  chunk_summary: string;
  chunk_content_hash: string;
  chunk_order_index: number;
  chunk_status: MemorySourceStatus;
  chunk_updated_at: string;
  chunk_metadata_json: string;
};

function toMemoryNode(row: DbMemoryNode): MemoryNode {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    summary: row.summary,
    body: row.body,
    weight: row.weight,
    status: row.status,
    source: row.source,
    sourceSessionId: row.source_session_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at ?? undefined,
    useCount: row.use_count,
    metadata: decodeJson(row.metadata_json)
  };
}

function toMemorySource(row: DbMemorySource): MemorySource {
  return {
    id: row.id,
    kind: row.kind,
    uri: row.uri,
    title: row.title,
    contentHash: row.content_hash,
    status: row.status,
    indexedAt: row.indexed_at,
    updatedAt: row.updated_at,
    metadata: decodeJson(row.metadata_json)
  };
}

function toMemoryChunk(row: DbMemoryChunk): MemoryChunk {
  return {
    id: row.id,
    sourceId: row.source_id,
    nodeId: row.node_id,
    uri: row.uri,
    heading: row.heading,
    body: row.body,
    summary: row.summary,
    contentHash: row.content_hash,
    orderIndex: row.order_index,
    status: row.status,
    updatedAt: row.updated_at,
    metadata: decodeJson(row.metadata_json)
  };
}

function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
}

function toMemoryEdge(row: DbMemoryEdge): MemoryEdge {
  return {
    id: row.id,
    fromNodeId: row.from_node_id,
    toNodeId: row.to_node_id,
    relation: row.relation,
    weight: row.weight,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? undefined,
    useCount: row.use_count,
    metadata: decodeJson(row.metadata_json)
  };
}

function recommendConflictResolution(
  from: MemoryNode,
  to: MemoryNode
): Pick<MemoryConflictRecord, "recommendation" | "reason"> {
  if (from.status === "active" && to.status === "disputed") {
    return {
      recommendation: "prefer_from",
      reason: `${from.title} is active while ${to.title} is disputed.`
    };
  }
  if (from.status === "disputed" && to.status === "active") {
    return {
      recommendation: "prefer_to",
      reason: `${to.title} is active while ${from.title} is disputed.`
    };
  }
  if (from.weight > to.weight + 0.05) {
    return {
      recommendation: "prefer_from",
      reason: `${from.title} has higher weight (${from.weight.toFixed(2)} vs ${to.weight.toFixed(2)}).`
    };
  }
  if (to.weight > from.weight + 0.05) {
    return {
      recommendation: "prefer_to",
      reason: `${to.title} has higher weight (${to.weight.toFixed(2)} vs ${from.weight.toFixed(2)}).`
    };
  }
  return {
    recommendation: "needs_review",
    reason: "Both nodes have similar status and weight; ask the user or use MemoryCorrect."
  };
}

function groupConflictRecords(conflicts: MemoryConflictRecord[]): MemoryConflictGroup[] {
  const nodeById = new Map<string, MemoryNode>();
  const parent = new Map<string, string>();
  for (const conflict of conflicts) {
    nodeById.set(conflict.from.id, conflict.from);
    nodeById.set(conflict.to.id, conflict.to);
    union(parent, conflict.from.id, conflict.to.id);
  }

  const byRoot = new Map<string, MemoryConflictRecord[]>();
  for (const conflict of conflicts) {
    const root = findRoot(parent, conflict.from.id);
    const existing = byRoot.get(root) ?? [];
    existing.push(conflict);
    byRoot.set(root, existing);
  }

  return Array.from(byRoot.entries())
    .map(([root, groupConflicts]) => {
      const nodes = Array.from(
        new Set(groupConflicts.flatMap((conflict) => [conflict.from.id, conflict.to.id]))
      )
        .map((id) => nodeById.get(id))
        .filter((node): node is MemoryNode => Boolean(node))
        .sort(compareConflictGroupNodes);
      const preferred = chooseConflictGroupPreferredNode(nodes, groupConflicts);
      const recommendation: MemoryConflictGroup["recommendation"] = preferred
        ? "prefer_node"
        : "needs_review";
      return {
        id: `conflict-group:${root}`,
        nodes,
        conflicts: groupConflicts.sort((left, right) => right.edge.weight - left.edge.weight),
        recommendation,
        preferredNodeId: preferred?.id,
        reason: preferred
          ? `${preferred.title} has the strongest active signal in this conflict group.`
          : "No single active node dominates this conflict group; ask the user or use MemoryCorrect."
      };
    })
    .sort(
      (left, right) =>
        right.conflicts.length - left.conflicts.length ||
        Math.max(...right.nodes.map((node) => node.weight)) -
          Math.max(...left.nodes.map((node) => node.weight)) ||
        left.id.localeCompare(right.id)
    );
}

function union(parent: Map<string, string>, left: string, right: string): void {
  const leftRoot = findRoot(parent, left);
  const rightRoot = findRoot(parent, right);
  if (leftRoot !== rightRoot) {
    parent.set(rightRoot, leftRoot);
  }
}

function findRoot(parent: Map<string, string>, id: string): string {
  const current = parent.get(id);
  if (!current) {
    parent.set(id, id);
    return id;
  }
  if (current === id) {
    return id;
  }
  const root = findRoot(parent, current);
  parent.set(id, root);
  return root;
}

function compareConflictGroupNodes(left: MemoryNode, right: MemoryNode): number {
  return (
    conflictNodeRank(right) - conflictNodeRank(left) ||
    right.weight - left.weight ||
    right.useCount - left.useCount ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.title.localeCompare(right.title)
  );
}

function conflictNodeRank(node: MemoryNode): number {
  if (node.status === "active" && typeof node.metadata.correctionFor === "string") return 4;
  if (node.status === "active") return 3;
  if (node.status === "disputed") return 1;
  return 0;
}

function chooseConflictGroupPreferredNode(
  nodes: MemoryNode[],
  conflicts: MemoryConflictRecord[]
): MemoryNode | undefined {
  const active = nodes.filter((node) => node.status === "active");
  if (active.length === 0) {
    return undefined;
  }
  const [first, second] = active.sort(compareConflictGroupNodes);
  if (!second) {
    return first;
  }
  if (first.weight >= second.weight + 0.05 || first.useCount > second.useCount) {
    return first;
  }
  const preferredIds = new Set(
    conflicts
      .map((conflict) => {
        if (conflict.recommendation === "prefer_from") return conflict.from.id;
        if (conflict.recommendation === "prefer_to") return conflict.to.id;
        return undefined;
      })
      .filter((id): id is string => Boolean(id))
  );
  return preferredIds.size === 1 && preferredIds.has(first.id) ? first : undefined;
}

function findMergeEntry(
  keep: MemoryNode,
  duplicateNodeId: string
): Record<string, unknown> | undefined {
  const current = readRecord(keep.metadata.merge);
  if (current && readString(current.duplicateNodeId) === duplicateNodeId) {
    return current;
  }
  const history = Array.isArray(keep.metadata.mergeHistory) ? keep.metadata.mergeHistory : [];
  for (const item of history) {
    const entry = readRecord(item);
    if (entry && readString(entry.duplicateNodeId) === duplicateNodeId) {
      return entry;
    }
  }
  return undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function graphRowToSource(row: DbGraphSearchRow): MemorySource {
  return {
    id: row.source_id,
    kind: row.source_kind,
    uri: row.source_uri,
    title: row.source_title,
    contentHash: row.source_content_hash,
    status: row.source_status,
    indexedAt: row.source_indexed_at,
    updatedAt: row.source_updated_at,
    metadata: decodeJson(row.source_metadata_json)
  };
}

function graphRowToChunk(row: DbGraphSearchRow): MemoryChunk {
  return {
    id: row.chunk_id,
    sourceId: row.chunk_source_id,
    nodeId: row.chunk_node_id,
    uri: row.chunk_uri,
    heading: row.chunk_heading,
    body: row.chunk_body,
    summary: row.chunk_summary,
    contentHash: row.chunk_content_hash,
    orderIndex: row.chunk_order_index,
    status: row.chunk_status,
    updatedAt: row.chunk_updated_at,
    metadata: decodeJson(row.chunk_metadata_json)
  };
}

function standaloneNodeSource(node: MemoryNode): MemorySource {
  return {
    id: `node-source:${node.id}`,
    kind: node.source === "memdir" ? "memdir" : node.source === "wiki" ? "wiki" : "explicit",
    uri: `memory-node/${node.id}`,
    title: node.title,
    contentHash: hashText(node.body),
    status: "active",
    indexedAt: node.createdAt,
    updatedAt: node.updatedAt,
    metadata: {
      standalone: true,
      nodeSource: node.source
    }
  };
}

function standaloneNodeChunk(node: MemoryNode): MemoryChunk {
  return {
    id: `node-chunk:${node.id}`,
    sourceId: `node-source:${node.id}`,
    nodeId: node.id,
    uri: `memory-node/${node.id}`,
    heading: node.title,
    body: node.body,
    summary: node.summary,
    contentHash: hashText(node.body),
    orderIndex: 0,
    status: "active",
    updatedAt: node.updatedAt,
    metadata: {
      standalone: true,
      nodeSource: node.source
    }
  };
}

function defaultTitle(type: MemoryNodeType, body: string): string {
  const prefix = type
    .split("_")
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
  return `${prefix}: ${defaultSummary(body).slice(0, 60)}`;
}

function defaultSummary(body: string): string {
  return normalizeWhitespace(body).slice(0, 160);
}

function defaultWeight(source: string): number {
  if (source === "explicit") return 0.95;
  if (source === "wiki") return 0.65;
  if (source === "memdir") return 0.6;
  return 0.45;
}

function normalizeWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function normalizeDuplicateTitle(text: string): string {
  return normalizeWhitespace(text).toLowerCase();
}

function hasDuplicateSimilarity(left: MemoryNode, right: MemoryNode): boolean {
  if (normalizeDuplicateTitle(left.summary) === normalizeDuplicateTitle(right.summary)) {
    return true;
  }
  const leftTerms = new Set(tokenizeDuplicateText(`${left.summary} ${left.body}`));
  const rightTerms = new Set(tokenizeDuplicateText(`${right.summary} ${right.body}`));
  if (leftTerms.size === 0 || rightTerms.size === 0) {
    return false;
  }
  let intersection = 0;
  for (const term of leftTerms) {
    if (rightTerms.has(term)) {
      intersection += 1;
    }
  }
  const overlap = intersection / Math.min(leftTerms.size, rightTerms.size);
  return overlap >= 0.72;
}

function tokenizeDuplicateText(text: string): string[] {
  return normalizeWhitespace(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .split(/\s+/)
    .filter((term) => term.length > 2);
}

function chooseDuplicateKeeper(left: MemoryNode, right: MemoryNode): [MemoryNode, MemoryNode] {
  if (left.weight !== right.weight) {
    return left.weight > right.weight ? [left, right] : [right, left];
  }
  if (left.useCount !== right.useCount) {
    return left.useCount > right.useCount ? [left, right] : [right, left];
  }
  return left.updatedAt >= right.updatedAt ? [left, right] : [right, left];
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("Memory decay value must be a finite number");
  }
  return Math.max(min, Math.min(max, value));
}

const MEMORY_TYPE_DECAY_MULTIPLIERS: Record<MemoryNodeType, number> = {
  user_profile: 1,
  preference: 1,
  work_habit: 0.5,
  workflow: 0.5,
  project: 1,
  decision: 1,
  problem: 1,
  reference: 1,
  skill_ref: 0.5,
  session: 1
};

function memoryTypeEffectiveDecay(type: MemoryNodeType, decay: number): number {
  return Number((decay * MEMORY_TYPE_DECAY_MULTIPLIERS[type]).toFixed(6));
}

function normalizeClassifierText(text: string): string {
  return normalizeWhitespace(text).toLowerCase();
}

function hasAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function tokenizeSearch(text: string): string[] {
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

function isSearchTerm(term: string): boolean {
  if (SEARCH_STOPWORDS.has(term)) return false;
  return term.length >= 3 || (/[\u4e00-\u9fff]/.test(term) && term.length >= 2);
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

function scoreGraphHit(
  input: { node: MemoryNode; source: MemorySource; chunk: MemoryChunk },
  terms: string[]
): number {
  const text = `${input.source.uri}\n${input.source.title}\n${input.node.title}\n${input.node.summary}\n${input.chunk.heading}\n${input.chunk.body}`;
  const words = tokenizeSearch(text);
  let lexicalScore = 0;
  for (const term of terms) {
    if (words.includes(term)) {
      lexicalScore += 5;
    } else if (words.some((word) => word.includes(term) || term.includes(word))) {
      lexicalScore += 1;
    }
    if (input.source.uri.toLowerCase().includes(term)) {
      lexicalScore += 3;
    }
  }
  if (lexicalScore <= 0) {
    return 0;
  }
  return lexicalScore + memoryPriorityScore(input.node);
}

function memoryPriorityScore(node: MemoryNode): number {
  const trend = readRecord(node.metadata.feedbackTrend);
  const useful = readNumber(trend?.useful) ?? 0;
  const irrelevant = readNumber(trend?.irrelevant) ?? 0;
  const feedbackSignal = Math.max(-0.6, Math.min(0.6, (useful - irrelevant) * 0.18));
  const useSignal = Math.min(0.8, node.useCount * 0.12);
  const freshnessSignal = node.lastUsedAt ? 0.18 : 0;
  return node.weight * 2 + useSignal + feedbackSignal + freshnessSignal;
}

function applyGraphEdges(
  hits: MemoryGraphSearchHit[],
  edges: MemoryEdge[],
  minScore: number,
  maxGraphDistance: number
): MemoryGraphSearchHit[] {
  const scored = new Map<string, MemoryGraphSearchHit>();
  const direct = new Set<string>();
  for (const hit of hits) {
    if (hit.score >= minScore) {
      direct.add(hit.node.id);
      hit.graphDistance = 0;
      hit.viaNodeIds = [];
      hit.viaEdgeIds = [];
    }
    scored.set(hit.node.id, { ...hit });
  }

  const rounds = Math.max(1, Math.min(Math.floor(maxGraphDistance), 3));
  for (let distance = 1; distance <= rounds; distance += 1) {
    let changed = false;
    for (const edge of edges) {
      if (edge.relation === "supersedes") {
        changed = applySupersedesPromotion(scored, edge, minScore, distance) || changed;
        continue;
      }
      if (edge.relation === "conflicts_with") {
        continue;
      }
      changed = spreadScore(scored, direct, edge, minScore, distance) || changed;
    }
    if (!changed) {
      break;
    }
  }

  for (const edge of edges) {
    if (edge.relation === "supersedes") {
      applySupersedesDemotion(scored, edge, minScore);
    }
  }

  for (const edge of edges) {
    if (edge.relation === "conflicts_with") {
      applyConflictPenalty(scored, direct, edge, minScore);
    }
  }

  return [...scored.values()];
}

function applySupersedesPromotion(
  scored: Map<string, MemoryGraphSearchHit>,
  edge: MemoryEdge,
  minScore: number,
  distance: number
): boolean {
  const current = scored.get(edge.fromNodeId);
  const superseded = scored.get(edge.toNodeId);
  if (!current || !superseded || superseded.score < minScore) {
    return false;
  }
  return promoteGraphHit(current, superseded, edge, "backward", distance);
}

function applySupersedesDemotion(
  scored: Map<string, MemoryGraphSearchHit>,
  edge: MemoryEdge,
  minScore: number
): void {
  const current = scored.get(edge.fromNodeId);
  const superseded = scored.get(edge.toNodeId);
  if (!current || !superseded || current.score < minScore) {
    return;
  }
  superseded.score = Math.min(superseded.score, minScore - 0.001);
}

function spreadScore(
  scored: Map<string, MemoryGraphSearchHit>,
  direct: Set<string>,
  edge: MemoryEdge,
  minScore: number,
  distance: number
): boolean {
  const from = scored.get(edge.fromNodeId);
  const to = scored.get(edge.toNodeId);
  if (!from || !to) {
    return false;
  }
  let changed = false;
  if (from.score >= minScore) {
    changed = promoteGraphHit(to, from, edge, "forward", distance) || changed;
  }
  if (to.score >= minScore && isBidirectionalRelation(edge.relation)) {
    changed = promoteGraphHit(from, to, edge, "backward", distance) || changed;
  }
  return changed;
}

function applyConflictPenalty(
  scored: Map<string, MemoryGraphSearchHit>,
  direct: Set<string>,
  edge: MemoryEdge,
  minScore: number
): void {
  const from = scored.get(edge.fromNodeId);
  const to = scored.get(edge.toNodeId);
  if (!from || !to || from.score < minScore || to.score < minScore) {
    return;
  }
  if (direct.has(edge.fromNodeId) && !direct.has(edge.toNodeId)) {
    to.score = Math.min(to.score, minScore - 0.001);
    return;
  }
  if (direct.has(edge.toNodeId) && !direct.has(edge.fromNodeId)) {
    from.score = Math.min(from.score, minScore - 0.001);
    return;
  }
  const loser = compareGraphSearchHits(from, to) <= 0 ? to : from;
  loser.score = Math.min(loser.score, minScore - 0.001);
}

function promoteGraphHit(
  target: MemoryGraphSearchHit,
  source: MemoryGraphSearchHit,
  edge: MemoryEdge,
  direction: "forward" | "backward",
  distance: number
): boolean {
  if ((source.graphDistance ?? 0) >= distance) {
    return false;
  }
  const nextScore = relationBoostedScore(source.score, edge, direction, distance);
  if (nextScore <= target.score) {
    if (shouldAttachComparableGraphPath(target, nextScore, distance)) {
      target.graphDistance = distance;
      target.viaNodeIds = [...(source.viaNodeIds ?? []), source.node.id];
      target.viaEdgeIds = [...(source.viaEdgeIds ?? []), edge.id];
      return true;
    }
    return false;
  }
  target.score = nextScore;
  target.graphDistance = distance;
  target.viaNodeIds = [...(source.viaNodeIds ?? []), source.node.id];
  target.viaEdgeIds = [...(source.viaEdgeIds ?? []), edge.id];
  return true;
}

function shouldAttachComparableGraphPath(
  target: MemoryGraphSearchHit,
  nextScore: number,
  distance: number
): boolean {
  if (distance !== 1) return false;
  if ((target.viaEdgeIds?.length ?? 0) > 0) return false;
  if ((target.graphDistance ?? 0) !== 0) return false;
  return nextScore >= target.score * 0.9;
}

function relationBoostedScore(
  score: number,
  edge: MemoryEdge,
  direction: "forward" | "backward",
  distance = 1
): number {
  const base = score * relationStrength(edge.relation, direction) * Math.max(0, edge.weight);
  const distancePenalty = distance <= 1 ? 1 : Math.pow(0.72, distance - 1);
  return base * distancePenalty + relationBonus(edge.relation) / distance;
}

function relationStrength(relation: MemoryEdgeRelation, direction: "forward" | "backward"): number {
  switch (relation) {
    case "belongs_to":
      return direction === "forward" ? 0.88 : 0.35;
    case "depends_on":
      return direction === "forward" ? 0.82 : 0.28;
    case "derived_from":
      return direction === "forward" ? 0.72 : 0.3;
    case "uses_skill":
      return direction === "forward" ? 0.78 : 0.25;
    case "supersedes":
      return direction === "backward" ? 0.95 : 0.05;
    case "conflicts_with":
      return 0;
    case "relates_to":
    default:
      return 0.64;
  }
}

function relationBonus(relation: MemoryEdgeRelation): number {
  if (relation === "supersedes") return 0.35;
  if (relation === "belongs_to" || relation === "depends_on") return 0.2;
  if (relation === "uses_skill") return 0.15;
  return 0.1;
}

function isBidirectionalRelation(relation: MemoryEdgeRelation): boolean {
  return relation === "relates_to" || relation === "conflicts_with";
}

function compareGraphSearchHits(a: MemoryGraphSearchHit, b: MemoryGraphSearchHit): number {
  return (
    b.score - a.score ||
    b.node.weight - a.node.weight ||
    b.node.useCount - a.node.useCount ||
    a.source.uri.localeCompare(b.source.uri) ||
    a.chunk.heading.localeCompare(b.chunk.heading)
  );
}

function compareFeedbackTrends(a: MemoryFeedbackTrend, b: MemoryFeedbackTrend): number {
  return (
    b.net - a.net ||
    b.useful + b.irrelevant - (a.useful + a.irrelevant) ||
    Date.parse(b.lastFeedbackAt ?? b.node.updatedAt) -
      Date.parse(a.lastFeedbackAt ?? a.node.updatedAt) ||
    b.node.weight - a.node.weight ||
    a.node.title.localeCompare(b.node.title)
  );
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function encodeJson(value: Record<string, unknown> | undefined): string {
  return JSON.stringify(value ?? {});
}

function decodeJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function latestIso(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function nowIso(): string {
  return new Date().toISOString();
}
