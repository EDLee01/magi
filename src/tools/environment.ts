export interface EnvVar {
  key: string;
  value: string;
}
export interface EnvironmentResult {
  vars: EnvVar[];
  count: number;
  filtered?: string;
}

export const EnvironmentInputSchema = {
  type: "object",
  properties: { prefix: { type: "string" }, filter: { type: "string" } },
  required: [],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseEnvironmentInput(input: Record<string, unknown>): {
  prefix?: string;
  filter?: string;
} {
  return {
    prefix: typeof input.prefix === "string" ? input.prefix : undefined,
    filter: typeof input.filter === "string" ? input.filter : undefined
  };
}

// Any variable whose name looks secret-bearing is redacted before its value
// ever reaches the model context. Matches KEY / TOKEN / SECRET / PASSWORD /
// PASSWD / CREDENTIAL / AUTH / SESSION / COOKIE / PRIVATE, case-insensitive.
const SECRET_KEY_PATTERN =
  /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|SESSION|COOKIE|PRIVATE)/i;

export function redactEnvValue(key: string, value: string): string {
  if (!value) return value;
  if (!SECRET_KEY_PATTERN.test(key)) return value;
  // Keep a short prefix so the value is still recognizable for debugging,
  // but never expose enough to be usable.
  const visible = value.length > 8 ? value.slice(0, 3) : "";
  return `${visible}***redacted*** (${value.length} chars)`;
}

export function executeEnvironment(input: { prefix?: string; filter?: string }): EnvironmentResult {
  let entries = Object.entries(process.env).map(([key, value]) => ({
    key,
    value: redactEnvValue(key, value ?? "")
  }));
  if (input.prefix) {
    const p = input.prefix.toUpperCase();
    entries = entries.filter(({ key }) => key.startsWith(p));
  }
  if (input.filter) {
    const f = input.filter.toLowerCase();
    entries = entries.filter(
      ({ key, value }) => key.toLowerCase().includes(f) || value.toLowerCase().includes(f)
    );
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
  if (result.vars.some((v) => v.value.length >= 500)) {
    lines.push(`... ${result.vars.filter((v) => v.value.length >= 500).length} values truncated`);
  }
  return [header, ...lines].join("\n");
}
