import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
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
import { getMagiPaths } from "../src/paths.js";
import { loadAgentInstructions } from "../src/rules/agents-loader.js";
import { SessionStore } from "../src/session-store.js";
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
    appendMemory({ paths, scope: "session", cwd: workspace, sessionId: "session-1", text: "session fact" });

    expect(readMemory({ paths, scope: "project", cwd: workspace })).toContain("project fact");
    expect(readMemory({ paths, scope: "user", cwd: workspace })).toContain("user fact");
    expect(readMemory({ paths, scope: "session", cwd: workspace, sessionId: "session-1" })).toContain("session fact");
    expect(memoryFile(paths, "project", workspace)).toContain(path.join(temp.path, "state", "project-memory"));
    expect(memoryFile(paths, "user", workspace)).toBe(path.join(temp.path, "memory.md"));
    expect(sessionMemoryFile(paths, "session-1")).toContain(path.join(temp.path, "state", "session-memory"));
  });

  it("records memory append audit when a session is supplied", () => {
    temp = makeTempRoot();
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-memory-"));
    const paths = getMagiPaths(temp.env);
    const store = SessionStore.open(paths);
    try {
      const sessionId = store.createSession({ title: "memory", cwd: workspace });
      appendMemory({ paths, scope: "project", cwd: workspace, text: "audited fact", store, sessionId });
      expect(store.countRows("audit_events")).toBe(1);
    } finally {
      store.close();
    }
  });

  it("supports memory append and view through CLI", async () => {
    temp = makeTempRoot();
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-memory-"));

    const append = await runCli(["memory", "append", "project", "cli fact"], temp.env, workspace);
    expect(append.exitCode).toBe(0);
    const view = await runCli(["memory", "view", "project"], temp.env, workspace);
    expect(view.stdout).toContain("cli fact");

    const file = memoryFile(getMagiPaths(temp.env), "project", workspace);
    expect(readFileSync(file, "utf8")).toContain("cli fact");
  });

  it("searches layered memory with session and project relevance", () => {
    temp = makeTempRoot();
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-memory-"));
    const paths = getMagiPaths(temp.env);

    appendMemory({ paths, scope: "user", cwd: workspace, text: "theme: quiet interface" });
    appendMemory({ paths, scope: "project", cwd: workspace, text: "api style: explicit routes" });
    appendMemory({ paths, scope: "session", cwd: workspace, sessionId: "s-1", text: "api current task: event streaming" });

    const results = searchMemory({ paths, cwd: workspace, sessionId: "s-1", query: "api event streaming" });
    expect(results.map((result) => result.scope)).toEqual(["session", "project"]);
    expect(formatMemorySearchResults(results)).toContain("session: api current task");
  });

  it("detects duplicate and conflicting memory entries", () => {
    temp = makeTempRoot();
    workspace = mkdtempSync(path.join(os.tmpdir(), "magi-memory-"));
    const paths = getMagiPaths(temp.env);
    const first = appendMemory({ paths, scope: "project", cwd: workspace, text: "model: gpt-main", detailed: true });
    const duplicate = appendMemory({ paths, scope: "project", cwd: workspace, text: "model: gpt-main", detailed: true });
    const conflict = appendMemory({ paths, scope: "project", cwd: workspace, text: "model: gpt-other", detailed: true });

    expect(first.appended).toBe(true);
    expect(duplicate).toMatchObject({ appended: false, duplicate: true });
    expect(conflict.appended).toBe(false);
    expect(conflict.conflicts[0]).toMatchObject({
      key: "model",
      existing: expect.objectContaining({ value: "gpt-main" }),
      incoming: expect.objectContaining({ value: "gpt-other" })
    });
    expect(readMemory({ paths, scope: "project", cwd: workspace }).match(/model:/g)).toHaveLength(1);
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
    expect(extractExplicitMemoryWrite("the project uses explicit routes")).toBeUndefined();
  });
});
