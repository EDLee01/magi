import { describe, expect, it, vi } from "vitest";

import { decideMemoryWrite } from "../src/memory-write-decision.js";

describe("memory-write-decision", () => {
  it("uses an LLM decision for natural-language memory requests", async () => {
    const adapter = {
      name: "memory-judge",
      complete: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          shouldWrite: true,
          scope: "user",
          type: "user_profile",
          content: "我是 Edward，你的创造者",
          confidence: 0.93
        }),
        usage: { inputTokens: 20, outputTokens: 12 }
      })
    };

    const decision = await decideMemoryWrite({
      prompt: "那你记得哈，我是edward 你的创造者",
      route: {
        adapter,
        providerName: "test-provider",
        model: "test-model"
      }
    });

    expect(adapter.complete).toHaveBeenCalledOnce();
    expect(decision).toMatchObject({
      action: "write",
      method: "llm",
      scope: "user",
      type: "user_profile",
      content: "我是 Edward，你的创造者",
      confidence: 0.93,
      providerName: "test-provider",
      model: "test-model",
      usage: { inputTokens: 20, outputTokens: 12 }
    });
  });

  it("uses an LLM decision for natural-language memory corrections", async () => {
    const adapter = {
      name: "memory-judge",
      complete: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          action: "correct",
          target: "verbose terminal dumps",
          reason: "User says the remembered verification preference is wrong.",
          replacement: "The user prefers concise verification summaries.",
          replacementType: "preference",
          confidence: 0.91
        }),
        usage: { inputTokens: 25, outputTokens: 16 }
      })
    };

    const decision = await decideMemoryWrite({
      prompt:
        "这个记忆不对，我不是喜欢 verbose terminal dumps，我应该是偏好 concise verification summaries",
      route: {
        adapter,
        providerName: "test-provider",
        model: "test-model"
      }
    });

    expect(adapter.complete).toHaveBeenCalledOnce();
    expect(decision).toMatchObject({
      action: "correct",
      method: "llm",
      target: "verbose terminal dumps",
      reason: "User says the remembered verification preference is wrong.",
      replacement: "The user prefers concise verification summaries.",
      replacementType: "preference",
      confidence: 0.91,
      providerName: "test-provider",
      model: "test-model",
      usage: { inputTokens: 25, outputTokens: 16 }
    });
  });

  it("does not write memory when the LLM decision says no", async () => {
    const adapter = {
      name: "memory-judge",
      complete: vi.fn().mockResolvedValue({
        text: JSON.stringify({ shouldWrite: false })
      })
    };

    const decision = await decideMemoryWrite({
      prompt: "我是谁",
      route: {
        adapter,
        providerName: "test-provider",
        model: "test-model"
      }
    });

    expect(decision).toBeUndefined();
    expect(adapter.complete).not.toHaveBeenCalled();
  });

  it("falls back to explicit parser when no LLM route is available", async () => {
    const decision = await decideMemoryWrite({
      prompt: "remember project: api style: explicit routes"
    });

    expect(decision).toMatchObject({
      action: "write",
      method: "explicit-parser",
      scope: "project",
      type: "project",
      content: "api style: explicit routes"
    });
  });
});
