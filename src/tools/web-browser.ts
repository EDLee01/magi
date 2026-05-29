import https from "node:https";
import http from "node:http";

export type SearchSource = "bing" | "baidu" | "duckduckgo";

export interface WebBrowserInput {
  action: "search" | "fetch";
  query?: string;
  url?: string;
  source?: SearchSource;
  maxResults?: number;
  maxChars?: number;
}

export interface WebBrowserSearchItem {
  title: string;
  url: string;
  snippet: string;
}

export interface WebBrowserResult {
  action: "search" | "fetch";
  query?: string;
  url?: string;
  source?: SearchSource;
  results?: WebBrowserSearchItem[];
  text?: string;
  error?: string;
}

export const WebBrowserInputSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["search", "fetch"] },
    query: { type: "string" },
    url: { type: "string" },
    source: { type: "string", enum: ["bing", "baidu", "duckduckgo"] },
    max_results: { type: "number" },
    max_chars: { type: "number" }
  },
  required: ["action"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseWebBrowserInput(input: Record<string, unknown>): WebBrowserInput {
  const action = input.action === "fetch" ? ("fetch" as const) : ("search" as const);
  const query = typeof input.query === "string" ? input.query.trim() : "";
  const url = typeof input.url === "string" ? input.url.trim() : "";
  const source = (
    input.source === "baidu" || input.source === "duckduckgo" ? input.source : "bing"
  ) as SearchSource;
  const maxResults =
    typeof input.max_results === "number"
      ? Math.min(Math.max(1, Math.floor(input.max_results)), 20)
      : 10;
  const maxChars =
    typeof input.max_chars === "number"
      ? Math.min(Math.max(1000, Math.floor(input.max_chars)), 100000)
      : 20000;

  if (action === "search" && !query) {
    throw new Error("WebBrowser search requires a query");
  }
  if (action === "fetch" && !url) {
    throw new Error("WebBrowser fetch requires a url");
  }
  if (action === "fetch") {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("WebBrowser fetch url must use http or https");
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("WebBrowser")) throw err;
      throw new Error("WebBrowser fetch url must be a valid URL");
    }
  }

  return { action, query, url, source, maxResults, maxChars };
}

export async function executeWebBrowser(input: WebBrowserInput): Promise<WebBrowserResult> {
  if (input.action === "search") {
    switch (input.source ?? "bing") {
      case "baidu":
        return searchBaidu(input.query!, input.maxResults ?? 10);
      case "duckduckgo":
        return searchDuckDuckGo(input.query!, input.maxResults ?? 10);
      default:
        return searchBing(input.query!, input.maxResults ?? 10);
    }
  }
  return fetchUrl(input.url!, input.maxChars ?? 20000);
}

export function formatWebBrowserResult(result: WebBrowserResult): string {
  if (result.action === "search") {
    if (!result.results || result.results.length === 0) {
      return `No search results for "${result.query}"`;
    }
    const sourceLabel = result.source ? `[${result.source}] ` : "";
    return [
      `${sourceLabel}Search results for "${result.query}" (${result.results.length}):`,
      "",
      ...result.results.map((item, i) =>
        [
          `${i + 1}. ${item.title}`,
          `   URL: ${item.url}`,
          item.snippet ? `   ${item.snippet}` : null
        ]
          .filter(Boolean)
          .join("\n")
      )
    ].join("\n");
  }

  if (result.error) {
    return `Error fetching ${result.url}: ${result.error}`;
  }
  const text = result.text ?? "";
  const lines = text.split("\n").length;
  const chars = text.length;
  return [`Content from ${result.url}:`, `(${chars} chars, ~${lines} lines)`, "", text].join("\n");
}

// ─── Bing Search ───────────────────────────────────────────────────

async function searchBing(query: string, maxResults: number): Promise<WebBrowserResult> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
  const raw = await httpsRequestGet(url);
  const items = parseBingResults(raw, maxResults);
  return { action: "search", query, source: "bing", results: items };
}

function parseBingResults(html: string, maxResults: number): WebBrowserSearchItem[] {
  const items: WebBrowserSearchItem[] = [];
  const liRegex = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>/gi;

  let match: RegExpExecArray | null;
  while ((match = liRegex.exec(html)) !== null && items.length < maxResults) {
    const start = match.index;
    let depth = 1;
    let pos = start + match[0].length;
    while (depth > 0 && pos < html.length) {
      const open = html.indexOf("<li", pos);
      const close = html.indexOf("</li>", pos);
      if (close === -1) break;
      if (open !== -1 && open < close) {
        depth++;
        pos = open + 3;
      } else {
        depth--;
        pos = close + 5;
      }
    }
    const block = html.slice(start, pos);

    // Title & URL from <a> inside <h2>
    const h2a = /<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/i.exec(block);
    if (!h2a) continue;
    const url = decodeHtmlEntities(h2a[1]);
    const title = stripHtml(h2a[2]);

    // Snippet from <p>
    const pMatch = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const snippet = pMatch ? stripHtml(pMatch[1]) : "";

    if (title && url) {
      items.push({ title, url, snippet });
    }
  }

  return items;
}

// ─── Baidu Search ──────────────────────────────────────────────────

async function searchBaidu(query: string, maxResults: number): Promise<WebBrowserResult> {
  const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`;
  const raw = await httpsRequestGet(url);
  const items = parseBaiduResults(raw, maxResults);
  return { action: "search", query, source: "baidu", results: items };
}

function parseBaiduResults(html: string, maxResults: number): WebBrowserSearchItem[] {
  const items: WebBrowserSearchItem[] = [];

  // Baidu results are in <div class="result" ...> or <div class="c-container">
  const resultRegex = /<div[^>]*class="[^"]*(?:result|c-container)[^"]*"[^>]*>/gi;

  let match: RegExpExecArray | null;
  while ((match = resultRegex.exec(html)) !== null && items.length < maxResults) {
    const start = match.index;
    let depth = 1;
    let pos = start + match[0].length;
    while (depth > 0 && pos < html.length) {
      const open = html.indexOf("<div", pos);
      const close = html.indexOf("</div>", pos);
      if (close === -1) break;
      if (open !== -1 && open < close) {
        depth++;
        pos = open + 4;
      } else {
        depth--;
        pos = close + 6;
      }
    }
    const block = html.slice(start, pos);

    // Title & URL
    const h3a = /<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/i.exec(
      block
    );
    if (!h3a) continue;
    let url = decodeHtmlEntities(h3a[1]);
    const title = stripHtml(h3a[2]);

    // Extract real URL from Baidu redirect
    url = extractBaiduUrl(url);

    // Snippet from <span class="content-right_..."> or general text
    const snippetMatch = /<div[^>]*class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(
      block
    );
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : "";

    if (title && url) {
      items.push({ title, url, snippet });
    }
  }

  return items;
}

function extractBaiduUrl(url: string): string {
  // Baidu wraps URLs: /link?url=REAL_URL or http(s)://www.baidu.com/link?url=...
  if (url.includes("baidu.com/link?")) {
    const up = new URL(url.startsWith("http") ? url : `https://www.baidu.com${url}`);
    const target = up.searchParams.get("url") || up.searchParams.get("target") || "";
    return target || url;
  }
  return url;
}

// ─── DuckDuckGo Search ─────────────────────────────────────────────

async function searchDuckDuckGo(query: string, maxResults: number): Promise<WebBrowserResult> {
  const body = new URLSearchParams({ q: query }).toString();
  const raw = await httpsRequest(
    "html.duckduckgo.com",
    "/html",
    "POST",
    {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
    },
    body,
    30000
  );

  const items = parseDdgResults(raw, maxResults);
  return { action: "search", query, source: "duckduckgo", results: items };
}

function parseDdgResults(html: string, maxResults: number): WebBrowserSearchItem[] {
  const items: WebBrowserSearchItem[] = [];
  const resultRegex = /<div[^>]*class="[^"]*result[^"]*"[^>]*>/gi;

  let match: RegExpExecArray | null;
  while ((match = resultRegex.exec(html)) !== null && items.length < maxResults) {
    const start = match.index;
    let depth = 1;
    let end = start + match[0].length;
    const endRe = /<\/div>/gi;
    const startRe = /<div[^>]*>/gi;
    startRe.lastIndex = end;
    endRe.lastIndex = end;

    while (depth > 0) {
      const nextStart = startRe.exec(html);
      const nextEnd = endRe.exec(html);
      if (!nextEnd) break;
      if (nextStart && nextStart.index < nextEnd.index) {
        depth++;
        endRe.lastIndex = nextEnd.index + 6;
      } else {
        depth--;
        end = nextEnd.index + 6;
      }
    }

    const block = html.slice(start, end);

    const titleMatch = /<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    const title = titleMatch ? stripHtml(titleMatch[1]).trim() : "";

    let url = "";
    const urlFromHref = /<a[^>]*class="result__a"[^>]*href="([^"]+)"/i.exec(block);
    if (urlFromHref) {
      url = decodeHtmlEntities(urlFromHref[1]);
    }
    if (url.includes("//duckduckgo.com/l/") || url.startsWith("/")) {
      const uddgMatch = /uddg=([^&]+)/.exec(url);
      if (uddgMatch) {
        url = decodeURIComponent(uddgMatch[1]);
      }
    }

    const snippetMatch = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]).trim() : "";

    if (title && url) {
      items.push({ title, url, snippet });
    }
  }

  return items;
}

// ─── URL Fetch ─────────────────────────────────────────────────────

async function fetchUrl(url: string, maxChars: number): Promise<WebBrowserResult> {
  const parsed = new URL(url);
  const hostname = parsed.hostname;
  const path = parsed.pathname + parsed.search;

  let raw: string;
  let contentType: string;
  try {
    const result = await httpsOrHttpRequest(hostname, path, parsed.protocol);
    raw = result.body;
    contentType = result.contentType;
  } catch (err) {
    return {
      action: "fetch",
      url,
      error: err instanceof Error ? err.message : String(err)
    };
  }

  const isHtml =
    contentType.includes("text/html") || /<html|<body|<article|<p[ >]/i.test(raw.slice(0, 500));
  const text = isHtml ? extractText(raw) : raw;
  const truncated = text.slice(0, maxChars);

  return {
    action: "fetch",
    url,
    text: truncated
  };
}

function extractText(html: string): string {
  let text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ");

  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote|pre)>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n---\n");

  text = text.replace(/<[^>]+>/g, " ");
  text = decodeHtmlEntities(text);

  text = text
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  return text;
}

// ─── HTTP helpers ──────────────────────────────────────────────────

function httpsOrHttpRequest(
  hostname: string,
  path: string,
  protocol: string
): Promise<{ body: string; contentType: string }> {
  const mod = protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        hostname,
        path,
        method: "GET",
        headers: {
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
        },
        timeout: 30000
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const contentType = res.headers["content-type"] ?? "";
          resolve({ body, contentType });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
    req.end();
  });
}

function httpsRequestGet(url: string, redirects = 5): Promise<string> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: {
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
        },
        timeout: 30000
      },
      (res) => {
        if (
          (res.statusCode === 301 ||
            res.statusCode === 302 ||
            res.statusCode === 307 ||
            res.statusCode === 308) &&
          res.headers.location &&
          redirects > 0
        ) {
          const redirect = res.headers.location;
          const nextUrl = redirect.startsWith("http")
            ? redirect
            : `https://${parsed.hostname}${redirect}`;
          resolve(httpsRequestGet(nextUrl, redirects - 1));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
    req.end();
  });
}

function httpsRequest(
  hostname: string,
  path: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
  timeout = 30000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const opts = { hostname, path, method, headers, timeout };
    const req = https.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
    if (body) req.write(body);
    req.end();
  });
}

// ─── String helpers ────────────────────────────────────────────────

function stripHtml(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_m: string, code: string) => {
      const n = Number(code);
      return Number.isFinite(n) ? String.fromCodePoint(n) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m: string, code: string) => {
      const n = Number.parseInt(code, 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : "";
    });
}
