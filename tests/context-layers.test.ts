import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildLayeredContext, getGitContext } from "../src/context/layers.js";

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

    it("includes user memory index when paths provided", () => {
      const cwd = makeTempCwd();
      const root = mkdtempSync(path.join(tmpdir(), "magi-home-"));
      writeFileSync(path.join(root, "memory.md"), "preferred language: TypeScript\n", "utf8");
      const paths = {
        root,
        stateRoot: path.join(root, "state"),
        configFile: path.join(root, "config.yaml"),
        sessionDbFile: path.join(root, "state", "sessions.db")
      } as import("../src/paths.js").MagiPaths;

      const result = buildLayeredContext({ cwd, paths, includeGit: false });
      const memLayer = result.layers.find((l) => l.name === "memory-index");
      expect(memLayer).toBeDefined();
      expect(memLayer!.content).toContain("preferred language: TypeScript");
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
      execSync("git init && git -c user.email=test@test.com -c user.name=Test commit --allow-empty -m init", { cwd, encoding: "utf8" });
      const result = getGitContext(cwd);
      expect(result).toBeDefined();
      expect(result).toContain("[Git]");
      expect(result).toContain("branch=");
    });
  });
});
