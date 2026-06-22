/**
 * Per-model pricing for cost estimation.
 *
 * Prices are USD per 1M tokens (input/output).
 * Source: anthropic/openai/deepseek public pricing as of 2026-05.
 * Update when prices change.
 */

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

const PRICING: Record<string, ModelPricing> = {
  // Anthropic Claude family
  "claude-fable-5": { inputPerMillion: 10, outputPerMillion: 50 },
  "claude-haiku-4-5-20251001": { inputPerMillion: 1, outputPerMillion: 5 },
  "claude-haiku-4-5": { inputPerMillion: 1, outputPerMillion: 5 },
  "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-sonnet-4-5": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-opus-4-7": { inputPerMillion: 15, outputPerMillion: 75 },
  "claude-opus-4-5": { inputPerMillion: 15, outputPerMillion: 75 },
  "claude-3-5-sonnet": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-3-5-haiku": { inputPerMillion: 0.8, outputPerMillion: 4 },

  // OpenAI GPT family
  "gpt-5.5": { inputPerMillion: 5, outputPerMillion: 30 },
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  "gpt-4-turbo": { inputPerMillion: 10, outputPerMillion: 30 },
  "o1-preview": { inputPerMillion: 15, outputPerMillion: 60 },
  "o1-mini": { inputPerMillion: 3, outputPerMillion: 12 },

  // DeepSeek
  "deepseek-chat": { inputPerMillion: 0.27, outputPerMillion: 1.1 },
  "deepseek-reasoner": { inputPerMillion: 0.55, outputPerMillion: 2.19 },

  // Local / unknown
  local: { inputPerMillion: 0, outputPerMillion: 0 }
};

/**
 * Look up pricing for a model. Tries exact match, then prefix match
 * (e.g. "claude-sonnet-4-6-20251015" matches "claude-sonnet-4-6"),
 * then family fallback.
 */
export function getModelPricing(model: string): ModelPricing {
  // Exact
  if (PRICING[model]) return PRICING[model];

  // Prefix match (model variant with date suffix)
  for (const [key, pricing] of Object.entries(PRICING)) {
    if (model.startsWith(key)) return pricing;
  }

  // Family fallback heuristics
  if (model.includes("haiku")) return { inputPerMillion: 1, outputPerMillion: 5 };
  if (model.includes("opus")) return { inputPerMillion: 15, outputPerMillion: 75 };
  if (model.includes("sonnet")) return { inputPerMillion: 3, outputPerMillion: 15 };
  if (model.includes("gpt-5.5")) return PRICING["gpt-5.5"];
  if (model.includes("gpt-4o-mini")) return { inputPerMillion: 0.15, outputPerMillion: 0.6 };
  if (model.includes("gpt-4")) return { inputPerMillion: 2.5, outputPerMillion: 10 };
  if (model.includes("deepseek-r")) return { inputPerMillion: 0.55, outputPerMillion: 2.19 };
  if (model.includes("deepseek")) return { inputPerMillion: 0.27, outputPerMillion: 1.1 };

  // Unknown model — assume zero cost rather than guess
  return { inputPerMillion: 0, outputPerMillion: 0 };
}

export function calculateCost(input: {
  model: string;
  inputTokens: number;
  outputTokens: number;
}): number {
  const pricing = getModelPricing(input.model);
  const inputCost = (input.inputTokens * pricing.inputPerMillion) / 1_000_000;
  const outputCost = (input.outputTokens * pricing.outputPerMillion) / 1_000_000;
  return inputCost + outputCost;
}

export function formatCostUsd(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}
