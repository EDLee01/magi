import { spawnSync } from "node:child_process";

export interface FileFindResult { files: Array<{ path: string; sizeBytes?: number; modifiedAt?: string }>; total: number }
export const FileFindInputSchema = { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, min_size: { type: "string" }, max_size: { type: "string" }, max_results: { type: "number" } }, required: [], additionalProperties: false } satisfies Record<string, unknown>;

export function parseFileFindInput(input: Record<string, unknown>): { pattern?: string; path?: string; minSize?: string; maxSize?: string; maxResults: number } {
  return {
    pattern: typeof input.pattern === "string" ? input.pattern : undefined,
    path: typeof input.path === "string" ? input.path : undefined,
    minSize: typeof input.min_size === "string" ? input.min_size : undefined,
    maxSize: typeof input.max_size === "string" ? input.max_size : undefined,
    maxResults: typeof input.max_results === "number" ? Math.min(input.max_results, 500) : 100
  };
}

export function executeFileFind(input: { pattern?: string; path?: string; minSize?: string; maxSize?: string; maxResults: number; cwd: string }): FileFindResult {
  const args = ["find", input.path ?? ".", "-type", "f"];
  if (input.pattern) args.push("-name", input.pattern);
  if (input.minSize) args.push("-size", `+${input.minSize}`);
  if (input.maxSize) args.push("-size", `-${input.maxSize}`);

  const result = spawnSync("find", args.slice(1), { cwd: input.cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
  if (result.error) throw result.error;

  const raw = result.stdout ?? "";
  const allFiles = raw.trim().split("\n").filter(Boolean);
  const files = allFiles.slice(0, input.maxResults).map(f => ({ path: f }));
  return { files, total: files.length };
}

export function formatFileFindResult(result: FileFindResult): string {
  if (result.files.length === 0) return "No matching files";
  return result.files.map(f => f.path).join("\n") + `\n(${result.total} files)`;
}
