import { SlashCommandInput } from "./registry.js";

export const command = {
  name: "usage",
  description: "Show recent API usage rate (calls and tokens by hour)",
  usage: "/usage [hours]",
  group: "Session",
  handler: (args: string[], input: SlashCommandInput): string => {
    const hours = Math.max(1, Math.min(168, Number(args[0]) || 24));
    const now = Date.now();
    const cutoff = now - hours * 3600_000;
    const usage = input.store
      .listAllUsage(5000)
      .filter((u) => new Date(u.createdAt).getTime() >= cutoff);
    if (usage.length === 0) {
      return `No API calls in the last ${hours}h.`;
    }
    // Bucket by hour
    const buckets = new Map<
      string,
      { calls: number; input: number; output: number; models: Set<string> }
    >();
    for (const u of usage) {
      const t = new Date(u.createdAt);
      const hourKey = `${t.toISOString().slice(0, 13)}:00`;
      const b = buckets.get(hourKey) ?? { calls: 0, input: 0, output: 0, models: new Set() };
      b.calls += 1;
      b.input += u.inputTokens;
      b.output += u.outputTokens;
      b.models.add(u.model);
      buckets.set(hourKey, b);
    }
    const sortedKeys = [...buckets.keys()].sort().reverse().slice(0, 24);
    const lines = [
      `API usage in the last ${hours}h: ${usage.length} calls`,
      "",
      `  ${"Hour".padEnd(20)} ${"Calls".padStart(6)} ${"Input".padStart(10)} ${"Output".padStart(10)}  Models`
    ];
    for (const key of sortedKeys) {
      const b = buckets.get(key)!;
      const inK = formatTokens(b.input);
      const outK = formatTokens(b.output);
      lines.push(
        `  ${key.replace("T", " ").padEnd(20)} ${String(b.calls).padStart(6)} ${inK.padStart(10)} ${outK.padStart(10)}  ${[...b.models].slice(0, 2).join(", ")}`
      );
    }
    const total = usage.reduce(
      (s, u) => ({ input: s.input + u.inputTokens, output: s.output + u.outputTokens }),
      { input: 0, output: 0 }
    );
    lines.push("");
    lines.push(`  Total: ${formatTokens(total.input)} in, ${formatTokens(total.output)} out`);
    lines.push("");
    lines.push("Note: this is local accounting, not the provider's enforced rate limit.");
    lines.push("Use /cost for per-model cost breakdown.");
    return lines.join("\n");
  }
};

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
