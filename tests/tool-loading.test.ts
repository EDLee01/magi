import { describe, expect, it } from "vitest";

import {
  FULL_TOOL_NAMES,
  parseToolSearchReveal,
  resolveInitialExposedToolNames,
  resolveToolLoadProfile
} from "../src/tool-loading.js";
import { getBuiltinToolDefinitions } from "../src/tools/registry.js";
import { executeToolSearch } from "../src/tools/tool-search.js";

describe("tool loading profiles", () => {
  it("defaults to full profile", () => {
    expect(resolveToolLoadProfile({})).toBe("full");
  });

  it("loads medium profile with bootstrap plus workspace pack", () => {
    const names = resolveInitialExposedToolNames("medium");
    expect(names).toEqual(
      expect.arrayContaining([
        "ToolSearch",
        "WebSearch",
        "WebFetch",
        "FileRead",
        "Brief",
        "AskUserQuestion",
        "Glob",
        "Grep",
        "WorkspaceDiagnostics",
        "Bash"
      ])
    );
    expect(names).not.toContain("FileWrite");
    expect(names).toHaveLength(10);
  });

  it("keeps full profile aligned with legacy core size", () => {
    expect(FULL_TOOL_NAMES).toHaveLength(26);
    expect(resolveInitialExposedToolNames("full")).toHaveLength(26);
  });

  it("parses pack and tool reveals from ToolSearch output", () => {
    expect(parseToolSearchReveal("Tool: WebFetch\nCategory: web")).toEqual(["WebFetch"]);
    expect(
      parseToolSearchReveal("Pack: edit\nTools: FileWrite, FileEdit, FilePatch\nLoaded 3 tools")
    ).toEqual(["FileWrite", "FileEdit", "FilePatch"]);
  });

  it("loads tool packs through ToolSearch", () => {
    const tools = getBuiltinToolDefinitions().map((tool) => ({
      name: tool.name,
      description: tool.description,
      category: "files",
      tags: [],
      inputSchema: tool.inputSchema,
      isReadOnly: () => true,
      isDestructive: () => false,
      isConcurrencySafe: () => true
    }));
    const result = executeToolSearch({ query: "pack:edit", maxResults: 5 }, tools, {
      coreToolNames: new Set(resolveInitialExposedToolNames("medium"))
    });
    expect(result).toContain("Pack: edit");
    expect(result).toContain("FileWrite");
    expect(parseToolSearchReveal(result)).toEqual(["FileWrite", "FileEdit", "FilePatch"]);
  });

  it("estimates fewer schema tokens for medium than full", () => {
    const byName = new Map(getBuiltinToolDefinitions().map((tool) => [tool.name, tool]));
    const medium = resolveInitialExposedToolNames("medium")
      .map((name) => byName.get(name))
      .filter(Boolean);
    const full = resolveInitialExposedToolNames("full")
      .map((name) => byName.get(name))
      .filter(Boolean);
    const mediumTokens = Math.ceil(JSON.stringify(medium).length / 4);
    const fullTokens = Math.ceil(JSON.stringify(full).length / 4);
    expect(mediumTokens).toBeLessThan(fullTokens);
    expect(mediumTokens).toBeLessThan(1400);
  });
});
