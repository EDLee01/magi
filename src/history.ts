/**
 * Persistent input history.
 * Stores history to ~/.magi-next/history (one entry per line, most recent last).
 * Deduplicates consecutive identical entries.
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
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
  const history = loadHistory();
  if (history.length > 0 && history[history.length - 1] === encoded) {
    return;
  }

  appendFileSync(HISTORY_FILE, encoded + "\n", "utf-8");

  // Trim if too long
  if (history.length >= MAX_ENTRIES) {
    const trimmed = history.slice(-MAX_ENTRIES + 1);
    trimmed.push(encoded);
    atomicWrite(HISTORY_FILE, trimmed.join("\n") + "\n");
  }
}

export function decodeHistoryEntry(encoded: string): string {
  return encoded.replace(/\\n/g, "\n");
}
