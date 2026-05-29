import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { getMagiPaths } from "../src/paths.js";
import { SessionStore } from "../src/session-store.js";
import { makeTempRoot, TempRoot } from "./helpers.js";

let temp: TempRoot | undefined;

afterEach(() => {
  temp?.cleanup();
  temp = undefined;
});

describe("SQLite session store", () => {
  it("creates sessions, appends messages, reads sessions, and records job/audit/usage", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    const store = SessionStore.open(paths);
    try {
      const sessionId = store.createSession({ cwd: process.cwd(), title: "test session" });
      const messageId = store.appendMessage({
        sessionId,
        role: "user",
        content: "hello",
        metadata: { channel: "test" }
      });
      store.recordJob({ id: "job-1", sessionId, kind: "test", status: "queued" });
      const seen: string[] = [];
      const unsubscribe = store.subscribeAuditEvents((event) => {
        seen.push(`${event.id}:${event.action}:${event.target ?? ""}`);
      });
      const audit = store.recordAudit({
        sessionId,
        jobId: "job-1",
        action: "job.created",
        target: "test"
      });
      unsubscribe();
      store.recordAudit({ sessionId, jobId: "job-2", action: "job.created", target: "other" });
      store.recordUsage({
        sessionId,
        provider: "none",
        model: "none",
        inputTokens: 1,
        outputTokens: 2,
        costUsd: 0
      });
      const summary = store.recordContextSummary({
        sessionId,
        summary: "FACT: hello is important",
        sourceMessageCount: 1
      });

      const session = store.getSession(sessionId);
      expect(session?.id).toBe(sessionId);
      expect(session?.messages).toHaveLength(1);
      expect(session?.messages[0]).toMatchObject({ id: messageId, role: "user", content: "hello" });
      expect(store.listSessions()).toMatchObject([
        { id: sessionId, title: "test session", messageCount: 1 }
      ]);
      expect(store.countRows("jobs")).toBe(1);
      expect(store.countRows("audit_events")).toBe(2);
      expect(audit).toMatchObject({
        sessionId,
        jobId: "job-1",
        action: "job.created",
        target: "test"
      });
      expect(seen).toEqual([`${audit.id}:job.created:test`]);
      expect(store.listSessionAuditEvents(sessionId, 10).map((event) => event.action)).toEqual([
        "job.created",
        "job.created"
      ]);
      expect(store.listRecentAuditEvents({ afterId: audit.id, order: "asc" })).toEqual([
        expect.objectContaining({ action: "job.created", target: "other" })
      ]);
      expect(store.listJobAuditEvents("job-1", 10)).toEqual([
        expect.objectContaining({ sessionId, jobId: "job-1", target: "test" })
      ]);
      expect(store.countRows("usage_events")).toBe(1);
      expect(store.getLatestContextSummary(sessionId)?.id).toBe(summary.id);
      expect(store.listContextSummaries(sessionId)).toHaveLength(1);
    } finally {
      store.close();
    }

    expect(existsSync(paths.sessionDbFile)).toBe(true);
    expect(paths.sessionDbFile).toContain("/state/");
  });

  it("stores, retrieves, and deletes MCP OAuth tokens", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    const store = new SessionStore(paths.sessionDbFile);
    try {
      // Empty initially
      expect(store.listMcpOAuthTokens()).toEqual([]);
      expect(store.getMcpOAuthToken("linear")).toBeUndefined();

      // Insert
      store.upsertMcpOAuthToken({
        serverName: "linear",
        accessToken: "at-1",
        refreshToken: "rt-1",
        tokenType: "Bearer",
        expiresAt: "2099-12-31T00:00:00Z",
        scope: "read",
        authServerUrl: "https://auth.linear.app",
        clientId: "client-abc"
      });
      const stored = store.getMcpOAuthToken("linear");
      expect(stored?.accessToken).toBe("at-1");
      expect(stored?.refreshToken).toBe("rt-1");
      expect(stored?.scope).toBe("read");
      expect(stored?.authServerUrl).toBe("https://auth.linear.app");
      expect(stored?.clientId).toBe("client-abc");

      // Update overwrites
      store.upsertMcpOAuthToken({
        serverName: "linear",
        accessToken: "at-2",
        refreshToken: "rt-2",
        scope: "read write"
      });
      const updated = store.getMcpOAuthToken("linear");
      expect(updated?.accessToken).toBe("at-2");
      expect(updated?.refreshToken).toBe("rt-2");
      expect(updated?.scope).toBe("read write");

      // List with another server
      store.upsertMcpOAuthToken({ serverName: "notion", accessToken: "n-token" });
      expect(store.listMcpOAuthTokens()).toHaveLength(2);
      expect(
        store
          .listMcpOAuthTokens()
          .map((t) => t.serverName)
          .sort()
      ).toEqual(["linear", "notion"]);

      // Delete
      store.deleteMcpOAuthToken("linear");
      expect(store.getMcpOAuthToken("linear")).toBeUndefined();
      expect(store.listMcpOAuthTokens().map((t) => t.serverName)).toEqual(["notion"]);
    } finally {
      store.close();
    }
  });

  it("renames, forks, truncates, and deletes sessions", () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    const store = new SessionStore(paths.sessionDbFile);
    try {
      const id = store.createSession({ title: "original", cwd: "/cwd" });
      const m1 = store.appendMessage({ sessionId: id, role: "user", content: "hello" });
      const m2 = store.appendMessage({ sessionId: id, role: "assistant", content: "hi" });
      const m3 = store.appendMessage({ sessionId: id, role: "user", content: "world" });

      // Rename
      expect(store.renameSession(id, "new title")).toBe(true);
      expect(store.getSession(id)?.title).toBe("new title");
      expect(store.renameSession("does-not-exist", "x")).toBe(false);

      // Fork up to message 2
      const forkId = store.forkSession({ sessionId: id, maxMessageId: m2 });
      expect(forkId).toBeDefined();
      const fork = store.getSession(forkId!);
      expect(fork?.messages.length).toBe(2);
      expect(fork?.title).toContain("fork");
      expect(fork?.metadata.forkedFrom).toBe(id);

      // Truncate after message 2
      const removed = store.truncateMessagesAfter(id, m2);
      expect(removed).toBe(1);
      expect(store.getSession(id)?.messages.length).toBe(2);
      expect(store.getSession(id)?.messages.map((m) => m.id)).toEqual([m1, m2]);

      // Delete cascades messages
      expect(store.deleteSession(id)).toBe(true);
      expect(store.getSession(id)).toBeUndefined();
      // Fork should still exist (independent)
      expect(store.getSession(forkId!)?.messages.length).toBe(2);
    } finally {
      store.close();
    }
  });
});
