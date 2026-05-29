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
  ageDays: number;
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
  metadata: Record<string, unknown>;
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
}

export interface MemoryGraphSearchHit {
  node: MemoryNode;
  source: MemorySource;
  chunk: MemoryChunk;
  score: number;
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
      "reference",
      "link",
      "url",
      "文档",
      "链接",
      "参考"
    ])
  ) {
    return "reference";
  }

  if (
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
      const weight = Math.max(node?.weight ?? 0, input.weight ?? defaultWeight(source.kind));
      const nodeStatus = node?.status === "disputed" ? "disputed" : "active";
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
            status = 'active', updated_at = ?, metadata_json = ?
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
    const rankedHits = applyGraphEdges(baseHits, this.listActiveEdges(), minScore)
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
        return {
          node,
          previousWeight: node.weight,
          nextWeight: Math.max(minWeight, Number((node.weight * (1 - decay)).toFixed(6))),
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
      metadata: input.metadata ?? {}
    };
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

function toMemoryEdge(row: DbMemoryEdge): MemoryEdge {
  return {
    id: row.id,
    fromNodeId: row.from_node_id,
    toNodeId: row.to_node_id,
    relation: row.relation,
    weight: row.weight,
    createdAt: row.created_at,
    metadata: decodeJson(row.metadata_json)
  };
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

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("Memory decay value must be a finite number");
  }
  return Math.max(min, Math.min(max, value));
}

function normalizeClassifierText(text: string): string {
  return normalizeWhitespace(text).toLowerCase();
}

function hasAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function tokenizeSearch(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_-]+/gu, " ")
        .split(/\s+/)
        .map((term) => term.trim())
        .filter(isSearchTerm)
    )
  );
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
  let score = 0;
  for (const term of terms) {
    if (words.includes(term)) {
      score += 5;
    } else if (words.some((word) => word.includes(term) || term.includes(word))) {
      score += 1;
    }
    if (input.source.uri.toLowerCase().includes(term)) {
      score += 3;
    }
  }
  return score > 0 ? score + input.node.weight : 0;
}

function applyGraphEdges(
  hits: MemoryGraphSearchHit[],
  edges: MemoryEdge[],
  minScore: number
): MemoryGraphSearchHit[] {
  const scored = new Map<string, MemoryGraphSearchHit>();
  const direct = new Set<string>();
  for (const hit of hits) {
    if (hit.score >= minScore) {
      direct.add(hit.node.id);
    }
    scored.set(hit.node.id, { ...hit });
  }

  for (const edge of edges) {
    if (edge.relation === "supersedes") {
      applySupersedesPromotion(scored, edge, minScore);
      continue;
    }
    if (edge.relation === "conflicts_with") {
      continue;
    }
    spreadScore(scored, direct, edge, minScore);
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
  minScore: number
): void {
  const current = scored.get(edge.fromNodeId);
  const superseded = scored.get(edge.toNodeId);
  if (!current || !superseded || superseded.score < minScore) {
    return;
  }
  current.score = Math.max(current.score, relationBoostedScore(superseded.score, edge, "backward"));
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
  minScore: number
): void {
  const from = scored.get(edge.fromNodeId);
  const to = scored.get(edge.toNodeId);
  if (!from || !to) {
    return;
  }
  if (from.score >= minScore) {
    to.score = Math.max(to.score, relationBoostedScore(from.score, edge, "forward"));
  }
  if (to.score >= minScore && isBidirectionalRelation(edge.relation)) {
    from.score = Math.max(from.score, relationBoostedScore(to.score, edge, "backward"));
  }
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

function relationBoostedScore(
  score: number,
  edge: MemoryEdge,
  direction: "forward" | "backward"
): number {
  const base = score * relationStrength(edge.relation, direction) * Math.max(0, edge.weight);
  return base + relationBonus(edge.relation);
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

function nowIso(): string {
  return new Date().toISOString();
}
