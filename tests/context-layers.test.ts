import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildLayeredContext, getGitContext } from "../src/context/layers.js";
import { MemoryNodeStore } from "../src/memory-node-store.js";

describe("context/layers", () => {
  function makeTempCwd(): string {
    return mkdtempSync(path.join(tmpdir(), "magi-ctx-"));
  }

  describe("buildLayeredContext", () => {
    it("includes system instructions as first layer", () => {
      const cwd = makeTempCwd();
      const result = buildLayeredContext({
        cwd,
        systemInstructions: "You are a helpful assistant.",
        includeGit: false
      });
      expect(result.layers[0].name).toBe("system");
      expect(result.layers[0].content).toBe("You are a helpful assistant.");
      expect(result.systemPrompt).toContain("You are a helpful assistant.");
    });

    it("includes project rules from AGENTS.md", () => {
      const cwd = makeTempCwd();
      writeFileSync(path.join(cwd, "AGENTS.md"), "Always use TypeScript.\n", "utf8");
      const result = buildLayeredContext({ cwd, includeGit: false });
      const rulesLayer = result.layers.find((l) => l.name === "project-rules");
      expect(rulesLayer).toBeDefined();
      expect(rulesLayer!.content).toContain("Always use TypeScript.");
    });

    it("includes hot memory from weighted graph nodes when paths provided", () => {
      const cwd = makeTempCwd();
      const root = mkdtempSync(path.join(tmpdir(), "magi-home-"));
      const paths = {
        root,
        stateRoot: path.join(root, "state"),
        configFile: path.join(root, "config.yaml"),
        sessionDbFile: path.join(root, "state", "sessions.db")
      } as import("../src/paths.js").MagiPaths;
      const store = MemoryNodeStore.open(paths);
      store.upsertNode({
        type: "work_habit",
        title: "Focused verification",
        summary: "User prefers focused verification before broad checks.",
        body: "For coding tasks, run focused verification before broad checks unless asked otherwise.",
        source: "test",
        weight: 0.8
      });
      store.close();

      const injectedNodes: string[] = [];
      const result = buildLayeredContext({ cwd, paths, includeGit: false });
      const memLayer = result.layers.find((l) => l.name === "hot-memory");
      expect(memLayer).toBeDefined();
      expect(memLayer!.content).toContain("Focused verification");
      expect(memLayer!.content).toContain("work_habit");

      buildLayeredContext({
        cwd,
        paths,
        includeGit: false,
        hotMemorySink: (nodes) => injectedNodes.push(...nodes.map((node) => node.title))
      });
      expect(injectedNodes).toEqual(["Focused verification"]);
    });

    it("loads graph memory before dynamic memory", () => {
      const cwd = makeTempCwd();
      const root = mkdtempSync(path.join(tmpdir(), "magi-home-"));
      const paths = {
        root,
        stateRoot: path.join(root, "state"),
        configFile: path.join(root, "config.yaml"),
        sessionDbFile: path.join(root, "state", "sessions.db")
      } as import("../src/paths.js").MagiPaths;
      const store = MemoryNodeStore.open(paths);
      store.upsertNode({
        type: "project",
        title: "Memory architecture",
        summary: "Memory graph is the primary store.",
        body: "Magi memory should use the SQLite memory graph as the source of truth.",
        source: "test",
        weight: 0.9
      });
      store.close();

      const result = buildLayeredContext({
        cwd,
        paths,
        memoryContext: "[Relevant Memory]\nlow-priority recall",
        includeGit: false
      });
      const names = result.layers.map((layer) => layer.name);
      expect(names.indexOf("hot-memory")).toBeLessThan(names.indexOf("dynamic-memory"));
      const memLayer = result.layers.find((layer) => layer.name === "hot-memory");
      expect(memLayer!.content).toContain("[Hot Memory]");
      expect(memLayer!.content).toContain("Memory architecture");
      expect(memLayer!.content).toContain("SQLite memory graph");
    });

    it("does not inject legacy markdown or memdir as hot memory", () => {
      const cwd = makeTempCwd();
      const root = mkdtempSync(path.join(tmpdir(), "magi-home-"));
      writeFileSync(path.join(root, "memory.md"), "legacy memory should not be hot\n", "utf8");
      const paths = {
        root,
        stateRoot: path.join(root, "state"),
        configFile: path.join(root, "config.yaml"),
        sessionDbFile: path.join(root, "state", "sessions.db")
      } as import("../src/paths.js").MagiPaths;

      const result = buildLayeredContext({ cwd, paths, includeGit: false });
      expect(result.layers.some((layer) => layer.name === "hot-memory")).toBe(false);
    });

    it("includes dynamic memory context", () => {
      const cwd = makeTempCwd();
      const result = buildLayeredContext({
        cwd,
        memoryContext: "[Relevant memory]\n- user: database: PostgreSQL",
        includeGit: false
      });
      const dynLayer = result.layers.find((l) => l.name === "dynamic-memory");
      expect(dynLayer).toBeDefined();
      expect(dynLayer!.content).toContain("PostgreSQL");
    });

    it("includes environment layer with date and cwd", () => {
      const cwd = makeTempCwd();
      const result = buildLayeredContext({ cwd, includeGit: false, platform: "linux" });
      const envLayer = result.layers.find((l) => l.name === "environment");
      expect(envLayer).toBeDefined();
      expect(envLayer!.content).toContain(`cwd=${cwd}`);
      expect(envLayer!.content).toContain("platform=linux");
      expect(envLayer!.content).toMatch(/date=\d{4}-\d{2}-\d{2}/);
    });

    it("concatenates all layers into systemPrompt", () => {
      const cwd = makeTempCwd();
      const result = buildLayeredContext({
        cwd,
        systemInstructions: "SYSTEM",
        memoryContext: "MEMORY",
        includeGit: false
      });
      expect(result.systemPrompt).toContain("SYSTEM");
      expect(result.systemPrompt).toContain("MEMORY");
      expect(result.systemPrompt).toContain("[Environment]");
    });

    it("skips empty layers gracefully", () => {
      const cwd = makeTempCwd();
      const result = buildLayeredContext({ cwd, includeGit: false });
      // Should at least have environment layer
      expect(result.layers.length).toBeGreaterThanOrEqual(1);
      expect(result.layers.some((l) => l.name === "environment")).toBe(true);
    });
  });

  describe("getGitContext", () => {
    it("returns undefined for non-git directories", () => {
      const cwd = makeTempCwd();
      expect(getGitContext(cwd)).toBeUndefined();
    });

    it("returns branch info for git repos", () => {
      const cwd = makeTempCwd();
      const { execSync } = require("node:child_process");
      execSync(
        "git init && git -c user.email=test@test.com -c user.name=Test commit --allow-empty -m init",
        { cwd, encoding: "utf8" }
      );
      const result = getGitContext(cwd);
      expect(result).toBeDefined();
      expect(result).toContain("[Git]");
      expect(result).toContain("branch=");
    });
  });
});
