import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { runCli } from "../src/cli.js";
import {
  compactSession,
  compactSessionWithHooks,
  compactSessionWithModel,
  microcompactMessages,
  recoverSessionContext
} from "../src/context/compaction.js";
import { computeSessionContextBudget, estimateTokens } from "../src/context/token-budget.js";
import { ProviderAdapter } from "../src/providers/ir.js";
import { ensureMagiHome, getMagiPaths } from "../src/paths.js";
import { SessionStore } from "../src/session-store.js";
import { makeTempRoot, TempRoot } from "./helpers.js";

let temp: TempRoot | undefined;

afterEach(() => {
  temp?.cleanup();
  temp = undefined;
});

describe("context budget and compaction", () => {
  it("estimates tokens and breaks budget down by role and summaries", () => {
    temp = makeTempRoot();
    const store = SessionStore.open(getMagiPaths(temp.env));
    try {
      const sessionId = seedContextSession(store);
      const session = store.getSession(sessionId);
      expect(session).toBeTruthy();
      const summary = store.recordContextSummary({
        sessionId,
        summary: "DECISION: keep MAGI_CONFIG_DIR as the test isolation switch",
        sourceMessageCount: 3
      });

      const budget = computeSessionContextBudget({ session: session!, summaries: [summary] });
      expect(budget.sessionId).toBe(sessionId);
      expect(budget.messageCount).toBe(3);
      expect(budget.summaryCount).toBe(1);
      expect(budget.estimatedTokens).toBeGreaterThan(0);
      expect(budget.categories.map((category) => category.category)).toEqual([
        "user",
        "assistant",
        "tool",
        "summary"
      ]);
      expect(estimateTokens("hello world")).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it("compacts long sessions into a recoverable summary that preserves required facts", () => {
    temp = makeTempRoot();
    const store = SessionStore.open(getMagiPaths(temp.env));
    try {
      const sessionId = seedContextSession(store);
      for (let index = 0; index < 8; index += 1) {
        store.appendMessage({ sessionId, role: "assistant", content: `routine update ${index}` });
      }

      const result = compactSession({ store, sessionId, recentMessages: 4 });
      expect(result.summary.summary).toContain("FACT: root stays ~/.magi-next");
      expect(result.summary.summary).toContain("TODO: add context budget command");
      expect(result.summary.summary).toContain("DECISION: summary is deterministic");
      expect(result.recovered.summary?.id).toBe(result.summary.id);
      expect(result.recovered.recentMessages).toHaveLength(4);

      const recovered = recoverSessionContext({ store, sessionId, recentMessages: 2 });
      expect(recovered.summary?.summary).toContain("FACT: root stays ~/.magi-next");
      expect(recovered.recentMessages).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("extracts structured facts from tool results so compaction does not lose side-effects", () => {
    temp = makeTempRoot();
    const store = SessionStore.open(getMagiPaths(temp.env));
    try {
      const sessionId = store.createSession({ title: "smart-compact", cwd: process.cwd() });
      // Original user task — should always survive compaction.
      store.appendMessage({
        sessionId,
        role: "user",
        content: "implement an MFA model for global microplastics"
      });
      // File operations.
      store.appendMessage({
        sessionId,
        role: "tool",
        content: "Wrote scripts/mfa_model.py (4830 bytes)"
      });
      store.appendMessage({
        sessionId,
        role: "tool",
        content: "Edited scripts/visualize.py"
      });
      store.appendMessage({
        sessionId,
        role: "tool",
        content: "Deleted /tmp/oldfile.txt"
      });
      // Package install.
      store.appendMessage({
        sessionId,
        role: "tool",
        content: "Successfully installed meshio-5.3.5 numpy-2.0.2"
      });
      // Error to be preserved.
      store.appendMessage({
        sessionId,
        role: "tool",
        content: "ToolError: Path /etc/passwd is outside allowed directories"
      });
      // Bunch of routine messages so a compaction is meaningful.
      for (let i = 0; i < 10; i++) {
        store.appendMessage({ sessionId, role: "assistant", content: `routine ${i}` });
      }

      const result = compactSession({ store, sessionId, recentMessages: 4 });
      const summary = result.summary.summary;

      // Original task preserved verbatim.
      expect(summary).toContain("implement an MFA model for global microplastics");
      // File side-effects preserved.
      expect(summary).toContain("file_written: scripts/mfa_model.py");
      expect(summary).toContain("file_edited: scripts/visualize.py");
      expect(summary).toContain("file_deleted: /tmp/oldfile.txt");
      // Install preserved.
      expect(summary).toContain("meshio-5.3.5");
      // Error preserved.
      expect(summary).toContain("Path /etc/passwd is outside allowed directories");
    } finally {
      store.close();
    }
  });

  it("microcompacts duplicate and oversized tool output before LLM summarization", () => {
    temp = makeTempRoot();
    const store = SessionStore.open(getMagiPaths(temp.env));
    try {
      const sessionId = seedContextSession(store);
      store.appendMessage({ sessionId, role: "tool", content: "same output" });
      store.appendMessage({ sessionId, role: "tool", content: "same output" });
      store.appendMessage({ sessionId, role: "tool", content: "x".repeat(60) });
      store.appendMessage({ sessionId, role: "system", content: "system one" });
      store.appendMessage({ sessionId, role: "system", content: "system two" });
      const session = store.getSession(sessionId)!;

      const compacted = microcompactMessages(session.messages, { maxToolResultChars: 40 });

      expect(compacted.removedDuplicateToolResults).toBe(1);
      expect(compacted.truncatedToolResults).toBe(1);
      expect(compacted.mergedSystemMessages).toBe(1);
      expect(
        compacted.messages.some((message) => message.content.includes("[tool result truncated]"))
      ).toBe(true);
      expect(compacted.messages.at(-1)?.content).toContain("system one\nsystem two");
    } finally {
      store.close();
    }
  });

  it("uses an explicit model runner for LLM compaction", async () => {
    temp = makeTempRoot();
    const store = SessionStore.open(getMagiPaths(temp.env));
    const calls: Array<{ model: string; prompt: string; maxOutputTokens?: number }> = [];
    try {
      const sessionId = seedContextSession(store);
      store.appendMessage({ sessionId, role: "tool", content: "duplicate output" });
      store.appendMessage({ sessionId, role: "tool", content: "duplicate output" });
      const adapter: ProviderAdapter = {
        name: "summary-provider",
        complete: async (request) => {
          const text =
            request.messages[0].content[0].type === "text"
              ? request.messages[0].content[0].text
              : "";
          calls.push({
            model: request.model,
            prompt: text,
            maxOutputTokens: request.maxOutputTokens
          });
          return { text: "LLM SUMMARY: keep root and pending context work" };
        }
      };

      const result = await compactSessionWithModel({
        store,
        sessionId,
        adapter,
        providerName: "summary",
        model: "haiku-explicit",
        recentMessages: 2
      });

      expect(result.summary.summary).toBe("LLM SUMMARY: keep root and pending context work");
      expect(result.summary.metadata).toMatchObject({
        kind: "llm-summary",
        provider: "summary",
        model: "haiku-explicit",
        microcompact: { removedDuplicateToolResults: 1 }
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].model).toBe("haiku-explicit");
      expect(calls[0].prompt).toContain("Summarize this Magi session");
      expect(calls[0].prompt).toContain("FACT: root stays ~/.magi-next");
      expect(calls[0].maxOutputTokens).toBe(20_000);
    } finally {
      store.close();
    }
  });

  it("runs pre_compact and post_compact hooks around compaction", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    const store = SessionStore.open(paths);
    try {
      const sessionId = seedContextSession(store);
      const result = await compactSessionWithHooks({
        store,
        sessionId,
        hooks: [
          {
            event: "pre_compact",
            type: "command",
            command: 'node -e \'require("fs").writeFileSync("pre.json", process.env.ARGUMENTS)\''
          },
          {
            event: "post_compact",
            type: "command",
            command: 'node -e \'require("fs").writeFileSync("post.json", process.env.ARGUMENTS)\''
          }
        ],
        cwd: temp.path,
        trigger: "manual",
        customInstructions: "keep constraints"
      });

      expect(result.hooks.pre).toHaveLength(1);
      expect(result.hooks.post).toHaveLength(1);
      await expect(readFile(path.join(temp.path, "pre.json"), "utf8")).resolves.toContain(
        '"trigger":"manual"'
      );
      await expect(readFile(path.join(temp.path, "pre.json"), "utf8")).resolves.toContain(
        '"customInstructions":"keep constraints"'
      );
      await expect(readFile(path.join(temp.path, "post.json"), "utf8")).resolves.toContain(
        '"compactSummary"'
      );
      expect(
        store
          .listAuditEvents(20)
          .filter((event) => event.action === "agent.hook.completed")
          .map((event) => event.target)
      ).toEqual(["post_compact:command", "pre_compact:command"]);
    } finally {
      store.close();
    }
  });

  it("blocks compaction when pre_compact hook blocks", async () => {
    temp = makeTempRoot();
    const store = SessionStore.open(getMagiPaths(temp.env));
    try {
      const sessionId = seedContextSession(store);
      await expect(
        compactSessionWithHooks({
          store,
          sessionId,
          hooks: [
            {
              event: "pre_compact",
              type: "command",
              command: "printf no-compact && exit 2"
            }
          ],
          cwd: temp.path
        })
      ).rejects.toThrow(/Compaction blocked by hook: no-compact/);
      expect(store.listContextSummaries(sessionId)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("supports context and compact commands from CLI", async () => {
    temp = makeTempRoot();
    const store = SessionStore.open(getMagiPaths(temp.env));
    let sessionId = "";
    try {
      sessionId = seedContextSession(store);
    } finally {
      store.close();
    }

    const contextBefore = await runCli(["context", sessionId], temp.env, process.cwd());
    expect(contextBefore.exitCode).toBe(0);
    expect(contextBefore.stdout).toContain(`sessionId: ${sessionId}`);
    expect(contextBefore.stdout).toContain("estimatedTokens:");
    expect(contextBefore.stdout).toContain("user:");

    const compact = await runCli(["compact", sessionId], temp.env, process.cwd());
    expect(compact.exitCode).toBe(0);
    expect(compact.stdout).toContain("summaryId:");
    expect(compact.stdout).toContain("FACT: root stays ~/.magi-next");

    const contextAfter = await runCli(["context", sessionId], temp.env, process.cwd());
    expect(contextAfter.stdout).toContain("summaries: 1");
    expect(contextAfter.stdout).toContain("summary:");
  });

  it("requires explicit --model for CLI LLM compaction and routes to the configured provider", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(
      paths.configFile,
      [
        "version: 0.1",
        "providers:",
        "  summary:",
        "    type: openai",
        "    apiKeyEnv: MAGI_OPENAI_API_KEY",
        "    baseUrl: http://127.0.0.1:9/v1",
        "models:",
        "  aliases:",
        "    compact: summary:gpt-compact",
        "  fallbacks: {}",
        ""
      ].join("\n"),
      "utf8"
    );
    const store = SessionStore.open(paths);
    let sessionId = "";
    try {
      sessionId = seedContextSession(store);
    } finally {
      store.close();
    }

    const deterministic = await runCli(["compact", sessionId], temp.env, temp.path);
    expect(deterministic.exitCode).toBe(0);
    expect(deterministic.stdout).toContain("FACT: root stays ~/.magi-next");

    const routed = await runCli(
      ["compact", sessionId, "--model", "compact"],
      { ...temp.env, MAGI_OPENAI_API_KEY: "test-key" },
      temp.path
    );
    expect(routed.exitCode).toBe(1);
    expect(routed.stderr).toContain("fetch failed");
  });

  it("triggers compact hooks from CLI compact command", async () => {
    temp = makeTempRoot();
    const paths = getMagiPaths(temp.env);
    ensureMagiHome(paths);
    writeFileSync(
      paths.configFile,
      [
        "version: 0.1",
        "hooks:",
        "  - event: pre_compact",
        "    type: command",
        '    command: "node -e \'require(\\"fs\\").writeFileSync(\\"cli-pre.json\\", process.env.ARGUMENTS)\'"',
        "  - event: post_compact",
        "    type: command",
        '    command: "node -e \'require(\\"fs\\").writeFileSync(\\"cli-post.json\\", process.env.ARGUMENTS)\'"',
        ""
      ].join("\n"),
      "utf8"
    );
    const store = SessionStore.open(paths);
    let sessionId = "";
    try {
      sessionId = seedContextSession(store);
    } finally {
      store.close();
    }

    const compact = await runCli(["compact", sessionId], temp.env, temp.path);
    expect(compact.exitCode).toBe(0);
    expect(compact.stdout).toContain("summaryId:");
    await expect(readFile(path.join(temp.path, "cli-pre.json"), "utf8")).resolves.toContain(
      "compact_started"
    );
    await expect(readFile(path.join(temp.path, "cli-post.json"), "utf8")).resolves.toContain(
      "compact_completed"
    );
  });
});

function seedContextSession(store: SessionStore): string {
  const sessionId = store.createSession({ title: "context fixture", cwd: process.cwd() });
  store.appendMessage({
    sessionId,
    role: "user",
    content: [
      "FACT: root stays ~/.magi-next",
      "TODO: add context budget command",
      "Please continue."
    ].join("\n")
  });
  store.appendMessage({
    sessionId,
    role: "assistant",
    content: "DECISION: summary is deterministic\nWorking on it."
  });
  store.appendMessage({
    sessionId,
    role: "tool",
    content: "searched src and tests"
  });
  return sessionId;
}
