import { spawnSync } from "node:child_process";

export interface TreeViewResult { path: string; depth: number; tree: string; entries: number }
export const TreeViewInputSchema = { type: "object", properties: { path: { type: "string" }, depth: { type: "number" }, show_files: { type: "boolean" } }, required: [], additionalProperties: false } satisfies Record<string, unknown>;

export function parseTreeViewInput(input: Record<string, unknown>): { path: string; depth: number; showFiles: boolean } {
  return {
    path: typeof input.path === "string" ? input.path : ".",
    depth: typeof input.depth === "number" ? Math.min(Math.max(input.depth, 1), 5) : 3,
    showFiles: input.show_files !== false
  };
}

export function executeTreeView(input: { path: string; depth: number; showFiles: boolean; cwd: string }): TreeViewResult {
  const depth = input.depth;
  const whichResult = spawnSync("which", ["tree"], { encoding: "utf8", timeout: 3000 });
  const useTree = whichResult.status === 0 && whichResult.stdout?.trim().length > 0;
  let tree: string;
  let entries = 0;

  if (useTree) {
    const args = ["-L", String(depth)];
    if (!input.showFiles) args.push("-d");
    args.push("--charset=utf-8", input.path);
    const result = spawnSync("tree", args, { cwd: input.cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 10 * 1024 * 1024 });
    tree = result.stdout?.trim() ?? "";
    entries = tree.split("\n").length - 1; // last line is summary
  } else {
    // fallback: find + format
    const args = [input.path, "-maxdepth", String(depth)];
    if (!input.showFiles) args.push("-type", "d");
    const result = spawnSync("find", args, { cwd: input.cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 10 * 1024 * 1024 });
    tree = result.stdout?.trim() ?? "";
    entries = tree.split("\n").length;
  }
  return { path: input.path, depth, tree, entries };
}

export function formatTreeViewResult(result: TreeViewResult): string {
  return `${result.tree}\n(${result.entries} entries, depth ${result.depth})`;
}
