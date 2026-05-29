import { describe, it, expect, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { selectRelevantMemories } from "../src/memory-selection.js";
import { MagiPaths } from "../src/paths.js";

function makeTempPaths(): MagiPaths {
  const root = mkdtempSync(path.join(tmpdir(), "magi-mem-sel-"));
  const stateRoot = path.join(root, "state");
  mkdirSync(stateRoot, { recursive: true });
  mkdirSync(path.join(stateRoot, "project-memory"), { recursive: true });
  return {
    root,
    stateRoot,
    configFile: path.join(root, "config.yaml"),
    sessionDbFile: path.join(stateRoot, "sessions.db")
  } as MagiPaths;
}

describe("memory-selection", () => {
  it("returns empty when no memories exist", async () => {
    const paths = makeTempPaths();
    const result = await selectRelevantMemories({
      paths,
      cwd: "/tmp/test-project",
      maxResults: 5,
      prompt: "hello"
    });
    expect(result.entries).toHaveLength(0);
    expect(result.method).toBe("keyword");
    expect(result.formatted).toBeUndefined();
  });

  it("uses keyword search when no selectionRoute", async () => {
    const paths = makeTempPaths();
    writeFileSync(
      path.join(paths.root, "memory.md"),
      ["preferred language: TypeScript", "database: PostgreSQL", "framework: React"].join("\n"),
      "utf8"
    );

    const result = await selectRelevantMemories({
      paths,
      cwd: "/tmp/test-project",
      scopes: ["user"],
      maxResults: 5,
      prompt: "what database should I use"
    });
    expect(result.method).toBe("keyword");
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries.some((e) => e.text.includes("PostgreSQL"))).toBe(true);
  });

  it("returns all entries when count <= maxResults without LLM", async () => {
    const paths = makeTempPaths();
    writeFileSync(
      path.join(paths.root, "memory.md"),
      ["preferred language: TypeScript", "database: PostgreSQL"].join("\n"),
      "utf8"
    );

    const result = await selectRelevantMemories({
      paths,
      cwd: "/tmp/test-project",
      scopes: ["user"],
      maxResults: 5,
      prompt: "anything",
      selectionRoute: {
        adapter: { name: "test", complete: vi.fn() },
        model: "test-model",
        providerName: "test"
      }
    });
    // With only 2 entries and maxResults=5, it uses keyword search (no LLM needed)
    expect(result.method).toBe("keyword");
  });

  it("uses LLM selection when entries exceed maxResults and route is provided", async () => {
    const paths = makeTempPaths();
    writeFileSync(
      path.join(paths.root, "memory.md"),
      [
        "preferred language: TypeScript",
        "database: PostgreSQL",
        "framework: React",
        "editor: VS Code",
        "os: Linux",
        "shell: zsh",
        "cloud: AWS",
        "ci: GitHub Actions"
      ].join("\n"),
      "utf8"
    );

    const mockAdapter = {
      name: "test",
      complete: vi.fn().mockResolvedValue({ text: "[1, 2]" })
    };

    const result = await selectRelevantMemories({
      paths,
      cwd: "/tmp/test-project",
      scopes: ["user"],
      maxResults: 3,
      prompt: "what database and framework do I use",
      selectionRoute: {
        adapter: mockAdapter,
        model: "fast-model",
        providerName: "test"
      }
    });
    expect(result.method).toBe("llm");
    expect(mockAdapter.complete).toHaveBeenCalledOnce();
    expect(result.entries.length).toBeLessThanOrEqual(3);
    // Indices [1, 2] → "database: PostgreSQL" and "framework: React"
    expect(result.entries.some((e) => e.text.includes("PostgreSQL"))).toBe(true);
    expect(result.entries.some((e) => e.text.includes("React"))).toBe(true);
  });

  it("falls back to keyword search when LLM fails", async () => {
    const paths = makeTempPaths();
    writeFileSync(
      path.join(paths.root, "memory.md"),
      [
        "preferred language: TypeScript",
        "database: PostgreSQL",
        "framework: React",
        "editor: VS Code",
        "os: Linux",
        "shell: zsh"
      ].join("\n"),
      "utf8"
    );

    const mockAdapter = {
      name: "test",
      complete: vi.fn().mockRejectedValue(new Error("API down"))
    };

    const result = await selectRelevantMemories({
      paths,
      cwd: "/tmp/test-project",
      scopes: ["user"],
      maxResults: 3,
      prompt: "database",
      selectionRoute: {
        adapter: mockAdapter,
        model: "fast-model",
        providerName: "test"
      }
    });
    expect(result.method).toBe("keyword");
    expect(result.entries.length).toBeGreaterThan(0);
  });
});
