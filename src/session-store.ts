import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";

import { MagiUsageError } from "./errors.js";
import { MagiPaths } from "./paths.js";

export interface SessionRecord {
  id: string;
  title: string | null;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
  messages: MessageRecord[];
}

export interface MessageRecord {
  id: number;
  sessionId: string;
  role: string;
  content: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface JobRecord {
  id: string;
  sessionId: string;
  kind: string;
  status: string;
  metadata?: Record<string, unknown>;
}

export interface StoredJobRecord extends JobRecord {
  createdAt: string;
  updatedAt: string;
}

export interface AuditRecord {
  sessionId: string;
  jobId?: string;
  action: string;
  target?: string;
  metadata?: Record<string, unknown>;
}

export type StoredAuditRecord = AuditRecord & { id: number; createdAt: string };
export type AuditEventSubscriber = (event: StoredAuditRecord) => void;

export interface UsageRecord {
  sessionId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  metadata?: Record<string, unknown>;
}

export interface DeviceRecord {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  metadata: Record<string, unknown>;
}

export type AgentRole = "explorer" | "worker";

export interface AgentTaskRecord {
  id: string;
  role: AgentRole;
  prompt: string;
  status: "queued" | "running" | "completed" | "cancelled" | "failed";
  cwd: string;
  sessionId: string | null;
  result: string | null;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface WriteClaimRecord {
  id: number;
  taskId: string;
  filePath: string;
  ownerRole: string;
  createdAt: string;
}

export interface ContextSummaryRecord {
  id: string;
  sessionId: string;
  summary: string;
  sourceMessageCount: number;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface McpOAuthTokenRecord {
  serverName: string;
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt?: string;
  scope?: string;
  authServerUrl?: string;
  clientId?: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface SessionSummary {
  id: string;
  title: string | null;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export class SessionStore {
  private readonly db: Database.Database;
  private readonly auditSubscribers = new Set<AuditEventSubscriber>();

  constructor(dbFile: string) {
    const inMemory = dbFile === ":memory:";
    if (!inMemory) {
      mkdirSync(path.dirname(dbFile), { recursive: true, mode: 0o700 });
    }
    this.db = new Database(dbFile);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    // The session DB stores full prompts, executed commands and tool output —
    // keep it owner-only, including the WAL/SHM sidecars sqlite creates.
    // In-memory databases have no on-disk footprint, so skip the chmod pass.
    if (!inMemory) {
      for (const suffix of ["", "-wal", "-shm"]) {
        const file = `${dbFile}${suffix}`;
        try {
          if (existsSync(file)) chmodSync(file, 0o600);
        } catch {
          // best-effort; never block session startup on a chmod failure
        }
      }
    }
    this.migrate();
  }

  static memory(): SessionStore {
    return new SessionStore(":memory:");
  }

  static open(paths: MagiPaths): SessionStore {
    return new SessionStore(paths.sessionDbFile);
  }

  close(): void {
    this.db.close();
  }

  createSession(input: {
    id?: string;
    title?: string;
    cwd: string;
    metadata?: Record<string, unknown>;
  }): string {
    const id = input.id ?? randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        "insert into sessions (id, title, cwd, created_at, updated_at, metadata_json) values (?, ?, ?, ?, ?, ?)"
      )
      .run(id, input.title ?? null, input.cwd, now, now, encodeJson(input.metadata));
    return id;
  }

  appendMessage(input: {
    sessionId: string;
    role: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): number {
    const now = nowIso();
    const result = this.db
      .prepare(
        "insert into messages (session_id, role, content, created_at, metadata_json) values (?, ?, ?, ?, ?)"
      )
      .run(input.sessionId, input.role, input.content, now, encodeJson(input.metadata));
    this.touchSession(input.sessionId, now);
    return Number(result.lastInsertRowid);
  }

  getSession(sessionId: string): SessionRecord | undefined {
    const session = this.db.prepare("select * from sessions where id = ?").get(sessionId) as
      | DbSession
      | undefined;
    if (!session) {
      return undefined;
    }

    const messages = this.db
      .prepare("select * from messages where session_id = ? order by id asc")
      .all(sessionId) as DbMessage[];

    return {
      id: session.id,
      title: session.title,
      cwd: session.cwd,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
      metadata: decodeJson(session.metadata_json),
      messages: messages.map((message) => ({
        id: message.id,
        sessionId: message.session_id,
        role: message.role,
        content: message.content,
        createdAt: message.created_at,
        metadata: decodeJson(message.metadata_json)
      }))
    };
  }

  /** Update a session's title. Returns true if the session existed. */
  renameSession(sessionId: string, title: string): boolean {
    const result = this.db
      .prepare("update sessions set title = ?, updated_at = ? where id = ?")
      .run(title, nowIso(), sessionId);
    return result.changes > 0;
  }

  /**
   * Merge keys into a session's metadata JSON. Set a key to undefined to remove it.
   * Returns true if the session existed.
   */
  updateSessionMetadata(sessionId: string, partial: Record<string, unknown>): boolean {
    const session = this.db
      .prepare("select metadata_json from sessions where id = ?")
      .get(sessionId) as { metadata_json: string } | undefined;
    if (!session) return false;
    const current = decodeJson(session.metadata_json);
    const merged: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(partial)) {
      if (v === undefined) delete merged[k];
      else merged[k] = v;
    }
    this.db
      .prepare("update sessions set metadata_json = ?, updated_at = ? where id = ?")
      .run(encodeJson(merged), nowIso(), sessionId);
    return true;
  }

  /** Delete a session and all its messages. Returns true if the session existed. */
  deleteSession(sessionId: string): boolean {
    // Messages cascade via foreign key
    const result = this.db.prepare("delete from sessions where id = ?").run(sessionId);
    return result.changes > 0;
  }

  /**
   * Drop all messages in a session whose ID is greater than the given message ID.
   * Used by /rewind to remove the last assistant turn (and any subsequent messages).
   * Returns the count of removed messages.
   */
  truncateMessagesAfter(sessionId: string, messageId: number): number {
    const result = this.db
      .prepare("delete from messages where session_id = ? and id > ?")
      .run(sessionId, messageId);
    if (result.changes > 0) {
      this.db.prepare("update sessions set updated_at = ? where id = ?").run(nowIso(), sessionId);
    }
    return result.changes;
  }

  /**
   * Fork a session: copies all messages up to (and including) maxMessageId into
   * a new session. If maxMessageId is omitted, copies all messages.
   * Returns the new session id.
   */
  forkSession(input: {
    sessionId: string;
    title?: string;
    maxMessageId?: number;
  }): string | undefined {
    const original = this.getSession(input.sessionId);
    if (!original) return undefined;
    const newId = this.createSession({
      title: input.title ?? `${original.title ?? "session"} (fork)`,
      cwd: original.cwd,
      metadata: { ...original.metadata, forkedFrom: input.sessionId, forkedAt: nowIso() }
    });
    const cutoff = input.maxMessageId ?? Number.MAX_SAFE_INTEGER;
    for (const msg of original.messages) {
      if (msg.id > cutoff) break;
      this.appendMessage({
        sessionId: newId,
        role: msg.role,
        content: msg.content,
        metadata: msg.metadata
      });
    }
    return newId;
  }

  getMostRecentSession(cwd?: string): SessionRecord | undefined {
    const row = cwd
      ? (this.db
          .prepare("select id from sessions where cwd = ? order by updated_at desc limit 1")
          .get(cwd) as { id: string } | undefined)
      : (this.db.prepare("select id from sessions order by updated_at desc limit 1").get() as
          | { id: string }
          | undefined);
    return row ? this.getSession(row.id) : undefined;
  }

  listSessions(limit = 20): SessionSummary[] {
    const rows = this.db
      .prepare(
        `
        select
          sessions.id,
          sessions.title,
          sessions.cwd,
          sessions.created_at,
          sessions.updated_at,
          count(messages.id) as message_count
        from sessions
        left join messages on messages.session_id = sessions.id
        group by sessions.id
        order by sessions.updated_at desc, sessions.created_at desc, sessions.id desc
        limit ?
        `
      )
      .all(limit) as DbSessionSummary[];

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      cwd: row.cwd,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageCount: row.message_count
    }));
  }

  recordJob(input: JobRecord): void {
    const now = nowIso();
    this.db
      .prepare(
        "insert into jobs (id, session_id, kind, status, created_at, updated_at, metadata_json) values (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        input.id,
        input.sessionId,
        input.kind,
        input.status,
        now,
        now,
        encodeJson(input.metadata)
      );
    this.touchSession(input.sessionId, now);
  }

  updateJobStatus(input: { id: string; status: string; metadata?: Record<string, unknown> }): void {
    this.db
      .prepare("update jobs set status = ?, updated_at = ?, metadata_json = ? where id = ?")
      .run(input.status, nowIso(), encodeJson(input.metadata), input.id);
  }

  getJob(jobId: string): StoredJobRecord | undefined {
    const row = this.db.prepare("select * from jobs where id = ?").get(jobId) as DbJob | undefined;
    return row ? toStoredJob(row) : undefined;
  }

  listJobs(limit = 50): StoredJobRecord[] {
    const rows = this.db
      .prepare("select * from jobs order by updated_at desc limit ?")
      .all(limit) as DbJob[];
    return rows.map(toStoredJob);
  }

  recordAudit(input: AuditRecord): StoredAuditRecord {
    const createdAt = nowIso();
    const result = this.db
      .prepare(
        "insert into audit_events (session_id, job_id, action, target, created_at, metadata_json) values (?, ?, ?, ?, ?, ?)"
      )
      .run(
        input.sessionId,
        input.jobId ?? null,
        input.action,
        input.target ?? null,
        createdAt,
        encodeJson(input.metadata)
      );
    const event: StoredAuditRecord = {
      id: Number(result.lastInsertRowid),
      sessionId: input.sessionId,
      jobId: input.jobId,
      action: input.action,
      target: input.target,
      createdAt,
      metadata: input.metadata ?? {}
    };
    this.publishAuditEvent(event);
    return event;
  }

  listAuditEvents(limit = 100): StoredAuditRecord[] {
    return this.listRecentAuditEvents({ limit });
  }

  listSessionAuditEvents(sessionId: string, limit = 100): StoredAuditRecord[] {
    return this.listRecentAuditEvents({ sessionId, limit });
  }

  listJobAuditEvents(jobId: string, limit = 100): StoredAuditRecord[] {
    return this.listRecentAuditEvents({ jobId, limit });
  }

  listRecentAuditEvents(
    input: {
      sessionId?: string;
      jobId?: string;
      afterId?: number;
      limit?: number;
      order?: "asc" | "desc";
    } = {}
  ): StoredAuditRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (input.sessionId) {
      clauses.push("session_id = ?");
      params.push(input.sessionId);
    }
    if (input.jobId) {
      clauses.push("job_id = ?");
      params.push(input.jobId);
    }
    if (input.afterId !== undefined) {
      clauses.push("id > ?");
      params.push(input.afterId);
    }
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    const order = input.order === "asc" ? "asc" : "desc";
    const limit = clampAuditLimit(input.limit ?? 100);
    const rows = this.db
      .prepare(`select * from audit_events ${where} order by id ${order} limit ?`)
      .all(...params, limit) as DbAuditEvent[];
    return rows.map(toAuditEvent);
  }

  subscribeAuditEvents(subscriber: AuditEventSubscriber): () => void {
    this.auditSubscribers.add(subscriber);
    return () => {
      this.auditSubscribers.delete(subscriber);
    };
  }

  recordUsage(input: UsageRecord): void {
    this.db
      .prepare(
        "insert into usage_events (session_id, provider, model, input_tokens, output_tokens, cost_usd, created_at, metadata_json) values (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        input.sessionId,
        input.provider,
        input.model,
        input.inputTokens,
        input.outputTokens,
        input.costUsd,
        nowIso(),
        encodeJson(input.metadata)
      );
  }

  listSessionUsage(sessionId: string): Array<{
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    createdAt: string;
  }> {
    const rows = this.db
      .prepare(
        "select provider, model, input_tokens, output_tokens, cost_usd, created_at from usage_events where session_id = ? order by id asc"
      )
      .all(sessionId) as Array<{
      provider: string;
      model: string;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
      created_at: string;
    }>;
    return rows.map((r) => ({
      provider: r.provider,
      model: r.model,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      costUsd: r.cost_usd,
      createdAt: r.created_at
    }));
  }

  listAllUsage(limit = 1000): Array<{
    sessionId: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    createdAt: string;
  }> {
    const rows = this.db
      .prepare(
        "select session_id, provider, model, input_tokens, output_tokens, cost_usd, created_at from usage_events order by id desc limit ?"
      )
      .all(limit) as Array<{
      session_id: string;
      provider: string;
      model: string;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
      created_at: string;
    }>;
    return rows.map((r) => ({
      sessionId: r.session_id,
      provider: r.provider,
      model: r.model,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      costUsd: r.cost_usd,
      createdAt: r.created_at
    }));
  }

  countRows(table: "jobs" | "audit_events" | "usage_events"): number {
    const row = this.db.prepare(`select count(*) as count from ${table}`).get() as {
      count: number;
    };
    return row.count;
  }

  upsertDevice(input: {
    id: string;
    name: string;
    tokenHash: string;
    expiresAt: string;
    metadata?: Record<string, unknown>;
  }): void {
    const now = nowIso();
    this.db
      .prepare(
        `insert into devices (id, name, token_hash, created_at, expires_at, metadata_json)
         values (?, ?, ?, ?, ?, ?)
         on conflict(id) do update set
           name = excluded.name,
           token_hash = excluded.token_hash,
           expires_at = excluded.expires_at,
           metadata_json = excluded.metadata_json`
      )
      .run(input.id, input.name, input.tokenHash, now, input.expiresAt, encodeJson(input.metadata));
  }

  getDevice(deviceId: string): DeviceRecord | undefined {
    const row = this.db.prepare("select * from devices where id = ?").get(deviceId) as
      | DbDevice
      | undefined;
    return row ? toDevice(row) : undefined;
  }

  listDevices(): DeviceRecord[] {
    const rows = this.db
      .prepare("select * from devices order by created_at desc")
      .all() as DbDevice[];
    return rows.map(toDevice);
  }

  createAgentTask(input: {
    id?: string;
    role: AgentRole;
    prompt: string;
    cwd: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
  }): string {
    const id = input.id ?? randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        `insert into agent_tasks (id, role, prompt, status, cwd, session_id, result, created_at, updated_at, metadata_json)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.role,
        input.prompt,
        "queued",
        input.cwd,
        input.sessionId ?? null,
        null,
        now,
        now,
        encodeJson(input.metadata)
      );
    return id;
  }

  updateAgentTask(input: {
    id: string;
    status: AgentTaskRecord["status"];
    result?: string | null;
    metadata?: Record<string, unknown>;
  }): void {
    const existing = this.getAgentTask(input.id);
    this.db
      .prepare(
        "update agent_tasks set status = ?, result = ?, updated_at = ?, metadata_json = ? where id = ?"
      )
      .run(
        input.status,
        input.result ?? existing?.result ?? null,
        nowIso(),
        encodeJson(input.metadata ?? existing?.metadata),
        input.id
      );
  }

  getAgentTask(taskId: string): AgentTaskRecord | undefined {
    const row = this.db.prepare("select * from agent_tasks where id = ?").get(taskId) as
      | DbAgentTask
      | undefined;
    return row ? toAgentTask(row) : undefined;
  }

  listAgentTasks(limit = 50): AgentTaskRecord[] {
    const rows = this.db
      .prepare("select * from agent_tasks order by updated_at desc limit ?")
      .all(limit) as DbAgentTask[];
    return rows.map(toAgentTask);
  }

  getWriteClaimByFile(filePath: string, excludeTaskId?: string): WriteClaimRecord | undefined {
    const row = (
      excludeTaskId
        ? this.db
            .prepare(
              "select * from write_claims where file_path = ? and task_id != ? order by id asc limit 1"
            )
            .get(filePath, excludeTaskId)
        : this.db
            .prepare("select * from write_claims where file_path = ? order by id asc limit 1")
            .get(filePath)
    ) as DbWriteClaim | undefined;
    return row ? toWriteClaim(row) : undefined;
  }

  claimWriteFile(input: { taskId: string; filePath: string; ownerRole: string }): WriteClaimRecord {
    const existing = this.getWriteClaimByFile(input.filePath, input.taskId);
    if (existing) {
      throw new MagiUsageError(
        `Write conflict for ${input.filePath}: already claimed by ${existing.taskId}`
      );
    }
    const result = this.db
      .prepare(
        "insert into write_claims (task_id, file_path, owner_role, created_at) values (?, ?, ?, ?)"
      )
      .run(input.taskId, input.filePath, input.ownerRole, nowIso());
    return {
      id: Number(result.lastInsertRowid),
      taskId: input.taskId,
      filePath: input.filePath,
      ownerRole: input.ownerRole,
      createdAt: nowIso()
    };
  }

  listWriteClaims(): WriteClaimRecord[] {
    const rows = this.db
      .prepare("select * from write_claims order by id asc")
      .all() as DbWriteClaim[];
    return rows.map(toWriteClaim);
  }

  recordContextSummary(input: {
    id?: string;
    sessionId: string;
    summary: string;
    sourceMessageCount: number;
    metadata?: Record<string, unknown>;
  }): ContextSummaryRecord {
    const id = input.id ?? randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        `insert into context_summaries (id, session_id, summary, source_message_count, created_at, metadata_json)
         values (?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.sessionId,
        input.summary,
        input.sourceMessageCount,
        now,
        encodeJson(input.metadata)
      );
    this.touchSession(input.sessionId, now);
    return {
      id,
      sessionId: input.sessionId,
      summary: input.summary,
      sourceMessageCount: input.sourceMessageCount,
      createdAt: now,
      metadata: input.metadata ?? {}
    };
  }

  getLatestContextSummary(sessionId: string): ContextSummaryRecord | undefined {
    const row = this.db
      .prepare(
        "select * from context_summaries where session_id = ? order by created_at desc, id desc limit 1"
      )
      .get(sessionId) as DbContextSummary | undefined;
    return row ? toContextSummary(row) : undefined;
  }

  listContextSummaries(sessionId: string): ContextSummaryRecord[] {
    const rows = this.db
      .prepare(
        "select * from context_summaries where session_id = ? order by created_at desc, id desc"
      )
      .all(sessionId) as DbContextSummary[];
    return rows.map(toContextSummary);
  }

  private touchSession(sessionId: string, updatedAt: string): void {
    this.db.prepare("update sessions set updated_at = ? where id = ?").run(updatedAt, sessionId);
  }

  private publishAuditEvent(event: StoredAuditRecord): void {
    for (const subscriber of this.auditSubscribers) {
      try {
        subscriber(event);
      } catch {
        this.auditSubscribers.delete(subscriber);
      }
    }
  }

  // --- MCP OAuth Token Storage ---

  upsertMcpOAuthToken(input: {
    serverName: string;
    accessToken: string;
    refreshToken?: string;
    tokenType?: string;
    expiresAt?: string;
    scope?: string;
    authServerUrl?: string;
    clientId?: string;
    metadata?: Record<string, unknown>;
  }): void {
    const now = nowIso();
    this.db
      .prepare(
        `insert into mcp_oauth_tokens
           (server_name, access_token, refresh_token, token_type, expires_at, scope, auth_server_url, client_id, created_at, updated_at, metadata_json)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(server_name) do update set
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           token_type = excluded.token_type,
           expires_at = excluded.expires_at,
           scope = excluded.scope,
           auth_server_url = excluded.auth_server_url,
           client_id = excluded.client_id,
           updated_at = excluded.updated_at,
           metadata_json = excluded.metadata_json`
      )
      .run(
        input.serverName,
        input.accessToken,
        input.refreshToken ?? null,
        input.tokenType ?? "Bearer",
        input.expiresAt ?? null,
        input.scope ?? null,
        input.authServerUrl ?? null,
        input.clientId ?? null,
        now,
        now,
        encodeJson(input.metadata)
      );
  }

  getMcpOAuthToken(serverName: string): McpOAuthTokenRecord | undefined {
    const row = this.db
      .prepare("select * from mcp_oauth_tokens where server_name = ?")
      .get(serverName) as DbMcpOAuthToken | undefined;
    if (!row) return undefined;
    return {
      serverName: row.server_name,
      accessToken: row.access_token,
      refreshToken: row.refresh_token ?? undefined,
      tokenType: row.token_type,
      expiresAt: row.expires_at ?? undefined,
      scope: row.scope ?? undefined,
      authServerUrl: row.auth_server_url ?? undefined,
      clientId: row.client_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      metadata: decodeJson(row.metadata_json)
    };
  }

  deleteMcpOAuthToken(serverName: string): void {
    this.db.prepare("delete from mcp_oauth_tokens where server_name = ?").run(serverName);
  }

  listMcpOAuthTokens(): McpOAuthTokenRecord[] {
    const rows = this.db
      .prepare("select * from mcp_oauth_tokens order by server_name")
      .all() as DbMcpOAuthToken[];
    return rows.map((row) => ({
      serverName: row.server_name,
      accessToken: row.access_token,
      refreshToken: row.refresh_token ?? undefined,
      tokenType: row.token_type,
      expiresAt: row.expires_at ?? undefined,
      scope: row.scope ?? undefined,
      authServerUrl: row.auth_server_url ?? undefined,
      clientId: row.client_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      metadata: decodeJson(row.metadata_json)
    }));
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists sessions (
        id text primary key,
        title text,
        cwd text not null,
        created_at text not null,
        updated_at text not null,
        metadata_json text not null
      );

      create table if not exists messages (
        id integer primary key autoincrement,
        session_id text not null references sessions(id) on delete cascade,
        role text not null,
        content text not null,
        created_at text not null,
        metadata_json text not null
      );

      create table if not exists jobs (
        id text primary key,
        session_id text not null references sessions(id) on delete cascade,
        kind text not null,
        status text not null,
        created_at text not null,
        updated_at text not null,
        metadata_json text not null
      );

      create table if not exists audit_events (
        id integer primary key autoincrement,
        session_id text not null references sessions(id) on delete cascade,
        job_id text,
        action text not null,
        target text,
        created_at text not null,
        metadata_json text not null
      );

      create table if not exists usage_events (
        id integer primary key autoincrement,
        session_id text not null references sessions(id) on delete cascade,
        provider text not null,
        model text not null,
        input_tokens integer not null,
        output_tokens integer not null,
        cost_usd real not null,
        created_at text not null,
        metadata_json text not null
      );

      create table if not exists devices (
        id text primary key,
        name text not null,
        token_hash text not null,
        created_at text not null,
        expires_at text not null,
        metadata_json text not null
      );

      create table if not exists agent_tasks (
        id text primary key,
        role text not null,
        prompt text not null,
        status text not null,
        cwd text not null,
        session_id text,
        result text,
        created_at text not null,
        updated_at text not null,
        metadata_json text not null
      );

      create table if not exists write_claims (
        id integer primary key autoincrement,
        task_id text not null,
        file_path text not null,
        owner_role text not null,
        created_at text not null
      );

      create table if not exists context_summaries (
        id text primary key,
        session_id text not null references sessions(id) on delete cascade,
        summary text not null,
        source_message_count integer not null,
        created_at text not null,
        metadata_json text not null
      );

      create table if not exists mcp_oauth_tokens (
        server_name text primary key,
        access_token text not null,
        refresh_token text,
        token_type text not null default 'Bearer',
        expires_at text,
        scope text,
        auth_server_url text,
        client_id text,
        created_at text not null,
        updated_at text not null,
        metadata_json text not null default '{}'
      );
    `);
  }
}

interface DbSession {
  id: string;
  title: string | null;
  cwd: string;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

interface DbMessage {
  id: number;
  session_id: string;
  role: string;
  content: string;
  created_at: string;
  metadata_json: string;
}

interface DbJob {
  id: string;
  session_id: string;
  kind: string;
  status: string;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

interface DbAuditEvent {
  id: number;
  session_id: string;
  job_id: string | null;
  action: string;
  target: string | null;
  created_at: string;
  metadata_json: string;
}

interface DbDevice {
  id: string;
  name: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  metadata_json: string;
}

interface DbAgentTask {
  id: string;
  role: AgentRole;
  prompt: string;
  status: AgentTaskRecord["status"];
  cwd: string;
  session_id: string | null;
  result: string | null;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

interface DbWriteClaim {
  id: number;
  task_id: string;
  file_path: string;
  owner_role: string;
  created_at: string;
}

interface DbContextSummary {
  id: string;
  session_id: string;
  summary: string;
  source_message_count: number;
  created_at: string;
  metadata_json: string;
}

interface DbMcpOAuthToken {
  server_name: string;
  access_token: string;
  refresh_token: string | null;
  token_type: string;
  expires_at: string | null;
  scope: string | null;
  auth_server_url: string | null;
  client_id: string | null;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

function toStoredJob(row: DbJob): StoredJobRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: decodeJson(row.metadata_json)
  };
}

function toAuditEvent(row: DbAuditEvent): StoredAuditRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    jobId: row.job_id ?? undefined,
    action: row.action,
    target: row.target ?? undefined,
    createdAt: row.created_at,
    metadata: decodeJson(row.metadata_json)
  };
}

function toDevice(row: DbDevice): DeviceRecord {
  return {
    id: row.id,
    name: row.name,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    metadata: decodeJson(row.metadata_json)
  };
}

function toAgentTask(row: DbAgentTask): AgentTaskRecord {
  return {
    id: row.id,
    role: row.role,
    prompt: row.prompt,
    status: row.status,
    cwd: row.cwd,
    sessionId: row.session_id,
    result: row.result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: decodeJson(row.metadata_json)
  };
}

function toWriteClaim(row: DbWriteClaim): WriteClaimRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    filePath: row.file_path,
    ownerRole: row.owner_role,
    createdAt: row.created_at
  };
}

function toContextSummary(row: DbContextSummary): ContextSummaryRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    summary: row.summary,
    sourceMessageCount: row.source_message_count,
    createdAt: row.created_at,
    metadata: decodeJson(row.metadata_json)
  };
}

interface DbSessionSummary {
  id: string;
  title: string | null;
  cwd: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function encodeJson(value: Record<string, unknown> | undefined): string {
  return JSON.stringify(value ?? {});
}

function decodeJson(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function clampAuditLimit(value: number): number {
  return Number.isInteger(value) && value >= 1 && value <= 500 ? value : 100;
}
