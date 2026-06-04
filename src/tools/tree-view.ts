import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

import { resolveWorkspacePath } from "./workspace.js";

export interface TreeViewResult {
  path: string;
  depth: number;
  tree: string;
  entries: number;
}
export const TreeViewInputSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    depth: { type: "number" },
    show_files: { type: "boolean" }
  },
  required: [],
  additionalProperties: false
} satisfies Record<string, unknown>;

export function parseTreeViewInput(input: Record<string, unknown>): {
  path: string;
  depth: number;
  showFiles: boolean;
} {
  return {
    path: typeof input.path === "string" ? input.path : ".",
    depth: typeof input.depth === "number" ? Math.min(Math.max(input.depth, 1), 5) : 3,
    showFiles: input.show_files !== false
  };
}

export function executeTreeView(input: {
  path: string;
  depth: number;
  showFiles: boolean;
  cwd: string;
}): TreeViewResult {
  const depth = input.depth;
  const resolved = resolveWorkspacePath(input.cwd, input.path);
  const displayPath = normalizeTreePath(resolved.relativePath);
  const useExternalTree = process.platform !== "win32" && hasTreeCommand();
  let tree: string | undefined;
  let entries: number | undefined;

  if (useExternalTree) {
    const args = ["-a", "-L", String(depth)];
    if (!input.showFiles) args.push("-d");
    args.push("--charset=utf-8", displayPath);
    const result = spawnSync("tree", args, {
      cwd: input.cwd,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 10 * 1024 * 1024
    });
    if (result.status === 0 && result.stdout?.trim()) {
      tree = result.stdout.trim();
      entries = tree.split("\n").length - 1; // last line is summary
    }
  }
  if (tree === undefined || entries === undefined) {
    const fallback = formatFilesystemTree({
      absolutePath: resolved.absolutePath,
      displayPath,
      depth,
      showFiles: input.showFiles
    });
    tree = fallback.tree;
    entries = fallback.entries;
  }
  return { path: displayPath, depth, tree, entries };
}

export function formatTreeViewResult(result: TreeViewResult): string {
  return `${result.tree}\n(${result.entries} entries, depth ${result.depth})`;
}

function hasTreeCommand(): boolean {
  const whichResult = spawnSync("which", ["tree"], { encoding: "utf8", timeout: 3000 });
  return whichResult.status === 0 && whichResult.stdout?.trim().length > 0;
}

export function formatFilesystemTree(input: {
  absolutePath: string;
  displayPath: string;
  depth: number;
  showFiles: boolean;
}): { tree: string; entries: number } {
  const stat = statSync(input.absolutePath);
  if (stat.isFile()) {
    return { tree: input.displayPath, entries: 1 };
  }
  const lines = [input.displayPath];
  let entries = 0;
  appendChildren(input.absolutePath, "", input.depth);
  return { tree: lines.join("\n"), entries };

  function appendChildren(dir: string, prefix: string, remainingDepth: number): void {
    if (remainingDepth <= 0) {
      return;
    }
    const children = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => input.showFiles || entry.isDirectory())
      .sort(
        (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)
      );
    children.forEach((entry, index) => {
      const isLast = index === children.length - 1;
      const connector = isLast ? "`-- " : "|-- ";
      const childPath = path.join(dir, entry.name);
      const isDirectory = entry.isDirectory();
      lines.push(`${prefix}${connector}${entry.name}${isDirectory ? "/" : ""}`);
      entries += 1;
      if (isDirectory) {
        appendChildren(childPath, `${prefix}${isLast ? "    " : "|   "}`, remainingDepth - 1);
      }
    });
  }
}

function normalizeTreePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}
