import { WebSearchConfig } from "../config.js";

export interface WebSearchToolInput {
  query: string;
  allowedDomains?: string[];
  blockedDomains?: string[];
  maxResults?: number;
}

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResult {
  query: string;
  provider: "http-json";
  endpoint: string;
  results: WebSearchResultItem[];
}

export const WebSearchInputSchema = {
  type: "object",
  properties: {
    query: { type: "string" },
    allowed_domains: { type: "array", items: { type: "string" } },
    blocked_domains: { type: "array", items: { type: "string" } },
    max_results: { type: "number" }
  },
  required: ["query"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseWebSearchInput(input: Record<string, unknown>): WebSearchToolInput {
  assertAllowedKeys(
    input,
    ["query", "allowed_domains", "blocked_domains", "max_results"],
    "WebSearch input"
  );
  const query = readNonEmptyString(input.query, "query");
  if (query.length < 2) {
    throw new Error("Tool input query must be at least 2 characters");
  }
  return {
    query,
    allowedDomains: readOptionalDomainList(input.allowed_domains, "allowed_domains"),
    blockedDomains: readOptionalDomainList(input.blocked_domains, "blocked_domains"),
    maxResults: readOptionalMaxResults(input.max_results)
  };
}

export async function webSearch(input: {
  request: WebSearchToolInput;
  config: WebSearchConfig;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}): Promise<WebSearchResult> {
  if (input.config.provider !== "http-json" || !input.config.endpoint) {
    throw new Error(
      "WebSearch requires webSearch.provider=http-json and webSearch.endpoint in Magi config or MAGI_WEBSEARCH_ENDPOINT"
    );
  }
  const endpoint = new URL(input.config.endpoint);
  endpoint.searchParams.set(input.config.queryParam, input.request.query);
  const maxResults = Math.min(
    input.request.maxResults ?? input.config.maxResults,
    input.config.maxResults
  );
  endpoint.searchParams.set("count", String(maxResults));
  endpoint.searchParams.set("locale", input.config.locale);
  endpoint.searchParams.set("market", input.config.market);
  const headers: Record<string, string> = { accept: "application/json" };
  if (input.config.apiKeyEnv) {
    const token = input.env?.[input.config.apiKeyEnv];
    if (!token) {
      throw new Error(`WebSearch API key env ${input.config.apiKeyEnv} is not set`);
    }
    headers[input.config.apiKeyHeader ?? "authorization"] = input.config.apiKeyHeader
      ? token
      : `Bearer ${token}`;
  }

  const response = await (input.fetch ?? fetch)(endpoint.toString(), { method: "GET", headers });
  if (!response.ok) {
    throw new Error(`WebSearch failed with HTTP ${response.status}`);
  }
  const parsed = (await response.json()) as unknown;
  const rawResults = readPath(parsed, input.config.resultsPath);
  if (!Array.isArray(rawResults)) {
    throw new Error(`WebSearch response path ${input.config.resultsPath} must be an array`);
  }
  const allowed = input.request.allowedDomains?.map((domain) => domain.toLowerCase());
  const blocked = input.request.blockedDomains?.map((domain) => domain.toLowerCase()) ?? [];
  const results = rawResults
    .map((item, index) => readResultItem(item, index, input.config))
    .filter((item) => domainAllowed(item.url, allowed, blocked))
    .sort((left, right) => mainlandScore(right, input.config) - mainlandScore(left, input.config))
    .slice(0, maxResults);
  return {
    query: input.request.query,
    provider: "http-json",
    endpoint: input.config.endpoint,
    results
  };
}

export function formatWebSearchResult(result: WebSearchResult): string {
  if (result.results.length === 0) {
    return `WebSearch results for ${JSON.stringify(result.query)}\nNo results`;
  }
  return [
    `WebSearch results for ${JSON.stringify(result.query)} (${result.results.length})`,
    `provider: ${result.provider}`,
    ...result.results.map((item, index) =>
      [
        `${index + 1}. ${item.title}`,
        `   URL: ${item.url}`,
        item.snippet ? `   Snippet: ${item.snippet}` : undefined
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n")
    )
  ].join("\n");
}

function mainlandScore(item: WebSearchResultItem, config: WebSearchConfig): number {
  if (!config.mainlandBoost) {
    return 0;
  }
  const host = normalizeHttpUrl(item.url, "WebSearch result url").hostname.toLowerCase();
  let score = 0;
  if (
    host.endsWith(".cn") ||
    host.endsWith(".com.cn") ||
    host.endsWith(".net.cn") ||
    host.endsWith(".org.cn")
  ) {
    score += 4;
  }
  if (containsCjk(item.title)) {
    score += 2;
  }
  if (containsCjk(item.snippet)) {
    score += 1;
  }
  return score;
}

function containsCjk(value: string): boolean {
  return /[\u3400-\u9fff]/u.test(value);
}

function readResultItem(
  value: unknown,
  index: number,
  config: WebSearchConfig
): WebSearchResultItem {
  const title = readPath(value, config.titlePath);
  const url = readPath(value, config.urlPath);
  const snippet = readPath(value, config.snippetPath);
  if (typeof title !== "string" || !title.trim()) {
    throw new Error(`WebSearch result ${index}.title must be a non-empty string`);
  }
  if (typeof url !== "string" || !url.trim()) {
    throw new Error(`WebSearch result ${index}.url must be a non-empty string`);
  }
  const normalizedUrl = normalizeHttpUrl(url, `WebSearch result ${index}.url`);
  return {
    title: title.trim(),
    url: normalizedUrl.toString(),
    snippet: typeof snippet === "string" ? snippet.trim() : ""
  };
}

function domainAllowed(
  urlValue: string,
  allowed: string[] | undefined,
  blocked: string[]
): boolean {
  const host = normalizeHttpUrl(urlValue, "WebSearch result url").hostname.toLowerCase();
  if (blocked.some((domain) => hostMatches(domain, host))) {
    return false;
  }
  if (allowed && allowed.length > 0) {
    return allowed.some((domain) => hostMatches(domain, host));
  }
  return true;
}

function normalizeHttpUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use http or https`);
  }
  return url;
}

function readPath(value: unknown, dottedPath: string): unknown {
  return dottedPath.split(".").reduce((current, part) => {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[part];
  }, value);
}

function readOptionalDomainList(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Tool input ${label} must be an array of domain strings`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`Tool input ${label}.${index} must be a non-empty string`);
    }
    return normalizeDomainPattern(item.trim().toLowerCase(), `${label}.${index}`);
  });
}

function normalizeDomainPattern(value: string, label: string): string {
  const domain = value.startsWith("*.") ? value.slice(2) : value;
  if (
    !/^[a-z0-9.-]+$/.test(domain) ||
    domain.includes("..") ||
    domain.startsWith(".") ||
    domain.endsWith(".")
  ) {
    throw new Error(`Tool input ${label} must be a domain or wildcard domain`);
  }
  return value;
}

function readOptionalMaxResults(value: unknown): number | undefined {
  if (value === undefined) return undefined;
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

function hostMatches(pattern: string, host: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) || host === pattern.slice(2);
  }
  return host === pattern;
}
