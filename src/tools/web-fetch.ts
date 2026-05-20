import { MagiMessage, textMessage } from "../providers/ir.js";

export interface WebFetchInput {
  url: string;
  prompt: string;
  maxBytes?: number;
  fetch?: typeof fetch;
  promptModel: (request: { messages: MagiMessage[] }) => Promise<{ text: string }>;
}

export interface WebFetchResult {
  url: string;
  title: string;
  summary: string;
  fetchedBytes: number;
}

export async function webFetch(input: WebFetchInput): Promise<WebFetchResult> {
  const url = normalizeWebFetchUrl(input.url);
  const response = await (input.fetch ?? fetch)(url.toString(), {
    method: "GET",
    headers: {
      accept: "text/html, text/plain;q=0.9, application/xhtml+xml;q=0.8"
    }
  });
  if (!response.ok) {
    throw new Error(`WebFetch failed with HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  const body = await readLimitedResponse(response, input.maxBytes ?? 1_000_000);
  const extracted = contentType.includes("text/html") || looksLikeHtml(body.text)
    ? extractHtml(body.text)
    : { title: url.toString(), text: body.text };
  const pageText = collapseWhitespace(extracted.text).slice(0, 60_000);
  if (!pageText.trim()) {
    throw new Error("WebFetch received no readable text");
  }

  const summary = await input.promptModel({
    messages: [
      textMessage("system", [
        "You are processing fetched web content for Magi.",
        "Follow the user's extraction prompt using only the provided page content.",
        "If the content does not contain the answer, say so."
      ].join("\n")),
      textMessage("user", [
        `URL: ${url.toString()}`,
        `Title: ${extracted.title || url.toString()}`,
        `Prompt: ${input.prompt}`,
        "Content:",
        pageText
      ].join("\n\n"))
    ]
  });

  return {
    url: url.toString(),
    title: extracted.title || url.toString(),
    summary: summary.text.trim(),
    fetchedBytes: body.bytes
  };
}

export function normalizeWebFetchUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("WebFetch url must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("WebFetch url must use http or https");
  }
  return url;
}

export function webFetchHostAllowed(url: string, allowlist: string[] | undefined): boolean {
  if (!allowlist || allowlist.length === 0) {
    return false;
  }
  const host = normalizeWebFetchUrl(url).hostname.toLowerCase();
  return allowlist.some((entry) => hostMatches(entry, host));
}

export function readWebFetchAllowlist(env: NodeJS.ProcessEnv | undefined): string[] {
  return (env?.MAGI_WEBFETCH_ALLOWLIST ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

async function readLimitedResponse(response: Response, maxBytes: number): Promise<{ text: string; bytes: number }> {
  if (!response.body) {
    const text = await response.text();
    return { text, bytes: Buffer.byteLength(text, "utf8") };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      reader.cancel().catch(() => undefined);
      throw new Error(`WebFetch response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return {
    text: new TextDecoder("utf8", { fatal: false }).decode(Buffer.concat(chunks)),
    bytes
  };
}

function extractHtml(html: string): { title: string; text: string } {
  const withoutHidden = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");
  const title = decodeHtmlEntities(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(withoutHidden)?.[1] ?? "").trim();
  const text = decodeHtmlEntities(withoutHidden
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " "));
  return { title, text };
}

function looksLikeHtml(value: string): boolean {
  return /<(html|body|article|main|p|title)\b/i.test(value);
}

function collapseWhitespace(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => {
      const value = Number(code);
      return Number.isFinite(value) ? String.fromCodePoint(value) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => {
      const value = Number.parseInt(code, 16);
      return Number.isFinite(value) ? String.fromCodePoint(value) : "";
    });
}

function hostMatches(pattern: string, host: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) || host === pattern.slice(2);
  }
  return host === pattern;
}
