/**
 * Filesystem utilities used across Magi for safe state writes.
 *
 * The main thing here is `atomicWrite`: write to a temp file in the same
 * directory, then rename onto the target. Rename is atomic on POSIX, so
 * a SIGKILL or power-loss mid-write can't leave a half-written config /
 * session / memory file. The tradeoff is one extra fsync — fine for state.
 */

import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export interface AtomicWriteOptions {
  /** File mode for the final file. Defaults to 0o644. */
  mode?: number;
  /** Sync the directory afterward (POSIX-only). Defaults to false; turn on for very critical files. */
  syncDir?: boolean;
}

/**
 * Write `content` to `targetPath` atomically. Throws on failure.
 *
 * Approach: open a sibling temp file, write+fsync, rename onto target.
 * Cleans the temp file on any error so we never leave .tmp.* litter.
 */
export function atomicWrite(targetPath: string, content: string | Buffer, options: AtomicWriteOptions = {}): void {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tmpName = `.${base}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  const tmpPath = path.join(dir, tmpName);
  const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  const mode = options.mode ?? 0o644;

  let fd: number | undefined;
  try {
    fd = openSync(tmpPath, "w", mode);
    writeSync(fd, data, 0, data.length);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmpPath, targetPath);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
    try { unlinkSync(tmpPath); } catch {}
    throw error;
  }
}
