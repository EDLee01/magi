import { describe, it, expect } from "vitest";
import { calculateCost, formatCostUsd, getModelPricing } from "../src/cost.js";

describe("cost calculation", () => {
  describe("getModelPricing", () => {
    it("returns exact match pricing for known models", () => {
      expect(getModelPricing("claude-sonnet-4-6").inputPerMillion).toBe(3);
      expect(getModelPricing("claude-sonnet-4-6").outputPerMillion).toBe(15);
      expect(getModelPricing("claude-haiku-4-5-20251001").inputPerMillion).toBe(1);
      expect(getModelPricing("claude-opus-4-7").outputPerMillion).toBe(75);
      expect(getModelPricing("gpt-5.5")).toEqual({ inputPerMillion: 5, outputPerMillion: 30 });
    });

    it("falls back to family heuristics for unknown variants", () => {
      // Unknown haiku variant
      expect(getModelPricing("claude-haiku-future-version").inputPerMillion).toBe(1);
      // Unknown opus variant
      expect(getModelPricing("claude-opus-future").outputPerMillion).toBe(75);
    });

    it("returns zero for fully unknown models", () => {
      const pricing = getModelPricing("totally-unknown-model");
      expect(pricing.inputPerMillion).toBe(0);
      expect(pricing.outputPerMillion).toBe(0);
    });

    it("matches via prefix for dated variants", () => {
      // claude-sonnet-4-6-20251015 should match claude-sonnet-4-6
      expect(getModelPricing("claude-sonnet-4-6-20251015").inputPerMillion).toBe(3);
    });
  });

  describe("calculateCost", () => {
    it("computes cost correctly for sonnet pricing", () => {
      // 1k in, 1k out at 3/15 per million = 0.003 + 0.015 = 0.018
      const cost = calculateCost({
        model: "claude-sonnet-4-6",
        inputTokens: 1000,
        outputTokens: 1000
      });
      expect(cost).toBeCloseTo(0.018, 5);
    });

    it("scales linearly with token count", () => {
      const cost1k = calculateCost({
        model: "claude-haiku-4-5",
        inputTokens: 1000,
        outputTokens: 1000
      });
      const cost10k = calculateCost({
        model: "claude-haiku-4-5",
        inputTokens: 10000,
        outputTokens: 10000
      });
      expect(cost10k).toBeCloseTo(cost1k * 10, 5);
    });

    it("returns 0 for unknown models", () => {
      expect(calculateCost({ model: "unknown", inputTokens: 1000, outputTokens: 1000 })).toBe(0);
    });

    it("returns 0 for zero tokens", () => {
      expect(calculateCost({ model: "claude-sonnet-4-6", inputTokens: 0, outputTokens: 0 })).toBe(
        0
      );
    });
  });

  describe("formatCostUsd", () => {
    it("formats zero as $0.00", () => {
      expect(formatCostUsd(0)).toBe("$0.00");
    });

    it("uses 4 decimals for sub-cent amounts", () => {
      expect(formatCostUsd(0.0012)).toBe("$0.0012");
    });

    it("uses 3 decimals for sub-dollar amounts", () => {
      expect(formatCostUsd(0.123)).toBe("$0.123");
    });

    it("uses 2 decimals for dollar amounts", () => {
      expect(formatCostUsd(12.34)).toBe("$12.34");
      expect(formatCostUsd(1234.56)).toBe("$1234.56");
    });
  });
});
