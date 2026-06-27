import { describe, expect, it } from "vitest";

import {
  buildCapabilityQuestionNudge,
  isCapabilityQuestion
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
});
