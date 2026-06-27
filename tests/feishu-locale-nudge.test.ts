import { describe, expect, it } from "vitest";

import { buildFeishuLocaleNudge, isFeishuLocalePrompt } from "../src/agent/feishu-locale-nudge.js";

describe("feishu locale nudge", () => {
  it("detects Feishu locale markers in prompts", () => {
    expect(isFeishuLocalePrompt("[Feishu channel]\n\n帮我分析")).toBe(true);
    expect(isFeishuLocalePrompt("plain prompt")).toBe(false);
  });

  it("reminds the model to mirror the user's language", () => {
    const nudge = buildFeishuLocaleNudge();
    expect(nudge).toContain("same language");
    expect(nudge).toContain("Korean");
  });
});
