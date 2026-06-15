import { MagiMessage, textMessage } from "../providers/ir.js";
import { assertUrlAllowed } from "./ssrf-guard.js";

export interface WebFetchInput {
  url: string;
  prompt: string;
  maxBytes?: number;
  fetch?: typeof fetch;
  /** Hosts the user explicitly allowlisted — exempt from the internal-IP block. */
  allowHost?: (hostname: string) => boolean;
  /**
   * Apply the SSRF guard to the *initial* URL too. The initial URL is normally
   * what the permission gate showed the user (ask/approve or allowlist), so it
   * reflects consent and is trusted. Set true when there is no human in the
   * loop (bypassPermissions). Redirect hops are ALWAYS guarded regardless,
   * since the user never saw them.
   */
  guardInitialHost?: boolean;
  promptModel: (request: { messages: MagiMessage[] }) => Promise<{ text: string }>;
}

export interface WebFetchResult {
  url: string;
  title: string;
  summary: string;
  fetchedBytes: number;
}

const MAX_REDIRECTS = 5;

export async function webFetch(input: WebFetchInput): Promise<WebFetchResult> {
  const url = normalizeWebFetchUrl(input.url);
  const { response, finalUrl } = await fetchFollowingRedirects(
    url,
    input.fetch ?? fetch,
    input.allowHost,
    input.guardInitialHost ?? false
  );
  if (!response.ok) {
    throw new Error(`WebFetch failed with HTTP ${response.status}`);
  }
  void finalUrl;
  const contentType = response.headers.get("content-type") ?? "";
  const body = await readLimitedResponse(response, input.maxBytes ?? 1_000_000);
  const extracted =
    contentType.includes("text/html") || looksLikeHtml(body.text)
      ? extractHtml(body.text)
      : { title: url.toString(), text: body.text };
  const pageText = collapseWhitespace(extracted.text).slice(0, 60_000);
  if (!pageText.trim()) {
    throw new Error("WebFetch received no readable text");
  }

  const summary = await input.promptModel({
    messages: [
      textMessage(
        "system",
        [
          "You are processing fetched web content for Magi.",
          "Follow the user's extraction prompt using only the provided page content.",
          "If the content does not contain the answer, say so."
        ].join("\n")
      ),
      textMessage(
        "user",
        [
          `URL: ${url.toString()}`,
          `Title: ${extracted.title || url.toString()}`,
          `Prompt: ${input.prompt}`,
          "Content:",
          pageText
        ].join("\n\n")
      )
    ]
  });

  return {
    url: url.toString(),
    title: extracted.title || url.toString(),
    summary: summary.text.trim(),
    fetchedBytes: body.bytes
  };
}

/**
 * Fetch a URL, validating every hop against the SSRF guard and following
 * redirects manually so an allowed external host cannot 302-redirect us into
 * an internal address (e.g. the cloud metadata endpoint).
 */
async function fetchFollowingRedirects(
  startUrl: URL,
  fetchImpl: typeof fetch,
  allowHost?: (hostname: string) => boolean,
  guardInitialHost = false
): Promise<{ response: Response; finalUrl: URL }> {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Redirect hops (hop > 0) are always guarded — the user never saw them.
    // The initial hop is guarded only when asked to (no human approval).
    if (hop > 0 || guardInitialHost) {
      await assertUrlAllowed(current.toString(), { allowHost });
    }
    const response = await fetchImpl(current.toString(), {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "text/html, text/plain;q=0.9, application/xhtml+xml;q=0.8"
      }
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return { response, finalUrl: current };
      }
      // Some fetch implementations (and the test stub) follow redirects
      // themselves and won't return a 3xx; this branch only runs for real
      // manual-redirect responses.
      current = normalizeWebFetchUrl(new URL(location, current).toString());
      continue;
    }
    return { response, finalUrl: current };
  }
  throw new Error(`WebFetch exceeded ${MAX_REDIRECTS} redirects`);
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

async function readLimitedResponse(
  response: Response,
  maxBytes: number
): Promise<{ text: string; bytes: number }> {
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
  const title = decodeHtmlEntities(
    /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(withoutHidden)?.[1] ?? ""
  ).trim();
  const text = decodeHtmlEntities(
    withoutHidden
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|li|h[1-6]|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  );
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
    .replace(/&quot;/gi, '"')
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
