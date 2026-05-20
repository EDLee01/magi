export interface EnvVar { key: string; value: string }
export interface EnvironmentResult { vars: EnvVar[]; count: number; filtered?: string }

export const EnvironmentInputSchema = { type: "object", properties: { prefix: { type: "string" }, filter: { type: "string" } }, required: [], additionalProperties: false } satisfies Record<string, unknown>;

export function parseEnvironmentInput(input: Record<string, unknown>): { prefix?: string; filter?: string } {
  return {
    prefix: typeof input.prefix === "string" ? input.prefix : undefined,
    filter: typeof input.filter === "string" ? input.filter : undefined
  };
}

export function executeEnvironment(input: { prefix?: string; filter?: string }): EnvironmentResult {
  let entries = Object.entries(process.env).map(([key, value]) => ({ key, value: value ?? "" }));
  if (input.prefix) {
    const p = input.prefix.toUpperCase();
    entries = entries.filter(({ key }) => key.startsWith(p));
  }
  if (input.filter) {
    const f = input.filter.toLowerCase();
    entries = entries.filter(({ key, value }) => key.toLowerCase().includes(f) || value.toLowerCase().includes(f));
  }
  entries.sort((a, b) => a.key.localeCompare(b.key));
  return { vars: entries, count: entries.length, filtered: input.prefix || input.filter };
}

export function formatEnvironmentResult(result: EnvironmentResult): string {
  const header = result.filtered
    ? `Environment (filtered: ${result.filtered}, ${result.count} vars)`
    : `Environment (${result.count} vars)`;
  const lines = result.vars
    .filter(({ value }) => value.length < 500) // skip long values
    .map(({ key, value }) => `${key}=${value}`);
  if (result.vars.some(v => v.value.length >= 500)) {
    lines.push(`... ${result.vars.filter(v => v.value.length >= 500).length} values truncated`);
  }
  return [header, ...lines].join("\n");
}
