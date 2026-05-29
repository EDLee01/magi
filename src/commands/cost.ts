import { SlashCommandInput } from "./registry.js";
import { calculateCost, formatCostUsd, getModelPricing } from "../cost.js";

export const command = {
  name: "cost",
  description: "Show token usage and estimated cost for the active session (or all sessions)",
  usage: "/cost [all]",
  group: "Session",
  handler: (args: string[], input: SlashCommandInput): string => {
    if (args[0] === "all") {
      return formatAllUsage(input);
    }
    if (!input.sessionId) {
      return "No active session. Use /cost all to see cumulative usage.";
    }
    return formatSessionUsage(input);
  }
};

function formatSessionUsage(input: SlashCommandInput): string {
  const usage = input.store.listSessionUsage(input.sessionId!);
  if (usage.length === 0) {
    return `Session ${input.sessionId}: no usage recorded yet.`;
  }
  // Aggregate per model
  const byModel = new Map<string, { input: number; output: number; cost: number; calls: number }>();
  let totalIn = 0,
    totalOut = 0,
    totalCost = 0;
  for (const u of usage) {
    const cost =
      u.costUsd > 0
        ? u.costUsd
        : calculateCost({
            model: u.model,
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens
          });
    const acc = byModel.get(u.model) ?? { input: 0, output: 0, cost: 0, calls: 0 };
    acc.input += u.inputTokens;
    acc.output += u.outputTokens;
    acc.cost += cost;
    acc.calls += 1;
    byModel.set(u.model, acc);
    totalIn += u.inputTokens;
    totalOut += u.outputTokens;
    totalCost += cost;
  }
  const lines = [
    `Session: ${input.sessionId}`,
    `Calls: ${usage.length}`,
    `Tokens: ${formatTokens(totalIn)} in, ${formatTokens(totalOut)} out`,
    `Estimated cost: ${formatCostUsd(totalCost)}`,
    "",
    "By model:",
    `  ${"Model".padEnd(35)} ${"Calls".padStart(6)} ${"Input".padStart(10)} ${"Output".padStart(10)} ${"Cost".padStart(10)}`
  ];
  for (const [model, agg] of byModel) {
    lines.push(
      `  ${model.padEnd(35)} ${String(agg.calls).padStart(6)} ${formatTokens(agg.input).padStart(10)} ${formatTokens(agg.output).padStart(10)} ${formatCostUsd(agg.cost).padStart(10)}`
    );
  }
  return lines.join("\n");
}

function formatAllUsage(input: SlashCommandInput): string {
  const usage = input.store.listAllUsage(5000);
  if (usage.length === 0) return "No usage recorded yet.";
  const byModel = new Map<string, { input: number; output: number; cost: number; calls: number }>();
  let totalIn = 0,
    totalOut = 0,
    totalCost = 0;
  for (const u of usage) {
    const cost =
      u.costUsd > 0
        ? u.costUsd
        : calculateCost({
            model: u.model,
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens
          });
    const acc = byModel.get(u.model) ?? { input: 0, output: 0, cost: 0, calls: 0 };
    acc.input += u.inputTokens;
    acc.output += u.outputTokens;
    acc.cost += cost;
    acc.calls += 1;
    byModel.set(u.model, acc);
    totalIn += u.inputTokens;
    totalOut += u.outputTokens;
    totalCost += cost;
  }
  const sortedModels = [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost);
  const lines = [
    `Cumulative usage across all sessions:`,
    `Calls: ${usage.length}`,
    `Tokens: ${formatTokens(totalIn)} in, ${formatTokens(totalOut)} out`,
    `Estimated cost: ${formatCostUsd(totalCost)}`,
    "",
    `  ${"Model".padEnd(35)} ${"Calls".padStart(6)} ${"Input".padStart(10)} ${"Output".padStart(10)} ${"Cost".padStart(10)}`
  ];
  for (const [model, agg] of sortedModels) {
    const pricing = getModelPricing(model);
    const priceHint = pricing.inputPerMillion === 0 ? " (no pricing data)" : "";
    lines.push(
      `  ${model.padEnd(35)} ${String(agg.calls).padStart(6)} ${formatTokens(agg.input).padStart(10)} ${formatTokens(agg.output).padStart(10)} ${formatCostUsd(agg.cost).padStart(10)}${priceHint}`
    );
  }
  return lines.join("\n");
}

function formatTokens(tokens: number): string {
  if (tokens === 0) return "0";
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}
