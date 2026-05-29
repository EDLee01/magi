import path from "node:path";
import os from "node:os";
import { realpathSync } from "node:fs";

import { ToolError } from "./errors.js";

export function resolveWorkspacePath(
  cwd: string,
  requestedPath: string
): { absolutePath: string; relativePath: string } {
  if (!requestedPath.trim()) {
    throw new ToolError("Path must not be empty", "not-found");
  }

  const absolutePath = path.resolve(cwd, requestedPath);

  // Resolve symlinks on both sides so /var vs /private/var on macOS doesn't
  // create false "outside workspace" errors. Also prevents bypass via
  // symlink -> /etc/passwd because we compare the *real* path against the
  // *real* cwd.
  const realCwd = safeRealpath(cwd);
  const realPath = safeRealpath(absolutePath);

  const rel = path.relative(realCwd, realPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ToolError(
      `Path ${requestedPath} is outside allowed directories`,
      "outside-workspace"
    );
  }
  return {
    absolutePath: realPath,
    relativePath: rel || "."
  };
}

function safeRealpath(p: string): string {
  // Walk up to the nearest ancestor that exists, realpath it, then rejoin
  // the trailing components. This handles paths to files we're about to
  // create, while still resolving any symlinks higher in the tree.
  const tail: string[] = [];
  let current = p;
  while (true) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached root without finding anything - return the original
        return p;
      }
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

export function isBinaryBuffer(buffer: Buffer): boolean {
  return buffer.includes(0);
}

export async function changeCwd(input: {
  cwd: string;
  newCwd: string;
  hooks?: import("../config.js").HookDefinition[];
  sessionId?: string;
}): Promise<{ oldCwd: string; newCwd: string }> {
  if (input.hooks) {
    const { triggerHook } = await import("../hooks/trigger.js");
    void triggerHook({
      event: "cwd_changed",
      hooks: input.hooks,
      context: {
        sessionId: input.sessionId,
        cwd: input.cwd,
        oldCwd: input.cwd,
        newCwd: input.newCwd
      }
    });
  }
  return { oldCwd: input.cwd, newCwd: input.newCwd };
}
