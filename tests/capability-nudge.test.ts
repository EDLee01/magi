import { describe, expect, it } from "vitest";

import {
  buildCapabilityQuestionNudge,
  buildWebResearchNudge,
  isCapabilityQuestion,
  isWebResearchTask
} from "../src/agent/capability-nudge.js";

describe("capability question nudge", () => {
  it("detects web capability questions in Chinese and English", () => {
    expect(isCapabilityQuestion("你有联网搜索的能力么")).toBe(true);
    expect(isCapabilityQuestion("can you search the web")).toBe(true);
    expect(isCapabilityQuestion("what tools do you have")).toBe(true);
    expect(isCapabilityQuestion("fix the login bug")).toBe(false);
  });

  it("builds a reminder that mentions WebSearch and ToolSearch", () => {
    const nudge = buildCapabilityQuestionNudge();
    expect(nudge).toContain("WebSearch");
    expect(nudge).toContain("ToolSearch");
    expect(nudge).toContain("cannot access the internet");
  });

  it("detects web research tasks and avoids capability-only prompts", () => {
    expect(isWebResearchTask("帮我搜索2026年 LLM memory 相关文献")).toBe(true);
    expect(isWebResearchTask("search arxiv for agent memory papers 2025")).toBe(true);
    expect(isWebResearchTask("你有联网搜索的能力么")).toBe(false);
    expect(isWebResearchTask("fix the login bug")).toBe(false);
  });

  it("builds a research nudge that steers away from Brief", () => {
    const nudge = buildWebResearchNudge();
    expect(nudge).toContain("WebSearch");
    expect(nudge).toContain("Brief");
  });
});
