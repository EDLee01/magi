import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { TextDecoder } from "node:util";

import { ToolError } from "./errors.js";
import { assertUrlAllowed } from "./ssrf-guard.js";

export interface HttpRequestResult {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  body: string;
}

export const HttpRequestInputSchema = {
  type: "object",
  properties: {
    url: { type: "string" },
    method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"] },
    headers: { type: "object" },
    body: { type: "string" },
    timeoutMs: { type: "number" }
  },
  required: ["url"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseHttpRequestInput(input: Record<string, unknown>): {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
} {
  const url = typeof input.url === "string" && input.url ? input.url : "";
  if (!url) throw new ToolError("url is required", "bad-input");
  if (!url.startsWith("http://") && !url.startsWith("https://"))
    throw new ToolError("url must start with http:// or https://", "bad-input");
  return {
    url,
    method: typeof input.method === "string" ? input.method.toUpperCase() : "GET",
    headers:
      typeof input.headers === "object" && input.headers
        ? (input.headers as Record<string, string>)
        : undefined,
    body: typeof input.body === "string" ? input.body : undefined,
    timeoutMs: typeof input.timeoutMs === "number" ? input.timeoutMs : 30_000
  };
}

export async function executeHttpRequest(input: {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
}): Promise<HttpRequestResult> {
  // Block internal/metadata addresses (SSRF). node http(s).request does not
  // follow redirects, so a single destination check is sufficient here.
  await assertUrlAllowed(input.url);

  const url = new URL(input.url);
  const mod = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = mod(
      url,
      {
        method: input.method,
        headers: {
          ...input.headers,
          ...(input.body ? { "content-length": String(Buffer.byteLength(input.body)) } : {})
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            headers[k] = Array.isArray(v) ? v.join(", ") : (v ?? "");
          }
          resolve({
            statusCode: res.statusCode ?? 0,
            statusMessage: res.statusMessage ?? "",
            headers,
            body: body.toString("utf8")
          });
        });
        res.on("error", reject);
      }
    );
    req.setTimeout(input.timeoutMs, () => {
      req.destroy();
      reject(new ToolError(`Request timed out after ${input.timeoutMs}ms`, "timeout"));
    });
    req.on("error", reject);
    if (input.body) req.write(input.body);
    req.end();
  });
}

export function formatHttpRequestResult(result: HttpRequestResult): string {
  const statusLine = `${result.statusCode} ${result.statusMessage}`;
  const headerLines = Object.entries(result.headers)
    .slice(0, 15)
    .map(([k, v]) => `${k}: ${v}`);
  const body =
    result.body.length > 5000
      ? result.body.slice(0, 5000) + `\n... (${result.body.length - 5000} more chars)`
      : result.body;
  return [`${statusLine}\n${headerLines.join("\n")}\n\n${body}`].join("\n");
}
