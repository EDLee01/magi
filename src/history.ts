/**
 * Persistent input history.
 * Stores history to ~/.magi-next/history (one entry per line, most recent last).
 * Deduplicates consecutive identical entries.
 */

import {
  existsSync,
  readFileSync,
  appendFileSync,
  mkdirSync,
  statSync,
  openSync,
  readSync,
  closeSync
} from "node:fs";
import path from "node:path";
import { atomicWrite } from "./fs-utils.js";
import os from "node:os";

const HISTORY_DIR = path.join(os.homedir(), ".magi-next");
const HISTORY_FILE = path.join(HISTORY_DIR, "history");
const MAX_ENTRIES = 1000;

export function loadHistory(): string[] {
  if (!existsSync(HISTORY_FILE)) return [];
  try {
    const raw = readFileSync(HISTORY_FILE, "utf-8");
    return raw.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export function appendHistory(entry: string): void {
  if (!entry.trim()) return;
  // Encode newlines for multi-line entries
  const encoded = entry.replace(/\n/g, "\\n");

  if (!existsSync(HISTORY_DIR)) {
    mkdirSync(HISTORY_DIR, { recursive: true });
  }

  // Check last entry to deduplicate
  if (readLastHistoryEntry() === encoded) {
    return;
  }

  appendFileSync(HISTORY_FILE, encoded + "\n", "utf-8");

  // Trim if too long
  const history = loadHistory();
  if (history.length > MAX_ENTRIES) {
    const trimmed = history.slice(-MAX_ENTRIES);
    atomicWrite(HISTORY_FILE, trimmed.join("\n") + "\n");
  }
}

export function decodeHistoryEntry(encoded: string): string {
  return encoded.replace(/\\n/g, "\n");
}

function readLastHistoryEntry(): string | undefined {
  if (!existsSync(HISTORY_FILE)) return undefined;
  let fd: number | undefined;
  try {
    const stat = statSync(HISTORY_FILE);
    if (stat.size === 0) return undefined;
    const readSize = Math.min(stat.size, 64 * 1024);
    const buffer = Buffer.alloc(readSize);
    fd = openSync(HISTORY_FILE, "r");
    readSync(fd, buffer, 0, readSize, stat.size - readSize);
    const chunk = buffer.toString("utf-8").replace(/\n+$/, "");
    if (!chunk) return undefined;
    const lastNewline = chunk.lastIndexOf("\n");
    return lastNewline === -1 ? chunk : chunk.slice(lastNewline + 1);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}
