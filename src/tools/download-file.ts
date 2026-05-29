import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { ToolError } from "./errors.js";
import { resolveWorkspacePath } from "./workspace.js";

export interface DownloadFileResult {
  url: string;
  path: string;
  sizeBytes: number;
}

export const DownloadFileInputSchema = {
  type: "object",
  properties: { url: { type: "string" }, path: { type: "string" } },
  required: ["url", "path"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseDownloadFileInput(input: Record<string, unknown>): {
  url: string;
  path: string;
} {
  const url = typeof input.url === "string" ? input.url : "";
  const p = typeof input.path === "string" ? input.path : "";
  if (!url) throw new ToolError("url is required", "bad-input");
  if (!p) throw new ToolError("path is required", "bad-input");
  return { url, path: p };
}

export async function executeDownloadFile(input: {
  url: string;
  path: string;
  cwd: string;
}): Promise<DownloadFileResult> {
  const dst = resolveWorkspacePath(input.cwd, input.path).absolutePath;
  mkdirSync(path.dirname(dst), { recursive: true });

  const url = new URL(input.url);
  const mod = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    mod(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new ToolError(`Download failed with status ${res.statusCode}`, "command-failed"));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const data = Buffer.concat(chunks);
        writeFileSync(dst, data);
        resolve({ url: input.url, path: input.path, sizeBytes: data.length });
      });
      res.on("error", reject);
    })
      .on("error", reject)
      .end();
  });
}

export function formatDownloadFileResult(result: DownloadFileResult): string {
  return `Downloaded ${result.url} → ${result.path} (${result.sizeBytes} bytes)`;
}
