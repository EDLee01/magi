export interface ToolSearchableRecord {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  category?: string;
  tags?: string[];
  isReadOnly(input: Record<string, unknown>): boolean;
  isDestructive(input: Record<string, unknown>): boolean;
  isConcurrencySafe(input: Record<string, unknown>): boolean;
}

export interface ToolSearchInput {
  query: string;
  maxResults: number;
}

export const ToolSearchInputSchema = {
  type: "object",
  properties: {
    query: { type: "string" },
    max_results: { type: "number" }
  },
  required: ["query"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseToolSearchInput(input: Record<string, unknown>): ToolSearchInput {
  assertAllowedKeys(input, ["query", "max_results"], "ToolSearch input");
  const query = readNonEmptyString(input.query, "query");
  const maxResults = input.max_results === undefined ? 5 : readMaxResults(input.max_results);
  return { query, maxResults };
}

export function executeToolSearch(input: ToolSearchInput, tools: ToolSearchableRecord[]): string {
  const select = /^select:(.+)$/i.exec(input.query.trim());
  if (select) {
    const requested = select[1].trim();
    const tool = tools.find((item) => item.name.toLowerCase() === requested.toLowerCase());
    if (!tool) {
      throw new Error(`Tool not found: ${requested}`);
    }
    return formatSelectedTool(tool);
  }

  const matches = searchTools(input.query, tools).slice(0, input.maxResults);
  if (matches.length === 0) {
    return `No tools match ${JSON.stringify(input.query)}`;
  }
  return [
    `ToolSearch results for ${JSON.stringify(input.query)} (${matches.length})`,
    ...matches.map(({ tool, score }, index) => [
      `${index + 1}. ${tool.name} [${tool.category ?? "uncategorized"}] score=${score}`,
      `   ${tool.description ?? "No description"}`,
      `   tags: ${(tool.tags ?? []).join(", ") || "none"}`,
      `   schema: ${schemaSummary(tool.inputSchema)}`
    ].join("\n")),
    "",
    "Use query select:<tool_name> for the full schema."
  ].join("\n");
}

function searchTools(query: string, tools: ToolSearchableRecord[]): Array<{ tool: ToolSearchableRecord; score: number }> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return tools
    .map((tool) => ({ tool, score: scoreTool(tool, terms) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name));
}

function scoreTool(tool: ToolSearchableRecord, terms: string[]): number {
  const name = tool.name.toLowerCase();
  const description = (tool.description ?? "").toLowerCase();
  const category = (tool.category ?? "").toLowerCase();
  const tags = (tool.tags ?? []).join(" ").toLowerCase();
  const schema = JSON.stringify(tool.inputSchema).toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (name === term) score += 100;
    if (name.startsWith(term)) score += 70;
    if (name.includes(term)) score += 50;
    if (category.includes(term)) score += 35;
    if (tags.includes(term)) score += 30;
    if (description.includes(term)) score += 20;
    if (schema.includes(term)) score += 5;
  }
  return score;
}

function formatSelectedTool(tool: ToolSearchableRecord): string {
  return [
    `Tool: ${tool.name}`,
    `Category: ${tool.category ?? "uncategorized"}`,
    `Description: ${tool.description ?? "No description"}`,
    `Read-only: ${tool.isReadOnly({}) ? "yes" : "depends on input or mode"}`,
    `Destructive: ${tool.isDestructive({}) ? "yes" : "no"}`,
    `Concurrency-safe: ${tool.isConcurrencySafe({}) ? "yes" : "no"}`,
    `Tags: ${(tool.tags ?? []).join(", ") || "none"}`,
    "Input schema:",
    JSON.stringify(tool.inputSchema, null, 2)
  ].join("\n");
}

function schemaSummary(schema: Record<string, unknown>): string {
  const properties = isRecord(schema.properties) ? Object.keys(schema.properties) : [];
  const required = Array.isArray(schema.required) ? schema.required.filter((item) => typeof item === "string") : [];
  return `required=[${required.join(", ")}] properties=[${properties.join(", ")}]`;
}

function readMaxResults(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 20) {
    throw new Error("Tool input max_results must be an integer from 1 to 20");
  }
  return value;
}

function readNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Tool input ${label} must be a non-empty string`);
  }
  return value.trim();
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown field: ${unknown[0]}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
