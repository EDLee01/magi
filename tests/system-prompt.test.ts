import { describe, expect, it } from "vitest";

import { buildSystemInstructions } from "../src/agent/system-prompt.js";

describe("system prompt", () => {
  it("tells the agent to inspect referenced projects before replying", () => {
    const prompt = buildSystemInstructions({ cwd: "/tmp/project", toolCount: 12 });

    expect(prompt).toContain("If the user gives a file path");
    expect(prompt).toContain("call read-only inspection tools in the same turn before replying");
    expect(prompt).toContain("Do not end a turn with promises");
    expect(prompt).toContain("Read-only discovery does not require confirmation");
    expect(prompt).toContain("Only core tool schemas are loaded initially");
    expect(prompt).toContain("select:<tool_name>");
  });
});
