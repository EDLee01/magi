import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
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

export interface MemoryEdge {
  id: number;
  fromNodeId: string;
  toNodeId: string;
  relation: MemoryEdgeRelation;
  weight: number;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export function classifyMemoryNodeType(
  text: string,
  input: { scope?: "project" | "user" | "session" } = {}
): MemoryNodeType {
  if (input.scope === "project") return "project";
  if (input.scope === "session") return "session";

  const normalized = normalizeClassifierText(text);
  if (!normalized) return "user_profile";

  if (hasAny(normalized, [
    "workflow", "process", "procedure", "runbook", "checklist", "playbook",
    "工作流", "流程", "步骤", "sop"
  ])) {
    return "workflow";
  }

  if (
    hasAny(normalized, ["work habit", "habit", "usually", "normally", "routine", "工作习惯", "习惯", "通常", "一般"]) ||
    (
      hasAny(normalized, ["before", "after", "first", "then", "prioritize", "先", "再", "优先"]) &&
      hasAny(normalized, ["check", "test", "verify", "verification", "build", "review", "验证", "测试", "检查"])
    )
  ) {
    return "work_habit";
  }

  if (hasAny(normalized, [
    "i am", "i'm", "my name is", "call me", "my role is", "身份", "我是", "我叫", "我的名字", "称呼我"
  ])) {
    return "user_profile";
  }

  if (hasAny(normalized, ["skill", "skill.md", "技能"])) {
    return "skill_ref";
  }

  if (hasAny(normalized, ["http://", "https://", "docs", "documentation", "reference", "link", "url", "文档", "链接", "参考"])) {
    return "reference";
  }

  if (hasAny(normalized, ["project", "repo", "repository", "codebase", "magi", "项目", "仓库", "代码库"])) {
    return "project";
  }

  if (hasAny(normalized, ["decision", "decided", "we chose", "architecture", "technical direction", "决定", "决策", "技术路线", "架构"])) {
    return "decision";
  }

  if (hasAny(normalized, ["problem", "issue", "bug", "error", "failure", "failed", "broken", "risk", "问题", "错误", "失败", "异常", "风险"])) {
    return "problem";
  }

  if (hasAny(normalized, [
    "prefer", "preference", "likes", "dislikes", "wants", "default", "style", "tone", "language",
    "偏好", "喜欢", "不喜欢", "默认", "风格", "语气", "语言", "简洁"
  ])) {
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
      this.db.prepare(`
        update memory_nodes
        set title = ?, summary = ?, body = ?, weight = ?, status = 'active', source = ?,
            source_session_id = ?, updated_at = ?, metadata_json = ?
        where id = ?
      `).run(
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
    this.db.prepare(`
      insert into memory_nodes
        (id, type, title, summary, body, weight, status, source, source_session_id,
         created_at, updated_at, last_used_at, use_count, metadata_json)
      values (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, null, 0, ?)
    `).run(
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

  getNode(id: string): MemoryNode | undefined {
    const row = this.db.prepare("select * from memory_nodes where id = ?").get(id) as DbMemoryNode | undefined;
    return row ? toMemoryNode(row) : undefined;
  }

  listHotNodes(input: ListHotMemoryNodesInput = {}): MemoryNode[] {
    const limit = Math.max(1, Math.min(input.limit ?? 12, 50));
    const minWeight = input.minWeight ?? 0.25;
    const rows = this.db.prepare(`
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
    `).all(minWeight, limit) as DbMemoryNode[];
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

  addEdge(input: {
    fromNodeId: string;
    toNodeId: string;
    relation: MemoryEdgeRelation;
    weight?: number;
    metadata?: Record<string, unknown>;
  }): MemoryEdge {
    const now = nowIso();
    const result = this.db.prepare(`
      insert into memory_edges (from_node_id, to_node_id, relation, weight, created_at, metadata_json)
      values (?, ?, ?, ?, ?, ?)
    `).run(
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

  private findDuplicate(type: MemoryNodeType, body: string): MemoryNode | undefined {
    const row = this.db.prepare(`
      select * from memory_nodes
      where type = ? and lower(body) = lower(?) and status != 'archived'
      order by updated_at desc
      limit 1
    `).get(type, body) as DbMemoryNode | undefined;
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
    `);
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

function defaultTitle(type: MemoryNodeType, body: string): string {
  const prefix = type.split("_").map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
  return `${prefix}: ${defaultSummary(body).slice(0, 60)}`;
}

function defaultSummary(body: string): string {
  return normalizeWhitespace(body).slice(0, 160);
}

function defaultWeight(source: string): number {
  return source === "explicit" ? 0.95 : 0.45;
}

function normalizeWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function normalizeClassifierText(text: string): string {
  return normalizeWhitespace(text).toLowerCase();
}

function hasAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function encodeJson(value: Record<string, unknown> | undefined): string {
  return JSON.stringify(value ?? {});
}

function decodeJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function nowIso(): string {
  return new Date().toISOString();
}
